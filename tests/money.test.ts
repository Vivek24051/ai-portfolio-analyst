import { describe, expect, it } from "vitest";
import { formatInr, MoneyError, parseInrText, toInr, bigIntToInr } from "@/domain/money";

describe("toInr", () => {
  it.each([
    [{ amount: 12.5, unit: "CRORE" }, 125_000_000], // R006
    [{ amount: 4.2, unit: "CRORE" }, 42_000_000], // R005 — float artefact absorbed
    [{ amount: 14, unit: "CRORE" }, 140_000_000],
    [{ amount: 50, unit: "LAKH" }, 5_000_000],
    [{ amount: 72, unit: "LAKH" }, 7_200_000],
    [{ amount: 250, unit: "THOUSAND" }, 250_000],
    [{ amount: 1_200_000, unit: "INR" }, 1_200_000],
    [{ amount: 0, unit: "INR" }, 0],
  ] as const)("%o → %d", (money, expected) => {
    expect(toInr(money)).toBe(expected);
  });

  it("rejects negative and absurd amounts", () => {
    expect(() => toInr({ amount: -1, unit: "CRORE" })).toThrow(MoneyError);
    expect(() => toInr({ amount: 200_000, unit: "CRORE" })).toThrow(/exceeds/);
    expect(() => toInr({ amount: Number.NaN, unit: "INR" })).toThrow(MoneyError);
  });
});

describe("parseInrText", () => {
  it.each([
    ["₹12.5 Cr", 125_000_000],
    ["₹10 crore", 100_000_000],
    ["4.2 crore", 42_000_000],
    ["12 Cr.", 120_000_000],
    ["50 lakh", 5_000_000],
    ["Rs 1,20,00,000", 12_000_000], // Indian grouping: 1 crore 20 lakh
    ["Rs 12,00,00,000", 120_000_000],
    ["INR 72,00,000", 7_200_000],
  ])("%s → %d", (text, expected) => {
    expect(parseInrText(text)).toBe(expected);
  });

  it("returns null for unparseable text", () => {
    expect(parseInrText("twelve crore")).toBeNull();
    expect(parseInrText("12 bananas")).toBeNull();
  });
});

describe("formatInr", () => {
  it("uses crore / lakh / Indian grouping", () => {
    expect(formatInr(120_000_000)).toBe("₹12 Cr");
    expect(formatInr(125_000_000)).toBe("₹12.5 Cr");
    expect(formatInr(1_115_000_000)).toBe("₹111.5 Cr");
    expect(formatInr(7_200_000)).toBe("₹72 L");
    expect(formatInr(45_000)).toBe("₹45,000");
    expect(formatInr(-8_500_000)).toBe("-₹85 L");
  });
});

describe("bigIntToInr", () => {
  it("converts safe values and rejects unsafe ones", () => {
    expect(bigIntToInr(240_000_000n)).toBe(240_000_000);
    expect(() => bigIntToInr(2n ** 60n)).toThrow(MoneyError);
  });
});
