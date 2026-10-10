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
  const { seedDatabase } = await import("./seedDatabase");
  const prisma = new PrismaClient();
  try {
    await seedDatabase(prisma, seed);
    console.log("Seed complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
