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

// New properties (R005, G3, W3, W4), status-only updates (W5) and hand-off (F4). Every write still goes
// through propose_* → explicit confirmation; nothing is created or changed by an unconfirmed message.
describe("dev stub: new properties through propose → confirm", () => {
  const R005 = "Add a 3000 sq ft retail property in Indiranagar worth ₹4.2 crore";
  const countOf = (d: Deps, userId: string) => d.stores.state.properties.filter((p) => p.userId === userId).length;
  const turn = (d: Deps, userId: string, message: string, conversationId?: string) =>
    handleChatTurn(d, { userId, message, ...(conversationId ? { conversationId } : {}) });

  it("R005: asks for exactly what the backend says is missing; nothing is proposed", async () => {
    const d = deps();
    const before = structuredClone(d.stores.state.properties);
    const r = await turn(d, "U004", R005);
    // The city is inferred from U004's own Indiranagar property (P012, Bengaluru) and is shown for
    // confirmation later; occupancy is the one required detail still missing.
    expect(d.stores.state.properties.find((p) => p.id === "P012")).toMatchObject({ userId: "U004", locality: "Indiranagar", city: "Bengaluru" });
    expect(r.reply).toContain("To add this property I still need whether it is tenanted, vacant or self-occupied. Could you tell me?");
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(d.stores.state.properties).toEqual(before);
    expect(r.needsAttention).toBe(false);
  });

  it("G3: 'Add a property' with no details asks for every required field, with no figures", async () => {
    const d = deps();
    const r = await turn(d, "U004", "Add a property to my portfolio");
    for (const ask of ["what type it is", "the locality", "the city", "its area in square feet", "its current estimated value", "tenanted, vacant or self-occupied"]) {
      expect(r.reply).toContain(ask);
    }
    expect(r.reply).toContain("Could you tell me?");
    expect(extractNumbers(r.reply)).toEqual([]);
    expect(r.pendingAction).toBeNull();
  });

  it("W4: the follow-up completes the draft → CREATE proposal → nothing saved until 'yes' → created once, audited", async () => {
    const d = deps();
    const startCount = countOf(d, "U004");
    const existingIds = new Set(d.stores.state.properties.map((p) => p.id));
    const t1 = await turn(d, "U004", R005);
    const t2 = await turn(d, "U004", "It's in Bengaluru and currently vacant", t1.conversationId);
    expect(t2.pendingAction).toMatchObject({ type: "CREATE_PROPERTY", propertyId: null });
    expect(t2.reply).toContain("**Proposed change — not saved yet.**");
    expect(t2.reply).toContain("New property · Location: — → **Indiranagar, Bengaluru**");
    expect(countOf(d, "U004")).toBe(startCount); // proposal only

    const t3 = await turn(d, "U004", "yes", t1.conversationId);
    expect(t3.reply).toContain("is added to your portfolio");
    expect(countOf(d, "U004")).toBe(startCount + 1);
    const created = d.stores.state.properties.find((p) => !existingIds.has(p.id))!;
    expect(created.userId).toBe("U004"); // owned by the signed-in user
    expect(created).toMatchObject({ city: "Bengaluru", areaSqft: 3000, currentValueInr: 42_000_000, occupancyStatus: "VACANT", annualRentInr: 0, assetClass: "RETAIL" });
    expect(d.stores.state.audits).toEqual([expect.objectContaining({ propertyId: created.id, userId: "U004", action: "CREATE" })]);
  });

  it("W4 variant: 'cancel' after the proposal creates nothing", async () => {
    const d = deps();
    const startCount = countOf(d, "U004");
    const t1 = await turn(d, "U004", R005);
    await turn(d, "U004", "It's in Bengaluru and currently vacant", t1.conversationId);
    const c = await turn(d, "U004", "cancel", t1.conversationId);
    expect(c.reply).toContain("Cancelled — nothing was changed.");
    await turn(d, "U004", "yes", t1.conversationId);
    expect(countOf(d, "U004")).toBe(startCount);
    expect(d.stores.state.audits).toHaveLength(0);
  });

  it("W3: the brief's example is flagged as a near-duplicate of P001 (backend check); 'separate' then proposes", async () => {
    const d = deps();
    const t1 = await turn(d, "U001", "I have a 5,000 sq ft retail property in Bandra worth ₹12 Cr. Add it to my portfolio.");
    expect(t1.reply).toContain("To add this property I still need whether it is tenanted, vacant or self-occupied. Could you tell me?");
    const t2 = await turn(d, "U001", "It's vacant", t1.conversationId);
    expect(t2.reply).toContain("This looks like your existing **P001** (Bandra West, Mumbai). Did you mean to update that one, or is this a separate property?");
    expect(t2.pendingAction).toBeNull();
    expect(extractNumbers(t2.reply)).toEqual([]); // the candidate's raw figures are not repeated
    const t3 = await turn(d, "U001", "It's a separate property", t1.conversationId);
    expect(t3.pendingAction).toMatchObject({ type: "CREATE_PROPERTY" });
    expect(countOf(d, "U001")).toBe(3); // still only a proposal
  });

  it("the city of a new locality is inferred only from the user's OWN properties; others' data is never used", async () => {
    const d = deps();
    // U003 has no Bandra property (U001 does): no city is inferred and no U001 duplicate is ever shown.
    const t1 = await turn(d, "U003", "Add a 5000 sq ft retail property in Bandra worth ₹12 Cr");
    expect(t1.reply).toContain("the city");
    const t2 = await turn(d, "U003", "It's in Mumbai and vacant", t1.conversationId);
    expect(t2.reply).not.toContain("P001");
    expect(t2.pendingAction).toMatchObject({ type: "CREATE_PROPERTY" });
  });

  it("only the immediately previous turn's draft continues; questions are never merged into a draft", async () => {
    const d = deps();
    const t1 = await turn(d, "U004", R005);
    const q = await turn(d, "U004", "Show my retail properties", t1.conversationId);
    expect(q.pendingAction).toBeNull();
    expect(q.reply).toContain("Found");
    const late = await turn(d, "U004", "It's in Bengaluru and currently vacant", t1.conversationId);
    expect(late.pendingAction).toBeNull(); // the draft was two turns ago
    expect(d.stores.state.pendingActions).toHaveLength(0);
  });
});

describe("dev stub: status-only updates (W5)", () => {
  const turn = (d: Deps, userId: string, message: string, conversationId?: string) =>
    handleChatTurn(d, { userId, message, ...(conversationId ? { conversationId } : {}) });

  it("'now tenanted' without a rent: the backend refuses, the stub asks for the rent, nothing is proposed", async () => {
    const d = deps();
    const r = await turn(d, "U001", "My Andheri office is now tenanted");
    expect(r.reply).toContain("What is the annual rent for **P002** now?");
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(d.stores.state.properties.find((p) => p.id === "P002")!.occupancyStatus).toBe("VACANT");
  });

  it("the rent in the next message proposes occupancy + rent; saved only after 'yes'", async () => {
    const d = deps();
    const t1 = await turn(d, "U001", "My Andheri office is now tenanted");
    const t2 = await turn(d, "U001", "₹45 lakh a year", t1.conversationId);
    expect(t2.reply).toContain("- P002 · Occupancy: Vacant → **Tenanted**");
    expect(t2.reply).toContain("- P002 · Annual rent: ₹0 → **₹45 L**");
    expect(rentOf(d, "P002")).toBe(0);
    await turn(d, "U001", "yes", t1.conversationId);
    expect(rentOf(d, "P002")).toBe(4_500_000);
    expect(d.stores.state.properties.find((p) => p.id === "P002")!.occupancyStatus).toBe("TENANTED");
    expect(d.stores.state.audits).toHaveLength(1);
  });

  it("'now vacant' proposes zero rent explicitly (not saved); an ambiguous property gets a question", async () => {
    const d = deps();
    const r = await turn(d, "U001", "My Bandra property is now vacant");
    expect(r.reply).toContain("- P001 · Annual rent: ₹72 L → **₹0**");
    expect(rentOf(d, "P001")).toBe(7_200_000);
    const amb = await turn(deps(), "U003", "My office is now vacant"); // U003 has two offices
    expect(amb.reply).toMatch(/which one of your properties do you mean\?/);
    expect(amb.pendingAction).toBeNull();
  });
});

describe("dev stub: hand-off to the business team (F4)", () => {
  it("flags the conversation via flag_for_human and says truthfully that nobody was contacted automatically", async () => {
    const d = deps();
    const r = await handleChatTurn(d, { userId: "U001", message: "I want to speak to a human advisor about selling P002 for tax reasons" });
    expect(r.handoff).toBe(true);
    expect(r.needsAttention).toBe(true); // visible in the admin queue
    expect(r.reply).toContain("flagged this conversation for the business team");
    expect(r.reply).toContain("No one is contacted automatically");
    expect(r.reply).not.toMatch(/will (call|contact) you|has been contacted|asked a team member to contact/);
    expect(r.pendingAction).toBeNull();
    const conv = await d.stores.conversations.get("U001", r.conversationId);
    expect(conv).toMatchObject({ needsAttention: true, attentionReason: expect.stringContaining("handoff (user_requested_human)") });
  });

  it("a request for tax advice is flagged as out of scope", async () => {
    const r = await handleChatTurn(deps(), { userId: "U001", message: "Can you give me tax advice on selling P002?" });
    expect(r.handoff).toBe(true);
    expect(r.reply).toContain("can't give tax, legal or investment advice");
  });
});
