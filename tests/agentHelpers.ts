// MOCKED model infrastructure for agent tests. No network, no API key, no cost.
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatModel, ModelInvokeOptions } from "@/agent/model";
import type { ChatDeps } from "@/server/services/chatService";
import { createMemoryStores, type MemoryStores } from "@/server/stores/memory";
import { loadSeed } from "./helpers";

export interface RecordedCall {
  messages: BaseMessage[];
  tools: ModelInvokeOptions["tools"];
}

type Step = AIMessage | Error | ((messages: BaseMessage[], opts: ModelInvokeOptions) => AIMessage | Promise<AIMessage>);

let callSeq = 0;

export function toolCall(name: string, args: Record<string, unknown>): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ id: `call_${++callSeq}`, name, args, type: "tool_call" }] });
}

export const text = (content: string) => new AIMessage(content);

/** A fake model that replays a script, one step per invocation, and records what it was sent. */
export function scriptedModel(id: string, steps: Step[]): ChatModel & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    id,
    calls,
    async invoke(messages, opts) {
      calls.push({ messages, tools: opts.tools });
      const step = steps[i++];
      if (step === undefined) throw new Error(`${id}: script exhausted at call ${i}`);
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(messages, opts) : step;
    },
  };
}

/** A model that never answers until its abort signal fires (simulates a hung provider). */
export function hangingModel(id: string): ChatModel & { calls: number } {
  const m = {
    id,
    calls: 0,
    invoke(_messages: BaseMessage[], opts: ModelInvokeOptions) {
      m.calls++;
      return new Promise<AIMessage>((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  return m;
}

export function freshStores(): MemoryStores {
  return createMemoryStores(loadSeed());
}

export function chatDeps(stores: MemoryStores, primary: ChatModel, fallback: ChatModel | null = null, over: Partial<ChatDeps> = {}): ChatDeps {
  return {
    stores,
    router: { primary, fallback, callTimeoutMs: 2_000 },
    historyLimit: 30,
    turnDeadlineMs: 5_000,
    now: () => new Date("2026-10-10T10:00:00Z"),
    ...over,
  };
}

export const systemOf = (call: RecordedCall) => {
  const first = call.messages[0];
  if (!first || !SystemMessage.isInstance(first)) throw new Error("first message is not a system message");
  return String(first.content);
};

export const lastToolResult = (messages: BaseMessage[]) => {
  const last = [...messages].reverse().find((m) => ToolMessage.isInstance(m));
  if (!last) throw new Error("no tool message");
  return JSON.parse(String(last.content)) as Record<string, unknown>;
};
