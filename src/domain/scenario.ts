// Hypothetical "what-if" analysis. Pure function over a copy of the portfolio:
// it cannot write to the database, and its output is always tagged `hypothetical: true`.

import { z } from "zod";
import { round2, summarizePortfolio, type PortfolioSummary } from "./analytics";
import { ASSET_CLASSES, OCCUPANCY_STATUSES, type Property } from "./types";

export const hypotheticalAdditionSchema = z
  .object({
    assetClass: z.enum(ASSET_CLASSES),
    city: z.string().min(1).max(60),
    locality: z.string().max(60).optional(),
    areaSqft: z.number().int().positive().optional(),
    currentValueInr: z.number().int().positive(),
    annualRentInr: z.number().int().nonnegative().default(0),
    occupancyStatus: z.enum(OCCUPANCY_STATUSES).optional(),
  })
  .strict();

export const scenarioInputSchema = z
  .object({
    excludePropertyIds: z.array(z.string()).max(50).default([]),
    valueOverrides: z
      .array(z.object({ propertyId: z.string(), newValueInr: z.number().int().positive() }).strict())
      .max(50)
      .default([]),
    rentOverrides: z
      .array(z.object({ propertyId: z.string(), newAnnualRentInr: z.number().int().nonnegative() }).strict())
      .max(50)
      .default([]),
    additions: z.array(hypotheticalAdditionSchema).max(10).default([]),
  })
  .strict();

export type ScenarioInput = z.input<typeof scenarioInputSchema>;

export class ScenarioError extends Error {}

export interface ScenarioResult {
  hypothetical: true;
  description: string[];
  baseline: PortfolioSummary;
  scenario: PortfolioSummary;
  deltas: {
    totalValueInr: number;
    totalAnnualRentInr: number;
    portfolioGrossYieldPctPoints: number | null;
    /** Change in each asset class's share of value, in percentage points. */
    assetClassSharePctPoints: Record<string, number | null>;
    sectorSharePctPoints: Record<string, number | null>;
  };
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : round2(b - a));

/**
 * Applies a scenario to the caller's (already user-scoped) properties.
 * Unknown property ids are rejected rather than ignored, so a mistyped id never silently
 * produces a "no change" answer — and ids from other users are indistinguishable from unknown.
 */
export function runScenario(properties: Property[], rawInput: ScenarioInput): ScenarioResult {
  const input = scenarioInputSchema.parse(rawInput);
  const byId = new Map(properties.map((p) => [p.id, p]));
  const referenced = [
    ...input.excludePropertyIds,
    ...input.valueOverrides.map((o) => o.propertyId),
    ...input.rentOverrides.map((o) => o.propertyId),
  ];
  const unknown = [...new Set(referenced.filter((id) => !byId.has(id)))];
  if (unknown.length > 0) {
    throw new ScenarioError(`Property not found in this portfolio: ${unknown.join(", ")}`);
  }

  const excluded = new Set(input.excludePropertyIds);
  const conflicting = [...input.valueOverrides, ...input.rentOverrides]
    .map((o) => o.propertyId)
    .filter((id) => excluded.has(id));
  if (conflicting.length > 0) {
    throw new ScenarioError(`Cannot both exclude and modify: ${[...new Set(conflicting)].join(", ")}`);
  }

  const description: string[] = [];
  // structuredClone guarantees the real records are never mutated.
  let working: Property[] = structuredClone(properties);

  if (excluded.size > 0) {
    working = working.filter((p) => !excluded.has(p.id));
    description.push(`Excluded ${[...excluded].join(", ")}`);
  }
  for (const o of input.valueOverrides) {
    const p = working.find((w) => w.id === o.propertyId)!;
    description.push(`${p.id} value ${p.currentValueInr} → ${o.newValueInr}`);
    p.currentValueInr = o.newValueInr;
  }
  for (const o of input.rentOverrides) {
    const p = working.find((w) => w.id === o.propertyId)!;
    description.push(`${p.id} annual rent ${p.annualRentInr} → ${o.newAnnualRentInr}`);
    p.annualRentInr = o.newAnnualRentInr;
  }
  input.additions.forEach((a, i) => {
    const id = `HYPOTHETICAL-${i + 1}`;
    description.push(`Added ${id} (${a.assetClass}, ${a.city}, value ${a.currentValueInr})`);
    working.push({
      id,
      userId: properties[0]?.userId ?? "",
      propertyTypeRaw: a.assetClass,
      assetClass: a.assetClass,
      subType: null,
      locationRaw: [a.locality, a.city].filter(Boolean).join(", "),
      locality: a.locality ?? a.city,
      city: a.city,
      state: null,
      areaSqft: a.areaSqft ?? 0,
      currentValueInr: a.currentValueInr,
      purchasePriceInr: null,
      annualRentInr: a.annualRentInr,
      occupancyStatus: a.occupancyStatus ?? (a.annualRentInr > 0 ? "TENANTED" : "VACANT"),
      ownershipPercent: 100,
      status: "ACTIVE",
      version: 0,
    });
  });
  if (description.length === 0) throw new ScenarioError("Scenario has no changes");

  const baseline = summarizePortfolio(properties);
  const scenario = summarizePortfolio(working);
  const shareDelta = (key: "byAssetClass" | "bySector") =>
    Object.fromEntries(
      baseline[key].map((b) => [
        b.key,
        diff(b.valueSharePct ?? 0, scenario[key].find((s) => s.key === b.key)?.valueSharePct ?? 0),
      ]),
    );

  return {
    hypothetical: true,
    description,
    baseline,
    scenario,
    deltas: {
      totalValueInr: scenario.totalValueInr - baseline.totalValueInr,
      totalAnnualRentInr: scenario.totalAnnualRentInr - baseline.totalAnnualRentInr,
      portfolioGrossYieldPctPoints: diff(baseline.portfolioGrossYieldPct, scenario.portfolioGrossYieldPct),
      assetClassSharePctPoints: shareDelta("byAssetClass"),
      sectorSharePctPoints: shareDelta("bySector"),
    },
  };
}
