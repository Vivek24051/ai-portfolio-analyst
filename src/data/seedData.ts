// Parses and validates the assignment CSVs into domain records.
//
// Rules: never silently alter data. Every normalisation is recorded as a note, raw labels are
// kept alongside normalised ones, and rows that fail validation abort the seed.

import { parse } from "csv-parse/sync";
import { z } from "zod";
import { ASSET_CLASS_LABELS, normalizeAssetClass, normalizeOccupancy } from "@/domain/normalize";
import { parseLocation } from "@/domain/location";
import type { Property, UserProfile } from "@/domain/types";

const userRow = z.object({
  user_id: z.string().regex(/^U\d{3}$/),
  name: z.string().min(1),
  city: z.string().min(1),
  preferences: z.string(),
  preferred_locations: z.string(),
  portfolio_value_preference_inr: z.string(),
});

const intString = z.string().regex(/^\d+$/, "expected a whole number").transform(Number);

const propertyRow = z.object({
  property_id: z.string().regex(/^P\d{3}$/),
  user_id: z.string().regex(/^U\d{3}$/),
  property_type: z.string().min(1),
  sub_type: z.string(),
  location: z.string().min(1),
  area_sqft: intString,
  current_estimated_value_inr: intString,
  purchase_price_inr: z.union([z.literal(""), intString]),
  annual_rent_inr: intString,
  occupancy_status: z.string(),
  tenant_status: z.enum(["Yes", "No"]),
  ownership_percent: z.string().transform(Number).pipe(z.number().gt(0).lte(100)),
  status: z.enum(["Active", "Inactive"]),
});

export interface SeedResult {
  users: UserProfile[];
  properties: Property[];
  notes: string[];
}

function parseCsv(text: string): Record<string, string>[] {
  return parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}

/** Validates one CSV row, reporting the file and 1-based line number on failure. */
function validateRow<T extends z.ZodType>(schema: T, row: unknown, file: string, index: number): z.output<T> {
  const result = schema.safeParse(row);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${file} line ${index + 2}: ${detail}`);
  }
  return result.data;
}

/** "30000000-80000000" → [30000000, 80000000]; "50000000" → [50000000, 50000000]. */
export function parseValuePreference(raw: string): { min: number | null; max: number | null } {
  const m = raw.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return { min: null, max: null };
  const min = Number(m[1]);
  return { min, max: m[2] ? Number(m[2]) : min };
}

export function buildSeed(usersCsv: string, propertiesCsv: string): SeedResult {
  const notes: string[] = [];

  const users: UserProfile[] = parseCsv(usersCsv).map((row, i) => {
    const r = validateRow(userRow, row, "users.csv", i);
    const pref = parseValuePreference(r.portfolio_value_preference_inr);
    if (pref.min !== pref.max) {
      notes.push(`${r.user_id}: value preference "${r.portfolio_value_preference_inr}" stored as range`);
    }
    return {
      id: r.user_id,
      name: r.name,
      city: r.city,
      preferences: r.preferences,
      preferredLocations: r.preferred_locations,
      portfolioValuePreferenceRaw: r.portfolio_value_preference_inr,
      prefMinInr: pref.min,
      prefMaxInr: pref.max,
    };
  });
  const userIds = new Set(users.map((u) => u.id));

  const seenIds = new Set<string>();
  const properties: Property[] = parseCsv(propertiesCsv).map((row, i) => {
    const r = validateRow(propertyRow, row, "properties.csv", i);
    const where = `${r.property_id}`;
    if (seenIds.has(r.property_id)) throw new Error(`${where}: duplicate property_id`);
    seenIds.add(r.property_id);
    if (!userIds.has(r.user_id)) throw new Error(`${where}: unknown user ${r.user_id}`);

    const assetClass = normalizeAssetClass(r.property_type);
    if (r.property_type !== ASSET_CLASS_LABELS[assetClass]) {
      notes.push(`${where}: property_type "${r.property_type}" normalised to ${assetClass}`);
    }
    const occupancy = normalizeOccupancy(r.occupancy_status);
    const loc = parseLocation(r.location);
    if (loc.state) {
      notes.push(`${where}: location "${r.location}" ends in a state; city=${loc.city}, state=${loc.state}`);
    }

    // Consistency checks — reported, never "fixed".
    if (occupancy === "TENANTED" && r.annual_rent_inr === 0) {
      notes.push(`WARNING ${where}: tenanted but annual rent is 0`);
    }
    if (occupancy !== "TENANTED" && r.annual_rent_inr > 0) {
      notes.push(`WARNING ${where}: ${occupancy} but annual rent is ${r.annual_rent_inr}`);
    }
    if ((r.tenant_status === "Yes") !== (occupancy === "TENANTED")) {
      notes.push(`WARNING ${where}: tenant_status "${r.tenant_status}" disagrees with occupancy "${r.occupancy_status}"`);
    }

    return {
      id: r.property_id,
      userId: r.user_id,
      propertyTypeRaw: r.property_type,
      assetClass,
      subType: r.sub_type || null,
      locationRaw: r.location,
      locality: loc.locality,
      city: loc.city,
      state: loc.state,
      areaSqft: r.area_sqft,
      currentValueInr: r.current_estimated_value_inr,
      purchasePriceInr: r.purchase_price_inr === "" ? null : r.purchase_price_inr,
      annualRentInr: r.annual_rent_inr,
      occupancyStatus: occupancy,
      ownershipPercent: r.ownership_percent,
      status: r.status === "Active" ? "ACTIVE" : "INACTIVE",
      version: 1,
    };
  });

  const missingPurchase = properties.filter((p) => p.purchasePriceInr === null).length;
  notes.push(`purchase_price_inr blank for ${missingPurchase}/${properties.length} properties (kept null, not imputed)`);

  return { users, properties, notes };
}
