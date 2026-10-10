// Shapes domain results for the model: pre-formatted ₹ and % strings, so the model copies
// figures instead of formatting (or recomputing) them. Raw INR integers are deliberately omitted.

import type { Bucket, GroupStats, PortfolioSummary, PropertyView, RankedEntry } from "@/domain/analytics";
import { formatInr } from "@/domain/money";
import { ASSET_CLASS_LABELS, OCCUPANCY_LABELS } from "@/domain/normalize";

export const fmtPct = (n: number | null) => (n === null ? null : `${n}%`);
export const fmtPp = (n: number | null) => (n === null ? null : `${n > 0 ? "+" : ""}${n} pp`);
export const fmtDelta = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${formatInr(Math.abs(n))}`;

export function presentProperty(p: PropertyView) {
  const label = ASSET_CLASS_LABELS[p.assetClass];
  return {
    id: p.id,
    type: p.propertyTypeRaw === label ? label : `${label} (recorded as "${p.propertyTypeRaw}")`,
    subType: p.subType,
    location: p.location,
    areaSqft: p.areaSqft,
    value: formatInr(p.currentValueInr),
    annualRent: p.annualRentInr > 0 ? formatInr(p.annualRentInr) : "none",
    grossYield: fmtPct(p.grossYieldPct),
    occupancy: OCCUPANCY_LABELS[p.occupancyStatus],
    ...(p.ownershipPercent !== 100 ? { ownership: `${p.ownershipPercent}%` } : {}),
    purchasePrice: p.purchasePriceInr === null ? "unknown" : formatInr(p.purchasePriceInr),
  };
}

export function presentRanked(e: RankedEntry) {
  return { rank: e.rank, ...presentProperty(e.property) };
}

export function presentBucket(b: Bucket) {
  return {
    group: b.label,
    count: b.count,
    value: formatInr(b.valueInr),
    shareOfValue: fmtPct(b.valueSharePct),
    annualRent: formatInr(b.annualRentInr),
    shareOfRent: fmtPct(b.rentSharePct),
    grossYield: fmtPct(b.grossYieldPct),
    propertyIds: b.propertyIds,
  };
}

export const SUMMARY_SECTIONS = ["totals", "by_asset_class", "by_sector", "by_city", "by_occupancy", "extremes", "data_gaps"] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

export function presentSummary(s: PortfolioSummary, sections: readonly SummarySection[] = SUMMARY_SECTIONS) {
  const want = new Set(sections);
  const out: Record<string, unknown> = {};
  if (want.has("totals")) {
    out.totals = {
      properties: s.propertyCount,
      totalValue: formatInr(s.totalValueInr),
      annualRent: formatInr(s.totalAnnualRentInr),
      grossYieldAllProperties: fmtPct(s.portfolioGrossYieldPct),
      grossYieldIncomeProducingOnly: fmtPct(s.incomeProducingYieldPct),
      ...(s.inactiveExcludedCount ? { inactiveExcluded: s.inactiveExcludedCount } : {}),
    };
  }
  // Empty categories are dropped to save tokens; "0 residential" is implied by absence.
  const nonEmpty = (bs: Bucket[]) => bs.filter((b) => b.count > 0).map(presentBucket);
  if (want.has("by_asset_class")) out.byAssetClass = nonEmpty(s.byAssetClass);
  if (want.has("by_sector")) out.bySector = nonEmpty(s.bySector);
  if (want.has("by_city")) out.byCity = nonEmpty(s.byCity);
  if (want.has("by_occupancy")) out.byOccupancy = nonEmpty(s.byOccupancy);
  if (want.has("extremes")) {
    out.highestValue = s.highestValue.map(presentRanked);
    out.lowestValue = s.lowestValue.map(presentRanked);
    out.highestRent = s.highestRent.map(presentRanked);
  }
  if (want.has("data_gaps")) out.dataGaps = s.dataGaps;
  return out;
}

export function presentGroup(g: GroupStats) {
  return {
    label: g.label,
    count: g.count,
    propertyIds: g.propertyIds,
    value: formatInr(g.valueInr),
    shareOfPortfolio: fmtPct(g.shareOfPortfolioPct),
    annualRent: formatInr(g.annualRentInr),
    grossYield: fmtPct(g.grossYieldPct),
    vacant: g.vacantCount,
    selfOccupied: g.selfOccupiedCount,
  };
}

