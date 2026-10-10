// Normalisation of the inconsistent labels in the seed data and in user input.
//
// Seed data uses both "Commercial Office" (P002, P007, P008) and "Office" (P011) for the same
// kind of asset. We keep the raw label for display/audit and compute on a normalised class.

import type { AssetClass, OccupancyStatus, Sector } from "./types";

const ASSET_CLASS_ALIASES: Array<[RegExp, AssetClass]> = [
  [/^(retail|shop|showroom|high[- ]street retail|mall retail|shopping centre unit)s?$/i, "RETAIL"],
  [/^(commercial office|office|office floor|office space|it park)s?$/i, "OFFICE"],
  [/^(residential|apartment|flat|villa|house|bungalow|penthouse)s?$/i, "RESIDENTIAL"],
];

export class NormalizationError extends Error {}

/** Maps a raw property-type label to an asset class, or throws for unknown labels. */
export function normalizeAssetClass(raw: string): AssetClass {
  const label = raw.trim().replace(/\s+/g, " ");
  const hit = ASSET_CLASS_ALIASES.find(([re]) => re.test(label));
  if (!hit) {
    // Deliberately not guessing: bare "Commercial" is ambiguous between retail and office.
    throw new NormalizationError(`Unrecognised property type "${raw}"`);
  }
  return hit[1];
}

export function sectorOf(assetClass: AssetClass): Sector {
  return assetClass === "RESIDENTIAL" ? "RESIDENTIAL" : "COMMERCIAL";
}

export function normalizeOccupancy(raw: string): OccupancyStatus {
  const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (v === "tenanted" || v === "leased" || v === "rented") return "TENANTED";
  if (v === "vacant" || v === "empty") return "VACANT";
  if (v === "selfoccupied" || v === "owneroccupied") return "SELF_OCCUPIED";
  throw new NormalizationError(`Unrecognised occupancy status "${raw}"`);
}

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  RETAIL: "Retail",
  OFFICE: "Office",
  RESIDENTIAL: "Residential",
};

export const OCCUPANCY_LABELS: Record<OccupancyStatus, string> = {
  TENANTED: "Tenanted",
  VACANT: "Vacant",
  SELF_OCCUPIED: "Self-occupied",
};
