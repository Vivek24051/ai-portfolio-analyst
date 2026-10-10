// Location parsing and matching.
//
// Seed locations are free text "Locality, City", with exceptions:
//  - "Alibaug, Maharashtra": the second segment is a state, not a city.
//  - User U003's city is "Delhi NCR" while properties say "Gurugram" / "Noida".
// So "properties in Mumbai" must NOT include Alibaug, and "Delhi NCR" must expand to its cities.

const CITY_ALIASES: Record<string, string> = {
  bombay: "Mumbai",
  bangalore: "Bengaluru",
  gurgaon: "Gurugram",
  "new delhi": "Delhi",
};

const INDIAN_STATES = new Set(
  [
    // "Delhi" is omitted on purpose: in "Locality, Delhi" it is the city.
    "maharashtra", "karnataka", "haryana", "uttar pradesh", "gujarat", "goa",
    "tamil nadu", "kerala", "telangana", "west bengal", "rajasthan", "punjab",
  ],
);

/** Regions users mention that span several cities. Only NCR appears in the data. */
const REGIONS: Record<string, string[]> = {
  "delhi ncr": ["Delhi", "Gurugram", "Noida", "Ghaziabad", "Faridabad"],
  ncr: ["Delhi", "Gurugram", "Noida", "Ghaziabad", "Faridabad"],
};

export interface ParsedLocation {
  locality: string;
  city: string;
  state: string | null;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function canonicalCity(name: string): string {
  const key = name.trim().toLowerCase();
  return CITY_ALIASES[key] ?? titleCase(name.trim());
}

/**
 * Splits "Locality, City". If the last segment is a state, the locality doubles as the city
 * and the state is recorded separately (documented in DECISIONS.md).
 */
export function parseLocation(raw: string): ParsedLocation {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Location is empty");
  if (parts.length === 1) {
    const only = canonicalCity(parts[0]!);
    return { locality: only, city: only, state: null };
  }
  const last = parts[parts.length - 1]!;
  const locality = parts.slice(0, -1).join(", ");
  if (INDIAN_STATES.has(last.toLowerCase())) {
    return { locality, city: canonicalCity(parts[0]!), state: titleCase(last) };
  }
  return { locality, city: canonicalCity(last), state: null };
}

/** Cities a user-supplied place name refers to, if it is a known city or region. */
export function expandPlace(query: string): string[] {
  const key = query.trim().toLowerCase();
  if (REGIONS[key]) return REGIONS[key];
  return [canonicalCity(query)];
}

/** City match, with region expansion ("Delhi NCR" → Gurugram, Noida, ...). Case-insensitive. */
export function matchesCity(propertyCity: string, query: string): boolean {
  const target = propertyCity.toLowerCase();
  return expandPlace(query).some((c) => c.toLowerCase() === target);
}

/** Substring match on locality ("Bandra" matches "Bandra West"). */
export function matchesLocality(propertyLocality: string, query: string): boolean {
  return propertyLocality.toLowerCase().includes(query.trim().toLowerCase());
}
