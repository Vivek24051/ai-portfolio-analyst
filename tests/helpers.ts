import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSeed, type SeedResult } from "@/data/seedData";
import type { Property } from "@/domain/types";

const dir = join(__dirname, "..", "data", "original");

/** The real assignment CSVs, parsed fresh for each call. */
export function loadSeed(): SeedResult {
  return buildSeed(readFileSync(join(dir, "users.csv"), "utf8"), readFileSync(join(dir, "properties.csv"), "utf8"));
}

export function propsOf(userId: string, seed = loadSeed()): Property[] {
  return seed.properties.filter((p) => p.userId === userId);
}

export const CR = 10_000_000;
