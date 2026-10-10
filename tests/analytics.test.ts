// Expected figures were computed by hand from properties.csv (see DECISIONS.md / dataset notes).
import { describe, expect, it } from "vitest";
import { compareGroups, rankProperties, summarizePortfolio, grossYieldPct } from "@/domain/analytics";
import { applyFilter } from "@/domain/filters";
import type { Property } from "@/domain/types";
import { loadSeed, propsOf } from "./helpers";

const bucket = (s: ReturnType<typeof summarizePortfolio>, dim: "byAssetClass" | "bySector" | "byCity", key: string) =>
  s[dim].find((b) => b.key === key);

describe("summarizePortfolio — per user", () => {
  it("U001: ₹29.7 Cr, retail 71.38%, office 28.62%, rent ₹1.32 Cr", () => {
    const s = summarizePortfolio(propsOf("U001"));
    expect(s.totalValueInr).toBe(297_000_000);
    expect(s.totalAnnualRentInr).toBe(13_200_000);
    expect(bucket(s, "byAssetClass", "RETAIL")).toMatchObject({ count: 2, valueInr: 212_000_000, valueSharePct: 71.38 });
    expect(bucket(s, "byAssetClass", "OFFICE")).toMatchObject({ count: 1, valueInr: 85_000_000, valueSharePct: 28.62 });
    expect(bucket(s, "byAssetClass", "RESIDENTIAL")).toMatchObject({ count: 0, valueInr: 0, valueSharePct: 0 });
    expect(bucket(s, "bySector", "COMMERCIAL")?.valueSharePct).toBe(100);
    expect(s.portfolioGrossYieldPct).toBe(4.44); // 1.32 / 29.7
    expect(s.incomeProducingYieldPct).toBe(6.23); // 1.32 / 21.2
    expect(s.highestRent.map((e) => e.propertyId)).toEqual(["P001"]);
  });

  it("U002: Mumbai is 59.59% because Alibaug is not Mumbai", () => {
    const s = summarizePortfolio(propsOf("U002"));
    expect(s.totalValueInr).toBe(193_000_000);
    expect(s.totalAnnualRentInr).toBe(2_400_000);
    expect(bucket(s, "byCity", "Mumbai")).toMatchObject({ count: 2, valueInr: 115_000_000, valueSharePct: 59.59 });
    expect(bucket(s, "byCity", "Alibaug")).toMatchObject({ count: 1, valueInr: 78_000_000 });
    expect(bucket(s, "bySector", "RESIDENTIAL")?.valueSharePct).toBe(100);
    const occ = Object.fromEntries(s.byOccupancy.map((b) => [b.key, b.count]));
    expect(occ).toEqual({ TENANTED: 1, VACANT: 1, SELF_OCCUPIED: 1 });
  });

  it("U003: ₹48.7 Cr, office 72.9%, highest rent P007, highest value P007", () => {
    const s = summarizePortfolio(propsOf("U003"));
    expect(s.totalValueInr).toBe(487_000_000);
    expect(s.totalAnnualRentInr).toBe(26_400_000);
    expect(bucket(s, "byAssetClass", "OFFICE")?.valueSharePct).toBe(72.9);
    expect(bucket(s, "byAssetClass", "RETAIL")?.valueSharePct).toBe(27.1);
    expect(s.highestRent.map((e) => e.propertyId)).toEqual(["P007"]); // R004
    expect(s.highestValue.map((e) => e.propertyId)).toEqual(["P007"]);
    expect(s.lowestValue.map((e) => e.propertyId)).toEqual(["P008"]);
  });

  it("U004: 'Office' (P011) is grouped with office; three-way split", () => {
    const s = summarizePortfolio(propsOf("U004"));
    expect(s.totalValueInr).toBe(138_000_000);
    expect(bucket(s, "byAssetClass", "OFFICE")).toMatchObject({ valueInr: 56_000_000, valueSharePct: 40.58 });
    expect(bucket(s, "byAssetClass", "RETAIL")?.valueSharePct).toBe(34.78);
    expect(bucket(s, "byAssetClass", "RESIDENTIAL")?.valueSharePct).toBe(24.64);
    expect(bucket(s, "bySector", "COMMERCIAL")?.valueSharePct).toBe(75.36);
  });

  it("all users combined: ₹111.5 Cr value, ₹4.98 Cr rent", () => {
    const s = summarizePortfolio(loadSeed().properties);
    expect(s.totalValueInr).toBe(1_115_000_000);
    expect(s.totalAnnualRentInr).toBe(49_800_000);
    expect(s.highestValue[0]?.propertyId).toBe("P007");
    expect(s.lowestValue[0]?.propertyId).toBe("P012");
  });

  it("reports data gaps instead of inventing appreciation", () => {
    const s = summarizePortfolio(propsOf("U001"));
    expect(s.dataGaps.join(" ")).toMatch(/No acquisition or valuation dates/);
    expect(s.dataGaps.join(" ")).toMatch(/Purchase price missing for 3 of 3/);
  });

  it("weights by ownership % and excludes inactive properties", () => {
    const [a, b] = propsOf("U001") as [Property, Property];
    const s = summarizePortfolio([{ ...a, ownershipPercent: 50 }, { ...b, status: "INACTIVE" }]);
    expect(s.propertyCount).toBe(1);
    expect(s.inactiveExcludedCount).toBe(1);
    expect(s.totalValueInr).toBe(60_000_000); // 50% of ₹12 Cr
    expect(s.totalAnnualRentInr).toBe(3_600_000);
  });

  it("handles an empty portfolio without dividing by zero", () => {
    const s = summarizePortfolio([]);
    expect(s.totalValueInr).toBe(0);
    expect(s.portfolioGrossYieldPct).toBeNull();
    expect(s.incomeProducingYieldPct).toBeNull();
    expect(s.highestValue).toEqual([]);
  });
});

describe("rankProperties", () => {
  it("U001 retail: P003 wins on yield (6.52% vs 6.00%), P001 wins on rent", () => {
    const retail = applyFilter(propsOf("U001"), { assetClasses: ["RETAIL"] });
    const byYield = rankProperties(retail, "yield");
    expect(byYield.entries.map((e) => [e.propertyId, e.metricValue])).toEqual([["P003", 6.52], ["P001", 6]]);
    expect(rankProperties(retail, "rent").entries[0]?.propertyId).toBe("P001");
  });

  it("U003: P007 has the most rent but P009 the best yield", () => {
    expect(rankProperties(propsOf("U003"), "rent").entries[0]?.propertyId).toBe("P007");
    const y = rankProperties(propsOf("U003"), "yield");
    expect(y.entries.map((e) => [e.propertyId, e.metricValue])).toEqual([["P009", 7.27], ["P007", 7]]);
    expect(y.excluded).toEqual([{ propertyId: "P008", reason: "no rental income (Vacant)" }]);
  });

  it("U004: P010 and P011 tie at exactly 7.5% yield and share rank 1", () => {
    const y = rankProperties(propsOf("U004"), "yield");
    expect(y.topIsTied).toBe(true);
    expect(y.entries.map((e) => [e.propertyId, e.rank, e.metricValue])).toEqual([["P010", 1, 7.5], ["P011", 1, 7.5]]);
    // limit never splits a tie
    expect(rankProperties(propsOf("U004"), "yield", "desc", 1).entries).toHaveLength(2);
  });

  it("lowest rent ignores zero-rent properties and lists them as excluded", () => {
    const r = rankProperties(propsOf("U002"), "rent", "asc");
    expect(r.entries.map((e) => e.propertyId)).toEqual(["P005"]);
    expect(r.excluded.map((e) => e.propertyId).sort()).toEqual(["P004", "P006"]);
  });

  it("property-level yield is null without rent", () => {
    const p008 = propsOf("U003").find((p) => p.id === "P008")!;
    expect(grossYieldPct(p008)).toBeNull();
  });
});

describe("compareGroups", () => {
  it("U004 residential vs commercial", () => {
    const ps = propsOf("U004");
    const c = compareGroups(
      ps,
      { label: "Residential", properties: applyFilter(ps, { sector: "RESIDENTIAL" }) },
      { label: "Commercial", properties: applyFilter(ps, { sector: "COMMERCIAL" }) },
    );
    expect(c.a).toMatchObject({ count: 1, valueInr: 34_000_000, shareOfPortfolioPct: 24.64, annualRentInr: 0, grossYieldPct: 0, selfOccupiedCount: 1 });
    expect(c.b).toMatchObject({ count: 2, valueInr: 104_000_000, shareOfPortfolioPct: 75.36, annualRentInr: 7_800_000, grossYieldPct: 7.5 });
    expect(c.difference.valueInr).toBe(-70_000_000);
    expect(c.overlappingPropertyIds).toEqual([]);
  });
});
