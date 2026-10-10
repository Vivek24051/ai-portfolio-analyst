// Deterministic numeric-faithfulness check: every number in the agent's reply must be traceable
// to backend tool output (or to text the user / the data itself supplied).
//
// Used in two places:
//   - production: a reply with unsupported figures flags the conversation for attention;
//   - evaluation: the "numeric faithfulness" metric.
//
// Extraction understands ₹ amounts (Cr / crore / L / lakh / plain), percentages, percentage
// points, and plain numbers. Property ids (P001) and list markers are ignored. Matching allows
// the rounding a reader would accept: money within 0.5%, percentages within 0.05.

export type NumberKind = "money" | "percent" | "points" | "plain";

export interface ExtractedNumber {
  raw: string;
  kind: NumberKind;
  value: number;
}

const CRORE = 10_000_000;
const LAKH = 100_000;

const MONEY = /(?:₹|rs\.?\s?|inr\s?)\s?(-?[\d,]*\.?\d+)\s*(crores?|cr\b\.?|lakhs?|lacs?|l\b)?/gi;
/** Amounts with a unit word but no currency sign ("12.5 crore", "50 lakh"). */
const MONEY_WORDS = /(-?[\d,]*\.?\d+)\s*(crores?|cr\b\.?|lakhs?|lacs?)/gi;
const PERCENT = /(-?\d+(?:\.\d+)?)\s?%/g;
const POINTS = /([+-]?\d+(?:\.\d+)?)\s?(?:pp\b|percentage points?)/gi;
const PLAIN = /(?<![\w.₹%])(-?\d[\d,]*(?:\.\d+)?)(?![\w%])/g;
const IGNORE = [/\bP\d{3,}\b/g, /HYPOTHETICAL-\d+/g, /^\s*\d+[.)]\s/gm, /\b\d{4}-\d{2}-\d{2}\b/g];

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function moneyValue(amount: string, unit: string | undefined): number {
  const n = toNumber(amount);
  if (!unit) return n;
  const u = unit.toLowerCase();
  if (u.startsWith("cr")) return Math.round(n * CRORE);
  return Math.round(n * LAKH);
}

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  let rest = text;
  for (const re of IGNORE) rest = rest.replace(re, " ");

  const take = (re: RegExp, kind: NumberKind, value: (m: RegExpExecArray) => number) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const v = value(m);
      if (Number.isFinite(v)) out.push({ raw: String(args[0]).trim(), kind, value: v });
      return " ";
    });
  };
  take(MONEY, "money", (m) => moneyValue(m[1]!, m[2]));
  take(MONEY_WORDS, "money", (m) => moneyValue(m[1]!, m[2]));
  take(POINTS, "points", (m) => toNumber(m[1]!));
  take(PERCENT, "percent", (m) => toNumber(m[1]!));
  take(PLAIN, "plain", (m) => toNumber(m[1]!));
  return out;
}

function matches(a: ExtractedNumber, b: ExtractedNumber): boolean {
  switch (a.kind) {
    case "money": {
      if (b.kind !== "money" && b.kind !== "plain") return false;
      const scale = Math.max(Math.abs(a.value), Math.abs(b.value), 1);
      return Math.abs(Math.abs(a.value) - Math.abs(b.value)) / scale <= 0.005;
    }
    case "percent":
    case "points":
      return (b.kind === "percent" || b.kind === "points" || b.kind === "plain") && Math.abs(Math.abs(a.value) - Math.abs(b.value)) <= 0.05;
    case "plain":
      return Math.abs(a.value - b.value) < 1e-9 || (b.kind !== "plain" && Math.abs(a.value - b.value) <= 0.05);
  }
}

/** Numbers implied by JSON values (e.g. "areaSqft": 5200, "matchCount": 3). */
function jsonNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  try {
    const walk = (v: unknown) => {
      if (typeof v === "number") out.push({ raw: String(v), kind: "plain", value: v });
      else if (Array.isArray(v)) {
        out.push({ raw: String(v.length), kind: "plain", value: v.length }); // "two properties"
        v.forEach(walk);
      } else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(text));
  } catch {
    /* not JSON */
  }
  return out;
}

export interface FaithfulnessResult {
  numbers: ExtractedNumber[];
  unsupported: ExtractedNumber[];
}

/**
 * @param reply   the agent's final answer
 * @param sources tool outputs (JSON strings) plus user messages and data labels (e.g. locations)
 */
export function checkNumericFaithfulness(reply: string, sources: string[]): FaithfulnessResult {
  const numbers = extractNumbers(reply).filter((n) => !(n.kind === "plain" && Math.abs(n.value) <= 1)); // "one", "1 property"
  if (numbers.length === 0) return { numbers, unsupported: [] };
  const pool = sources.flatMap((s) => [...extractNumbers(s), ...jsonNumbers(s)]);
  const unsupported = numbers.filter((n) => !pool.some((p) => matches(n, p)));
  return { numbers, unsupported };
}
