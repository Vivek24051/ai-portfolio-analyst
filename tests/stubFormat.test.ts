// Dev stub template replies: readable, built only from tool output (no LLM, no network).
import { describe, expect, it } from "vitest";
import { checkNumericFaithfulness, extractNumbers } from "@/agent/faithfulness";
import { createDevStubModel } from "@/agent/devStubModel";
import { formatToolResultForStub } from "@/agent/stubFormat";
import { handleChatTurn } from "@/server/services/chatService";
import { pct, summarizePortfolio } from "@/domain/analytics";
import { applyFilter } from "@/domain/filters";
import { formatInr } from "@/domain/money";
import { freshStores } from "./agentHelpers";
import { loadSeed, propsOf } from "./helpers";

const deps = () => ({
  stores: freshStores(),
  router: { primary: createDevStubModel({ streamDelayMs: 0 }), fallback: null, callTimeoutMs: 5_000 },
  historyLimit: 30,
  turnDeadlineMs: 10_000,
});

describe("dev stub template replies", () => {
  it("portfolio overview is readable prose with the real figures, not raw JSON", async () => {
    const r = await handleChatTurn(deps(), { userId: "U001", message: "What does my portfolio look like?" });
    expect(r.reply).toMatch(/^\[dev stub — template reply, no LLM\]/);
    expect(r.reply).toContain("You own **3 properties** worth **₹29.7 Cr**, earning **₹1.32 Cr** a year in rent.");
    expect(r.reply).toContain("- Retail: **₹21.2 Cr** (71.38%) · 2 properties");
    expect(r.reply).not.toContain('{"');
    expect(r.needsAttention).toBe(false); // every figure traces to tool output
  });

  it("search results list one line per property; ties and exclusions are stated", async () => {
    const yieldReply = (await handleChatTurn(deps(), { userId: "U004", message: "Which property has the best yield?" })).reply;
    expect(yieldReply).toContain("tie for first place");
    expect(yieldReply).toContain("- #1 **P010**: Retail — Mall retail, Whitefield, Bengaluru · **₹4.8 Cr** · rent ₹36 L/yr · yield 7.5% · Tenanted");
    expect(yieldReply).toContain("Not ranked: P012 — no rental income (Self-occupied).");

    const rentReply = (await handleChatTurn(deps(), { userId: "U003", message: "Which property has the highest rent?" })).reply;
    expect(rentReply).toContain('**P007**: Office (recorded as "Commercial Office"), Golf Course Road, Gurugram');

    const mumbai = (await handleChatTurn(deps(), { userId: "U002", message: "Show me my properties in Mumbai" })).reply;
    expect(mumbai).toContain("Found **2 properties**");
    expect(mumbai).not.toContain("P006");
  });

  it("templates never introduce numbers that are not in the tool output", () => {
    const tool = JSON.stringify({
      scope: "whole portfolio",
      totals: { properties: 1, totalValue: "₹4.8 Cr", annualRent: "₹36 L", grossYieldAllProperties: "7.5%", grossYieldIncomeProducingOnly: "7.5%" },
      byAssetClass: [{ group: "Retail", count: 1, value: "₹4.8 Cr", shareOfValue: "100%" }],
      dataGaps: ["…"],
    });
    const text = formatToolResultForStub("portfolio_analytics", tool);
    expect(checkNumericFaithfulness(text, [tool]).unsupported).toEqual([]);
  });

  it("errors, empty results and unknown tools get short readable messages", () => {
    expect(formatToolResultForStub("search_properties", '{"error":"invalid_arguments"}')).toContain("didn't work (invalid_arguments)");
    expect(formatToolResultForStub("search_properties", '{"matchCount":0,"properties":[]}')).toContain("No properties in your portfolio match that.");
    expect(formatToolResultForStub("run_scenario", "{}")).toContain("The run_scenario step finished.");
    expect(formatToolResultForStub("x", "not json")).toContain("unexpected result");
  });
});

// Multi-turn stub conversations through the real chat service, graph, tools and in-memory store.
describe("dev stub: share, follow-ups, what-ifs and missing data", () => {
  const turn = (d: ReturnType<typeof deps>, userId: string, message: string, conversationId?: string) =>
    handleChatTurn(d, { userId, message, ...(conversationId ? { conversationId } : {}) });

  it("'how much of my portfolio is retail?' gives the slice, the whole, the share and the count", async () => {
    const d = deps();
    for (const q of ["How much of my portfolio is retail?", "What percentage of my total portfolio value is retail?"]) {
      const r = await turn(d, "U001", q);
      expect(r.reply).toContain("**Retail is 71.38% of your portfolio by value**: **₹21.2 Cr** out of a total **₹29.7 Cr**, across **2 of your 3 properties**.");
      expect(r.needsAttention).toBe(false); // every figure traces to tool output
    }
  });

  it("the share figures are derived from the signed-in user's own data, not hardcoded", async () => {
    for (const userId of ["U002", "U003", "U004"]) {
      const mine = propsOf(userId);
      const retail = summarizePortfolio(applyFilter(mine, { assetClasses: ["RETAIL"] }));
      const whole = summarizePortfolio(mine);
      const r = await turn(deps(), userId, "How much of my portfolio is retail?");
      if (retail.propertyCount === 0) {
        expect(r.reply).toContain(`You have no retail properties, so they are **0%** of your **${formatInr(whole.totalValueInr)}** portfolio.`);
      } else {
        expect(r.reply).toContain(`**Retail is ${pct(retail.totalValueInr, whole.totalValueInr)}% of your portfolio by value**`);
        expect(r.reply).toContain(`**${formatInr(retail.totalValueInr)}** out of a total **${formatInr(whole.totalValueInr)}**`);
      }
      expect(r.needsAttention).toBe(false);
    }
  });

  it("'which of those earns more annual rent?' ranks the previous result set", async () => {
    const d = deps();
    const first = await turn(d, "U001", "How much of my portfolio is retail?");
    const r = await turn(d, "U001", "Which of those retail properties earns more annual rent?", first.conversationId);
    expect(r.reply).toContain("**P001** earns more annual rent: **₹72 L a year**, vs ₹60 L a year for P003.");
    expect(r.reply).not.toContain("P002"); // the office property was not in the previous result set
    expect(r.needsAttention).toBe(false);
  });

  it("the follow-up comparison follows the data: change the rents and the answer changes", async () => {
    const d = deps();
    d.stores.state.properties.find((p) => p.id === "P003")!.annualRentInr = 8_000_000;
    const first = await turn(d, "U001", "Show my retail properties");
    const r = await turn(d, "U001", "Which of those earns more rent?", first.conversationId);
    expect(r.reply).toContain("**P003** earns more annual rent: **₹80 L a year**, vs ₹72 L a year for P001.");
  });

  it("'what if the rent of P001 increases by 10%?' is hypothetical and never written", async () => {
    const d = deps();
    const r = await turn(d, "U001", "What if the annual rent of P001 increases by 10%?");
    expect(r.hypothetical).toBe(true);
    expect(r.reply).toContain("**Hypothetical — nothing is saved; your real portfolio is unchanged.**");
    expect(r.reply).toContain("- P001 annual rent: ₹72 L → **₹79.2 L** a year (+₹7.2 L)");
    expect(r.reply).toContain("- Annual rent: ₹1.32 Cr → **₹1.39 Cr** (+₹7.2 L)");
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.properties.find((p) => p.id === "P001")!.annualRentInr).toBe(7_200_000);
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(r.needsAttention).toBe(false);

    const follow = await turn(d, "U001", "How would that change my portfolio?", r.conversationId);
    expect(follow.reply).toContain("₹72 L → **₹79.2 L**");
    const drop = await turn(d, "U001", "What if the rent of P003 drops by 10%?", r.conversationId);
    expect(drop.reply).toContain("- P003 annual rent: ₹60 L → **₹54 L** a year (-₹6 L)");
    const bandra = await turn(d, "U001", "What if I exclude the Bandra property?", r.conversationId);
    expect(bandra.reply).toContain("- Excluded P001");
  });

  it("a what-if on another user's property is refused without revealing anything about it", async () => {
    const d = deps();
    const r = await turn(d, "U001", "What if the rent of P004 increases by 10%?");
    expect(r.reply).toContain("I couldn't run that what-if: Property not found in this portfolio: P004.");
    expect(r.reply).not.toMatch(/₹/); // none of U002's figures
    expect(d.stores.state.properties.find((p) => p.id === "P004")!.annualRentInr).toBe(propsOf("U002").find((p) => p.id === "P004")!.annualRentInr);
  });

  it("appreciation / ROI: answers that it can't be calculated first, with the current value only as context", async () => {
    const r = await turn(deps(), "U001", "What is my portfolio's total appreciation since purchase?");
    const body = r.reply.replace(/^\[dev stub — template reply, no LLM\]\n\n/, "");
    expect(body.startsWith("**I can't calculate your portfolio's appreciation or ROI.**")).toBe(true);
    expect(r.reply).toContain("Purchase price missing for 3 of 3 properties (P001, P002, P003)");
    expect(r.reply).toContain("No acquisition or valuation dates");
    expect(r.reply).toContain("For context only (this is today's estimate, not a gain)");
    expect(r.reply).not.toMatch(/By type|Highest value/); // no overview in place of an answer
    expect(r.needsAttention).toBe(false);
  });
});

// Regressions found by `npm run eval:stub`: help text must carry no figures or property ids, and
// "rental yield" must rank by yield, not by rent.
describe("dev stub regressions (help text, rental-yield routing)", () => {
  const UNRECOGNISED = ["Tell me a joke", "What's the weather like?", "Can you help me?"];
  const SCENARIO_WITHOUT_TARGET = ["What if things change?", "Suppose the market moves", "What if the rent goes up?"];
  const allIds = loadSeed().properties.map((p) => p.id);

  it("help replies contain no numbers at all, so nothing can be an unsupported figure", async () => {
    for (const message of [...UNRECOGNISED, ...SCENARIO_WITHOUT_TARGET]) {
      const r = await handleChatTurn(deps(), { userId: "U002", message });
      expect(r.reply).toMatch(/^\[dev stub — no LLM configured\]/);
      expect(extractNumbers(r.reply)).toEqual([]);
      expect(r.needsAttention).toBe(false); // the production faithfulness check does not flag it
    }
  });

  it("help replies name no property ids — in particular none belonging to another user", async () => {
    for (const userId of ["U001", "U002", "U003", "U004"]) {
      const others = allIds.filter((id) => !propsOf(userId).some((p) => p.id === id));
      expect(others.length).toBeGreaterThan(0);
      for (const message of [...UNRECOGNISED, ...SCENARIO_WITHOUT_TARGET]) {
        const r = await handleChatTurn(deps(), { userId, message });
        expect(r.reply).not.toMatch(/\bP\d{3,}\b/);
        for (const id of others) expect(r.reply).not.toContain(id);
      }
    }
  });

  it("'best rental yield' ranks by yield (U004: P010 and P011 tie at 7.5%), not by rent", async () => {
    for (const message of ["Which property has the best rental yield?", "What is my highest rental yield?", "Which of my properties performs best?"]) {
      const r = await handleChatTurn(deps(), { userId: "U004", message });
      expect(r.reply).toContain("Ranked by yield");
      expect(r.reply).not.toContain("Ranked by rent");
      expect(r.reply).toContain("**P010** and **P011** tie for the highest gross yield: **7.5%** each.");
      expect(r.needsAttention).toBe(false);
    }
    // A plain rent question still ranks by rent.
    const rent = await handleChatTurn(deps(), { userId: "U004", message: "Which property earns the most rent?" });
    expect(rent.reply).toContain("Ranked by rent");
  });
});
