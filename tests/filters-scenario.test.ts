import { describe, expect, it } from "vitest";
import { applyFilter, propertyFilterSchema } from "@/domain/filters";
import { applyPercentChange, runScenario, ScenarioError } from "@/domain/scenario";
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

describe("applyPercentChange", () => {
  it("applies a percentage to whole rupees exactly, in both directions", () => {
    expect(applyPercentChange(7_200_000, 10)).toBe(7_920_000); // ₹72 L + 10% = ₹79.2 L
    expect(applyPercentChange(6_000_000, -10)).toBe(5_400_000);
    expect(applyPercentChange(9_999, 12.5)).toBe(11_249); // rounded to the nearest rupee
    expect(applyPercentChange(5_000_000, -100)).toBe(0);
  });

  it("rejects changes below -100% and non-numbers", () => {
    expect(() => applyPercentChange(1_000, -101)).toThrow(ScenarioError);
    expect(() => applyPercentChange(1_000, Number.NaN)).toThrow(ScenarioError);
  });
});

describe("runScenario", () => {
  it("reports each property's before / after / delta for value and rent overrides", () => {
    const r = runScenario(propsOf("U001"), {
      valueOverrides: [{ propertyId: "P002", newValueInr: 80_000_000 }],
      rentOverrides: [{ propertyId: "P001", newAnnualRentInr: 7_920_000 }],
    });
    expect(r.propertyChanges).toEqual([
      { propertyId: "P002", field: "value", beforeInr: 85_000_000, afterInr: 80_000_000, deltaInr: -5_000_000 },
      { propertyId: "P001", field: "annualRent", beforeInr: 7_200_000, afterInr: 7_920_000, deltaInr: 720_000 },
    ]);
    expect(r.deltas.totalAnnualRentInr).toBe(720_000);
  });

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
