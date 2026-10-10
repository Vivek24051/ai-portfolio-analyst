// Structured property filter shared by search, analytics, comparison and scenario tools.
// The LLM fills this schema; the backend applies it. No free-form SQL ever leaves the model.

import { z } from "zod";
import { matchesCity, matchesLocality } from "./location";
import { sectorOf } from "./normalize";
import { ASSET_CLASSES, OCCUPANCY_STATUSES, SECTORS, type Property } from "./types";

export const propertyFilterSchema = z
  .object({
    propertyIds: z.array(z.string().max(64)).max(50).optional()
      .describe("Restrict to these property ids (e.g. from a previous answer)"),
    assetClasses: z.array(z.enum(ASSET_CLASSES)).optional()
      .describe("RETAIL, OFFICE or RESIDENTIAL. 'Commercial Office' is OFFICE."),
    sector: z.enum(SECTORS).optional()
      .describe("COMMERCIAL = RETAIL + OFFICE; RESIDENTIAL"),
    city: z.string().max(60).optional()
      .describe("City or region, e.g. 'Mumbai', 'Bengaluru', 'Delhi NCR'. Exact city match, not substring."),
    locality: z.string().max(60).optional()
      .describe("Neighbourhood substring, e.g. 'Bandra' matches 'Bandra West'"),
    occupancy: z.array(z.enum(OCCUPANCY_STATUSES)).optional(),
    valueAboveInr: z.number().int().nonnegative().optional()
      .describe("Strictly greater than this current value in whole INR (₹10 Cr = 100000000)"),
    valueBelowInr: z.number().int().positive().optional()
      .describe("Strictly less than this current value in whole INR"),
  })
  .strict();

export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

export function matchesFilter(p: Property, f: PropertyFilter): boolean {
  if (f.propertyIds && !f.propertyIds.includes(p.id)) return false;
  if (f.assetClasses && !f.assetClasses.includes(p.assetClass)) return false;
  if (f.sector && sectorOf(p.assetClass) !== f.sector) return false;
  if (f.city && !matchesCity(p.city, f.city)) return false;
  if (f.locality && !matchesLocality(p.locality, f.locality)) return false;
  if (f.occupancy && !f.occupancy.includes(p.occupancyStatus)) return false;
  if (f.valueAboveInr !== undefined && !(p.currentValueInr > f.valueAboveInr)) return false;
  if (f.valueBelowInr !== undefined && !(p.currentValueInr < f.valueBelowInr)) return false;
  return true;
}

export function applyFilter(properties: Property[], filter: PropertyFilter = {}): Property[] {
  return properties.filter((p) => matchesFilter(p, filter));
}
