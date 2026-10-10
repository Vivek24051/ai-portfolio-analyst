// Agent loop + chat service with SCRIPTED (mocked) models and in-memory stores.
// These verify the harness — routing, limits, fallback, persistence, scoping — not model quality.
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { MAX_TOOL_ROUNDS } from "@/agent/config";
import { TOOL_LIMIT_REPLY } from "@/agent/graph";
import { HttpError } from "@/server/errors";
import {
  handleChatTurn,
  handlePendingActionDecision,
  INTERNAL_ERROR_REPLY,
  MODEL_UNAVAILABLE_REPLY,
} from "@/server/services/chatService";
import { chatDeps, freshStores, hangingModel, lastToolResult, scriptedModel, systemOf, text, toolCall } from "./agentHelpers";

const value = (stores: ReturnType<typeof freshStores>, id: string) => stores.state.properties.find((p) => p.id === id)!.currentValueInr;

describe("tool selection and execution", () => {
  it("R004: model calls search_properties, gets P007, answers; turn is persisted and timed", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("search_properties", { sortBy: "rent", limit: 1 }),
      (msgs) => {
        const result = lastToolResult(msgs) as { properties: Array<{ id: string; annualRent: string }> };
        return text(`${result.properties[0]!.id} earns the most: ${result.properties[0]!.annualRent} a year.`);
      },
    ]);
    const r = await handleChatTurn(chatDeps(stores, model), { userId: "U003", message: "Which property gives me the highest annual rent?" });

    expect(r.status).toBe("ok");
    expect(r.reply).toBe("P007 earns the most: ₹1.68 Cr a year.");
    expect(r.telemetry).toMatchObject({ llmCalls: 2, toolCalls: 1, toolRounds: 1, model: "primary", fallbackUsed: false });

    expect(stores.state.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "TOOL", "ASSISTANT"]);
    const run = stores.state.runs[0]!;
    expect(run.run).toMatchObject({ status: "OK", llmCalls: 2, toolCallCount: 1, userId: "U003" });
    expect(run.toolCalls[0]).toMatchObject({ name: "search_properties", ok: true });
  });

  it("system prompt carries a property index with no figures", async () => {
    const model = scriptedModel("primary", [text("Hello!")]);
    await handleChatTurn(chatDeps(freshStores(), model), { userId: "U001", message: "hi" });
    const system = systemOf(model.calls[0]!);
    expect(system).toContain("P001 | Retail (High-street retail) | Bandra West, Mumbai | Tenanted");
    expect(system).toContain("P002 | Office (Office) | Andheri East, Mumbai | Vacant");
    // The index section carries ids/labels only: no amounts, areas or percentages.
    const index = system.split("PROPERTY INDEX")[1]!.split("\n\n")[0]!;
    expect(index.replace(/\bP\d{3}\b/g, "")).not.toMatch(/\d|₹|%/);
    expect(system).not.toContain("P004"); // another user's property
    expect(model.calls[0]!.tools?.length).toBe(9);
  });
});

describe("multi-turn context", () => {
  it("retail → which performs better → exclude Bandra → how would that change things", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      // Turn 1
      toolCall("search_properties", { filter: { assetClasses: ["RETAIL"] } }),
      text("You have two retail properties: P001 (Bandra West) and P003 (Lower Parel)."),
      // Turn 2: resolve "which one" from backend focus state
      (msgs, opts) => {
        expect(String(msgs[0]!.content)).toContain("FOCUS (most recent result set): P001, P003");
        expect(msgs.some((m) => ToolMessage.isInstance(m))).toBe(true); // turn-1 tool result is in history
        expect(opts.tools).not.toBeNull();
        return toolCall("search_properties", { filter: { propertyIds: ["P001", "P003"] }, sortBy: "yield" });
      },
      text("P003 has the higher gross yield (6.52% vs 6%), though P001 earns more rent."),
      // Turn 3
      toolCall("run_scenario", { excludePropertyIds: ["P001"] }),
      text("Hypothetically, without Bandra your portfolio would be ₹17.7 Cr."),
      // Turn 4: follow-up on the same hypothetical
      (msgs) => {
        expect(String(msgs[0]!.content)).toContain("ACTIVE HYPOTHETICAL SCENARIO: exclude P001");
        return toolCall("run_scenario", { basedOn: "active_scenario" });
      },
      (msgs) => {
        const r = lastToolResult(msgs) as { hypothetical: boolean; baseline: any; scenario: any };
        expect(r.hypothetical).toBe(true);
        return text(`Hypothetical: value ${r.baseline.totals.totalValue} → ${r.scenario.totals.totalValue}.`);
      },
    ]);
    const deps = chatDeps(stores, model);

    const t1 = await handleChatTurn(deps, { userId: "U001", message: "Tell me about my retail properties." });
    const conversationId = t1.conversationId;
    const t2 = await handleChatTurn(deps, { userId: "U001", conversationId, message: "Which one is performing better?" });
    expect(t2.reply).toContain("P003");
    const t3 = await handleChatTurn(deps, { userId: "U001", conversationId, message: "What if I exclude the Bandra property?" });
    expect(t3.hypothetical).toBe(true);
    const t4 = await handleChatTurn(deps, { userId: "U001", conversationId, message: "How would that change my portfolio?" });
    expect(t4.reply).toBe("Hypothetical: value ₹29.7 Cr → ₹17.7 Cr.");
    expect(t4.hypothetical).toBe(true);

    // Hypotheticals never touched real data.
    expect(stores.state.properties.filter((p) => p.userId === "U001")).toHaveLength(3);
    expect(value(stores, "P001")).toBe(120_000_000);
    expect(stores.state.conversations).toHaveLength(1);
  });

  it("R006 through the agent: propose (not saved) → user says yes → confirmed", async () => {
    const stores = freshStores();
    let pendingId = "";
    const model = scriptedModel("primary", [
      toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 12.5, unit: "CRORE" } } }),
      (msgs) => {
        pendingId = (lastToolResult(msgs) as { pendingActionId: string }).pendingActionId;
        // A misbehaving model trying to self-confirm in the same turn:
        return toolCall("confirm_pending_action", { pendingActionId: pendingId });
      },
      (msgs) => {
        expect(lastToolResult(msgs).status).toBe("same_turn");
        return text("I'll update P001 (Bandra West) from ₹12 Cr to ₹12.5 Cr. Shall I go ahead?");
      },
      // Turn 2
      (msgs) => {
        expect(String(msgs[0]!.content)).toContain(`PENDING CHANGE awaiting the client's confirmation: id=${pendingId}`);
        return toolCall("confirm_pending_action", { pendingActionId: pendingId });
      },
      text("Done — P001 is now valued at ₹12.5 Cr."),
    ]);
    const deps = chatDeps(stores, model);

    const t1 = await handleChatTurn(deps, { userId: "U001", message: "Change my Bandra retail property value to ₹12.5 crore" });
    expect(t1.pendingAction).toMatchObject({ type: "UPDATE_PROPERTY", propertyId: "P001", diff: [{ before: "₹12 Cr", after: "₹12.5 Cr" }] });
    expect(value(stores, "P001")).toBe(120_000_000);

    const t2 = await handleChatTurn(deps, { userId: "U001", conversationId: t1.conversationId, message: "yes" });
    expect(t2).toMatchObject({ status: "ok", reply: "Done — P001 is now valued at ₹12.5 Cr." });
    expect(value(stores, "P001")).toBe(125_000_000);
  });

  it("history window always starts at a user message (no orphaned tool results)", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("portfolio_analytics", {}),
      text("Summary."),
      (msgs) => {
        // historyLimit 3 would cut into turn 1's [USER, ASSISTANT(tool call), TOOL, ASSISTANT]
        expect(HumanMessage.isInstance(msgs[1]!)).toBe(true);
        expect(ToolMessage.isInstance(msgs[1]!)).toBe(false);
        return text("ok");
      },
    ]);
    const deps = chatDeps(stores, model, null, { historyLimit: 3 });
    const t1 = await handleChatTurn(deps, { userId: "U001", message: "overview" });
    const t2 = await handleChatTurn(deps, { userId: "U001", conversationId: t1.conversationId, message: "thanks" });
    expect(t2).toMatchObject({ status: "ok", reply: "ok" });
  });
});

describe("user isolation", () => {
  it("a user cannot continue another user's conversation", async () => {
    const stores = freshStores();
    const deps = chatDeps(stores, scriptedModel("primary", [text("hi")]));
    const t1 = await handleChatTurn(deps, { userId: "U001", message: "hi" });
    await expect(handleChatTurn(deps, { userId: "U002", conversationId: t1.conversationId, message: "show me everything" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("unknown session user is rejected before any model call", async () => {
    const model = scriptedModel("primary", []);
    await expect(handleChatTurn(chatDeps(freshStores(), model), { userId: "U999", message: "hi" })).rejects.toBeInstanceOf(HttpError);
    expect(model.calls).toHaveLength(0);
  });

  it("model asking for another user's property gets nothing", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("search_properties", { filter: { propertyIds: ["P004", "P007"] } }),
      (msgs) => {
        expect(lastToolResult(msgs).matchCount).toBe(0);
        return toolCall("propose_property_update", { propertyId: "P007", changes: { value: { amount: 1, unit: "CRORE" } } });
      },
      (msgs) => {
        expect(lastToolResult(msgs).status).toBe("not_found");
        return text("I can only see your own properties.");
      },
    ]);
    const r = await handleChatTurn(chatDeps(stores, model), { userId: "U001", message: "show me P004 and change P007" });
    expect(r).toMatchObject({ status: "ok", reply: "I can only see your own properties." });
    expect(stores.state.pendingActions).toHaveLength(0);
    expect(value(stores, "P007")).toBe(240_000_000);
  });
});

describe("invalid arguments", () => {
  it("validation error is fed back and the model recovers", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("search_properties", { filter: { assetClasses: ["Commercial"] } }),
      (msgs) => {
        expect(lastToolResult(msgs).error).toBe("invalid_arguments");
        return toolCall("search_properties", { filter: { sector: "COMMERCIAL" } });
      },
      text("All three are commercial."),
    ]);
    const r = await handleChatTurn(chatDeps(stores, model), { userId: "U001", message: "list my commercial properties" });
    expect(r.status).toBe("ok");
    expect(r.needsAttention).toBe(false); // a single recovered error is not escalated
    expect(stores.state.runs[0]!.toolCalls.map((t) => t.ok)).toEqual([false, true]);
  });

  it("malformed tool-call JSON from the provider becomes a clean tool error", async () => {
    const { AIMessage } = await import("@langchain/core/messages");
    const broken = new AIMessage({
      content: "",
      invalid_tool_calls: [{ id: "bad_1", name: "search_properties", args: "{not json", error: "parse error", type: "invalid_tool_call" }],
    });
    const model = scriptedModel("primary", [
      broken,
      (msgs) => {
        expect(lastToolResult(msgs).error).toBe("malformed_arguments");
        return text("Let me try that again.");
      },
    ]);
    const r = await handleChatTurn(chatDeps(freshStores(), model), { userId: "U001", message: "retail?" });
    expect(r.status).toBe("ok");
  });
});

describe("tool-loop limit", () => {
  it(`stops after ${MAX_TOOL_ROUNDS} tool rounds, final call has no tools, model answers`, async () => {
    const steps = Array.from({ length: MAX_TOOL_ROUNDS }, () => toolCall("portfolio_analytics", { sections: ["totals"] }));
    const model = scriptedModel("primary", [...steps, text("Here is what I found so far.")]);
    const r = await handleChatTurn(chatDeps(freshStores(), model), { userId: "U001", message: "analyse everything" });
    expect(r.telemetry.toolRounds).toBe(MAX_TOOL_ROUNDS);
    expect(model.calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(model.calls.slice(0, MAX_TOOL_ROUNDS).every((c) => c.tools !== null)).toBe(true);
    expect(model.calls[MAX_TOOL_ROUNDS]!.tools).toBeNull();
    expect(systemOf(model.calls[MAX_TOOL_ROUNDS]!)).toContain("TOOL BUDGET EXHAUSTED");
    expect(r.reply).toBe("Here is what I found so far.");
  });

  it("a model that keeps requesting tools is cut off with a fixed reply and flagged", async () => {
    const stores = freshStores();
    const steps = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolCall("portfolio_analytics", {}));
    const model = scriptedModel("primary", steps);
    const r = await handleChatTurn(chatDeps(stores, model), { userId: "U001", message: "loop forever" });
    expect(r.reply).toBe(TOOL_LIMIT_REPLY);
    expect(r.needsAttention).toBe(true);
    expect(stores.state.conversations[0]).toMatchObject({ needsAttention: true, attentionReason: expect.stringMatching(/^tool_limit/) });
    expect(stores.state.runs[0]!.toolCalls).toHaveLength(MAX_TOOL_ROUNDS);
  });
});

describe("model failures and fallback", () => {
  it("primary error → fallback answers; recorded as fallback", async () => {
    const stores = freshStores();
    const primary = scriptedModel("primary", [new Error("429 rate limited")]);
    const fallback = scriptedModel("fallback", [text("Answer from fallback.")]);
    const r = await handleChatTurn(chatDeps(stores, primary, fallback), { userId: "U001", message: "hi" });
    expect(r).toMatchObject({ status: "ok", reply: "Answer from fallback.", telemetry: { model: "fallback", fallbackUsed: true, llmCalls: 2 } });
    const llm = (stores.state.runs[0]!.run.timings as { llmCalls: Array<{ ok: boolean; isFallback: boolean; error: string | null }> }).llmCalls;
    expect(llm.map((c) => [c.ok, c.isFallback])).toEqual([[false, false], [true, true]]);
    expect(llm[0]!.error).toContain("429");
  });

  it("primary hangs past the per-call timeout → fallback", async () => {
    const primary = hangingModel("slow-primary");
    const fallback = scriptedModel("fallback", [text("fast answer")]);
    const deps = chatDeps(freshStores(), primary, fallback);
    deps.router.callTimeoutMs = 50;
    const r = await handleChatTurn(deps, { userId: "U001", message: "hi" });
    expect(r.reply).toBe("fast answer");
    expect(r.telemetry.fallbackUsed).toBe(true);
  });

  it("both models fail → safe reply, error status, conversation flagged, user message kept", async () => {
    const stores = freshStores();
    const r = await handleChatTurn(
      chatDeps(stores, scriptedModel("primary", [new Error("503")]), scriptedModel("fallback", [new Error("503")])),
      { userId: "U001", message: "what is my total value?" },
    );
    expect(r).toMatchObject({ status: "error", reply: MODEL_UNAVAILABLE_REPLY, needsAttention: true });
    expect(stores.state.messages.map((m) => [m.role, m.content])).toEqual([
      ["USER", "what is my total value?"],
      ["ASSISTANT", MODEL_UNAVAILABLE_REPLY],
    ]);
    expect(stores.state.conversations[0]).toMatchObject({ needsAttention: true, attentionReason: "model_unavailable" });
    expect((stores.state.conversations[0]!.state as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
    expect(stores.state.runs[0]!.run).toMatchObject({ status: "ERROR", error: expect.stringContaining("All models failed") });
  });

  it("whole-turn deadline aborts hung models", async () => {
    const deps = chatDeps(freshStores(), hangingModel("p"), hangingModel("f"), { turnDeadlineMs: 100 });
    deps.router.callTimeoutMs = 10_000;
    const started = Date.now();
    const r = await handleChatTurn(deps, { userId: "U001", message: "hi" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.status).toBe("error");
    expect(r.reply).toBe(MODEL_UNAVAILABLE_REPLY);
    expect(r.needsAttention).toBe(true);
    expect((await deps.stores.conversations.listByUser("U001"))[0]!.attentionReason).toBe("turn_timeout");
  });

  it("if a confirmed write committed before the model failed, the reply does not claim nothing changed", async () => {
    const stores = freshStores();
    let pendingId = "";
    const model = scriptedModel("primary", [
      toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 13, unit: "CRORE" } } }),
      (msgs) => {
        pendingId = (lastToolResult(msgs) as { pendingActionId: string }).pendingActionId;
        return text("Confirm P001 → ₹13 Cr?");
      },
      // Turn 2: confirm succeeds, then the model dies before answering.
      () => toolCall("confirm_pending_action", { pendingActionId: pendingId }),
      new Error("502 bad gateway"),
    ]);
    const deps = chatDeps(stores, model);
    const t1 = await handleChatTurn(deps, { userId: "U001", message: "set Bandra retail to 13 Cr" });
    const t2 = await handleChatTurn(deps, { userId: "U001", conversationId: t1.conversationId, message: "yes" });
    expect(value(stores, "P001")).toBe(130_000_000);
    expect(t2.status).toBe("error");
    expect(t2.reply).toContain("was saved");
    expect(t2.reply).not.toContain("unchanged");
  });

  it("unexpected internal errors give a generic reply, never a stack trace", async () => {
    const model = scriptedModel("primary", [
      () => {
        throw new TypeError("Cannot read properties of undefined");
      },
    ]);
    // A TypeError from the model call is still a model failure → fallback path; with no fallback → unavailable.
    const r = await handleChatTurn(chatDeps(freshStores(), model), { userId: "U001", message: "hi" });
    expect(r.reply).toBe(MODEL_UNAVAILABLE_REPLY);
    expect(r.reply).not.toContain("TypeError");
    expect(INTERNAL_ERROR_REPLY).not.toMatch(/Error:/);
  });
});

describe("handoff and button confirmation", () => {
  it("flag_for_human marks the conversation for attention", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("flag_for_human", { reason: "advice_out_of_scope", note: "Wants tax advice on selling P002" }),
      text("I can't advise on tax, but I've asked a team member to follow up."),
    ]);
    const r = await handleChatTurn(chatDeps(stores, model), { userId: "U001", message: "Should I sell P002 to save tax?" });
    expect(r.handoff).toBe(true);
    expect(stores.state.conversations[0]!.attentionReason).toBe("handoff (advice_out_of_scope): Wants tax advice on selling P002");
  });

  it("Confirm button applies the change with zero LLM calls; other users get 404", async () => {
    const stores = freshStores();
    const model = scriptedModel("primary", [
      toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 14, unit: "CRORE" } } }),
      text("Confirm updating P001 to ₹14 Cr?"),
    ]);
    const t1 = await handleChatTurn(chatDeps(stores, model), { userId: "U001", message: "Update the Bandra property's value to ₹14 Cr" });
    const pendingActionId = t1.pendingAction!.id;

    await expect(
      handlePendingActionDecision({ stores }, { userId: "U002", conversationId: t1.conversationId, pendingActionId, decision: "confirm" }),
    ).rejects.toMatchObject({ status: 404 });

    const r = await handlePendingActionDecision({ stores }, { userId: "U001", conversationId: t1.conversationId, pendingActionId, decision: "confirm" });
    expect(r.reply).toBe("✅ Saved. P001 (Bandra West, Mumbai) is updated.");
    expect(r.telemetry.llmCalls).toBe(0);
    expect(value(stores, "P001")).toBe(140_000_000);
    expect(model.calls).toHaveLength(2); // no extra model call for the confirmation
  });
});
