// Safety guard for the opt-in PostgreSQL integration suite. FAILS CLOSED.
//
// The suite migrates the database it is given and TRUNCATEs this app's tables, so it only ever
// touches a database that is positively identified as a dedicated test database:
//   1. TEST_DATABASE_URL must be set explicitly (DATABASE_URL is never used as a fallback);
//   2. not in production (NODE_ENV=production or running on Vercel);
//   3. not the same host+database as DATABASE_URL/DIRECT_URL from the process env OR any standard
//      dotenv file (.env, .env.local, .env.{development,test,production}[.local]); values that cannot
//      be compared reliably (e.g. $ expansion) fail closed;
//   4. the database NAME contains a "test" token (e.g. portfolio_analyst_test);
//   5. strict URL settings: lowercase names only, no duplicates, allow-listed names only, every
//      `schema` exactly "public"; `options` (which can change search_path) is refused;
//   6. live, read-only inspection BEFORE any write, via the system catalog (pg_class/pg_namespace),
//      which lists relations regardless of ownership or privileges (unlike information_schema):
//      - current_database() must equal the URL's database name;
//      - ordinary/partitioned tables, views, materialized views and foreign tables are inspected in
//        every schema except pg_catalog, information_schema, pg_toast* and temporary schemas;
//      - an unmarked database must contain none of these at all; a marked one may contain only
//        this app's own ORDINARY tables in "public" (anything else → refuse).
// The URL is never placed on a command line and never printed (see prismaCli / redactDbUrls).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const TEST_DB_MARKER = "portfolio-analyst-integration-test";
const TEST_NAME = /(^|[_-])(test|tests|testing)([_-]|$)/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,63}$/;

/** This app's tables (created by prisma/migrations) — the only ones a marked database may hold. */
export const APP_TABLES = ["User", "Property", "Conversation", "Message", "AgentRun", "ToolCall", "PendingAction", "PropertyAudit"] as const;
const ALLOWED_TABLES = new Set<string>([...APP_TABLES, "_prisma_migrations"]);

/** URL query parameters that cannot redirect queries to another schema/database. */
const ALLOWED_PARAMS = new Set([
  "schema",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslaccept",
  "sslpassword",
  "channel_binding",
  "connect_timeout",
  "connection_limit",
  "pool_timeout",
  "socket_timeout",
  "statement_cache_size",
  "pgbouncer",
  "application_name",
]);

export interface DbIdentity {
  host: string;
  port: string;
  database: string;
}

export function parseDbUrl(url: string): DbIdentity | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!database) return null;
    return { host: u.hostname.toLowerCase(), port: u.port || "5432", database };
  } catch {
    return null;
  }
}

const sameDb = (a: DbIdentity, b: DbIdentity) => a.host === b.host && a.port === b.port && a.database === b.database;
const describeDb = (d: DbIdentity) => `${d.database} on ${d.host}:${d.port}`;

export type UrlAssessment = { ok: true; identity: DbIdentity } | { ok: false; reason: string };

/**
 * Strict query-setting check. Ambiguity is refused rather than interpreted:
 *   - names must be exactly lowercase (Prisma matches names case-sensitively; "Schema" would be
 *     ignored by Prisma but could slip past a case-insensitive check);
 *   - no name may appear twice (?schema=public&schema=app: readers disagree on which value wins);
 *   - only allow-listed names; every `schema` value must be exactly "public".
 */
export function checkUrlSettings(url: string): string | null {
  const seen = new Set<string>();
  for (const [key, value] of new URL(url).searchParams) {
    if (key !== key.toLowerCase()) return `URL parameter "${key}" must be lowercase.`;
    if (seen.has(key)) return `URL parameter "${key}" appears more than once; refusing an ambiguous setting.`;
    seen.add(key);
    if (!ALLOWED_PARAMS.has(key)) return `URL parameter "${key}" is not allowed for the test database (it could redirect queries).`;
    if (key === "schema" && value !== "public") return `Only the "public" schema is supported for the test database (got schema="${value}").`;
  }
  return null;
}

// ---------- Application database URLs (process env + dotenv files) ----------

/** Variables that hold the application's database URLs. */
export const APP_URL_VARS = ["DATABASE_URL", "DIRECT_URL"] as const;
/** Dotenv files Next.js and the Prisma CLI may read. Read as text only — never loaded or printed. */
export const APP_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
] as const;

export type DotenvRead = { name: string; value: string } | { name: string; unparseable: string };

/**
 * Minimal dotenv reader for selected variables: skips blank/comment lines, accepts `export KEY=`,
 * single/double/backtick-quoted values (including multi-line ones, which are consumed so their
 * contents are never mistaken for assignments), and unquoted values with ` #` inline comments.
 * Returns values only for `names`; never logs anything.
 */
export function readDotenvVars(text: string, names: readonly string[]): DotenvRead[] {
  const out: DotenvRead[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const name = m[1]!;
    let rest = m[2]!;
    let value: string | null;
    let unparseable: string | null = null;
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      let body = rest.slice(1);
      let close = findClosingQuote(body, q);
      let multiline = false;
      while (close === -1 && i + 1 < lines.length) {
        multiline = true;
        body += "\n" + lines[++i]!;
        close = findClosingQuote(body, q);
      }
      if (close === -1) {
        value = null;
        unparseable = "unterminated quoted value";
      } else {
        value = body.slice(0, close);
        if (multiline) unparseable = "multi-line value";
      }
      rest = "";
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }
    if (!names.includes(name)) continue;
    if (unparseable) out.push({ name, unparseable });
    else out.push({ name, value: value! });
  }
  return out;
}

function findClosingQuote(body: string, q: string): number {
  for (let j = 0; j < body.length; j++) {
    if (body[j] === "\\" && q === '"') {
      j++;
      continue;
    }
    if (body[j] === q) return j;
  }
  return -1;
}

export type FileReader = (fileName: string) => string | null;

/** Default reader: project-root dotenv file as text, or null if it does not exist. Other errors throw. */
export const readProjectFile: FileReader = (fileName) => {
  try {
    return readFileSync(join(process.cwd(), fileName), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};

/**
 * Compares the test target with every application database URL found in the process env and the
 * dotenv files. Returns a refusal reason (never containing any value) or null. Fails closed when a
 * candidate cannot be compared reliably (variable expansion, multi-line/unterminated value,
 * non-URL text, unreadable file).
 */
export function checkAgainstAppUrls(testUrl: string, identity: DbIdentity, env: NodeJS.ProcessEnv, readFile: FileReader): string | null {
  const candidates: Array<{ where: string; name: string; value?: string; unparseable?: string }> = [];
  for (const name of APP_URL_VARS) {
    const v = env[name]?.trim();
    if (v) candidates.push({ where: "the environment", name, value: v });
  }
  for (const file of APP_ENV_FILES) {
    let text: string | null;
    try {
      text = readFile(file);
    } catch {
      return `Could not read ${file} to compare application database URLs; refusing (fail closed).`;
    }
    if (text === null) continue;
    for (const r of readDotenvVars(text, APP_URL_VARS)) {
      candidates.push("value" in r ? { where: file, name: r.name, value: r.value.trim() } : { where: file, name: r.name, unparseable: r.unparseable });
    }
  }
  for (const c of candidates) {
    const label = `${c.name} in ${c.where}`;
    if (c.unparseable) return `${label} could not be compared (${c.unparseable}); refusing (fail closed).`;
    const v = c.value!;
    if (!v) continue;
    if (c.where !== "the environment" && v.includes("$")) {
      return `${label} uses variable expansion ($) and cannot be compared reliably; refusing (fail closed).`;
    }
    if (v === testUrl) return `TEST_DATABASE_URL points at the same database as ${label} (${describeDb(identity)}).`;
    let protocol: string;
    try {
      protocol = new URL(v).protocol;
    } catch {
      return `${label} is not a parseable URL, so it cannot be compared; refusing (fail closed).`;
    }
    if (protocol !== "postgres:" && protocol !== "postgresql:") continue; // a different database type cannot be this Postgres target
    const o = parseDbUrl(v);
    if (!o) return `${label} is a postgres URL without a database name; refusing (fail closed).`;
    if (sameDb(o, identity)) return `TEST_DATABASE_URL points at the same database as ${label} (${describeDb(identity)}).`;
  }
  return null;
}

export interface AssessOptions {
  /** Injectable for tests; defaults to reading the project's dotenv files. */
  readFile?: FileReader;
}

/** Static checks (no connection). */
export function assessTestDatabaseUrl(env: NodeJS.ProcessEnv, options: AssessOptions = {}): UrlAssessment {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return { ok: false, reason: "TEST_DATABASE_URL is not set (the suite never falls back to DATABASE_URL)." };
  if (env.NODE_ENV === "production" || env.VERCEL) return { ok: false, reason: "Refusing to run in a production/Vercel environment." };
  const identity = parseDbUrl(url);
  if (!identity) return { ok: false, reason: "TEST_DATABASE_URL is not a valid postgres:// or postgresql:// URL with a database name." };

  const settings = checkUrlSettings(url);
  if (settings) return { ok: false, reason: settings };

  const sameAsApp = checkAgainstAppUrls(url, identity, env, options.readFile ?? readProjectFile);
  if (sameAsApp) return { ok: false, reason: sameAsApp };

  if (!SAFE_IDENTIFIER.test(identity.database)) return { ok: false, reason: "Database name contains unsupported characters." };
  if (!TEST_NAME.test(identity.database)) {
    return { ok: false, reason: `Database name "${identity.database}" does not contain a "test" token (e.g. portfolio_analyst_test).` };
  }
  return { ok: true, identity };
}

/** pg_class.relkind: r table, p partitioned table, v view, m materialized view, f foreign table. */
export type RelKind = "r" | "p" | "v" | "m" | "f";

export interface TableRef {
  schema: string;
  name: string;
  /** Defaults to "r" (ordinary table) when omitted. */
  kind?: RelKind;
}

export interface LiveState {
  currentDatabase: string;
  /** Data-bearing relations (tables, partitioned tables, views, materialized views, foreign tables) in every non-system schema. */
  tables: TableRef[];
  comment: string | null;
}

export type LiveAssessment = { ok: true; action: "claim-empty" | "already-marked" } | { ok: false; reason: string };

/** Live-state decision (pure). Called with read-only facts, before any write. */
export function assessLiveState(state: LiveState, expectedDatabase: string): LiveAssessment {
  if (state.currentDatabase !== expectedDatabase) {
    return { ok: false, reason: `Connected database "${state.currentDatabase}" does not match the URL's database "${expectedDatabase}". Refusing.` };
  }
  const outsidePublic = state.tables.filter((t) => t.schema !== "public");
  if (outsidePublic.length > 0) {
    const schemas = [...new Set(outsidePublic.map((t) => t.schema))].join(", ");
    return { ok: false, reason: `Database has relations outside "public" (schemas: ${schemas}). Refusing: only a dedicated, single-schema test database is allowed.` };
  }
  if (state.comment === TEST_DB_MARKER) {
    // Only this app's ORDINARY tables: a view/materialized view/foreign table reusing a name is foreign.
    const foreign = state.tables.filter((t) => !ALLOWED_TABLES.has(t.name) || (t.kind ?? "r") !== "r");
    if (foreign.length > 0) {
      return { ok: false, reason: `Marked test database contains ${foreign.length} relation(s) this app did not create. Refusing.` };
    }
    return { ok: true, action: "already-marked" };
  }
  if (state.tables.length === 0) return { ok: true, action: "claim-empty" };
  return {
    ok: false,
    reason: `Database has ${state.tables.length} relation(s) but is not marked as a dedicated test database. Refusing to modify it. Use a NEW, empty database whose name contains "test".`,
  };
}

/** Operations the preparation step needs — injected so the order of operations is unit-testable. */
export interface TestDbOps {
  readState(): Promise<LiveState>;
  /** Writes the marker comment on the given (verified) database. */
  mark(database: string): Promise<void>;
  /** Applies the committed migrations. */
  migrate(): Promise<void>;
}

/**
 * The ONLY entry point that writes during setup. Order: read-only inspection → decision →
 * (marker on the verified current database, if claiming an empty one) → migrate.
 * Any refusal throws before mark()/migrate() are called.
 */
export async function prepareTestDatabase(ops: TestDbOps, expectedDatabase: string): Promise<LiveAssessment & { ok: true }> {
  const state = await ops.readState();
  const decision = assessLiveState(state, expectedDatabase);
  if (!decision.ok) throw new Error(`[test:db] ${decision.reason}`);
  if (decision.action === "claim-empty") await ops.mark(state.currentDatabase);
  await ops.migrate();
  return decision;
}

/**
 * SQL used by readState(). pg_class is readable by every role and lists relations regardless of
 * ownership/privileges — information_schema.tables hides objects the current role cannot access
 * and omits materialized views. Partitions appear as relkind 'r'/'p' and are included.
 */
// String.raw keeps the backslashes, so "_" is a literal underscore in the LIKE patterns.
export const LIST_RELATIONS_SQL = String.raw`SELECT n.nspname AS "schema", c.relname AS "name", c.relkind::text AS "kind"
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_toast%'
    AND n.nspname NOT LIKE 'pg\_temp\_%'`;

/** The previous, privilege-filtered query — kept only so tests can show what it misses. */
export const INFORMATION_SCHEMA_TABLES_SQL = `SELECT table_schema AS "schema", table_name AS "name" FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;

export function markerSql(verifiedDatabase: string): string {
  if (!SAFE_IDENTIFIER.test(verifiedDatabase)) throw new Error("Refusing to mark a database with an unsafe name.");
  return `COMMENT ON DATABASE "${verifiedDatabase}" IS '${TEST_DB_MARKER}'`;
}

/** Removes any database URL (and the given URL's password) from text before it is shown. */
export function redactDbUrls(text: string, url?: string): string {
  let out = text;
  if (url) {
    out = out.split(url).join("<TEST_DATABASE_URL>");
    try {
      const pw = decodeURIComponent(new URL(url).password);
      if (pw) out = out.split(pw).join("<redacted>");
      const rawPw = new URL(url).password;
      if (rawPw) out = out.split(rawPw).join("<redacted>");
    } catch {
      /* not a URL */
    }
  }
  return out.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "<database-url>");
}

/**
 * How the Prisma CLI is invoked: Node runs Prisma's JS entry point directly (no npx, no shell), and
 * the datasource URL travels ONLY in the child environment — never on the command line.
 */
export function prismaInvocation(args: string[], testUrl: string) {
  const require = createRequire(import.meta.url);
  return {
    command: process.execPath,
    argv: [require.resolve("prisma/build/index.js"), ...args],
    options: {
      encoding: "utf8" as const,
      shell: false,
      env: { ...process.env, DATABASE_URL: testUrl, DIRECT_URL: testUrl, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    },
  };
}

export function prismaCli(args: string[], testUrl: string): { status: number | null; output: string } {
  const inv = prismaInvocation(args, testUrl);
  const r = spawnSync(inv.command, inv.argv, inv.options);
  return { status: r.status, output: redactDbUrls(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`, testUrl) };
}

/** Drift check: the database (read via the env datasource URL) vs schema.prisma. 0 = no drift. */
export const DRIFT_ARGS = ["migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"];
