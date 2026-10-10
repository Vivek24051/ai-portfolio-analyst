// Tool schemas and execution against in-memory stores (MOCKED persistence; no model involved).
import { describe, expect, it } from "vitest";
import { parseConversationState } from "@/agent/conversationState";
import { executeToolCall, MALFORMED_ARGS_KEY, newTurnEvents, TOOL_SPECS, type ToolContext } from "@/agent/tools";
import { freshStores } from "./agentHelpers";
import type { MemoryStores } from "@/server/stores/memory";

function ctxFor(userId: string, stores: MemoryStores = freshStores(), over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId,
    conversationId: "C-test",
    runId: "run-1",
    now: new Date("2026-10-10T10:00:00Z"),
    stores,
    latestUserMessage: "",
    state: parseConversationState({}),
    events: newTurnEvents(),
    ...over,
  };
}

const run = async (ctx: ToolContext, name: string, args: unknown) => {
  const o = await executeToolCall(ctx, { id: "t1", name, args });
  return { ...o, json: JSON.parse(o.content) as Record<string, any> };
};

describe("tool specs (what the model sees)", () => {
  it("every tool is a strict object schema with no user-identity parameter", () => {
    expect(TOOL_SPECS.map((t) => t.function.name)).toEqual([
      "search_properties", "portfolio_analytics", "compare_groups", "run_scenario", "propose_new_property",
      "propose_property_update", "confirm_pending_action", "cancel_pending_action", "flag_for_human",
    ]);
    for (const spec of TOOL_SPECS) {
      expect(spec.function.parameters.type).toBe("object");
      expect(spec.function.parameters.additionalProperties).toBe(false);
      expect(JSON.stringify(spec.function.parameters)).not.toMatch(/"userId"|"user_id"|"ownerId"/);
    }
  });
});

describe("read tools", () => {
  it("R001: U001 retail → P001, P003 with pre-formatted figures; sets focus", async () => {
    const ctx = ctxFor("U001");
    const r = await run(ctx, "search_properties", { filter: { assetClasses: ["RETAIL"] } });
    expect(r.ok).toBe(true);
    expect(r.json.properties.map((p: any) => [p.id, p.value, p.grossYield])).toEqual([
      ["P001", "₹12 Cr", "6%"],
      ["P003", "₹9.2 Cr", "6.52%"],
    ]);
    expect(ctx.state.focusPropertyIds).toEqual(["P001", "P003"]);
  });

  it("R002: money threshold is given in crore and converted by the backend", async () => {
    const r = await run(ctxFor("U001"), "search_properties", { filter: { valueAbove: { amount: 10, unit: "CRORE" } } });
    expect(r.json.properties.map((p: any) => p.id)).toEqual(["P001"]);
  });

  it("R004: highest rent for U003 → P007, vacant P008 listed as excluded", async () => {
    const r = await run(ctxFor("U003"), "search_properties", { sortBy: "rent", limit: 1 });
    expect(r.json.properties.map((p: any) => [p.rank, p.id, p.annualRent])).toEqual([[1, "P007", "₹1.68 Cr"]]);
    expect(r.json.excludedFromRanking).toEqual([{ propertyId: "P008", reason: "no rental income (Vacant)" }]);
  });

  it("U004 yield tie is reported", async () => {
    const r = await run(ctxFor("U004"), "search_properties", { sortBy: "yield", limit: 1 });
    expect(r.json.topIsTied).toBe(true);
    expect(r.json.properties.map((p: any) => p.id)).toEqual(["P010", "P011"]);
  });

  it("portfolio_analytics: U001 totals, mix and data gaps", async () => {
    const r = await run(ctxFor("U001"), "portfolio_analytics", {});
    expect(r.json.totals).toMatchObject({ properties: 3, totalValue: "₹29.7 Cr", annualRent: "₹1.32 Cr", grossYieldAllProperties: "4.44%" });
    expect(r.json.byAssetClass.map((b: any) => [b.group, b.shareOfValue])).toEqual([["Retail", "71.38%"], ["Office", "28.62%"]]);
    expect(r.json.dataGaps[0]).toMatch(/No acquisition or valuation dates/);
  });

  it("portfolio_analytics with a filter reports the subset's share of the whole", async () => {
    const r = await run(ctxFor("U002"), "portfolio_analytics", { filter: { city: "Mumbai" }, sections: ["totals"] });
    expect(r.json).toMatchObject({ scope: "filtered: 2 of 3 properties", shareOfWholePortfolioValue: "59.59%" });
  });

  it("compare_groups: U004 residential vs commercial", async () => {
    const r = await run(ctxFor("U004"), "compare_groups", {
      groupA: { label: "Residential", filter: { sector: "RESIDENTIAL" } },
      groupB: { label: "Commercial", filter: { sector: "COMMERCIAL" } },
    });
    expect(r.json.groupA).toMatchObject({ value: "₹3.4 Cr", shareOfPortfolio: "24.64%" });
    expect(r.json.groupB).toMatchObject({ value: "₹10.4 Cr", shareOfPortfolio: "75.36%", grossYield: "7.5%" });
    expect(r.json.difference.value).toBe("-₹7 Cr");
  });
});

describe("scenario tool", () => {
  it("exclude Bandra (P001): hypothetical result, real data untouched, state remembers scenario", async () => {
    const stores = freshStores();
    const ctx = ctxFor("U001", stores);
    const r = await run(ctx, "run_scenario", { excludePropertyIds: ["P001"] });
    expect(r.json.hypothetical).toBe(true);
    expect(r.json.scenario.totals.totalValue).toBe("₹17.7 Cr");
    expect(r.json.deltas.totalValue).toBe("-₹12 Cr");
    expect(r.json.deltas.assetClassShare.RETAIL).toBe("-19.4 pp");
    expect(ctx.events.hypothetical).toBe(true);
    expect(ctx.state.activeScenario?.excludePropertyIds).toEqual(["P001"]);
    expect(stores.state.properties.filter((p) => p.userId === "U001")).toHaveLength(3);
    expect(stores.state.properties.find((p) => p.id === "P001")!.currentValueInr).toBe(120_000_000);
  });

  it("basedOn active_scenario re-runs and extends the previous scenario", async () => {
    const ctx = ctxFor("U001");
    await run(ctx, "run_scenario", { excludePropertyIds: ["P001"] });
    const again = await run(ctx, "run_scenario", { basedOn: "active_scenario" });
    expect(again.json.scenario.totals.totalValue).toBe("₹17.7 Cr");
    const extended = await run(ctx, "run_scenario", {
      basedOn: "active_scenario",
      valueChanges: [{ propertyId: "P003", newValue: { amount: 10, unit: "CRORE" } }],
    });
    expect(extended.json.scenario.totals.totalValue).toBe("₹18.5 Cr");
  });

  it("basedOn active_scenario without one is a clear error", async () => {
    const r = await run(ctxFor("U001"), "run_scenario", { basedOn: "active_scenario" });
    expect(r.ok).toBe(false);
    expect(r.json.error).toBe("no_active_scenario");
  });
});

describe("user isolation", () => {
  it("another user's property id is simply not found — everywhere", async () => {
    const stores = freshStores();
    const ctx = ctxFor("U001", stores);
    const search = await run(ctx, "search_properties", { filter: { propertyIds: ["P004"] } });
    expect(search.json.matchCount).toBe(0);
    const scenario = await run(ctx, "run_scenario", { excludePropertyIds: ["P004"] });
    expect(scenario.json).toMatchObject({ error: "invalid_scenario" });
    const update = await run(ctx, "propose_property_update", { propertyId: "P004", changes: { value: { amount: 1, unit: "CRORE" } } });
    expect(update.json.status).toBe("not_found");
    expect(stores.state.pendingActions).toHaveLength(0);
  });

  it("a userId smuggled into arguments is rejected, not honoured", async () => {
    const r = await run(ctxFor("U001"), "search_properties", { userId: "U002" });
    expect(r.ok).toBe(false);
    expect(r.json.error).toBe("invalid_arguments");
    const nested = await run(ctxFor("U001"), "search_properties", { filter: { userId: "U002" } });
    expect(nested.json.error).toBe("invalid_arguments");
  });
});

describe("invalid arguments and failures", () => {
  it("bad enum value → invalid_arguments with the path", async () => {
    const r = await run(ctxFor("U001"), "search_properties", { filter: { assetClasses: ["Commercial"] } });
    expect(r).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(r.json.issues[0]).toMatch(/^filter\.assetClasses\.0/);
  });

  it("raw INR numbers where Money is required are rejected", async () => {
    const r = await run(ctxFor("U001"), "propose_property_update", { propertyId: "P001", changes: { value: 125000000 } });
    expect(r.json.error).toBe("invalid_arguments");
  });

  it("unknown tool and malformed JSON arguments", async () => {
    expect((await run(ctxFor("U001"), "drop_tables", {})).json.error).toBe("unknown_tool");
    expect((await run(ctxFor("U001"), "search_properties", { [MALFORMED_ARGS_KEY]: true })).json.error).toBe("malformed_arguments");
  });

  it("absurd amounts are rejected by money validation", async () => {
    const r = await run(ctxFor("U001"), "propose_property_update", {
      propertyId: "P001",
      changes: { value: { amount: 500_000, unit: "CRORE" } },
    });
    expect(r.json.status ?? r.json.error).toMatch(/invalid/);
  });

  it("store failures become internal_error without leaking details", async () => {
    const stores = freshStores();
    stores.properties.listByUser = async () => {
      throw new Error("connection refused at 10.0.0.5");
    };
    const r = await run(ctxFor("U001", stores), "portfolio_analytics", {});
    expect(r.json).toEqual({ error: "internal_error", message: "The tool failed unexpectedly. Do not guess the answer." });
  });
});

describe("write tools", () => {
  it("propose then confirm in the SAME turn is refused; next turn with 'yes' applies", async () => {
    const stores = freshStores();
    const ctx1 = ctxFor("U001", stores, { latestUserMessage: "Change my Bandra retail property value to ₹12.5 crore" });
    const p = await run(ctx1, "propose_property_update", { propertyId: "P001", changes: { value: { amount: 12.5, unit: "CRORE" } } });
    expect(p.json).toMatchObject({ status: "proposed", diff: [{ before: "₹12 Cr", after: "₹12.5 Cr" }] });
    expect(ctx1.state.pendingActionId).toBe(p.json.pendingActionId);

    const same = await run(ctx1, "confirm_pending_action", { pendingActionId: p.json.pendingActionId });
    expect(same.json.status).toBe("same_turn");
    expect(stores.state.properties.find((x) => x.id === "P001")!.currentValueInr).toBe(120_000_000);

    const ctx2 = ctxFor("U001", stores, { runId: "run-2", latestUserMessage: "yes", state: ctx1.state });
    const ok = await run(ctx2, "confirm_pending_action", { pendingActionId: p.json.pendingActionId });
    expect(ok.json).toMatchObject({ status: "confirmed", property: { id: "P001", value: "₹12.5 Cr" } });
    expect(ctx2.state.pendingActionId).toBeNull();
  });

  it("R005 incomplete add → needs_info, nothing staged", async () => {
    const stores = freshStores();
    const r = await run(ctxFor("U004", stores), "propose_new_property", {
      assetClass: "RETAIL", locality: "Indiranagar", areaSqft: 3000, value: { amount: 4.2, unit: "CRORE" },
    });
    expect(r.json).toEqual({ status: "needs_info", missing: ["city", "occupancyStatus"], errors: [] });
    expect(stores.state.pendingActions).toHaveLength(0);
  });

  it("flag_for_human records a handoff event", async () => {
    const ctx = ctxFor("U001");
    await run(ctx, "flag_for_human", { reason: "advice_out_of_scope", note: "Asked whether to sell P002 for tax reasons" });
    expect(ctx.events.handoff).toEqual({ reason: "advice_out_of_scope", note: "Asked whether to sell P002 for tax reasons" });
  });
});
