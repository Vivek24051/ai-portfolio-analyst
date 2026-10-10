// Validation for property create/update requests coming from the agent.
//
// Input schemas are deliberately permissive (fields optional) so that an incomplete request
// yields a structured "needs_info" result the agent can turn into a question, instead of a
// schema error. Business rules live here, not in the prompt.

import { z } from "zod";
import { formatInr, moneySchema, toInr, MoneyError } from "./money";
import { canonicalCity } from "./location";
import { ASSET_CLASS_LABELS, OCCUPANCY_LABELS } from "./normalize";
import { toView, type PropertyView } from "./analytics";
import { ASSET_CLASSES, OCCUPANCY_STATUSES, type Property } from "./types";

const shortText = z.string().trim().min(1).max(80);

export const createPropertyInputSchema = z
  .object({
    assetClass: z.enum(ASSET_CLASSES).optional(),
    propertyTypeLabel: shortText.optional().describe("The user's own wording, e.g. 'Commercial Office'"),
    subType: shortText.optional().describe("e.g. High-street retail, Apartment, Office floor"),
    locality: shortText.optional().describe("Neighbourhood, e.g. 'Indiranagar'"),
    city: shortText.optional().describe("City, e.g. 'Bengaluru'. Ask if not stated."),
    areaSqft: z.number().int().positive().max(10_000_000).optional(),
    value: moneySchema.optional().describe("Current estimated value"),
    annualRent: moneySchema.optional().describe("Annual (not monthly) rent; 0 if vacant/self-occupied"),
    occupancyStatus: z.enum(OCCUPANCY_STATUSES).optional(),
    purchasePrice: moneySchema.optional(),
    ownershipPercent: z.number().gt(0).lte(100).optional(),
    allowDuplicate: z.boolean().optional()
      .describe("Set true only after the user confirmed this is a different property from a flagged near-duplicate"),
  })
  .strict();
export type CreatePropertyInput = z.infer<typeof createPropertyInputSchema>;

export const updatePropertyChangesSchema = z
  .object({
    value: moneySchema.optional(),
    annualRent: moneySchema.optional(),
    occupancyStatus: z.enum(OCCUPANCY_STATUSES).optional(),
    areaSqft: z.number().int().positive().max(10_000_000).optional(),
    subType: shortText.optional(),
    purchasePrice: moneySchema.optional(),
    ownershipPercent: z.number().gt(0).lte(100).optional(),
  })
  .strict();
export type UpdatePropertyChanges = z.infer<typeof updatePropertyChangesSchema>;

/** Fields a new property must have before it can be proposed. */
export const REQUIRED_CREATE_FIELDS = ["assetClass", "locality", "city", "areaSqft", "value", "occupancyStatus"] as const;

/** Writable shape for a new property (no id/user/version: assigned by the store). */
export type NewPropertyData = Omit<Property, "id" | "userId" | "version" | "status">;

/** Mutable subset of a property. */
export type PropertyPatch = Partial<
  Pick<Property, "currentValueInr" | "annualRentInr" | "occupancyStatus" | "areaSqft" | "subType" | "purchasePriceInr" | "ownershipPercent">
>;

export interface DiffEntry {
  field: string;
  label: string;
  before: string | null;
  after: string;
}

export type CreateValidation =
  | { status: "needs_info"; missing: string[]; errors: string[] }
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; data: NewPropertyData; diff: DiffEntry[] };

export type UpdateValidation =
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; patch: PropertyPatch; diff: DiffEntry[] };

function convert(money: z.infer<typeof moneySchema> | undefined, field: string, errors: string[]): number | undefined {
  if (!money) return undefined;
  try {
    return toInr(money);
  } catch (e) {
    errors.push(`${field}: ${e instanceof MoneyError ? e.message : "invalid amount"}`);
    return undefined;
  }
}

/** Rent must be positive for tenanted property and zero otherwise (matches every seed row). */
function rentConsistencyError(occupancy: Property["occupancyStatus"], rent: number): string | null {
  if (occupancy === "TENANTED" && rent <= 0) return "A tenanted property needs its annual rent.";
  if (occupancy !== "TENANTED" && rent > 0) {
    return `A ${OCCUPANCY_LABELS[occupancy].toLowerCase()} property should have zero rent; confirm the occupancy or rent.`;
  }
  return null;
}

export function validateCreate(input: CreatePropertyInput): CreateValidation {
  const errors: string[] = [];
  const missing: string[] = REQUIRED_CREATE_FIELDS.filter((f) => input[f] === undefined);
  const valueInr = convert(input.value, "value", errors);
  const rentInr = convert(input.annualRent, "annualRent", errors);
  const purchaseInr = convert(input.purchasePrice, "purchasePrice", errors);

  if (input.value && valueInr === 0) errors.push("value: must be greater than zero");
  if (input.occupancyStatus === "TENANTED" && input.annualRent === undefined) missing.push("annualRent");
  if (input.occupancyStatus && rentInr !== undefined) {
    const err = rentConsistencyError(input.occupancyStatus, rentInr);
    if (err) errors.push(err);
  }

  if (missing.length > 0) return { status: "needs_info", missing, errors };
  if (errors.length > 0) return { status: "invalid", errors };

  const assetClass = input.assetClass!;
  const locality = input.locality!.trim();
  const city = canonicalCity(input.city!);
  const data: NewPropertyData = {
    propertyTypeRaw: input.propertyTypeLabel ?? ASSET_CLASS_LABELS[assetClass],
    assetClass,
    subType: input.subType ?? null,
    locationRaw: `${locality}, ${city}`,
    locality,
    city,
    state: null,
    areaSqft: input.areaSqft!,
    currentValueInr: valueInr!,
    purchasePriceInr: purchaseInr ?? null,
    annualRentInr: rentInr ?? 0,
    occupancyStatus: input.occupancyStatus!,
    ownershipPercent: input.ownershipPercent ?? 100,
  };
  const diff: DiffEntry[] = [
    { field: "assetClass", label: "Type", before: null, after: data.subType ? `${ASSET_CLASS_LABELS[assetClass]} (${data.subType})` : ASSET_CLASS_LABELS[assetClass] },
    { field: "location", label: "Location", before: null, after: data.locationRaw },
    { field: "areaSqft", label: "Area", before: null, after: `${data.areaSqft.toLocaleString("en-IN")} sq ft` },
    { field: "currentValueInr", label: "Current value", before: null, after: formatInr(data.currentValueInr) },
    { field: "occupancyStatus", label: "Occupancy", before: null, after: OCCUPANCY_LABELS[data.occupancyStatus] },
    { field: "annualRentInr", label: "Annual rent", before: null, after: formatInr(data.annualRentInr) },
  ];
  if (data.purchasePriceInr !== null) {
    diff.push({ field: "purchasePriceInr", label: "Purchase price", before: null, after: formatInr(data.purchasePriceInr) });
  }
  if (data.ownershipPercent !== 100) {
    diff.push({ field: "ownershipPercent", label: "Ownership", before: null, after: `${data.ownershipPercent}%` });
  }
  return { status: "ok", data, diff };
}

export function validateUpdate(current: Property, changes: UpdatePropertyChanges): UpdateValidation {
  const errors: string[] = [];
  const patch: PropertyPatch = {};
  const diff: DiffEntry[] = [];
  const money = (n: number | null) => (n === null ? null : formatInr(n));

  const valueInr = convert(changes.value, "value", errors);
  const rentInr = convert(changes.annualRent, "annualRent", errors);
  const purchaseInr = convert(changes.purchasePrice, "purchasePrice", errors);
  if (errors.length) return { status: "invalid", errors };

  const set = <K extends keyof PropertyPatch>(field: K, label: string, next: NonNullable<Property[K]>, fmt: (v: Property[K]) => string | null) => {
    if (current[field] === next) return;
    patch[field] = next as PropertyPatch[K];
    diff.push({ field, label, before: fmt(current[field]), after: fmt(next)! });
  };

  if (valueInr !== undefined) {
    if (valueInr <= 0) errors.push("value: must be greater than zero");
    else set("currentValueInr", "Current value", valueInr, (v) => money(v as number));
  }
  if (rentInr !== undefined) set("annualRentInr", "Annual rent", rentInr, (v) => money(v as number));
  if (changes.occupancyStatus) set("occupancyStatus", "Occupancy", changes.occupancyStatus, (v) => OCCUPANCY_LABELS[v as Property["occupancyStatus"]]);
  if (changes.areaSqft !== undefined) set("areaSqft", "Area", changes.areaSqft, (v) => `${(v as number).toLocaleString("en-IN")} sq ft`);
  if (changes.subType !== undefined) set("subType", "Sub-type", changes.subType, (v) => (v as string | null));
  if (purchaseInr !== undefined) set("purchasePriceInr", "Purchase price", purchaseInr, (v) => money(v as number | null));
  if (changes.ownershipPercent !== undefined) set("ownershipPercent", "Ownership", changes.ownershipPercent, (v) => `${v}%`);

  // Check the resulting state, so "mark P001 vacant" without zeroing rent is caught.
  const occupancyAfter = patch.occupancyStatus ?? current.occupancyStatus;
  const rentAfter = patch.annualRentInr ?? current.annualRentInr;
  const consistency = rentConsistencyError(occupancyAfter, rentAfter);
  if (consistency && (patch.occupancyStatus !== undefined || patch.annualRentInr !== undefined)) errors.push(consistency);

  if (errors.length) return { status: "invalid", errors };
  if (diff.length === 0) return { status: "invalid", errors: ["No changes: the requested values match the current record."] };
  return { status: "ok", patch, diff };
}

/**
 * Near-duplicate check for new properties: same class and city, overlapping locality, and
 * area or value within 15%. Catches the brief's own example ("5,000 sq ft retail in Bandra,
 * ₹12 Cr") against P001 (5,200 sq ft, Bandra West, ₹12 Cr).
 */
export function findPossibleDuplicates(existing: Property[], draft: NewPropertyData): PropertyView[] {
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.15 * Math.max(a, b);
  const la = draft.locality.toLowerCase();
  return existing
    .filter((p) => p.status === "ACTIVE")
    .filter((p) => p.assetClass === draft.assetClass && p.city.toLowerCase() === draft.city.toLowerCase())
    .filter((p) => {
      const lb = p.locality.toLowerCase();
      return lb.includes(la) || la.includes(lb);
    })
    .filter((p) => close(p.areaSqft, draft.areaSqft) || close(p.currentValueInr, draft.currentValueInr))
    .map(toView);
}
