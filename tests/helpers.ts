import { readFileSync } from "node:fs";
import { seedFile } from "@/data/paths";
import { buildSeed, type SeedResult } from "@/data/seedData";
import type { Property } from "@/domain/types";

/** The real assignment CSVs, parsed fresh for each call. */
export function loadSeed(): SeedResult {
  return buildSeed(readFileSync(seedFile("users.csv"), "utf8"), readFileSync(seedFile("properties.csv"), "utf8"));
}

export function propsOf(userId: string, seed = loadSeed()): Property[] {
  return seed.properties.filter((p) => p.userId === userId);
}

export const CR = 10_000_000;
