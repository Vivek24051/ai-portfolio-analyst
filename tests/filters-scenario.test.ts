import { describe, expect, it } from "vitest";
import { applyFilter, propertyFilterSchema } from "@/domain/filters";
import { runScenario, ScenarioError } from "@/domain/scenario";
import { loadSeed, propsOf } from "./helpers";

const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

describe("filters — sample requests", () => {
  it("R001 U001 retail → P001, P003", () => {
    expect(ids(applyFilter(propsOf("U001"), { assetClasses: ["RETAIL"] }))).toEqual(["P001", "P003"]);
  });

  it("R002 U001 above ₹10 Cr (strict) → P001 only", () => {
    expect(ids(applyFilter(propsOf("U001"), { valueAboveInr: 100_000_000 }))).toEqual(["P001"]);
    // strictness: exactly ₹12 Cr is not "above ₹12 Cr"
    expect(ids(applyFilter(propsOf("U001"), { valueAboveInr: 120_000_000 }))).toEqual([]);
  });

  it("R003 U002 in Mumbai → P004, P005 (not Alibaug)", () => {
    expect(ids(applyFilter(propsOf("U002"), { city: "Mumbai" }))).toEqual(["P004", "P005"]);
  });

  it("U003 in Delhi NCR → all three", () => {
    expect(ids(applyFilter(propsOf("U003"), { city: "Delhi NCR" }))).toEqual(["P007", "P008", "P009"]);
  });

  it("Bandra locality is user-scoped: U001 → P001, U002 → P004", () => {
    expect(ids(applyFilter(propsOf("U001"), { locality: "Bandra" }))).toEqual(["P001"]);
    expect(ids(applyFilter(propsOf("U002"), { locality: "Bandra" }))).toEqual(["P004"]);
  });

  it("combines sector, occupancy and value", () => {
    expect(ids(applyFilter(loadSeed().properties, { sector: "COMMERCIAL", occupancy: ["VACANT"] }))).toEqual(["P002", "P008"]);
  });

  it("schema rejects unknown keys (no free-form fields from the model)", () => {
    expect(propertyFilterSchema.safeParse({ userId: "U002" }).success).toBe(false);
    expect(propertyFilterSchema.safeParse({ assetClasses: ["Commercial"] }).success).toBe(false);
  });
});

describe("runScenario", () => {
  it("excluding the Bandra property (P001) from U001's portfolio", () => {
    const r = runScenario(propsOf("U001"), { excludePropertyIds: ["P001"] });
    expect(r.hypothetical).toBe(true);
    expect(r.baseline.totalValueInr).toBe(297_000_000);
    expect(r.scenario.totalValueInr).toBe(177_000_000);
    expect(r.deltas.totalValueInr).toBe(-120_000_000);
    expect(r.scenario.totalAnnualRentInr).toBe(6_000_000);
    expect(r.scenario.byAssetClass.find((b) => b.key === "RETAIL")?.valueSharePct).toBe(51.98);
    expect(r.deltas.assetClassSharePctPoints.RETAIL).toBe(-19.4); // 71.38 → 51.98
    expect(r.scenario.portfolioGrossYieldPct).toBe(3.39);
    expect(r.deltas.portfolioGrossYieldPctPoints).toBe(-1.05); // 4.44 → 3.39
  });

  it("never mutates the real records", () => {
    const real = propsOf("U001");
    const before = structuredClone(real);
    runScenario(real, {
      excludePropertyIds: ["P002"],
      valueOverrides: [{ propertyId: "P001", newValueInr: 140_000_000 }],
      rentOverrides: [{ propertyId: "P003", newAnnualRentInr: 7_000_000 }],
    });
    expect(real).toEqual(before);
  });

  it("supports value overrides and hypothetical additions", () => {
    const r = runScenario(propsOf("U004"), {
      additions: [{ assetClass: "RETAIL", city: "Bengaluru", locality: "Indiranagar", currentValueInr: 42_000_000 }],
    });
    expect(r.scenario.totalValueInr).toBe(180_000_000);
    expect(r.scenario.propertyCount).toBe(4);
    expect(r.description[0]).toMatch(/HYPOTHETICAL-1/);
  });

  it("rejects ids outside the user's portfolio (including other users' ids)", () => {
    expect(() => runScenario(propsOf("U001"), { excludePropertyIds: ["P004"] })).toThrow(ScenarioError);
    expect(() => runScenario(propsOf("U001"), { excludePropertyIds: ["P999"] })).toThrow(/not found/);
  });

  it("rejects contradictory or empty scenarios", () => {
    expect(() =>
      runScenario(propsOf("U001"), {
        excludePropertyIds: ["P001"],
        valueOverrides: [{ propertyId: "P001", newValueInr: 1 }],
      }),
    ).toThrow(/both exclude and modify/);
    expect(() => runScenario(propsOf("U001"), {})).toThrow(/no changes/);
  });

  it("excluding everything yields an empty scenario without crashing", () => {
    const r = runScenario(propsOf("U001"), { excludePropertyIds: ["P001", "P002", "P003"] });
    expect(r.scenario.totalValueInr).toBe(0);
    expect(r.scenario.portfolioGrossYieldPct).toBeNull();
    expect(r.deltas.portfolioGrossYieldPctPoints).toBeNull();
  });
});
