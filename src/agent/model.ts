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

/** HTTP 401 (invalid key) / 402 (insufficient credits): retrying on another model cannot help. */
export function isAccountError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401 || status === 402;
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

/**
 * Calls the models in order — primary, fallback, then the last resort (the dev stub) — each with a
 * per-call timeout. Any failure (timeout, 429, 5xx, network, provider error) moves on to the next.
 * Account errors (401 bad key / 402 no credits) skip every remaining model on the SAME provider —
 * same key, same credits, so a retry there cannot help and is never attempted — but a different
 * provider is still tried. Aborts immediately if the whole-turn deadline fires. Streams tokens
 * when both the model and the caller support it. Every attempt is recorded.
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
  },
  recorder: RunRecorder,
): Promise<{
  message: AIMessage;
  modelId: string;
  usedFallback: boolean;
  primaryFailed: boolean;
  /** The answer came from the last-resort stub (every real model failed or was skipped). */
  usedLastResort: boolean;
  /** Models that failed, or were skipped after an account error, during this call (for the caller's per-turn circuit breaker). */
  failedModelIds: string[];
}> {
  type Tier = "primary" | "fallback" | "last_resort";
  const chain: Array<{ model: ChatModel; tier: Tier }> = [{ model: router.primary, tier: "primary" }];
  if (router.fallback) chain.push({ model: router.fallback, tier: "fallback" });
  if (router.lastResort) chain.push({ model: router.lastResort, tier: "last_resort" });
  const skip = new Set(opts.skipModelIds ?? []);
  if (opts.skipPrimary) skip.add(router.primary.id);
  // Never skip everything: the last link of the chain is always tried.
  let attempts = chain.filter((a, i) => i === chain.length - 1 || !skip.has(a.model.id));
  if (attempts.length === 0) attempts = [chain.at(-1)!];

  let primaryFailed = false;
  const failedModelIds: string[] = [];
  const accountFailures: ChatModel[] = [];
  const causes: string[] = [];

  for (const { model, tier } of attempts) {
    const isFallback = tier !== "primary";
    if (opts.turnSignal.aborted) break;
    if (accountFailures.some((f) => !differentAccount(f, model))) {
      causes.push(`${model.id}: skipped (account-level error on the same or an unknown provider; same key/credits)`);
      // Report it to the per-turn circuit breaker too, so a later tool round can't call it with the same key.
      failedModelIds.push(model.id);
      continue;
    }
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
      return { message, modelId: model.id, usedFallback: isFallback, primaryFailed, usedLastResort: tier === "last_resort", failedModelIds };
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
      // Bad key / no credits fail identically on every model of the same provider: never retry there.
      if (isAccountError(e)) {
        accountFailures.push(model);
        const rest = attempts.slice(attempts.findIndex((a) => a.model === model) + 1);
        if (rest.every((a) => !differentAccount(model, a.model))) {
          causes.push("fallback skipped: account-level error (same key/credits)");
          break;
        }
      }
    } finally {
      deadline.clear();
    }
  }
  const why = opts.turnSignal.aborted ? "Turn deadline exceeded" : "All models failed";
  throw new ModelUnavailableError(why, causes);
}
