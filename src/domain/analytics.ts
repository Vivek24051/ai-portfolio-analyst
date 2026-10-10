// Deterministic portfolio analytics. Every number the agent states must come from here.
//
// Conventions (documented in DECISIONS.md):
//  - Only ACTIVE properties are analysed; inactive ones are counted and reported as excluded.
//  - Portfolio totals use the owner's share: value × ownership% (100% for all seed rows).
//  - Gross yield = annual rent ÷ current estimated value. No purchase price/dates → no ROI or
//    appreciation; these are reported as data gaps instead of estimated.
//  - Percentages are rounded to 2 dp for presentation, so shares may sum to 99.99/100.01.

import { ASSET_CLASS_LABELS, OCCUPANCY_LABELS, sectorOf } from "./normalize";
import {
  ASSET_CLASSES,
  OCCUPANCY_STATUSES,
  SECTORS,
  type OccupancyStatus,
  type Property,
} from "./types";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** a/b as a percentage, or null when the denominator is zero. */
export function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round2((numerator / denominator) * 100);
}

export const ownedValue = (p: Property) => Math.round((p.currentValueInr * p.ownershipPercent) / 100);
export const ownedRent = (p: Property) => Math.round((p.annualRentInr * p.ownershipPercent) / 100);

/** Property-level gross yield (ownership share cancels out). Null when there is no rent or no value. */
export function grossYieldPct(p: Property): number | null {
  if (p.annualRentInr <= 0 || p.currentValueInr <= 0) return null;
  return pct(p.annualRentInr, p.currentValueInr);
}

export interface PropertyView {
  id: string;
  assetClass: Property["assetClass"];
  propertyTypeRaw: string;
  subType: string | null;
  location: string;
  city: string;
  areaSqft: number;
  currentValueInr: number;
  annualRentInr: number;
  grossYieldPct: number | null;
  occupancyStatus: OccupancyStatus;
  ownershipPercent: number;
  purchasePriceInr: number | null;
}

export function toView(p: Property): PropertyView {
  return {
    id: p.id,
    assetClass: p.assetClass,
    propertyTypeRaw: p.propertyTypeRaw,
    subType: p.subType,
    location: p.locationRaw,
    city: p.city,
    areaSqft: p.areaSqft,
    currentValueInr: p.currentValueInr,
    annualRentInr: p.annualRentInr,
    grossYieldPct: grossYieldPct(p),
    occupancyStatus: p.occupancyStatus,
    ownershipPercent: p.ownershipPercent,
    purchasePriceInr: p.purchasePriceInr,
  };
}

export interface Bucket {
  key: string;
  label: string;
  count: number;
  valueInr: number;
  valueSharePct: number | null;
  annualRentInr: number;
  rentSharePct: number | null;
  grossYieldPct: number | null;
  propertyIds: string[];
}

function bucketize(
  props: Property[],
  keyOf: (p: Property) => string,
  labelOf: (key: string) => string,
  orderedKeys?: readonly string[],
): Bucket[] {
  const totalValue = props.reduce((s, p) => s + ownedValue(p), 0);
  const totalRent = props.reduce((s, p) => s + ownedRent(p), 0);
  const groups = new Map<string, Property[]>();
  for (const k of orderedKeys ?? []) groups.set(k, []);
  for (const p of props) {
    const k = keyOf(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const buckets = [...groups.entries()].map(([key, items]) => {
    const valueInr = items.reduce((s, p) => s + ownedValue(p), 0);
    const annualRentInr = items.reduce((s, p) => s + ownedRent(p), 0);
    return {
      key,
      label: labelOf(key),
      count: items.length,
      valueInr,
      valueSharePct: pct(valueInr, totalValue),
      annualRentInr,
      rentSharePct: pct(annualRentInr, totalRent),
      grossYieldPct: pct(annualRentInr, valueInr),
      propertyIds: items.map((p) => p.id),
    };
  });
  // Fixed-category breakdowns keep their canonical order (zero rows included);
  // open-ended ones (cities) sort by value.
  return orderedKeys ? buckets : buckets.sort((a, b) => b.valueInr - a.valueInr);
}

// ---------- Rankings ----------

export const RANK_METRICS = ["value", "rent", "yield", "area", "value_per_sqft"] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

const METRIC_FN: Record<RankMetric, (p: Property) => number | null> = {
  value: (p) => p.currentValueInr,
  // Zero rent is "no income", not a competitor in rent rankings; reported as excluded.
  rent: (p) => (p.annualRentInr > 0 ? p.annualRentInr : null),
  yield: grossYieldPct,
  area: (p) => p.areaSqft,
  value_per_sqft: (p) => (p.areaSqft > 0 ? Math.round(p.currentValueInr / p.areaSqft) : null),
};

export interface RankedEntry {
  rank: number;
  propertyId: string;
  metricValue: number;
  property: PropertyView;
}

export interface Ranking {
  metric: RankMetric;
  order: "desc" | "asc";
  entries: RankedEntry[];
  /** True when the first-ranked position is shared by more than one property. */
  topIsTied: boolean;
  excluded: Array<{ propertyId: string; reason: string }>;
}

/** Ranks with shared ranks for ties (1, 1, 3). `limit` cuts by rank, so ties are never split. */
export function rankProperties(
  props: Property[],
  metric: RankMetric,
  order: "desc" | "asc" = "desc",
  limit?: number,
): Ranking {
  const scored: Array<{ p: Property; v: number }> = [];
  const excluded: Ranking["excluded"] = [];
  for (const p of props) {
    const v = METRIC_FN[metric](p);
    if (v === null) {
      const reason =
        metric === "value_per_sqft"
          ? "area is zero"
          : p.annualRentInr <= 0
            ? `no rental income (${OCCUPANCY_LABELS[p.occupancyStatus]})`
            : "current value is zero";
      excluded.push({ propertyId: p.id, reason });
    } else {
      scored.push({ p, v });
    }
  }
  scored.sort((a, b) => (order === "desc" ? b.v - a.v : a.v - b.v) || a.p.id.localeCompare(b.p.id));

  const entries: RankedEntry[] = [];
  scored.forEach(({ p, v }, i) => {
    const rank = i > 0 && v === scored[i - 1]!.v ? entries[i - 1]!.rank : i + 1;
    entries.push({ rank, propertyId: p.id, metricValue: v, property: toView(p) });
  });
  const limited = limit === undefined ? entries : entries.filter((e) => e.rank <= limit);
  const topIsTied = entries.filter((e) => e.rank === 1).length > 1;
  return { metric, order, entries: limited, topIsTied, excluded };
}

// ---------- Summary ----------

export interface PortfolioSummary {
  propertyCount: number;
  inactiveExcludedCount: number;
  totalValueInr: number;
  totalAnnualRentInr: number;
  /** Rent ÷ value across all properties, including vacant/self-occupied. */
  portfolioGrossYieldPct: number | null;
  /** Rent ÷ value across income-producing properties only. */
  incomeProducingYieldPct: number | null;
  byAssetClass: Bucket[];
  bySector: Bucket[];
  byCity: Bucket[];
  byOccupancy: Bucket[];
  highestValue: RankedEntry[];
  lowestValue: RankedEntry[];
  highestRent: RankedEntry[];
  dataGaps: string[];
}

export function dataGaps(props: Property[]): string[] {
  const gaps: string[] = [
    "No acquisition or valuation dates: appreciation, holding period and time-based trends cannot be computed.",
  ];
  const missing = props.filter((p) => p.purchasePriceInr === null).map((p) => p.id);
  if (missing.length > 0) {
    gaps.push(
      `Purchase price missing for ${missing.length} of ${props.length} properties (${missing.join(", ")}): capital gain and ROI cannot be computed for them.`,
    );
  }
  return gaps;
}

export function summarizePortfolio(all: Property[]): PortfolioSummary {
  const props = all.filter((p) => p.status === "ACTIVE");
  const totalValueInr = props.reduce((s, p) => s + ownedValue(p), 0);
  const totalAnnualRentInr = props.reduce((s, p) => s + ownedRent(p), 0);
  const earning = props.filter((p) => p.annualRentInr > 0);
  const earningValue = earning.reduce((s, p) => s + ownedValue(p), 0);
  const top = (r: Ranking) => r.entries.filter((e) => e.rank === 1);

  return {
    propertyCount: props.length,
    inactiveExcludedCount: all.length - props.length,
    totalValueInr,
    totalAnnualRentInr,
    portfolioGrossYieldPct: pct(totalAnnualRentInr, totalValueInr),
    incomeProducingYieldPct: earning.length ? pct(totalAnnualRentInr, earningValue) : null,
    byAssetClass: bucketize(props, (p) => p.assetClass, (k) => ASSET_CLASS_LABELS[k as Property["assetClass"]], ASSET_CLASSES),
    bySector: bucketize(props, (p) => sectorOf(p.assetClass), (k) => (k === "COMMERCIAL" ? "Commercial (retail + office)" : "Residential"), SECTORS),
    byCity: bucketize(props, (p) => p.city, (k) => k),
    byOccupancy: bucketize(props, (p) => p.occupancyStatus, (k) => OCCUPANCY_LABELS[k as OccupancyStatus], OCCUPANCY_STATUSES),
    highestValue: top(rankProperties(props, "value", "desc")),
    lowestValue: top(rankProperties(props, "value", "asc")),
    highestRent: top(rankProperties(props, "rent", "desc")),
    dataGaps: dataGaps(props),
  };
}

// ---------- Group comparison ----------

export interface GroupStats {
  label: string;
  count: number;
  propertyIds: string[];
  valueInr: number;
  shareOfPortfolioPct: number | null;
  annualRentInr: number;
  grossYieldPct: number | null;
  vacantCount: number;
  selfOccupiedCount: number;
}

function groupStats(label: string, group: Property[], portfolioValue: number): GroupStats {
  const valueInr = group.reduce((s, p) => s + ownedValue(p), 0);
  const annualRentInr = group.reduce((s, p) => s + ownedRent(p), 0);
  return {
    label,
    count: group.length,
    propertyIds: group.map((p) => p.id),
    valueInr,
    shareOfPortfolioPct: pct(valueInr, portfolioValue),
    annualRentInr,
    grossYieldPct: pct(annualRentInr, valueInr),
    vacantCount: group.filter((p) => p.occupancyStatus === "VACANT").length,
    selfOccupiedCount: group.filter((p) => p.occupancyStatus === "SELF_OCCUPIED").length,
  };
}

export interface GroupComparison {
  a: GroupStats;
  b: GroupStats;
  /** a − b */
  difference: { valueInr: number; annualRentInr: number; grossYieldPctPoints: number | null };
  overlappingPropertyIds: string[];
}

export function compareGroups(
  portfolio: Property[],
  a: { label: string; properties: Property[] },
  b: { label: string; properties: Property[] },
): GroupComparison {
  const active = (ps: Property[]) => ps.filter((p) => p.status === "ACTIVE");
  const total = active(portfolio).reduce((s, p) => s + ownedValue(p), 0);
  const sa = groupStats(a.label, active(a.properties), total);
  const sb = groupStats(b.label, active(b.properties), total);
  const bIds = new Set(sb.propertyIds);
  return {
    a: sa,
    b: sb,
    difference: {
      valueInr: sa.valueInr - sb.valueInr,
      annualRentInr: sa.annualRentInr - sb.annualRentInr,
      grossYieldPctPoints:
        sa.grossYieldPct === null || sb.grossYieldPct === null ? null : round2(sa.grossYieldPct - sb.grossYieldPct),
    },
    overlappingPropertyIds: sa.propertyIds.filter((id) => bIds.has(id)),
  };
}
