// Domain types shared by calculations, tools and persistence.
// Kept free of Prisma/LangChain imports so the core logic is unit-testable in isolation.

export const ASSET_CLASSES = ["RETAIL", "OFFICE", "RESIDENTIAL"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** COMMERCIAL = RETAIL + OFFICE (documented assumption — the brief does not define it). */
export const SECTORS = ["COMMERCIAL", "RESIDENTIAL"] as const;
export type Sector = (typeof SECTORS)[number];

export const OCCUPANCY_STATUSES = ["TENANTED", "VACANT", "SELF_OCCUPIED"] as const;
export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];

export type PropertyStatus = "ACTIVE" | "INACTIVE";

/** A property as the domain layer sees it. All money is whole INR as a JS number. */
export interface Property {
  id: string;
  userId: string;
  propertyTypeRaw: string;
  assetClass: AssetClass;
  subType: string | null;
  locationRaw: string;
  locality: string;
  city: string;
  state: string | null;
  areaSqft: number;
  currentValueInr: number;
  purchasePriceInr: number | null;
  annualRentInr: number;
  occupancyStatus: OccupancyStatus;
  ownershipPercent: number;
  status: PropertyStatus;
  version: number;
}

export interface UserProfile {
  id: string;
  name: string;
  city: string;
  preferences: string;
  preferredLocations: string;
  portfolioValuePreferenceRaw: string;
  prefMinInr: number | null;
  prefMaxInr: number | null;
}
