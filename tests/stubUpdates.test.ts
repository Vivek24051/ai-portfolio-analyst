// Dev stub (no LLM, no network): real property updates through the EXISTING propose → confirm write
// path, plus fixes found on the live deployment. In-memory stores; nothing here touches a database.
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createDevStubModel } from "@/agent/devStubModel";
import { extractNumbers } from "@/agent/faithfulness";
import { parseInrText, parseMoneyText } from "@/domain/money";
import { handleChatTurn, handlePendingActionDecision } from "@/server/services/chatService";
import { confirmPendingAction, PENDING_ACTION_TTL_MS } from "@/server/services/propertyActions";
import { freshStores } from "./agentHelpers";

const deps = () => ({
  stores: freshStores(),
  router: { primary: createDevStubModel({ streamDelayMs: 0 }), fallback: null, callTimeoutMs: 5_000 },
  historyLimit: 30,
  turnDeadlineMs: 10_000,
});
type Deps = ReturnType<typeof deps>;

const UPDATE = "Update P001's annual rent to ₹80 lakh per year.";
const rentOf = (d: Deps, id: string) => d.stores.state.properties.find((p) => p.id === id)!.annualRentInr;

describe("dev stub: property updates (propose → confirm / cancel / expiry)", () => {
  it("parses '₹80 lakh' with the domain money grammar (the stub does no arithmetic)", () => {
    expect(parseMoneyText("₹80 lakh")).toEqual({ amount: 80, unit: "LAKH" });
    expect(parseMoneyText("80 lakh")).toEqual({ amount: 80, unit: "LAKH" });
    expect(parseMoneyText("1.25 crore")).toEqual({ amount: 1.25, unit: "CRORE" });
    expect(parseMoneyText("Rs 8,00,000")).toEqual({ amount: 800_000, unit: "INR" });
    expect(parseMoneyText("twelve crore")).toBeNull();
    expect(parseInrText("₹80 lakh")).toBe(8_000_000); // the existing parser behaves as before
  });

  it("the request only PROPOSES: current → new is shown and nothing is written", async () => {
    const d = deps();
    const r = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    expect(r.reply).toContain("**Proposed change — not saved yet.**");
    expect(r.reply).toContain("- P001 · Annual rent: ₹72 L → **₹80 L**");
    expect(r.pendingAction).toMatchObject({ propertyId: "P001" }); // the UI shows Confirm / Cancel
    expect(rentOf(d, "P001")).toBe(7_200_000);
    expect(d.stores.state.pendingActions.map((a) => a.status)).toEqual(["PENDING"]);
    expect(d.stores.state.audits).toHaveLength(0);
    expect(r.needsAttention).toBe(false); // every figure traces to tool output or the user's message
  });

  it("an explicit 'yes' in a later message saves once, with an audit row; a repeat does nothing", async () => {
    const d = deps();
    const p = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    const yes = await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "yes" });
    expect(yes.reply).toContain("**Saved.** P001 is updated:");
    expect(yes.reply).toContain("rent ₹80 L/yr");
    expect(rentOf(d, "P001")).toBe(8_000_000);
    expect(d.stores.state.audits).toEqual([
      expect.objectContaining({ propertyId: "P001", userId: "U001", pendingActionId: p.pendingAction!.id }),
    ]);
    await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "yes" });
    expect(d.stores.state.audits).toHaveLength(1);
  });

  it("a non-committal reply does not confirm; the Confirm button path still works", async () => {
    const d = deps();
    const p = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "hmm, maybe later" });
    expect(rentOf(d, "P001")).toBe(7_200_000);
    const button = await handlePendingActionDecision(
      { stores: d.stores },
      { userId: "U001", conversationId: p.conversationId, pendingActionId: p.pendingAction!.id, decision: "confirm" },
    );
    expect(button.reply).toContain("Saved");
    expect(rentOf(d, "P001")).toBe(8_000_000);
  });

  it("'cancel' discards the proposal, and a later 'yes' cannot revive it", async () => {
    const d = deps();
    const p = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    const c = await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "cancel" });
    expect(c.reply).toContain("Cancelled — nothing was changed.");
    expect(d.stores.state.pendingActions.map((a) => a.status)).toEqual(["CANCELLED"]);
    await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "yes" });
    expect(rentOf(d, "P001")).toBe(7_200_000);
    expect(d.stores.state.audits).toHaveLength(0);
  });

  it("an expired proposal cannot be confirmed, and the value is unchanged", async () => {
    const d = deps();
    const p = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    const late = new Date(Date.now() + PENDING_ACTION_TTL_MS + 60_000);
    const r = await confirmPendingAction(
      d.stores,
      { userId: "U001", conversationId: p.conversationId, runId: "late", now: late },
      p.pendingAction!.id,
      { via: "button" },
    );
    expect(r.status).toBe("expired");
    expect(rentOf(d, "P001")).toBe(7_200_000);
  });

  it("optimistic locking: if the property changed after the proposal, 'yes' saves nothing", async () => {
    const d = deps();
    const p = await handleChatTurn(d, { userId: "U001", message: UPDATE });
    const row = d.stores.state.properties.find((x) => x.id === "P001")!;
    row.version += 1; // a concurrent write by someone else
    const yes = await handleChatTurn(d, { userId: "U001", conversationId: p.conversationId, message: "yes" });
    expect(yes.reply).toContain("Nothing was saved:");
    expect(rentOf(d, "P001")).toBe(7_200_000);
    expect(d.stores.state.audits).toHaveLength(0);
  });

  it("another user's property id is 'not found': no proposal, no data revealed, nothing written", async () => {
    const d = deps();
    const before = rentOf(d, "P004");
    const r = await handleChatTurn(d, { userId: "U001", message: "Update P004's annual rent to ₹80 lakh per year." });
    expect(r.reply).toContain("I couldn't find P004 in your portfolio, so nothing was changed.");
    expect(r.reply).not.toMatch(/₹/); // none of U002's figures
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(rentOf(d, "P004")).toBe(before);
  });

  it("ambiguous or incomplete requests get one clarifying question (no figures, no ids); nothing is proposed", async () => {
    const cases: Array<[string, RegExp]> = [
      ["Update the rent to 80 lakh", /which one of your properties do you mean\?/],
      ["Update my Mumbai property's value to ₹10 Cr", /which one of your properties do you mean\?/],
      ["Update P001 and P003 rent to 80 lakh", /which one of your properties do you mean\?/],
      ["Update P001 to 80 lakh", /which figure should I change — the annual rent, the current value or the purchase price\?/],
      ["Update P001's rent by 10%", /what should the new figure be\?/],
    ];
    for (const [message, question] of cases) {
      const d = deps();
      const r = await handleChatTurn(d, { userId: "U002", message });
      expect(r.reply).toMatch(question);
      expect(extractNumbers(r.reply)).toEqual([]);
      expect(r.reply).not.toMatch(/\bP\d{3,}\b/);
      expect(r.pendingAction).toBeNull();
      expect(d.stores.state.pendingActions).toHaveLength(0);
    }
  });

  it("a what-if phrased with 'change' stays hypothetical: no proposal, no write", async () => {
    const d = deps();
    const r = await handleChatTurn(d, { userId: "U001", message: "What if I change P001's annual rent to ₹80 lakh?" });
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(rentOf(d, "P001")).toBe(7_200_000);
  });
});

describe("dev stub: fixes found on the live deployment", () => {
  const signal = () => new AbortController().signal;

  it("formats the LATEST tool call when an old tool-call id repeats in the history (serverless cold start)", async () => {
    const stub = createDevStubModel({ streamDelayMs: 0 });
    const analytics = (id: string, args: Record<string, unknown>) =>
      new AIMessage({ content: "", tool_calls: [{ id, name: "portfolio_analytics", args, type: "tool_call" }] });
    const result = JSON.stringify({
      scope: "filtered: 2 of 3 properties",
      shareOfWholePortfolioValue: "71.38%",
      wholePortfolio: { properties: 3, totalValue: "₹29.7 Cr" },
      totals: { properties: 2, totalValue: "₹21.2 Cr", annualRent: "₹1.32 Cr" },
    });
    const reply = await stub.invoke(
      [
        new SystemMessage("PROPERTY INDEX (ids and labels only)\n(no properties yet)"),
        new HumanMessage("What does my portfolio look like?"),
        analytics("stub_1", {}), // written by an earlier server instance, same id
        new ToolMessage({ content: "{}", tool_call_id: "stub_1", name: "portfolio_analytics" }),
        new AIMessage("overview"),
        new HumanMessage("How much of my portfolio is retail?"),
        analytics("stub_1", { filter: { assetClasses: ["RETAIL"] }, sections: ["totals"] }),
        new ToolMessage({ content: result, tool_call_id: "stub_1", name: "portfolio_analytics" }),
      ],
      { tools: null, signal: signal() },
    );
    expect(String(reply.content)).toContain("**Retail is 71.38% of your portfolio by value**");
  });

  it("new tool-call ids are unique", async () => {
    const stub = createDevStubModel({ streamDelayMs: 0 });
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const m = await stub.invoke([new HumanMessage("portfolio overview")], { tools: null, signal: signal() });
      ids.add(m.tool_calls![0]!.id!);
    }
    expect(ids.size).toBe(20);
  });

  it("'What's my ROI?' gets the honest can't-calculate answer (regex word boundaries restored)", async () => {
    const r = await handleChatTurn(deps(), { userId: "U001", message: "What's my ROI?" });
    expect(r.reply).toContain("**I can't calculate your portfolio's appreciation or ROI.**");
  });
});
