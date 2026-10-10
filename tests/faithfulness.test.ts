import { describe, expect, it } from "vitest";
import { checkNumericFaithfulness, extractNumbers } from "@/agent/faithfulness";

const summaryTool = JSON.stringify({
  totals: { properties: 3, totalValue: "₹29.7 Cr", annualRent: "₹1.32 Cr", grossYieldAllProperties: "4.44%" },
  byAssetClass: [{ group: "Retail", shareOfValue: "71.38%", value: "₹21.2 Cr" }],
});

describe("extractNumbers", () => {
  it("parses money, percentages, points and plain numbers; ignores ids and list markers", () => {
    const got = extractNumbers("1. P001 is ₹12.5 Cr (rent ₹72 L, 6.52%), retail fell -19.4 pp across 3 properties of 5,200 sq ft. ₹45,000 deposit; 2 crore? No: ₹2 crore.");
    expect(got.map((n) => [n.kind, n.value])).toEqual([
      ["money", 125_000_000],
      ["money", 7_200_000],
      ["money", 45_000],
      ["money", 20_000_000],
      ["money", 20_000_000], // "2 crore" without ₹ is still money
      ["points", -19.4],
      ["percent", 6.52],
      ["plain", 3],
      ["plain", 5200],
    ]);
  });
});

describe("checkNumericFaithfulness", () => {
  it("accepts figures copied from tool output, including light rounding", () => {
    const r = checkNumericFaithfulness("Your portfolio is worth ₹29.7 crore; retail is about 71.4% of it, across 3 properties.", [summaryTool]);
    expect(r.unsupported).toEqual([]);
    expect(r.numbers).toHaveLength(3);
  });

  it("flags invented or recomputed figures", () => {
    const r = checkNumericFaithfulness("Your portfolio is ₹30 Cr and appreciated 12% since purchase.", [summaryTool]);
    expect(r.unsupported.map((n) => n.raw)).toEqual(["₹30 Cr", "12%"]);
  });

  it("accepts numbers the user supplied and numbers in data labels", () => {
    const r = checkNumericFaithfulness("I'll stage ₹12.5 Cr for your Sector 29 property.", ["Change it to 12.5 crore", "Sector 29, Gurugram"]);
    expect(r.unsupported).toEqual([]);
  });

  it("counts array lengths as supported counts (e.g. 'two properties' → 2)", () => {
    const tool = JSON.stringify({ properties: [{ id: "P001" }, { id: "P003" }] });
    expect(checkNumericFaithfulness("You have 2 retail properties.", [tool]).unsupported).toEqual([]);
  });

  it("replies without numbers are trivially faithful", () => {
    expect(checkNumericFaithfulness("Which property do you mean?", [])).toEqual({ numbers: [], unsupported: [] });
  });
});
