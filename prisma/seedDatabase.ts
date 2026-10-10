// Database write step of the seed, shared by `npm run db:seed` and the opt-in DB integration tests.

import type { PrismaClient } from "@prisma/client";
import type { SeedResult } from "../src/data/seedData";

/**
 * Interactive-transaction limits for the seed.
 *
 * The seed performs 16 sequential upserts (4 users + 12 properties) in ONE transaction, so it is
 * all-or-nothing. Prisma's defaults (timeout 5 s, maxWait 2 s) are sized for in-region queries:
 * from a developer laptop to a remote serverless Postgres, each upsert is at least one network
 * round trip, so 16+ round trips can approach 5 s, and a database waking from auto-suspend can
 * delay the first connection beyond 2 s. These limits give headroom for that one-off, manual
 * operation without masking a genuinely hung connection. They apply ONLY to the seed; request-path
 * transactions keep Prisma's defaults.
 */
export const SEED_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Upserts seed users and properties. Idempotent; chat-created properties are never touched. */
export async function seedDatabase(prisma: PrismaClient, seed: SeedResult): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const u of seed.users) {
      const data = {
        name: u.name,
        city: u.city,
        preferences: u.preferences,
        preferredLocations: u.preferredLocations,
        portfolioValuePreferenceRaw: u.portfolioValuePreferenceRaw,
        prefMinInr: u.prefMinInr === null ? null : BigInt(u.prefMinInr),
        prefMaxInr: u.prefMaxInr === null ? null : BigInt(u.prefMaxInr),
      };
      await tx.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
    }
    for (const p of seed.properties) {
      const data = {
        userId: p.userId,
        propertyTypeRaw: p.propertyTypeRaw,
        assetClass: p.assetClass,
        subType: p.subType,
        locationRaw: p.locationRaw,
        locality: p.locality,
        city: p.city,
        state: p.state,
        areaSqft: p.areaSqft,
        currentValueInr: BigInt(p.currentValueInr),
        purchasePriceInr: p.purchasePriceInr === null ? null : BigInt(p.purchasePriceInr),
        annualRentInr: BigInt(p.annualRentInr),
        occupancyStatus: p.occupancyStatus,
        ownershipPercent: p.ownershipPercent,
        status: p.status,
        source: "seed",
      };
      await tx.property.upsert({
        where: { id: p.id },
        create: { id: p.id, ...data },
        update: { ...data, version: { increment: 1 } },
      });
    }
  }, SEED_TRANSACTION_OPTIONS);
}
