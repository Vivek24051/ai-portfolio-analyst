// Unit/regression tests for the integration-suite safety guard. No database is used: live state
// is faked, and the only process spawned is `prisma validate` (offline, no connection).
import { describe, expect, it } from "vitest";
import {
  APP_TABLES,
  assessLiveState,
  assessTestDatabaseUrl,
  checkUrlSettings,
  readDotenvVars,
  DRIFT_ARGS,
  markerSql,
  parseDbUrl,
  prepareTestDatabase,
  prismaCli,
  prismaInvocation,
  redactDbUrls,
  TEST_DB_MARKER,
  type LiveState,
  type TestDbOps,
} from "./db/guard";

const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;
/** Static assessment with an injected file reader (no real dotenv files are read). */
const assess = (vars: Record<string, string>, files: Record<string, string> = {}) =>
  assessTestDatabaseUrl(env(vars), { readFile: (name) => files[name] ?? null });
const LOCAL_TEST = "postgresql://postgres:pw@localhost:5433/portfolio_analyst_test";
const DB = "portfolio_analyst_test";
const appTables = (schema = "public") => [...APP_TABLES, "_prisma_migrations"].map((name) => ({ schema, name }));

describe("assessTestDatabaseUrl (static, before connecting)", () => {
  it("requires an explicit TEST_DATABASE_URL and never falls back to DATABASE_URL", () => {
    expect(assess({ DATABASE_URL: LOCAL_TEST })).toMatchObject({ ok: false, reason: expect.stringMatching(/not set/) });
  });

  it("refuses production and Vercel environments", () => {
    expect(assess({ TEST_DATABASE_URL: LOCAL_TEST, NODE_ENV: "production" }).ok).toBe(false);
    expect(assess({ TEST_DATABASE_URL: LOCAL_TEST, VERCEL: "1" }).ok).toBe(false);
  });

  it("refuses the same database as DATABASE_URL or DIRECT_URL (even with different credentials/params)", () => {
    const r = assess({ TEST_DATABASE_URL: LOCAL_TEST, DATABASE_URL: "postgres://other:x@LOCALHOST:5433/portfolio_analyst_test?sslmode=disable" });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/same database as DATABASE_URL/) });
    expect(assess({ TEST_DATABASE_URL: LOCAL_TEST, DIRECT_URL: LOCAL_TEST }).ok).toBe(false);
  });

  it("requires a 'test' token in the database name", () => {
    for (const name of ["portfolio_analyst", "neondb", "latest", "contest", "testimony"]) {
      expect(assess({ TEST_DATABASE_URL: `postgresql://u:p@localhost/${name}` }).ok).toBe(false);
    }
    for (const name of ["portfolio_analyst_test", "test", "test_portfolio", "app-testing"]) {
      expect(assess({ TEST_DATABASE_URL: `postgresql://u:p@localhost/${name}` }).ok).toBe(true);
    }
  });

  it("refuses a non-public schema and parameters that could change search_path", () => {
    expect(assess({ TEST_DATABASE_URL: `${LOCAL_TEST}?schema=app` })).toMatchObject({ ok: false, reason: expect.stringMatching(/Only the "public" schema/) });
    expect(assess({ TEST_DATABASE_URL: `${LOCAL_TEST}?options=-c%20search_path%3Dapp` })).toMatchObject({ ok: false, reason: expect.stringMatching(/"options" is not allowed/) });
    expect(assess({ TEST_DATABASE_URL: `${LOCAL_TEST}?search_path=app` }).ok).toBe(false);
  });

  it("accepts allow-listed connection parameters, including schema=public", () => {
    const url = `${LOCAL_TEST}?schema=public&sslmode=require&connect_timeout=15&channel_binding=require`;
    expect(assess({ TEST_DATABASE_URL: url }).ok).toBe(true);
  });

  it("rejects malformed URLs and never includes credentials in reasons", () => {
    expect(assess({ TEST_DATABASE_URL: "mysql://u:p@h/test" }).ok).toBe(false);
    expect(assess({ TEST_DATABASE_URL: "postgresql://u:p@h/" }).ok).toBe(false);
    const r = assess({ TEST_DATABASE_URL: "postgresql://admin:SuperSecret@prod.example/app" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SuperSecret");
  });

  it("parses identity (host lower-cased, default port)", () => {
    expect(parseDbUrl("postgres://u:p@DB.Example.com/x_test")).toEqual({ host: "db.example.com", port: "5432", database: "x_test" });
  });
});

describe("strict URL settings (regression: MEDIUM 2)", () => {
  it("refuses a duplicated schema setting (?schema=public&schema=app)", () => {
    expect(checkUrlSettings(`${LOCAL_TEST}?schema=public&schema=app`)).toMatch(/appears more than once/);
    expect(assess({ TEST_DATABASE_URL: `${LOCAL_TEST}?schema=public&schema=app` }).ok).toBe(false);
  });

  it("refuses non-lowercase parameter names (?Schema=app, ?SSLMODE=require)", () => {
    expect(checkUrlSettings(`${LOCAL_TEST}?Schema=app`)).toMatch(/must be lowercase/);
    expect(checkUrlSettings(`${LOCAL_TEST}?SSLMODE=require`)).toMatch(/must be lowercase/);
  });

  it("refuses duplicated unrelated settings too (?sslmode=require&sslmode=disable)", () => {
    expect(checkUrlSettings(`${LOCAL_TEST}?sslmode=require&sslmode=disable`)).toMatch(/appears more than once/);
  });

  it("refuses an empty or non-public schema value", () => {
    expect(checkUrlSettings(`${LOCAL_TEST}?schema=`)).toMatch(/Only the "public" schema/);
    expect(checkUrlSettings(`${LOCAL_TEST}?schema=Public`)).toMatch(/Only the "public" schema/);
  });

  it("accepts the normal supported URL (?schema=public&sslmode=require)", () => {
    expect(checkUrlSettings(`${LOCAL_TEST}?schema=public&sslmode=require`)).toBeNull();
    expect(checkUrlSettings(LOCAL_TEST)).toBeNull();
    expect(assess({ TEST_DATABASE_URL: `${LOCAL_TEST}?schema=public&sslmode=require` }).ok).toBe(true);
  });
});

describe("application database URLs from process env and dotenv files (regression: LOW 3)", () => {
  const SECRET = "S3cr3t-P4ss";
  const sameDb = `postgresql://app:${SECRET}@localhost:5433/portfolio_analyst_test?sslmode=disable`;
  const otherDb = `postgresql://app:${SECRET}@db.example.com:5432/portfolio_analyst`;
  const noSecretIn = (r: { ok: boolean; reason?: string }) => expect(JSON.stringify(r)).not.toContain(SECRET);

  it("refuses when .env holds the same database (different credentials/params), naming only the file", () => {
    const r = assess({ TEST_DATABASE_URL: LOCAL_TEST }, { ".env": `DATABASE_URL=${sameDb}\n` });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/same database as DATABASE_URL in \.env \(/) });
    noSecretIn(r);
  });

  it("parses .env.local with comments, export, quotes and inline comments", () => {
    const file = [
      "# local settings",
      "",
      "ADMIN_USERNAME=admin   # not relevant",
      `export DIRECT_URL="${sameDb}"   # quoted`,
    ].join("\r\n");
    const r = assess({ TEST_DATABASE_URL: LOCAL_TEST }, { ".env.local": file });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/DIRECT_URL in \.env\.local/) });
    noSecretIn(r);
  });

  it("checks every standard dotenv file (e.g. .env.production.local)", () => {
    const r = assess({ TEST_DATABASE_URL: LOCAL_TEST }, { ".env.production.local": `DATABASE_URL='${sameDb}'` });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/\.env\.production\.local/) });
  });

  it("allows a different application database, empty values and non-Postgres URLs", () => {
    expect(assess({ TEST_DATABASE_URL: LOCAL_TEST, DATABASE_URL: otherDb }, { ".env": `DATABASE_URL=\nDIRECT_URL=""\n`, ".env.local": "DATABASE_URL=file:./dev.db" }).ok).toBe(true);
  });

  it("fails closed when a value cannot be compared reliably", () => {
    const cases: Record<string, string> = {
      expansion: "DATABASE_URL=postgresql://app:${PW}@localhost:5433/portfolio_analyst_test",
      unterminated: `DATABASE_URL="${sameDb}`,
      multiline: `DATABASE_URL="postgresql://app:x@\nlocalhost:5433/portfolio_analyst_test"`,
      notAUrl: "DATABASE_URL=my-database-please",
    };
    for (const [kind, text] of Object.entries(cases)) {
      const r = assess({ TEST_DATABASE_URL: LOCAL_TEST }, { ".env": text });
      expect(r.ok, kind).toBe(false);
      expect(r.ok ? "" : r.reason, kind).toMatch(/fail closed/);
      noSecretIn(r);
    }
  });

  it("fails closed when a dotenv file exists but cannot be read", () => {
    const r = assessTestDatabaseUrl(env({ TEST_DATABASE_URL: LOCAL_TEST }), {
      readFile: (name) => {
        if (name === ".env.local") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return null;
      },
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Could not read \.env\.local/) });
  });

  it("does not mistake text inside another variable's multi-line value for an assignment", () => {
    const file = `PRIVATE_KEY="-----BEGIN-----\nDATABASE_URL=${sameDb}\n-----END-----"\nOTHER=1\n`;
    expect(assess({ TEST_DATABASE_URL: LOCAL_TEST }, { ".env": file }).ok).toBe(true);
  });

  it("readDotenvVars: BOM, export, single quotes, escaped double quotes, inline comments", () => {
    const text = `﻿export DATABASE_URL='a b'\nDIRECT_URL="x\\"y" # c\nDATABASE_URL=plain # trailing\n`;
    expect(readDotenvVars(text, ["DATABASE_URL", "DIRECT_URL"])).toEqual([
      { name: "DATABASE_URL", value: "a b" },
      { name: "DIRECT_URL", value: 'x\\"y' },
      { name: "DATABASE_URL", value: "plain" },
    ]);
  });
});

describe("assessLiveState (read-only facts → decision)", () => {
  const state = (over: Partial<LiveState>): LiveState => ({ currentDatabase: DB, tables: [], comment: null, ...over });

  it("allows an empty database or a marked one containing only this app's tables", () => {
    expect(assessLiveState(state({}), DB)).toEqual({ ok: true, action: "claim-empty" });
    expect(assessLiveState(state({ tables: appTables(), comment: TEST_DB_MARKER }), DB)).toEqual({ ok: true, action: "already-marked" });
  });

  it("REFUSES an empty public schema when another schema has tables (regression: HIGH 1)", () => {
    const r = assessLiveState(state({ tables: [{ schema: "app", name: "orders" }] }), DB);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/outside "public" \(schemas: app\)/) });
  });

  it("refuses tables in another schema even when the database is marked", () => {
    expect(assessLiveState(state({ tables: [...appTables(), { schema: "billing", name: "invoices" }], comment: TEST_DB_MARKER }), DB).ok).toBe(false);
  });

  it("refuses a marked database containing tables this app did not create", () => {
    expect(assessLiveState(state({ tables: [...appTables(), { schema: "public", name: "customers" }], comment: TEST_DB_MARKER }), DB)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/did not create/),
    });
  });

  it("kind-aware: a marked DB may not hold views/materialized views/foreign tables, even under app table names", () => {
    const withExtra = (extra: { schema: string; name: string; kind: "v" | "m" | "f" | "p" }) =>
      assessLiveState(state({ tables: [...appTables().filter((t) => t.name !== extra.name), extra], comment: TEST_DB_MARKER }), DB);
    expect(withExtra({ schema: "public", name: "User", kind: "v" }).ok).toBe(false);
    expect(withExtra({ schema: "public", name: "reporting_mv", kind: "m" }).ok).toBe(false);
    expect(withExtra({ schema: "public", name: "remote_orders", kind: "f" }).ok).toBe(false);
    expect(withExtra({ schema: "public", name: "Message", kind: "p" }).ok).toBe(false);
  });

  it("an unmarked database holding only a materialized view or foreign table is NOT empty", () => {
    expect(assessLiveState(state({ tables: [{ schema: "public", name: "mv", kind: "m" }] }), DB).ok).toBe(false);
    expect(assessLiveState(state({ tables: [{ schema: "public", name: "ft", kind: "f" }] }), DB).ok).toBe(false);
  });

  it("refuses a non-empty, unmarked database even if its name contains 'test'", () => {
    expect(assessLiveState(state({ tables: [{ schema: "public", name: "User" }] }), DB)).toMatchObject({ ok: false, reason: expect.stringMatching(/not marked/) });
  });

  it("REFUSES when current_database() differs from the URL's database (regression: MEDIUM 3)", () => {
    expect(assessLiveState(state({ currentDatabase: "postgres" }), DB)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
  });
});

describe("prepareTestDatabase: order of operations (no writes before the decision)", () => {
  function fakeOps(live: LiveState) {
    const calls: string[] = [];
    const ops: TestDbOps = {
      readState: async () => {
        calls.push("read");
        return live;
      },
      mark: async (db) => {
        calls.push(`mark:${db}`);
      },
      migrate: async () => {
        calls.push("migrate");
      },
    };
    return { ops, calls };
  }

  it("tables in another schema → throws with ONLY the read performed (no marker, no migration)", async () => {
    const { ops, calls } = fakeOps({ currentDatabase: DB, tables: [{ schema: "app", name: "orders" }], comment: null });
    await expect(prepareTestDatabase(ops, DB)).rejects.toThrow(/outside "public"/);
    expect(calls).toEqual(["read"]);
  });

  it("database-name mismatch → throws before any write", async () => {
    const { ops, calls } = fakeOps({ currentDatabase: "other_test", tables: [], comment: null });
    await expect(prepareTestDatabase(ops, DB)).rejects.toThrow(/does not match/);
    expect(calls).toEqual(["read"]);
  });

  it("empty database → marks the VERIFIED current database, then migrates", async () => {
    const { ops, calls } = fakeOps({ currentDatabase: DB, tables: [], comment: null });
    await expect(prepareTestDatabase(ops, DB)).resolves.toMatchObject({ action: "claim-empty" });
    expect(calls).toEqual(["read", `mark:${DB}`, "migrate"]);
  });

  it("already-marked database → migrates without re-marking", async () => {
    const { ops, calls } = fakeOps({ currentDatabase: DB, tables: appTables(), comment: TEST_DB_MARKER });
    await prepareTestDatabase(ops, DB);
    expect(calls).toEqual(["read", "migrate"]);
  });

  it("marker SQL only accepts a safe identifier", () => {
    expect(markerSql(DB)).toBe(`COMMENT ON DATABASE "${DB}" IS '${TEST_DB_MARKER}'`);
    expect(() => markerSql('x"; DROP DATABASE y; --')).toThrow(/unsafe name/);
  });
});

describe("Prisma CLI invocation: no shell, URL only in the environment (regression: HIGH 2)", () => {
  const nasty = "postgresql://user:p%40ss%26w0rd%5E%7C%22%27%24%60@localhost:5435/portfolio_analyst_test?sslmode=disable&connect_timeout=15&application_name=a%26b";

  it("runs Node directly with Prisma's JS entry point, without a shell", () => {
    const inv = prismaInvocation(DRIFT_ARGS, nasty);
    expect(inv.command).toBe(process.execPath);
    expect(inv.argv[0]).toMatch(/prisma[\\/]build[\\/]index\.js$/);
    expect(inv.options.shell).toBe(false);
  });

  it("never puts the URL, password or host string on the command line; drift check uses the env datasource", () => {
    const inv = prismaInvocation(DRIFT_ARGS, nasty);
    const argv = inv.argv.join(" ");
    expect(argv).not.toContain("postgresql://");
    expect(argv).not.toContain("p%40ss");
    expect(DRIFT_ARGS).toContain("--from-schema-datasource");
    expect(DRIFT_ARGS).not.toContain("--from-url");
    expect(inv.options.env.DATABASE_URL).toBe(nasty); // passed byte-for-byte via env
    expect(inv.options.env.DIRECT_URL).toBe(nasty);
  });

  it("a URL with &, %, ^, |, quotes and $ reaches Prisma intact and is not echoed (real spawn, offline `prisma validate`)", () => {
    const r = prismaCli(["validate"], nasty);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/is valid/);
    expect(r.output).not.toContain("p%40ss");
    expect(r.output).not.toContain("postgresql://");
  }, 60_000);

  it("redacts full URLs, the password (raw and decoded) and any other database URL", () => {
    const text = `failed at ${nasty} (password p@ss&w0rd^|"'$\`) also postgres://x:y@h/db`;
    const out = redactDbUrls(text, nasty);
    expect(out).not.toContain("p%40ss");
    expect(out).not.toContain("p@ss&w0rd");
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  });
});
