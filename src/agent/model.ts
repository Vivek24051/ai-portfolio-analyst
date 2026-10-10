// Model abstraction + primary/fallback routing.
//
// The graph depends on this small interface, not on a vendor SDK, so tests use scripted fakes
// and production uses OpenRouter through LangChain's ChatOpenAI (OpenAI-compatible API).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, type AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { safeErrorMessage } from "@/server/redact";
import { createDeadline, raceAbort } from "./deadline";
import type { RunRecorder } from "./telemetry";
import type { ToolSpec } from "./tools";

export interface ModelInvokeOptions {
  /** null = call without tools (used when the tool budget is exhausted). */
  tools: ToolSpec[] | null;
  signal: AbortSignal;
}

export interface ChatModel {
  readonly id: string;
  /**
   * Which provider account the model runs on ("gemini", "openrouter", "stub"). Models with the same
   * provider share a key and credits, so an account error (401/402) on one rules out the others.
   * Undefined (test fakes) counts as one shared provider, which keeps the original stop-on-401/402.
   */
  readonly provider?: string;
  invoke(messages: BaseMessage[], opts: ModelInvokeOptions): Promise<AIMessage>;
  /** Optional token streaming. Must resolve to the same complete message `invoke` would return. */
  stream?(messages: BaseMessage[], opts: ModelInvokeOptions, onDelta: (text: string) => void): Promise<AIMessage>;
}

export interface ModelRouter {
  primary: ChatModel;
  fallback: ChatModel | null;
  /**
   * Tried after primary and fallback have failed: the clearly labelled dev stub (no LLM, no cost),
   * so a provider outage degrades to template answers instead of an error. Optional.
   */
  lastResort?: ChatModel | null;
  callTimeoutMs: number;
  /**
   * Quota cooldowns shared by every turn this router serves (one router per server instance). A model
   * that returned 429 is not called again until its cooldown ends. Null/undefined = no cooldowns.
   */
  cooldowns?: ModelCooldowns | null;
  /**
   * Hard cap on calls to real (non-stub) models in one user turn, across all tool rounds and the whole
   * chain. When it is reached, the labelled stub last resort answers. Undefined = no cap.
   */
  maxRealCallsPerTurn?: number;
}

/** Both primary and fallback failed (or the turn deadline passed). */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly causes: string[],
  ) {
    super(message);
  }
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Text portion of a streamed chunk (string content or text blocks). */
function chunkText(chunk: AIMessageChunk): string {
  if (typeof chunk.content === "string") return chunk.content;
  return chunk.content.map((b) => (typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : "")).join("");
}

/** Options shared by all OpenAI-compatible providers. */
export interface OpenRouterOptions {
  /** Injected fetch — used by tests to replay synthetic provider responses without network access. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/** What differs between OpenAI-compatible providers. */
interface ProviderProfile {
  /** Provider account label recorded on the model (see ChatModel.provider). */
  provider: string;
  baseURL: string;
  /** Provider-specific request fields (e.g. OpenRouter usage accounting). */
  modelKwargs?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Send `parallel_tool_calls` when binding tools. */
  parallelToolCalls: boolean;
  /** Send `stream_options.include_usage` on streamed calls. */
  streamUsage: boolean;
}

function createOpenAICompatibleModel(modelId: string, apiKey: string, profile: ProviderProfile, options: OpenRouterOptions): ChatModel {
  const client = new ChatOpenAI({
    model: modelId,
    apiKey,
    temperature: 0,
    // Retries/fallback are handled by invokeWithFallback, so failures surface fast.
    maxRetries: 0,
    streamUsage: profile.streamUsage,
    ...(profile.modelKwargs ? { modelKwargs: profile.modelKwargs } : {}),
    configuration: {
      baseURL: options.baseURL ?? profile.baseURL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(profile.headers ? { defaultHeaders: profile.headers } : {}),
    },
  });
  const runnableFor = (tools: ToolSpec[] | null) =>
    tools ? client.bindTools(tools, profile.parallelToolCalls ? { parallel_tool_calls: true } : {}) : client;
  return {
    id: modelId,
    provider: profile.provider,
    async invoke(messages, opts) {
      return (await runnableFor(opts.tools).invoke(messages, { signal: opts.signal })) as AIMessage;
    },
    async stream(messages, opts, onDelta) {
      let acc: AIMessageChunk | undefined;
      for await (const chunk of await runnableFor(opts.tools).stream(messages, { signal: opts.signal })) {
        const text = chunkText(chunk);
        if (text) onDelta(text);
        acc = acc ? acc.concat(chunk) : chunk;
      }
      if (!acc) throw new Error("Empty stream from provider");
      return new AIMessage({
        content: acc.content,
        tool_calls: acc.tool_calls,
        invalid_tool_calls: acc.invalid_tool_calls,
        usage_metadata: acc.usage_metadata,
        response_metadata: acc.response_metadata,
      });
    },
  };
}

/**
 * OpenRouter via the OpenAI-compatible API (paid; not used in this submission).
 * Verified offline against synthetic payloads (tests/openrouter.test.ts).
 */
export function createOpenRouterModel(modelId: string, apiKey: string, options: OpenRouterOptions = {}): ChatModel {
  return createOpenAICompatibleModel(
    modelId,
    apiKey,
    {
      provider: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      // Ask OpenRouter to include usage accounting (tokens + cost) in responses.
      modelKwargs: { usage: { include: true } },
      headers: { "X-Title": "AI Real Estate Portfolio Analyst" },
      parallelToolCalls: true,
      streamUsage: true,
    },
    options,
  );
}

export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/**
 * Google Gemini through its OpenAI-compatible endpoint (free tier via a Google AI Studio key).
 * Only standard OpenAI request fields are sent — no OpenRouter extras — and stream usage is not
 * requested, so token counts may be "not reported" (null) rather than risk a rejected request.
 * Verified offline against synthetic payloads (tests/gemini.test.ts); live behaviour untested here.
 */
export function createGeminiModel(modelId: string, apiKey: string, options: OpenRouterOptions = {}): ChatModel {
  return createOpenAICompatibleModel(
    modelId,
    apiKey,
    { provider: "gemini", baseURL: GEMINI_OPENAI_BASE_URL, parallelToolCalls: false, streamUsage: false },
    options,
  );
}

/**
 * Provider-reported cost in USD, or null. Checks the places OpenRouter usage accounting may
 * surface through LangChain metadata. ASSUMPTION — not yet verified against a live OpenRouter
 * response; if none match, cost stays null (unknown) rather than being estimated.
 */
export function extractCostUsd(message: AIMessage): number | null {
  const meta = (message.response_metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    (meta.usage as Record<string, unknown> | undefined)?.cost,
    (meta.tokenUsage as Record<string, unknown> | undefined)?.cost,
    meta.cost,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** Redacted, length-capped error text (provider errors can echo request details). */
const describe = (e: unknown) => safeErrorMessage(e, 300);

const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

/**
 * Error message plus the provider's parsed error body, length-capped. The OpenAI SDK keeps the body on
 * `error`; a body without an `error` field (Google's array-wrapped `[{ error: {...} }]`) is kept whole
 * (verified offline in tests/geminiSafeguards.test.ts).
 */
function errorText(e: unknown): string {
  const err = e as { message?: unknown; error?: unknown } | null;
  let body = "";
  try {
    body = err?.error === undefined ? "" : JSON.stringify(err.error);
  } catch {
    body = "";
  }
  return `${typeof err?.message === "string" ? err.message : ""} ${body}`.slice(0, 4_000);
}

/** Gemini answers an invalid key with HTTP 400 ("API key not valid", reason API_KEY_INVALID). */
const INVALID_KEY = /api[ _-]?key[^.\n]{0,40}?\b(not valid|invalid|expired)\b|API_KEY_INVALID|invalid api[ _-]?key/i;

/**
 * The key or account cannot work, so another model on the same provider (same key, same credits,
 * same project) cannot help: HTTP 401 (unauthenticated), 402 (no credits), 403 (permission denied),
 * or Gemini's HTTP 400 for an invalid API key.
 */
export function isAccountError(e: unknown): boolean {
  const status = statusOf(e);
  if (status === 401 || status === 402 || status === 403) return true;
  return status === 400 && INVALID_KEY.test(errorText(e));
}

/** HTTP 429: rate limit or quota exhausted (Gemini: RESOURCE_EXHAUSTED). */
export function isRateLimitError(e: unknown): boolean {
  return statusOf(e) === 429;
}

export const COOLDOWN_MIN_MS = 1_000;
/** Used when the provider gives no retry hint. */
export const COOLDOWN_DEFAULT_MS = 60_000;
/** Upper bound for any cooldown, and the cooldown for a daily quota (its reset can be hours away). */
export const COOLDOWN_MAX_MS = 15 * 60_000;

function retryAfterHeader(e: unknown): string | null {
  const h = (e as { headers?: unknown } | null)?.headers;
  if (!h || typeof h !== "object") return null;
  if (typeof (h as Headers).get === "function") return (h as Headers).get("retry-after");
  const entry = Object.entries(h as Record<string, unknown>).find(([k]) => k.toLowerCase() === "retry-after");
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

/**
 * How long to leave a model alone after a 429. Order: the Retry-After header (seconds or an HTTP
 * date), then Gemini's retry hint in the body (`retryDelay: "37s"` / "Please retry in 37.1s"), else
 * COOLDOWN_DEFAULT_MS. A daily quota ("PerDay") gets at least COOLDOWN_MAX_MS. Always clamped to
 * [COOLDOWN_MIN_MS, COOLDOWN_MAX_MS], so a hostile or broken header cannot block a model for long.
 */
export function rateLimitCooldownMs(e: unknown, now: number = Date.now()): number {
  const text = errorText(e);
  let hinted: number | null = null;
  const header = retryAfterHeader(e)?.trim();
  if (header) {
    if (/^\d+(\.\d+)?$/.test(header)) hinted = Number(header) * 1_000;
    else if (!Number.isNaN(Date.parse(header))) hinted = Date.parse(header) - now;
  }
  if (hinted === null) {
    const m = /retryDelay\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?)s/i.exec(text) ?? /retry in (\d+(?:\.\d+)?)\s*s\b/i.exec(text);
    if (m) hinted = Number(m[1]) * 1_000;
  }
  let ms = hinted ?? COOLDOWN_DEFAULT_MS;
  if (/per ?day|PerDay|daily/i.test(text)) ms = Math.max(ms, COOLDOWN_MAX_MS);
  return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.ceil(ms)));
}

/**
 * Per-process quota cooldowns: model → time it may be called again. No timers: entries are checked
 * and expired lazily. The map is bounded (`maxEntries`); when full, the entry ending soonest is
 * dropped. Keyed by provider + model id, so the same id on two providers is tracked separately.
 */
export class ModelCooldowns {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 32,
  ) {}

  private static key(model: ChatModel) {
    return `${model.provider ?? "unknown"}:${model.id}`;
  }

  /** Milliseconds left in this model's cooldown (0 = callable). */
  remainingMs(model: ChatModel): number {
    const key = ModelCooldowns.key(model);
    const until = this.until.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.until.delete(key);
    return 0;
  }

  start(model: ChatModel, ms: number): void {
    const now = this.now();
    for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
    const key = ModelCooldowns.key(model);
    if (!this.until.has(key) && this.until.size >= this.maxEntries) {
      const soonest = [...this.until.entries()].sort((a, b) => a[1] - b[1])[0];
      if (soonest) this.until.delete(soonest[0]);
    }
    this.until.set(key, Math.max(this.until.get(key) ?? 0, now + Math.max(0, ms)));
  }

  get size(): number {
    return this.until.size;
  }
}

export interface StreamHooks {
  onDelta(text: string): void;
  /** Called when already-streamed text must be discarded (the attempt failed; trying fallback). */
  onReset(): void;
}

/**
 * After an account error (401/402) on `failed`, may `next` still be tried? Only when BOTH are labelled
 * with different providers (a different key and account). Unknown means "possibly the same account",
 * so it is never retried — the conservative choice for keys and credits.
 */
const differentAccount = (failed: ChatModel, next: ChatModel) => !!failed.provider && !!next.provider && failed.provider !== next.provider;

/** A real model costs quota; the dev stub (primary in stub mode, or the last resort) does not. */
const isRealModel = (model: ChatModel, tier: string) => tier !== "last_resort" && model.provider !== "stub";

/**
 * Calls the models in order — primary, fallback, then the last resort (the dev stub) — each with a
 * per-call timeout. Any failure (timeout, 429, 5xx, network, provider error) moves on to the next.
 * Account errors (see isAccountError) skip every remaining model on the SAME provider — same key,
 * same credits, so a retry there cannot help and is never attempted — but a different provider is
 * still tried. A 429 puts the model in a cooldown shared across turns (router.cooldowns), and real
 * model calls per turn are capped (router.maxRealCallsPerTurn); skipped models fall through to the
 * next link, ultimately the labelled stub. Aborts immediately if the whole-turn deadline fires.
 * Streams tokens when both the model and the caller support it. Every attempt is recorded.
 */
export async function invokeWithFallback(
  router: ModelRouter,
  messages: BaseMessage[],
  opts: {
    tools: ToolSpec[] | null;
    turnSignal: AbortSignal;
    stream?: StreamHooks;
    /** Per-turn circuit breaker: once the primary failed in this turn, go straight to the fallback. */
    skipPrimary?: boolean;
    /** Per-turn circuit breaker, generalised: models that already failed this turn are skipped. */
    skipModelIds?: readonly string[];
    /** Real model calls already made earlier in this turn (for router.maxRealCallsPerTurn). */
    realCallsSoFar?: number;
  },
  recorder: RunRecorder,
): Promise<{
  message: AIMessage;
  modelId: string;
  usedFallback: boolean;
  primaryFailed: boolean;
  /** The answer came from the last-resort stub (every real model failed or was skipped). */
  usedLastResort: boolean;
  /** Models that failed, or were skipped after an account error or during a cooldown, during this call (for the caller's per-turn circuit breaker). */
  failedModelIds: string[];
  /** Real model calls made by this invocation (attempted, successful or not). */
  realCalls: number;
  /** Why earlier links were not used (redacted); useful when the last resort answered. */
  causes: string[];
}> {
  type Tier = "primary" | "fallback" | "last_resort";
  const chain: Array<{ model: ChatModel; tier: Tier }> = [{ model: router.primary, tier: "primary" }];
  if (router.fallback) chain.push({ model: router.fallback, tier: "fallback" });
  if (router.lastResort) chain.push({ model: router.lastResort, tier: "last_resort" });
  const skip = new Set(opts.skipModelIds ?? []);
  if (opts.skipPrimary) skip.add(router.primary.id);
  // The per-turn circuit breaker never skips everything: the last link of the chain is still considered.
  // (Cooldowns and the per-turn call cap below can still skip it: that is their purpose.)
  let attempts = chain.filter((a, i) => i === chain.length - 1 || !skip.has(a.model.id));
  if (attempts.length === 0) attempts = [chain.at(-1)!];

  let primaryFailed = false;
  const failedModelIds: string[] = [];
  const accountFailures: ChatModel[] = [];
  const causes: string[] = [];
  let realCalls = 0;
  let attempted = false;

  for (const { model, tier } of attempts) {
    const isFallback = tier !== "primary";
    const real = isRealModel(model, tier);
    if (opts.turnSignal.aborted) break;
    if (accountFailures.some((f) => !differentAccount(f, model))) {
      causes.push(`${model.id}: skipped (account-level error on the same or an unknown provider; same key/credits)`);
      // Report it to the per-turn circuit breaker too, so a later tool round can't call it with the same key,
      // and cool it down so the next turns don't either.
      failedModelIds.push(model.id);
      if (real) router.cooldowns?.start(model, COOLDOWN_DEFAULT_MS);
      continue;
    }
    const coolingMs = real ? (router.cooldowns?.remainingMs(model) ?? 0) : 0;
    if (coolingMs > 0) {
      causes.push(`${model.id}: skipped (cooling down after a rate-limit or account error; ${Math.ceil(coolingMs / 1_000)} s left)`);
      failedModelIds.push(model.id);
      continue;
    }
    const cap = router.maxRealCallsPerTurn;
    if (real && cap !== undefined && (opts.realCallsSoFar ?? 0) + realCalls >= cap) {
      causes.push(`${model.id}: skipped (per-turn cap of ${cap} real model calls reached)`);
      continue;
    }
    if (real) realCalls++;
    attempted = true;
    const deadline = createDeadline(router.callTimeoutMs, opts.turnSignal);
    const signal = deadline.signal;
    const start = performance.now();
    let ttftMs: number | null = null;
    let streamed = false;
    const base = {
      model: model.id,
      provider: model.provider ?? null,
      isFallback,
      lastResort: tier === "last_resort",
      withTools: opts.tools !== null,
      streamed: false,
    };
    try {
      const callOpts = { tools: opts.tools, signal };
      const work =
        model.stream && opts.stream
          ? model.stream(messages, callOpts, (text) => {
              if (signal.aborted) return;
              if (ttftMs === null) ttftMs = Math.round(performance.now() - start);
              streamed = true;
              opts.stream!.onDelta(text);
            })
          : model.invoke(messages, callOpts);
      const message = await raceAbort(work, signal);
      // isInstance accepts AIMessage and AIMessageChunk (some providers return chunks).
      if (!AIMessage.isInstance(message)) throw new Error("Model returned a non-AI message");
      const usage = message.usage_metadata;
      recorder.llmCalls.push({
        ...base,
        streamed,
        ms: Math.round(performance.now() - start),
        ttftMs,
        ok: true,
        error: null,
        promptTokens: usage?.input_tokens ?? null,
        completionTokens: usage?.output_tokens ?? null,
        costUsd: extractCostUsd(message),
      });
      return {
        message,
        modelId: model.id,
        usedFallback: isFallback,
        primaryFailed,
        usedLastResort: tier === "last_resort",
        failedModelIds,
        realCalls,
        causes,
      };
    } catch (e) {
      if (streamed) opts.stream?.onReset();
      const reason = signal.aborted && !opts.turnSignal.aborted ? `timeout after ${router.callTimeoutMs} ms` : describe(e);
      if (!isFallback) primaryFailed = true;
      failedModelIds.push(model.id);
      causes.push(`${model.id}: ${reason}`);
      recorder.llmCalls.push({
        ...base,
        streamed,
        ms: Math.round(performance.now() - start),
        ttftMs,
        ok: false,
        error: reason,
        promptTokens: null,
        completionTokens: null,
        costUsd: null,
      });
      // Quota / rate limit: leave this model alone across turns until its cooldown ends.
      if (real && isRateLimitError(e)) router.cooldowns?.start(model, rateLimitCooldownMs(e));
      // Bad key / no credits / no permission fail identically on every model of the same provider: never retry there.
      if (isAccountError(e)) {
        if (real) router.cooldowns?.start(model, COOLDOWN_DEFAULT_MS);
        accountFailures.push(model);
        const rest = attempts.slice(attempts.findIndex((a) => a.model === model) + 1);
        if (rest.every((a) => !differentAccount(model, a.model))) {
          causes.push("fallback skipped: account-level error (same key/credits)");
          for (const a of rest) if (isRealModel(a.model, a.tier)) router.cooldowns?.start(a.model, COOLDOWN_DEFAULT_MS);
          break;
        }
      }
    } finally {
      deadline.clear();
    }
  }
  const why = opts.turnSignal.aborted ? "Turn deadline exceeded" : attempted ? "All models failed" : "No model available (cooldown, account error or call cap)";
  throw new ModelUnavailableError(why, causes);
}
