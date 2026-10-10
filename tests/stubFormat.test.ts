// Dev stub template replies: readable, built only from tool output (no LLM, no network).
import { describe, expect, it } from "vitest";
import { checkNumericFaithfulness, extractNumbers } from "@/agent/faithfulness";
import { createDevStubModel } from "@/agent/devStubModel";
import { fmtPp } from "@/agent/present";
import { formatToolResultForStub } from "@/agent/stubFormat";
import { handleChatTurn } from "@/server/services/chatService";
import { compareGroups, pct, rankProperties, summarizePortfolio } from "@/domain/analytics";
import { applyFilter } from "@/domain/filters";
import { formatInr } from "@/domain/money";
import { runScenario } from "@/domain/scenario";
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

// H1 regression: "value dropped to ₹10 Cr" was run as "Excluded P009" because "drop" was an exclusion
// verb. It is an absolute hypothetical revaluation; figures must come from the backend scenario.
describe("dev stub: absolute what-if values (H1)", () => {
  const H1 = "What if my Sector 29 property's value dropped to ₹10 Cr?";

  it("revalues P009 to ₹10 Cr instead of excluding it; every figure is the backend scenario's", async () => {
    const d = deps();
    const r = await handleChatTurn(d, { userId: "U003", message: H1 });
    // Independent expectation from the domain function the tool uses (no hardcoded totals).
    const expected = runScenario(propsOf("U003"), { valueOverrides: [{ propertyId: "P009", newValueInr: 100_000_000 }] });
    const before = propsOf("U003").find((p) => p.id === "P009")!.currentValueInr;

    expect(r.hypothetical).toBe(true);
    expect(r.reply).not.toContain("Excluded");
    expect(r.reply).toContain(`- P009 value: ${formatInr(before)} → **${formatInr(100_000_000)}** (-${formatInr(before - 100_000_000)})`);
    expect(r.reply).toContain(`Total value: ${formatInr(expected.baseline.totalValueInr)} → **${formatInr(expected.scenario.totalValueInr)}**`);
    expect(formatInr(expected.scenario.totalValueInr)).toBe("₹45.5 Cr"); // the golden set's expected figure
    expect(r.needsAttention).toBe(false); // production faithfulness check: every figure traces to tool output
  });

  it("creates no real proposal and writes nothing", async () => {
    const d = deps();
    const before = structuredClone(d.stores.state.properties);
    const r = await handleChatTurn(d, { userId: "U003", message: H1 });
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(d.stores.state.audits).toHaveLength(0);
    expect(d.stores.state.properties).toEqual(before);
  });

  it("an absolute rent what-if uses the new figure; another user's id is still not found", async () => {
    const rent = await handleChatTurn(deps(), { userId: "U001", message: "What if the rent of P001 dropped to ₹60 lakh?" });
    expect(rent.reply).toContain("- P001 annual rent: ₹72 L → **₹60 L** a year (-₹12 L)");
    const other = await handleChatTurn(deps(), { userId: "U001", message: "What if P004's value dropped to ₹1 Cr?" });
    expect(other.reply).toContain("I couldn't run that what-if: Property not found in this portfolio: P004.");
    expect(other.reply).not.toContain("₹6.4 Cr"); // U002's figure is never shown
  });

  it("'drop' alone never excludes a property; explicit exclusion still works", async () => {
    for (const message of ["What if the Sector 29 property drops?", "What if I drop P009?"]) {
      const d = deps();
      const r = await handleChatTurn(d, { userId: "U003", message });
      expect(r.reply).not.toContain("Excluded");
      expect(r.hypothetical).toBe(false);
      expect(d.stores.state.pendingActions).toHaveLength(0);
    }
    const exclude = await handleChatTurn(deps(), { userId: "U003", message: "What if I exclude the Sector 29 property?" });
    expect(exclude.reply).toContain("- Excluded P009");
  });
});

// Read-only filters / sorting (R002, C4, C5, M3), totals and comparisons (C3, M2, A6, M1 turn 4) and
// hypothetical purchases / described properties (H2, H3). Expected figures come from the same domain
// functions the tools use, never from hardcoded answers.
describe("dev stub: filters, totals, comparisons and more what-ifs", () => {
  const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

  it("R002: 'above ₹10 crore' filters on current value (strict) and lists only the matches", async () => {
    const mine = propsOf("U001");
    const above = applyFilter(mine, { valueAboveInr: 100_000_000 });
    const r = await handleChatTurn(deps(), { userId: "U001", message: "Which of my properties are above ₹10 crore?" });
    for (const p of above) expect(r.reply).toContain(`**${p.id}**`);
    for (const id of ids(mine).filter((id) => !ids(above).includes(id))) expect(r.reply).not.toContain(id);
    expect(r.reply).toContain(formatInr(above[0]!.currentValueInr));
    const below = applyFilter(mine, { valueBelowInr: 100_000_000 });
    const r2 = await handleChatTurn(deps(), { userId: "U001", message: "Which of my properties are under ₹10 crore?" });
    expect(r2.reply).toContain(`Found **${below.length} properties**`);
    expect(r.needsAttention || r2.needsAttention).toBe(false);
  });

  it("C4: 'lowest rent' ranks ascending and leaves zero-rent properties out of the ranking", async () => {
    const ranking = rankProperties(propsOf("U001"), "rent", "asc", 1);
    const top = ranking.entries[0]!.property;
    const r = await handleChatTurn(deps(), { userId: "U001", message: "Which property has the lowest rent?" });
    expect(r.reply).toContain(`**${top.id}** has the lowest annual rent: **${formatInr(top.annualRentInr)} a year**.`);
    for (const e of ranking.excluded) expect(r.reply).toContain(`${e.propertyId} — ${e.reason}`);
    expect(r.needsAttention).toBe(false);
  });

  it("C5 / M3: occupancy filters, directly and on the previous result set", async () => {
    const offices = applyFilter(propsOf("U003"), { assetClasses: ["OFFICE"] });
    const vacant = applyFilter(offices, { occupancy: ["VACANT"] });
    const others = ids(offices).filter((id) => !ids(vacant).includes(id));
    expect(vacant.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);

    const direct = await handleChatTurn(deps(), { userId: "U003", message: "Which of my offices are vacant?" });
    for (const id of ids(vacant)) expect(direct.reply).toContain(id);
    for (const id of others) expect(direct.reply).not.toContain(id);

    const d = deps();
    const first = await handleChatTurn(d, { userId: "U003", message: "Tell me about my offices" });
    const follow = await handleChatTurn(d, { userId: "U003", conversationId: first.conversationId, message: "Which one is vacant?" });
    for (const id of ids(vacant)) expect(follow.reply).toContain(id);
    for (const id of others) expect(follow.reply).not.toContain(id);
  });

  it("statements such as 'It's vacant' are not turned into occupancy searches", async () => {
    const statement = await handleChatTurn(deps(), { userId: "U001", message: "It's vacant" });
    expect(statement.reply).toMatch(/^\[dev stub — no LLM configured\]/); // unrecognised, as before
    const status = await handleChatTurn(deps(), { userId: "U001", message: "My Andheri office is now tenanted" });
    expect(status.reply).not.toContain("No properties in your portfolio match that."); // not filtered to tenanted offices
    expect(status.reply).toContain("What is the annual rent for **P002** now?"); // a status change (W5), not a search
  });

  it("C3: income and overall yield come from the portfolio totals, not a ranking", async () => {
    const s = summarizePortfolio(propsOf("U002"));
    const r = await handleChatTurn(deps(), { userId: "U002", message: "What is my annual rental income and overall yield?" });
    expect(r.reply).toContain(`earning **${formatInr(s.totalAnnualRentInr)}** a year in rent`);
    expect(r.reply).toContain(`Gross yield ${s.portfolioGrossYieldPct}%`);
    expect(r.reply).not.toContain("Ranked by");
  });

  it("M2: 'their combined value' totals exactly the previous result set", async () => {
    const mine = propsOf("U002");
    const mumbai = applyFilter(mine, { city: "Mumbai" });
    const d = deps();
    const first = await handleChatTurn(d, { userId: "U002", message: "Show me my properties in Mumbai" });
    const r = await handleChatTurn(d, { userId: "U002", conversationId: first.conversationId, message: "What's their combined value?" });
    const names = ids(mumbai).length > 1 ? `${ids(mumbai).slice(0, -1).join(", ")} and ${ids(mumbai).at(-1)}` : ids(mumbai)[0];
    const part = summarizePortfolio(mumbai).totalValueInr;
    const whole = summarizePortfolio(mine).totalValueInr;
    expect(r.reply).toContain(`Combined value of **${names}**: **${formatInr(part)}**, which is ${pct(part, whole)}% of your **${formatInr(whole)}** portfolio.`);
    expect(r.needsAttention).toBe(false);
  });

  it("A6: 'compare residential and commercial' uses compare_groups and states both shares", async () => {
    const mine = propsOf("U004");
    const c = compareGroups(
      mine,
      { label: "Residential", properties: applyFilter(mine, { sector: "RESIDENTIAL" }) },
      { label: "Commercial", properties: applyFilter(mine, { sector: "COMMERCIAL" }) },
    );
    const r = await handleChatTurn(deps(), { userId: "U004", message: "Compare my residential and commercial exposure." });
    expect(r.reply).toContain("**Residential vs Commercial (retail + office)**");
    expect(r.reply).toContain(`(${c.a.shareOfPortfolioPct}% of your portfolio)`);
    expect(r.reply).toContain(`(${c.b.shareOfPortfolioPct}% of your portfolio)`);
    expect(r.needsAttention).toBe(false);
    // Only one group named: no comparison is invented.
    const one = await handleChatTurn(deps(), { userId: "U004", message: "Compare my residential properties." });
    expect(one.reply).not.toContain(" vs ");
  });

  it("M1 turn 4: a what-if shows the mix change by type from the backend scenario", async () => {
    const d = deps();
    let conversationId: string | undefined;
    for (const message of ["Tell me about my retail properties.", "Which one is performing better?", "What if I exclude the Bandra property?"]) {
      conversationId = (await handleChatTurn(d, { userId: "U001", message, ...(conversationId ? { conversationId } : {}) })).conversationId;
    }
    const r = await handleChatTurn(d, { userId: "U001", conversationId, message: "How would that change my portfolio?" });
    const s = runScenario(propsOf("U001"), { excludePropertyIds: ["P001"] });
    const share = (sum: typeof s.baseline) => sum.byAssetClass.find((b) => b.key === "RETAIL")!.valueSharePct;
    expect(r.reply).toContain(`- Retail: ${share(s.baseline)}% → **${share(s.scenario)}%** (${fmtPp(s.deltas.assetClassSharePctPoints.RETAIL!)})`);
    expect(r.hypothetical).toBe(true);
  });

  it("H2: a hypothetical purchase is added to a scenario only; the city comes from the user's own index", async () => {
    const d = deps();
    const before = structuredClone(d.stores.state.properties);
    const r = await handleChatTurn(d, { userId: "U004", message: "What if I bought a ₹5 Cr office in Whitefield?" });
    const s = runScenario(propsOf("U004"), {
      additions: [{ assetClass: "OFFICE", city: "Bengaluru", locality: "Whitefield", currentValueInr: 50_000_000 }],
    });
    expect(r.hypothetical).toBe(true);
    expect(r.reply).toContain("- Added HYPOTHETICAL-1 (OFFICE, Bengaluru, value ₹5 Cr)");
    expect(r.reply).toContain(`Total value: ${formatInr(s.baseline.totalValueInr)} → **${formatInr(s.scenario.totalValueInr)}**`);
    expect(r.pendingAction).toBeNull();
    expect(d.stores.state.pendingActions).toHaveLength(0);
    expect(d.stores.state.properties).toEqual(before);
    expect(r.needsAttention).toBe(false);
  });

  it("H2: an unknown place or missing price gets a question with no figures, and nothing runs", async () => {
    for (const message of ["What if I bought a ₹5 Cr office in Atlantis?", "What if I bought an office in Whitefield?"]) {
      const r = await handleChatTurn(deps(), { userId: "U004", message });
      expect(r.hypothetical).toBe(false);
      expect(extractNumbers(r.reply)).toEqual([]);
    }
  });

  it("H3: 'my vacant office' resolves to the single matching property; ambiguity is never guessed", async () => {
    const d = deps();
    const r = await handleChatTurn(d, { userId: "U001", message: "What if I sold my vacant office?" });
    const target = applyFilter(propsOf("U001"), { assetClasses: ["OFFICE"], occupancy: ["VACANT"] });
    expect(target).toHaveLength(1);
    const s = runScenario(propsOf("U001"), { excludePropertyIds: [target[0]!.id] });
    expect(r.reply).toContain(`- Excluded ${target[0]!.id}`);
    expect(r.reply).toContain(`Total value: ${formatInr(s.baseline.totalValueInr)} → **${formatInr(s.scenario.totalValueInr)}**`);
    expect(d.stores.state.pendingActions).toHaveLength(0);

    // U003 has two offices: "my office" is ambiguous → no scenario, no guess.
    expect(applyFilter(propsOf("U003"), { assetClasses: ["OFFICE"] }).length).toBeGreaterThan(1);
    const ambiguous = await handleChatTurn(deps(), { userId: "U003", message: "What if I sold my office?" });
    expect(ambiguous.hypothetical).toBe(false);
    expect(ambiguous.reply).not.toContain("Excluded");

    // U002 has no office: nothing from another user's portfolio is used.
    const none = await handleChatTurn(deps(), { userId: "U002", message: "What if I sold my vacant office?" });
    expect(none.hypothetical).toBe(false);
    expect(none.reply).not.toMatch(/\bP\d{3,}\b/);
  });
});
