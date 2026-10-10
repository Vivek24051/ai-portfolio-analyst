// Opt-in PostgreSQL integration suite: `npm run test:db` (requires TEST_DATABASE_URL; see tests/db/).
// Kept separate from vitest.config.ts so `npm test` never touches a database.
//
// Reuses the base config's `resolve` (path aliases) rather than mergeConfig(): mergeConfig
// concatenates arrays, which would add the unit-test `include` globs to this suite.
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["tests/db/**/*.dbtest.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
