// Offline token ESTIMATES for cost planning (no provider involved). Counts what would be sent to
// a model — system prompt, history, tool schemas — with the cl100k_base tokenizer. Real models
// tokenize differently (often ±10–25%), so these are planning figures, never reported as usage.

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { getEncoding } from "js-tiktoken";
import type { ChatModel } from "@/agent/model";

const enc = getEncoding("cl100k_base");
const count = (s: string) => enc.encode(s).length;
const PER_MESSAGE_OVERHEAD = 4;

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  withTools: boolean;
}

function messageTokens(m: BaseMessage): number {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  const calls = AIMessage.isInstance(m) && m.tool_calls?.length ? JSON.stringify(m.tool_calls) : "";
  return PER_MESSAGE_OVERHEAD + count(content) + (calls ? count(calls) : 0);
}

/** Wraps a model and records an input/output token estimate for every call. */
export function withTokenEstimates(inner: ChatModel, sink: TokenEstimate[]): ChatModel {
  return {
    id: inner.id,
    async invoke(messages, opts) {
      const input = messages.reduce((s, m) => s + messageTokens(m), 0) + (opts.tools ? count(JSON.stringify(opts.tools)) : 0);
      const out = await inner.invoke(messages, opts);
      sink.push({ inputTokens: input, outputTokens: messageTokens(out), withTools: opts.tools !== null });
      return out;
    },
  };
}
