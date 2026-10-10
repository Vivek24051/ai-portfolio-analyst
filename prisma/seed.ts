// Seeds Postgres from the committed synthetic dataset in data/seed/ (unmodified assignment CSVs).
//
//   npm run db:seed          upsert users + seed properties (idempotent; resets seed rows to CSV values)
//   npm run db:seed:dry      parse/validate/normalise only, print the report, no DB connection
//
// Properties created through chat (source = "chat") are never touched by re-seeding.

import { readFileSync } from "node:fs";
import { seedFile } from "../src/data/paths";
import { buildSeed } from "../src/data/seedData";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const seed = buildSeed(
    readFileSync(seedFile("users.csv"), "utf8"),
    readFileSync(seedFile("properties.csv"), "utf8"),
  );

  console.log(`Parsed ${seed.users.length} users and ${seed.properties.length} properties.`);
  console.log("Normalisation notes:");
  for (const note of seed.notes) console.log(`  - ${note}`);

  if (dryRun) {
    console.log("Dry run: no database writes.");
    return;
  }

  // Imported lazily so the dry run works without a generated client or DATABASE_URL.
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
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
    });
    console.log("Seed complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
