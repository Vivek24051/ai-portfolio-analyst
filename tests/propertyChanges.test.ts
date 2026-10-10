import { describe, expect, it } from "vitest";
import { findPossibleDuplicates, validateCreate, validateUpdate } from "@/domain/propertyChanges";
import { isAffirmative } from "@/domain/affirmation";
import { propsOf } from "./helpers";

describe("validateCreate", () => {
  it("R005 as stated is missing city and occupancy → needs_info (agent must ask)", () => {
    const v = validateCreate({ assetClass: "RETAIL", locality: "Indiranagar", areaSqft: 3000, value: { amount: 4.2, unit: "CRORE" } });
    expect(v).toEqual({ status: "needs_info", missing: ["city", "occupancyStatus"], errors: [] });
  });

  it("tenanted property also needs annual rent", () => {
    const v = validateCreate({
      assetClass: "RETAIL", locality: "Indiranagar", city: "Bengaluru", areaSqft: 3000,
      value: { amount: 4.2, unit: "CRORE" }, occupancyStatus: "TENANTED",
    });
    expect(v.status).toBe("needs_info");
    expect(v.status === "needs_info" && v.missing).toEqual(["annualRent"]);
  });

  it("complete R005 converts ₹4.2 Cr exactly and builds a readable diff", () => {
    const v = validateCreate({
      assetClass: "RETAIL", locality: "Indiranagar", city: "bangalore", areaSqft: 3000,
      value: { amount: 4.2, unit: "CRORE" }, occupancyStatus: "VACANT",
    });
    expect(v.status).toBe("ok");
    if (v.status !== "ok") return;
    expect(v.data).toMatchObject({
      assetClass: "RETAIL", propertyTypeRaw: "Retail", city: "Bengaluru", locationRaw: "Indiranagar, Bengaluru",
      currentValueInr: 42_000_000, annualRentInr: 0, purchasePriceInr: null, ownershipPercent: 100,
    });
    expect(v.diff.find((d) => d.field === "currentValueInr")?.after).toBe("₹4.2 Cr");
  });

  it("rejects rent on a vacant property instead of silently zeroing it", () => {
    const v = validateCreate({
      assetClass: "OFFICE", locality: "Whitefield", city: "Bengaluru", areaSqft: 1000,
      value: { amount: 3, unit: "CRORE" }, occupancyStatus: "VACANT", annualRent: { amount: 20, unit: "LAKH" },
    });
    expect(v.status).toBe("invalid");
  });
});

describe("validateUpdate", () => {
  const p001 = propsOf("U001").find((p) => p.id === "P001")!;

  it("R006: value → ₹12.5 Cr with before/after diff", () => {
    const v = validateUpdate(p001, { value: { amount: 12.5, unit: "CRORE" } });
    expect(v).toEqual({
      status: "ok",
      patch: { currentValueInr: 125_000_000 },
      diff: [{ field: "currentValueInr", label: "Current value", before: "₹12 Cr", after: "₹12.5 Cr" }],
    });
  });

  it("no-op updates are rejected", () => {
    expect(validateUpdate(p001, { value: { amount: 12, unit: "CRORE" } }).status).toBe("invalid");
  });

  it("marking a tenanted property vacant requires zeroing the rent too", () => {
    expect(validateUpdate(p001, { occupancyStatus: "VACANT" }).status).toBe("invalid");
    const ok = validateUpdate(p001, { occupancyStatus: "VACANT", annualRent: { amount: 0, unit: "INR" } });
    expect(ok.status === "ok" && ok.patch).toEqual({ occupancyStatus: "VACANT", annualRentInr: 0 });
  });
});

describe("findPossibleDuplicates", () => {
  it("flags the brief's example (5,000 sq ft retail, Bandra, ₹12 Cr) against P001", () => {
    const v = validateCreate({
      assetClass: "RETAIL", locality: "Bandra", city: "Mumbai", areaSqft: 5000,
      value: { amount: 12, unit: "CRORE" }, occupancyStatus: "VACANT",
    });
    if (v.status !== "ok") throw new Error("expected ok");
    expect(findPossibleDuplicates(propsOf("U001"), v.data).map((p) => p.id)).toEqual(["P001"]);
  });

  it("does not flag a genuinely different property", () => {
    const v = validateCreate({
      assetClass: "RETAIL", locality: "Indiranagar", city: "Bengaluru", areaSqft: 3000,
      value: { amount: 4.2, unit: "CRORE" }, occupancyStatus: "VACANT",
    });
    if (v.status !== "ok") throw new Error("expected ok");
    // U004 owns P012 in Indiranagar, but it is residential.
    expect(findPossibleDuplicates(propsOf("U004"), v.data)).toEqual([]);
  });
});

describe("isAffirmative", () => {
  it.each(["yes", "Yes!", "ok", "yes please", "Go ahead", "confirm", "haan", "👍", "✅", "looks good"])("accepts %s", (t) => {
    expect(isAffirmative(t)).toBe(true);
  });
  it.each([
    "no", "yes, but make it 13 Cr", "wait", "not yet", "change the value first", "what is my rent?",
    "", "ok so what about Mumbai and also tell me everything about my entire portfolio in detail please",
  ])("rejects %s", (t) => {
    expect(isAffirmative(t)).toBe(false);
  });
});
