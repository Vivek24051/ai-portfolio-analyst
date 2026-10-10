// Offline migration drift check: the committed init migration must equal what Prisma generates
// from schema.prisma. Runs the Prisma CLI (no database needed). It does NOT prove the SQL applies
// cleanly to a live Postgres — that remains to be verified with `npm run db:deploy`.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const normalise = (s: string) => s.replace(/\r\n/g, "\n").trim();

describe("prisma migrations", () => {
  it("init migration matches schema.prisma (no drift)", () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    // While there is a single migration, "empty → schema" must equal it exactly. With more
    // migrations, switch to `prisma migrate diff --from-migrations … --shadow-database-url …`.
    expect(dirs).toEqual(["20261010000000_init"]);
    const committed = readFileSync(join(MIGRATIONS, dirs[0]!, "migration.sql"), "utf8");
    const generated = execSync("npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Fully offline: disable the Prisma CLI's optional update/telemetry check.
      env: { ...process.env, CHECKPOINT_DISABLE: "1" },
    });
    expect(normalise(generated)).toBe(normalise(committed));
  }, 60_000);
});
