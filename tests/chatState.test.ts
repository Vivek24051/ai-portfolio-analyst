// Pure UI state transitions (no browser, no network).
import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, type ChatState } from "@/lib/chatState";
import { SseParser, encodeSse } from "@/lib/sse";
import type { ChatTurnResult } from "@/server/services/chatService";

const at = "2026-10-10T10:00:00.000Z";
const result = (over: Partial<ChatTurnResult> = {}): ChatTurnResult => ({
  conversationId: "C1",
  runId: "r1",
  reply: "Your portfolio is ₹29.7 Cr.",
  status: "ok",
  pendingAction: null,
  hypothetical: false,
  handoff: false,
  toolActivity: [],
  needsAttention: false,
  telemetry: { totalMs: 1, llmMs: 0, toolMs: 0, llmCalls: 1, toolCalls: 0, toolRounds: 0, model: "m", fallbackUsed: false },
  ...over,
});
const pending = { id: "PA1", type: "UPDATE_PROPERTY" as const, propertyId: "P001", diff: [], expiresAt: at };

function run(...actions: Parameters<typeof chatReducer>[1][]): ChatState {
  return actions.reduce(chatReducer, initialChatState);
}

describe("chatReducer: streaming turn", () => {
  it("send → tool activity → deltas → done", () => {
    let s = run({ type: "send", text: "total?", localId: "l1", at });
    expect(s.phase).toBe("streaming");
    expect(s.messages.map((m) => m.role)).toEqual(["user"]);

    s = chatReducer(s, { type: "event", at, event: { type: "start", conversationId: "C1", runId: "r1" } });
    s = chatReducer(s, { type: "event", at, event: { type: "delta", text: "Let me check" } });
    s = chatReducer(s, { type: "event", at, event: { type: "tool_start", callId: "t1", name: "portfolio_analytics", label: "Calculating portfolio figures" } });
    expect(s.draft?.text).toBe(""); // preamble cleared once tools start
    s = chatReducer(s, { type: "event", at, event: { type: "tool_end", callId: "t1", name: "portfolio_analytics", ok: true, summary: "whole portfolio" } });
    expect(s.draft?.activity).toEqual([{ callId: "t1", label: "Calculating portfolio figures", state: "ok", summary: "whole portfolio" }]);
    s = chatReducer(s, { type: "event", at, event: { type: "delta", text: "Your portfolio " } });
    s = chatReducer(s, { type: "event", at, event: { type: "delta", text: "is ₹29.7 Cr." } });
    expect(s.draft?.text).toBe("Your portfolio is ₹29.7 Cr.");

    s = chatReducer(s, { type: "event", at, event: { type: "done", result: result() } });
    expect(s).toMatchObject({ phase: "idle", draft: null, conversationId: "C1", error: null });
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "Your portfolio is ₹29.7 Cr.", hypothetical: false });
  });

  it("reset (fallback after partial stream) discards streamed text", () => {
    let s = run({ type: "send", text: "x", localId: "l1", at }, { type: "event", at, event: { type: "delta", text: "partial" } });
    s = chatReducer(s, { type: "event", at, event: { type: "reset" } });
    expect(s.draft?.text).toBe("");
  });

  it("hypothetical results are flagged on the message", () => {
    const s = run({ type: "send", text: "what if", localId: "l1", at }, { type: "event", at, event: { type: "done", result: result({ hypothetical: true }) } });
    expect(s.messages.at(-1)?.hypothetical).toBe(true);
  });

  it("server-side failure (status error) shows the apology and offers retry of the same text", () => {
    const s = run(
      { type: "send", text: "total?", localId: "l1", at },
      { type: "event", at, event: { type: "done", result: result({ status: "error", reply: "Sorry…" }) } },
    );
    expect(s.messages.at(-1)).toMatchObject({ isError: true });
    expect(s.error?.retryText).toBe("total?");
  });

  it("stream error event ends streaming with a retryable error", () => {
    const s = run(
      { type: "send", text: "total?", localId: "l1", at },
      { type: "event", at, event: { type: "error", code: "stream_interrupted", message: "The connection dropped." } },
    );
    expect(s).toMatchObject({ phase: "idle", draft: null, error: { message: "The connection dropped.", retryText: "total?" } });
  });

  it("network failure marks the message failed; retry removes it before re-sending", () => {
    let s = run(
      { type: "send", text: "total?", localId: "l1", at },
      { type: "send_failed", localId: "l1", message: "offline", retryText: "total?" },
    );
    expect(s.messages[0]).toMatchObject({ failed: true });
    s = chatReducer(s, { type: "retry", localId: "l1" });
    expect(s.messages).toHaveLength(0);
    expect(s.error).toBeNull();
  });
});

describe("chatReducer: pending actions", () => {
  it("a proposal shows the card; a later turn without proposal keeps it; confirm/cancel tools clear it", () => {
    let s = run({ type: "send", text: "set to 12.5 Cr", localId: "l1", at }, { type: "event", at, event: { type: "done", result: result({ pendingAction: pending }) } });
    expect(s.pendingAction?.id).toBe("PA1");
    s = chatReducer(s, { type: "send", text: "what is my rent?", localId: "l2", at });
    s = chatReducer(s, { type: "event", at, event: { type: "done", result: result({ runId: "r2" }) } });
    expect(s.pendingAction?.id).toBe("PA1");
    s = chatReducer(s, { type: "send", text: "yes", localId: "l3", at });
    s = chatReducer(s, {
      type: "event",
      at,
      event: { type: "done", result: result({ runId: "r3", toolActivity: [{ name: "confirm_pending_action", label: "x", ok: true, summary: "saved" }] }) },
    });
    expect(s.pendingAction).toBeNull();
  });

  it("button decision appends the label and the deterministic reply, and clears the card", () => {
    let s = run({ type: "loaded", view: { id: "C1", messages: [], pendingAction: pending } });
    s = chatReducer(s, { type: "decide_start" });
    expect(s.phase).toBe("deciding");
    s = chatReducer(s, { type: "decide_done", label: "✅ Confirm", at, result: result({ runId: "r9", reply: "✅ Saved." }) });
    expect(s.pendingAction).toBeNull();
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([["user", "✅ Confirm"], ["assistant", "✅ Saved."]]);
  });
});

describe("SseParser", () => {
  it("handles split frames, multiple frames, heartbeats, CRLF and garbage", () => {
    const p = new SseParser();
    const frame = encodeSse({ type: "delta", text: "₹12 Cr" });
    expect(p.push(frame.slice(0, 7))).toEqual([]);
    expect(p.push(frame.slice(7) + ": keep-alive\n\n" + encodeSse({ type: "reset" }))).toEqual([
      { type: "delta", text: "₹12 Cr" },
      { type: "reset" },
    ]);
    expect(p.push('data: {"type":"status","label":"x"}\r\n\r\n')).toEqual([{ type: "status", label: "x" }]);
    expect(p.push("data: {not json}\n\n")).toEqual([]);
  });
});
