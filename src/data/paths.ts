import { join } from "node:path";

/**
 * Committed synthetic dataset (byte-identical copies of the assignment CSVs).
 * Read-only: used by the Postgres seed, the in-memory store and the tests.
 */
export const SEED_DATA_DIR = join(process.cwd(), "data", "seed");

export const seedFile = (name: "users.csv" | "properties.csv" | "sample_requests.csv") => join(SEED_DATA_DIR, name);
