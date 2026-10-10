// Telemetry semantics, cost extraction, redaction and the per-turn fallback circuit breaker.
// Models are scripted fakes; the cost-metadata shapes below are ASSUMED OpenRouter shapes and are
// not verified against a live response.
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { extractCostUsd } from "@/agent/model";
import { RunRecorder, type LlmCallRecord } from "@/agent/telemetry";
import { handleChatTurn } from "@/server/services/chatService";
import { logError, redactSecrets, safeErrorMessage } from "@/server/redact";
import { chatDeps, freshStores, scriptedModel, text, toolCall } from "./agentHelpers";

const call = (over: Partial<LlmCallRecord>): LlmCallRecord => ({
  model: "m",
  ms: 10,
  ttftMs: null,
  streamed: false,
  ok: true,
  error: null,
  isFallback: false,
  withTools: true,
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.001,
  ...over,
});

describe("RunRecorder aggregates: missing ≠ zero", () => {
  it("sums when every successful call reported the figure", () => {
    const r = new RunRecorder();
    r.llmCalls.push(call({}), call({ promptTokens: 20, completionTokens: 0, costUsd: 0 }));
    expect(r.tokens()).toEqual({ promptTokens: 30, completionTokens: 5 });
    expect(r.costUsd()).toBeCloseTo(0.001);
  });

  it("is null (unknown) if any successful call did not report it", () => {
    const r = new RunRecorder();
    r.llmCalls.push(call({}), call({ promptTokens: null, costUsd: null }));
    expect(r.tokens().promptTokens).toBeNull();
    expect(r.tokens().completionTokens).toBe(10);
    expect(r.costUsd()).toBeNull();
  });

  it("ignores failed calls (they never return usage) and is null with no successful calls", () => {
    const r = new RunRecorder();
    r.llmCalls.push(call({ ok: false, promptTokens: null, completionTokens: null, costUsd: null }), call({}));
    expect(r.tokens()).toEqual({ promptTokens: 10, completionTokens: 5 });
    const none = new RunRecorder();
    expect(none.tokens()).toEqual({ promptTokens: null, completionTokens: null });
    expect(none.costUsd()).toBeNull();
  });

  it("measures from the request receipt time when given", () => {
    const r = new RunRecorder(performance.now() - 250);
    expect(r.elapsedMs()).toBeGreaterThanOrEqual(250);
  });
});

describe("extractCostUsd (assumed OpenRouter metadata shapes; unverified live)", () => {
  it("reads a reported cost and never invents one", () => {
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: { usage: { cost: 0.00042 } } }))).toBe(0.00042);
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: { tokenUsage: { cost: "0.0001" } } }))).toBe(0.0001);
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: { usage: { cost: 0 } } }))).toBe(0);
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: {} }))).toBeNull();
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: { usage: { cost: -1 } } }))).toBeNull();
    expect(extractCostUsd(new AIMessage({ content: "", response_metadata: { usage: { cost: "n/a" } } }))).toBeNull();
  });

  it("flows into the run when every call reports it", async () => {
    const stores = freshStores();
    const priced = new AIMessage({
      content: "hi",
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      response_metadata: { usage: { cost: 0.0005 } },
    });
    await handleChatTurn(chatDeps(stores, scriptedModel("p", [priced])), { userId: "U001", message: "hi" });
    expect(stores.state.runs[0]!.run).toMatchObject({ promptTokens: 100, completionTokens: 20, costUsd: 0.0005 });
  });
});

describe("redaction", () => {
  it("removes keys, bearer tokens, connection strings and key=value secrets", () => {
    const raw = [
      "401 from provider: invalid key sk-or-v1-0123456789abcdef",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "db postgresql://admin:hunter2@db.example:5432/app",
      'payload {"api_key": "zzz-123", "password":"p@ss"} token=abc123',
    ].join(" | ");
    const out = redactSecrets(raw, {} as NodeJS.ProcessEnv);
    for (const leaked of ["sk-or-v1-0123", "abcdefghijklmnop", "hunter2", "zzz-123", "p@ss", "abc123"]) expect(out).not.toContain(leaked);
    expect(out).toContain('"api_key": "[REDACTED]"');
    expect(out).toContain("db [REDACTED]");
  });

  it("strips configured secret values verbatim and caps length", () => {
    const env = { OPENROUTER_API_KEY: "or-live-very-secret-value" } as unknown as NodeJS.ProcessEnv;
    expect(redactSecrets("echo or-live-very-secret-value back", env)).toBe("echo [REDACTED] back");
    expect(safeErrorMessage(new Error("x".repeat(1000)), 50)).toHaveLength(50);
  });

  it("logError prints a single redacted line (no stack, no raw object)", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      logError("test", new Error("boom with sk-or-v1-abcdefghijkl"));
    } finally {
      console.error = orig;
    }
    expect(lines).toEqual(["[test] Error: boom with [REDACTED]"]);
  });
});

describe("per-turn fallback circuit breaker", () => {
  it("after the primary fails, later model calls in the same turn go straight to the fallback", async () => {
    const primary = scriptedModel("primary", [new Error("timeout")]);
    const fallback = scriptedModel("fallback", [toolCall("portfolio_analytics", { sections: ["totals"] }), text("Total ₹29.7 Cr.")]);
    const stores = freshStores();
    const r = await handleChatTurn(chatDeps(stores, primary, fallback), { userId: "U001", message: "total?" });
    expect(r.reply).toBe("Total ₹29.7 Cr.");
    expect(primary.calls).toHaveLength(1); // not retried on the second model call
    expect(fallback.calls).toHaveLength(2);
    const llm = (stores.state.runs[0]!.run.timings as { llmCalls: LlmCallRecord[] }).llmCalls;
    expect(llm.map((c) => [c.model, c.ok])).toEqual([["primary", false], ["fallback", true], ["fallback", true]]);
  });

  it("the next turn tries the primary again", async () => {
    const primary = scriptedModel("primary", [new Error("blip"), text("primary is back")]);
    const fallback = scriptedModel("fallback", [text("fallback answer")]);
    const stores = freshStores();
    const deps = chatDeps(stores, primary, fallback);
    const t1 = await handleChatTurn(deps, { userId: "U001", message: "a" });
    const t2 = await handleChatTurn(deps, { userId: "U001", conversationId: t1.conversationId, message: "b" });
    expect([t1.reply, t2.reply]).toEqual(["fallback answer", "primary is back"]);
  });
});
