import { describe, expect, it } from "vitest";
import { normalizeAssetClass, normalizeOccupancy, NormalizationError, sectorOf } from "@/domain/normalize";
import { expandPlace, matchesCity, matchesLocality, parseLocation } from "@/domain/location";

describe("normalizeAssetClass", () => {
  it("maps the inconsistent seed labels", () => {
    expect(normalizeAssetClass("Commercial Office")).toBe("OFFICE");
    expect(normalizeAssetClass("Office")).toBe("OFFICE");
    expect(normalizeAssetClass("Retail")).toBe("RETAIL");
    expect(normalizeAssetClass("Residential")).toBe("RESIDENTIAL");
  });

  it("maps common sub-type wording and is case/space tolerant", () => {
    expect(normalizeAssetClass("  office   floor ")).toBe("OFFICE");
    expect(normalizeAssetClass("Mall retail")).toBe("RETAIL");
    expect(normalizeAssetClass("Villa")).toBe("RESIDENTIAL");
    expect(normalizeAssetClass("apartments")).toBe("RESIDENTIAL");
  });

  it("refuses to guess ambiguous or unknown labels", () => {
    expect(() => normalizeAssetClass("Commercial")).toThrow(NormalizationError);
    expect(() => normalizeAssetClass("Warehouse")).toThrow(NormalizationError);
  });

  it("COMMERCIAL sector = retail + office", () => {
    expect(sectorOf("RETAIL")).toBe("COMMERCIAL");
    expect(sectorOf("OFFICE")).toBe("COMMERCIAL");
    expect(sectorOf("RESIDENTIAL")).toBe("RESIDENTIAL");
  });
});

describe("normalizeOccupancy", () => {
  it("maps seed values", () => {
    expect(normalizeOccupancy("Tenanted")).toBe("TENANTED");
    expect(normalizeOccupancy("Vacant")).toBe("VACANT");
    expect(normalizeOccupancy("Self-occupied")).toBe("SELF_OCCUPIED");
  });
  it("rejects unknown values", () => {
    expect(() => normalizeOccupancy("Under construction")).toThrow(NormalizationError);
  });
});

describe("parseLocation", () => {
  it("splits Locality, City", () => {
    expect(parseLocation("Bandra West, Mumbai")).toEqual({ locality: "Bandra West", city: "Mumbai", state: null });
    expect(parseLocation("Noida Sector 62, Noida")).toEqual({ locality: "Noida Sector 62", city: "Noida", state: null });
  });

  it("treats a trailing state as a state, not a city (Alibaug)", () => {
    expect(parseLocation("Alibaug, Maharashtra")).toEqual({ locality: "Alibaug", city: "Alibaug", state: "Maharashtra" });
  });

  it("keeps Delhi as a city", () => {
    expect(parseLocation("Connaught Place, Delhi").city).toBe("Delhi");
  });

  it("canonicalises old city names", () => {
    expect(parseLocation("Koramangala, Bangalore").city).toBe("Bengaluru");
    expect(parseLocation("Sector 29, Gurgaon").city).toBe("Gurugram");
  });
});

describe("city / locality matching", () => {
  it("Mumbai does not match Alibaug", () => {
    expect(matchesCity("Mumbai", "mumbai")).toBe(true);
    expect(matchesCity("Alibaug", "Mumbai")).toBe(false);
  });

  it("Delhi NCR expands to Gurugram and Noida", () => {
    expect(expandPlace("Delhi NCR")).toContain("Gurugram");
    expect(matchesCity("Noida", "Delhi NCR")).toBe(true);
    expect(matchesCity("Gurugram", "NCR")).toBe(true);
    expect(matchesCity("Gurugram", "Gurgaon")).toBe(true);
  });

  it("locality is a case-insensitive substring match", () => {
    expect(matchesLocality("Bandra West", "bandra")).toBe(true);
    expect(matchesLocality("Lower Parel", "Bandra")).toBe(false);
  });
});
