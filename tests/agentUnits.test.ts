import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { parseConversationState } from "@/agent/conversationState";
import { createDeadline, DeadlineError, raceAbort } from "@/agent/deadline";
import { createDevStubModel } from "@/agent/devStubModel";
import { toLangChainMessages, toNewMessages, windowHistory } from "@/agent/memory";
import type { MessageRecord } from "@/server/stores/types";

const rec = (role: MessageRecord["role"], over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: Math.random().toString(36),
  conversationId: "C1",
  role,
  content: role.toLowerCase(),
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  runId: "r",
  createdAt: new Date(),
  ...over,
});

describe("deadline helpers", () => {
  it("fires even when nothing else references the pending work", async () => {
    const d = createDeadline(20);
    const never = new Promise<string>(() => {});
    await expect(raceAbort(never, d.signal)).rejects.toBeInstanceOf(DeadlineError);
  });

  it("propagates parent aborts and clears cleanly", async () => {
    const parent = new AbortController();
    const d = createDeadline(10_000, parent.signal);
    parent.abort(new Error("turn over"));
    expect(d.signal.aborted).toBe(true);
    d.clear();
    const ok = createDeadline(10_000);
    await expect(raceAbort(Promise.resolve(42), ok.signal)).resolves.toBe(42);
    ok.clear();
  });
});

describe("memory", () => {
  it("window starts at the first user message", () => {
    const records = [rec("TOOL", { toolCallId: "c1" }), rec("ASSISTANT"), rec("USER"), rec("ASSISTANT")];
    expect(windowHistory(records).map((r) => r.role)).toEqual(["USER", "ASSISTANT"]);
    expect(windowHistory([rec("TOOL"), rec("ASSISTANT")])).toEqual([]);
  });

  it("round-trips tool calls and tool results", () => {
    const records = [
      rec("USER", { content: "retail?" }),
      rec("ASSISTANT", { content: "", toolCalls: [{ id: "c1", name: "search_properties", args: { sortBy: "rent" } }] }),
      rec("TOOL", { content: '{"matchCount":2}', toolCallId: "c1", toolName: "search_properties" }),
      rec("ASSISTANT", { content: "Two." }),
    ];
    const msgs = toLangChainMessages(records);
    expect(HumanMessage.isInstance(msgs[0]!)).toBe(true);
    expect((msgs[1] as AIMessage).tool_calls?.[0]).toMatchObject({ id: "c1", name: "search_properties" });
    expect((msgs[2] as ToolMessage).tool_call_id).toBe("c1");
    const back = toNewMessages(msgs, "r2");
    expect(back.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "TOOL", "ASSISTANT"]);
    expect(back[1]!.toolCalls).toEqual([{ id: "c1", name: "search_properties", args: { sortBy: "rent" } }]);
  });

  it("truncates very large historical tool payloads", () => {
    const big = "x".repeat(10_000);
    const msgs = toLangChainMessages([rec("USER"), rec("TOOL", { content: big, toolCallId: "c" })]);
    expect(String(msgs[1]!.content).length).toBeLessThan(5_000);
  });
});

describe("conversation state", () => {
  it("defaults missing fields and resets corrupt state", () => {
    expect(parseConversationState(undefined)).toEqual({ focusPropertyIds: [], activeScenario: null, pendingActionId: null, consecutiveFailures: 0 });
    expect(parseConversationState({ focusPropertyIds: "P001" }).focusPropertyIds).toEqual([]);
  });
});

describe("dev stub model (not an LLM)", () => {
  it("routes a few demo phrases to real tools and labels everything else", async () => {
    const stub = createDevStubModel();
    const signal = new AbortController().signal;
    const r1 = await stub.invoke([new HumanMessage("Which property has the highest rent?")], { tools: null, signal });
    expect(r1.tool_calls?.[0]).toMatchObject({ name: "search_properties", args: { sortBy: "rent", limit: 1 } });
    const r2 = await stub.invoke([new HumanMessage("Tell me a joke")], { tools: null, signal });
    expect(String(r2.content)).toMatch(/^\[dev stub — no LLM configured\]/);
  });
});
