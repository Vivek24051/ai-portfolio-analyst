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
  invoke(messages: BaseMessage[], opts: ModelInvokeOptions): Promise<AIMessage>;
  /** Optional token streaming. Must resolve to the same complete message `invoke` would return. */
  stream?(messages: BaseMessage[], opts: ModelInvokeOptions, onDelta: (text: string) => void): Promise<AIMessage>;
}

export interface ModelRouter {
  primary: ChatModel;
  fallback: ChatModel | null;
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

/**
 * OpenRouter via the OpenAI-compatible API.
 * NOT exercised by any test (no paid calls yet) — verified only by type-checking.
 */
export interface OpenRouterOptions {
  /** Injected fetch — used by tests to replay synthetic OpenRouter responses without network access. */
  fetch?: typeof fetch;
  baseURL?: string;
}

export function createOpenRouterModel(modelId: string, apiKey: string, options: OpenRouterOptions = {}): ChatModel {
  const client = new ChatOpenAI({
    model: modelId,
    apiKey,
    temperature: 0,
    // Retries/fallback are handled by invokeWithFallback, so failures surface fast.
    maxRetries: 0,
    streamUsage: true,
    // Ask OpenRouter to include usage accounting (tokens + cost) in responses.
    modelKwargs: { usage: { include: true } },
    configuration: {
      baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      defaultHeaders: { "X-Title": "AI Real Estate Portfolio Analyst" },
    },
  });
  const runnableFor = (tools: ToolSpec[] | null) => (tools ? client.bindTools(tools, { parallel_tool_calls: true }) : client);
  return {
    id: modelId,
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
 * Calls the primary model with a per-call timeout; on any failure (timeout, 429, 5xx, network,
 * provider error) retries once on the fallback model. Aborts immediately if the whole-turn
 * deadline signal fires. Streams tokens when both the model and the caller support it.
 * Every attempt is recorded (duration, time-to-first-token, tokens, error).
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
  },
  recorder: RunRecorder,
): Promise<{ message: AIMessage; modelId: string; usedFallback: boolean; primaryFailed: boolean }> {
  const attempts: Array<{ model: ChatModel; isFallback: boolean }> = [];
  if (!(opts.skipPrimary && router.fallback)) attempts.push({ model: router.primary, isFallback: false });
  if (router.fallback) attempts.push({ model: router.fallback, isFallback: true });
  let primaryFailed = false;
  const causes: string[] = [];

  for (const { model, isFallback } of attempts) {
    if (opts.turnSignal.aborted) break;
    const deadline = createDeadline(router.callTimeoutMs, opts.turnSignal);
    const signal = deadline.signal;
    const start = performance.now();
    let ttftMs: number | null = null;
    let streamed = false;
    const base = { model: model.id, isFallback, withTools: opts.tools !== null, streamed: false };
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
      return { message, modelId: model.id, usedFallback: isFallback, primaryFailed };
    } catch (e) {
      if (streamed) opts.stream?.onReset();
      const reason = signal.aborted && !opts.turnSignal.aborted ? `timeout after ${router.callTimeoutMs} ms` : describe(e);
      if (!isFallback) primaryFailed = true;
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
      // Bad key / no credits fail identically on the fallback (same key, same account): stop here.
      if (isAccountError(e)) {
        causes.push("fallback skipped: account-level error (same key/credits)");
        break;
      }
    } finally {
      deadline.clear();
    }
  }
  const why = opts.turnSignal.aborted ? "Turn deadline exceeded" : "All models failed";
  throw new ModelUnavailableError(why, causes);
}
