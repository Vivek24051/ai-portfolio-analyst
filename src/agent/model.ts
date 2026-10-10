// Model abstraction + primary/fallback routing.
//
// The graph depends on this small interface, not on a vendor SDK, so tests use scripted fakes
// and production uses OpenRouter through LangChain's ChatOpenAI (OpenAI-compatible API).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
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

/** OpenRouter via the OpenAI-compatible API. Not exercised by tests (no paid calls). */
export function createOpenRouterModel(modelId: string, apiKey: string): ChatModel {
  const client = new ChatOpenAI({
    model: modelId,
    apiKey,
    temperature: 0,
    // Retries/fallback are handled by invokeWithFallback, so failures surface fast.
    maxRetries: 0,
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: { "X-Title": "AI Real Estate Portfolio Analyst" },
    },
  });
  return {
    id: modelId,
    async invoke(messages, opts) {
      const runnable = opts.tools ? client.bindTools(opts.tools, { parallel_tool_calls: true }) : client;
      return (await runnable.invoke(messages, { signal: opts.signal })) as AIMessage;
    },
  };
}

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * Calls the primary model with a per-call timeout; on any failure (timeout, 429, 5xx, network,
 * provider error) retries once on the fallback model. Aborts immediately if the whole-turn
 * deadline signal fires. Every attempt is recorded for observability.
 */
export async function invokeWithFallback(
  router: ModelRouter,
  messages: BaseMessage[],
  opts: { tools: ToolSpec[] | null; turnSignal: AbortSignal },
  recorder: RunRecorder,
): Promise<{ message: AIMessage; modelId: string; usedFallback: boolean }> {
  const attempts: Array<{ model: ChatModel; isFallback: boolean }> = [{ model: router.primary, isFallback: false }];
  if (router.fallback) attempts.push({ model: router.fallback, isFallback: true });
  const causes: string[] = [];

  for (const { model, isFallback } of attempts) {
    if (opts.turnSignal.aborted) break;
    const deadline = createDeadline(router.callTimeoutMs, opts.turnSignal);
    const signal = deadline.signal;
    const start = performance.now();
    try {
      const message = await raceAbort(model.invoke(messages, { tools: opts.tools, signal }), signal);
      // isInstance accepts AIMessage and AIMessageChunk (some providers return chunks).
      if (!AIMessage.isInstance(message)) throw new Error("Model returned a non-AI message");
      const usage = message.usage_metadata;
      recorder.llmCalls.push({
        model: model.id,
        ms: Math.round(performance.now() - start),
        ok: true,
        error: null,
        isFallback,
        withTools: opts.tools !== null,
        promptTokens: usage?.input_tokens ?? null,
        completionTokens: usage?.output_tokens ?? null,
      });
      return { message, modelId: model.id, usedFallback: isFallback };
    } catch (e) {
      const reason = signal.aborted && !opts.turnSignal.aborted ? `timeout after ${router.callTimeoutMs} ms` : describe(e);
      causes.push(`${model.id}: ${reason}`);
      recorder.llmCalls.push({
        model: model.id,
        ms: Math.round(performance.now() - start),
        ok: false,
        error: reason,
        isFallback,
        withTools: opts.tools !== null,
        promptTokens: null,
        completionTokens: null,
      });
    } finally {
      deadline.clear();
    }
  }
  const why = opts.turnSignal.aborted ? "Turn deadline exceeded" : "All models failed";
  throw new ModelUnavailableError(why, causes);
}
