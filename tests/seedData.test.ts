import { describe, expect, it } from "vitest";
import { buildSeed, parseValuePreference } from "@/data/seedData";
import { loadSeed } from "./helpers";

describe("seed parsing of the real assignment CSVs", () => {
  const seed = loadSeed();

  it("loads 4 users and 12 properties, 3 per user", () => {
    expect(seed.users.map((u) => u.id)).toEqual(["U001", "U002", "U003", "U004"]);
    expect(seed.properties).toHaveLength(12);
    for (const u of seed.users) expect(seed.properties.filter((p) => p.userId === u.id)).toHaveLength(3);
  });

  it("keeps raw labels and records each normalisation", () => {
    const p011 = seed.properties.find((p) => p.id === "P011")!;
    const p007 = seed.properties.find((p) => p.id === "P007")!;
    expect(p011).toMatchObject({ propertyTypeRaw: "Office", assetClass: "OFFICE" });
    expect(p007).toMatchObject({ propertyTypeRaw: "Commercial Office", assetClass: "OFFICE" });
    expect(seed.notes.filter((n) => n.includes("normalised to OFFICE"))).toHaveLength(3);
  });

  it("never imputes purchase price", () => {
    expect(seed.properties.every((p) => p.purchasePriceInr === null)).toBe(true);
    expect(seed.notes).toContain("purchase_price_inr blank for 12/12 properties (kept null, not imputed)");
  });

  it("finds no rent/occupancy inconsistencies in the seed data", () => {
    expect(seed.notes.filter((n) => n.startsWith("WARNING"))).toEqual([]);
  });

  it("parses value preferences that mix numbers and ranges", () => {
    expect(parseValuePreference("50000000")).toEqual({ min: 50_000_000, max: 50_000_000 });
    expect(parseValuePreference("30000000-80000000")).toEqual({ min: 30_000_000, max: 80_000_000 });
    expect(parseValuePreference("flexible")).toEqual({ min: null, max: null });
  });

  it("rejects malformed rows with file and line number", () => {
    const users = "user_id,name,city,preferences,preferred_locations,portfolio_value_preference_inr\nU001,A,Mumbai,x,y,1\n";
    const header =
      "property_id,user_id,property_type,sub_type,location,area_sqft,current_estimated_value_inr,purchase_price_inr,annual_rent_inr,occupancy_status,tenant_status,ownership_percent,status\n";
    expect(() => buildSeed(users, header + 'P001,U001,Retail,x,"A, Mumbai",abc,1,,0,Vacant,No,100,Active\n')).toThrow(
      /properties\.csv line 2: area_sqft/,
    );
    expect(() => buildSeed(users, header + 'P001,U999,Retail,x,"A, Mumbai",1,1,,0,Vacant,No,100,Active\n')).toThrow(
      /unknown user U999/,
    );
  });

  it("reports (does not fix) inconsistent rent/occupancy", () => {
    const users = "user_id,name,city,preferences,preferred_locations,portfolio_value_preference_inr\nU001,A,Mumbai,x,y,1\n";
    const header =
      "property_id,user_id,property_type,sub_type,location,area_sqft,current_estimated_value_inr,purchase_price_inr,annual_rent_inr,occupancy_status,tenant_status,ownership_percent,status\n";
    const s = buildSeed(users, header + 'P001,U001,Retail,x,"A, Mumbai",1,100,,500,Vacant,No,100,Active\n');
    expect(s.properties[0]!.annualRentInr).toBe(500);
    expect(s.notes.some((n) => n.startsWith("WARNING P001"))).toBe(true);
  });
});
