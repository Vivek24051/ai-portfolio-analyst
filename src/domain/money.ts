// Money conversion and formatting.
//
// The LLM never multiplies by 10^7. Tools accept { amount, unit } and the backend converts,
// so "₹12.5 Cr" becomes exactly 125,000,000 here, and the confirmation card echoes it back.

import { z } from "zod";

export const MONEY_UNITS = ["INR", "THOUSAND", "LAKH", "CRORE"] as const;
export type MoneyUnit = (typeof MONEY_UNITS)[number];

const UNIT_FACTORS: Record<MoneyUnit, number> = {
  INR: 1,
  THOUSAND: 1_000,
  LAKH: 100_000,
  CRORE: 10_000_000,
};

/** Upper bound for a single amount: ₹1,00,000 Cr. Anything larger is almost certainly a unit mistake. */
export const MAX_AMOUNT_INR = 1_000_000_000_000;

export const moneySchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    unit: z.enum(MONEY_UNITS),
  })
  .describe('Money amount with explicit unit, e.g. {"amount": 12.5, "unit": "CRORE"} for ₹12.5 Cr');

export type Money = z.infer<typeof moneySchema>;

export class MoneyError extends Error {}

/** Converts a unit-tagged amount to whole rupees. Throws on out-of-range values. */
export function toInr(money: Money): number {
  const { amount, unit } = money;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new MoneyError(`Invalid amount: ${amount}`);
  }
  // Round to whole rupees; absorbs float artefacts such as 4.2 * 1e7 = 42000000.00000001.
  const inr = Math.round(amount * UNIT_FACTORS[unit]);
  if (inr > MAX_AMOUNT_INR) {
    throw new MoneyError(`Amount ₹${inr} exceeds the supported maximum; check the unit.`);
  }
  return inr;
}

const UNIT_WORDS: Array<[RegExp, MoneyUnit]> = [
  [/^(cr|crs|crore|crores)$/i, "CRORE"],
  [/^(l|lac|lacs|lakh|lakhs)$/i, "LAKH"],
  [/^(k|thousand)$/i, "THOUSAND"],
];

/**
 * Parses free-text INR such as "₹12.5 Cr", "50 lakh", "Rs 1,20,00,000", "4.2 crore".
 * Used for CSV/test inputs and deterministic fallbacks; returns null if not parseable.
 */
export function parseInrText(text: string): number | null {
  const cleaned = text.trim().replace(/^(₹|rs\.?|inr)\s*/i, "");
  const match = cleaned.match(/^([\d,]*\.?\d+)\s*([a-z]+)?\.?$/i);
  if (!match) return null;
  const amount = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const word = match[2];
  if (!word) return toInr({ amount, unit: "INR" });
  const unit = UNIT_WORDS.find(([re]) => re.test(word))?.[1];
  return unit ? toInr({ amount, unit }) : null;
}

/** Indian-style display: ₹12.5 Cr, ₹24 L, ₹45,000. */
export function formatInr(inr: number): string {
  const sign = inr < 0 ? "-" : "";
  const abs = Math.abs(inr);
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= UNIT_FACTORS.CRORE) return `${sign}₹${trim(abs / UNIT_FACTORS.CRORE)} Cr`;
  if (abs >= UNIT_FACTORS.LAKH) return `${sign}₹${trim(abs / UNIT_FACTORS.LAKH)} L`;
  return `${sign}₹${abs.toLocaleString("en-IN")}`;
}

/** Safe BigInt → number for values coming out of Postgres. */
export function bigIntToInr(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new MoneyError(`Value ${value} exceeds safe integer range`);
  return n;
}
