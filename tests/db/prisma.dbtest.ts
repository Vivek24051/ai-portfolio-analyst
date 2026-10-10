// OPT-IN PostgreSQL integration suite (real database, real Prisma client). Not part of `npm test`.
//
//   TEST_DATABASE_URL="postgresql://USER:PASS@localhost:5435/portfolio_analyst_test" npm run test:db
//
// Safety: see ./guard.ts. Nothing is written until the guard has positively identified a dedicated
// test database (test-named, not DATABASE_URL/DIRECT_URL, and empty or previously marked).
// Without TEST_DATABASE_URL every test is SKIPPED — skipped tests prove nothing about Postgres.

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConversationTrace, getOverview, listConversationsForAdmin, resolveAttention } from "@/server/admin/adminService";
import { handleChatTurn, handlePendingActionDecision } from "@/server/services/chatService";
import { confirmPendingAction, proposeUpdate } from "@/server/services/propertyActions";
import { createPrismaStores } from "@/server/stores/prisma";
import type { Stores } from "@/server/stores/types";
import { seedDatabase } from "../../prisma/seedDatabase";
import { scriptedModel, text, toolCall } from "../agentHelpers";
import { loadSeed } from "../helpers";
import {
  APP_TABLES,
  assessLiveState,
  assessTestDatabaseUrl,
  DRIFT_ARGS,
  INFORMATION_SCHEMA_TABLES_SQL,
  LIST_RELATIONS_SQL,
  markerSql,
  prepareTestDatabase,
  prismaCli,
  TEST_DB_MARKER,
  type LiveState,
  type TableRef,
} from "./guard";

const urlCheck = assessTestDatabaseUrl(process.env);
const enabled = urlCheck.ok;
if (!enabled) console.warn(`[test:db] SKIPPED — ${urlCheck.reason}`);

type RawClient = Pick<PrismaClient, "$queryRawUnsafe">;

/** Read-only live facts used by the guard (system catalog, not information_schema). */
async function readLiveState(client: RawClient): Promise<LiveState> {
  const [db] = await client.$queryRawUnsafe<Array<{ current_database: string }>>("SELECT current_database()");
  const tables = await client.$queryRawUnsafe<TableRef[]>(LIST_RELATIONS_SQL);
  const [row] = await client.$queryRawUnsafe<Array<{ comment: string | null }>>(
    `SELECT shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = current_database()`,
  );
  return { currentDatabase: db!.current_database, tables, comment: row?.comment ?? null };
}

class Rollback extends Error {}
/** Runs fn in a transaction that is ALWAYS rolled back, so probes leave nothing behind. */
async function inRolledBackTransaction(fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

let prisma: PrismaClient;
let stores: Stores;
const seed = loadSeed();

/** A second client/stores pair: simulates a different serverless instance reading the same data. */
async function freshInstance() {
  const p = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  return { p, s: createPrismaStores(p) };
}

async function resetAndSeed() {
  // Schema-qualified: only this app's tables in "public" (the guard has verified nothing else exists).
  await prisma.$executeRawUnsafe(`TRUNCATE ${APP_TABLES.map((t) => `"public"."${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await seedDatabase(prisma, seed);
}

const deps = (model: Parameters<typeof scriptedModel>[1] | ReturnType<typeof scriptedModel>, fallback: ReturnType<typeof scriptedModel> | null = null) => ({
  stores,
  router: { primary: Array.isArray(model) ? scriptedModel("primary", model) : model, fallback, callTimeoutMs: 5_000 },
  historyLimit: 30,
  turnDeadlineMs: 20_000,
});

describe.skipIf(!enabled)("PostgreSQL integration (opt-in)", () => {
  beforeAll(async () => {
    if (!urlCheck.ok) throw new Error("unreachable");
    const url = process.env.TEST_DATABASE_URL!;
    prisma = new PrismaClient({ datasourceUrl: url });

    // Read-only inspection → decision → marker (verified DB only) → migrate. Refusal throws first.
    await prepareTestDatabase(
      {
        readState: () => readLiveState(prisma),
        mark: async (verified) => {
          await prisma.$executeRawUnsafe(markerSql(verified));
        },
        migrate: async () => {
          const deploy = prismaCli(["migrate", "deploy"], url);
          if (deploy.status !== 0) throw new Error(`prisma migrate deploy failed:
${deploy.output}`);
        },
      },
      urlCheck.identity.database,
    );

    stores = createPrismaStores(prisma);
    await resetAndSeed();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe("schema & migrations", () => {
    it("the migrated database matches schema.prisma (no drift)", () => {
      const diff = prismaCli(DRIFT_ARGS, process.env.TEST_DATABASE_URL!); // URL passed via env only
      expect(diff.status, diff.output).toBe(0); // 0 = no difference, 2 = drift
    });

    it("the committed init migration is recorded as applied", async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
        `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`,
      );
      expect(rows.map((r) => r.migration_name)).toContain("20261010000000_init");
      expect(rows.every((r) => r.finished_at !== null)).toBe(true);
    });
  });

  describe("seed", () => {
    it("loads 4 users and 12 properties with exact BigInt money and null purchase prices", async () => {
      expect(await prisma.user.count()).toBe(4);
      expect(await prisma.property.count()).toBe(12);
      const p007 = await prisma.property.findUniqueOrThrow({ where: { id: "P007" } });
      expect(p007).toMatchObject({ userId: "U003", assetClass: "OFFICE", propertyTypeRaw: "Commercial Office", currentValueInr: 240_000_000n, annualRentInr: 16_800_000n, purchasePriceInr: null });
      const p006 = await prisma.property.findUniqueOrThrow({ where: { id: "P006" } });
      expect(p006).toMatchObject({ city: "Alibaug", state: "Maharashtra" });
    });

    it("is idempotent: re-seeding keeps counts and bumps the version", async () => {
      await seedDatabase(prisma, seed);
      expect(await prisma.property.count()).toBe(12);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: "P001" } })).version).toBe(2);
      await resetAndSeed();
    });
  });

  describe("user-scoped queries", () => {
    it("never returns or modifies another user's property", async () => {
      expect((await stores.properties.listByUser("U001")).map((p) => p.id).sort()).toEqual(["P001", "P002", "P003"]);
      expect(await stores.properties.getForUser("U001", "P004")).toBeNull();
      expect(await stores.properties.update("U001", "P004", 1, { currentValueInr: 1 }, { pendingActionId: "x" })).toBeNull();
      expect((await prisma.property.findUniqueOrThrow({ where: { id: "P004" } })).currentValueInr).toBe(64_000_000n);
    });
  });

  describe("conversation persistence", () => {
    it("a chat turn persists messages (in order), state, run and tool calls — readable from another instance", async () => {
      const t = await handleChatTurn(deps([toolCall("search_properties", { filter: { assetClasses: ["RETAIL"] } }), text("P001 and P003.")]), {
        userId: "U001",
        message: "Show my retail properties",
      });
      const { p, s } = await freshInstance();
      try {
        const msgs = await s.conversations.recentMessages("U001", t.conversationId, 30);
        expect(msgs.map((m) => m.role)).toEqual(["USER", "ASSISTANT", "TOOL", "ASSISTANT"]);
        expect(msgs[1]!.toolCalls?.[0]).toMatchObject({ name: "search_properties", args: { filter: { assetClasses: ["RETAIL"] } } });
        const conv = await s.conversations.get("U001", t.conversationId);
        expect((conv!.state as { focusPropertyIds: string[] }).focusPropertyIds).toEqual(["P001", "P003"]);
        expect(await s.conversations.get("U002", t.conversationId)).toBeNull(); // cross-user
        const [run] = await s.admin.listRuns({ conversationId: t.conversationId, limit: 5 });
        expect(run!.run).toMatchObject({ status: "OK", userId: "U001", llmCalls: 2, toolCallCount: 1 });
        expect(run!.toolCalls.map((c) => c.name)).toEqual(["search_properties"]);
      } finally {
        await p.$disconnect();
      }
    });
  });

  describe("proposal / confirmation", () => {
    it("propose → Confirm button → value updated once, version bumped, audit row written", async () => {
      const t = await handleChatTurn(deps([toolCall("propose_property_update", { propertyId: "P001", changes: { value: { amount: 12.5, unit: "CRORE" } } }), text("Confirm?")]), {
        userId: "U001",
        message: "Set Bandra to 12.5 Cr",
      });
      expect((await prisma.property.findUniqueOrThrow({ where: { id: "P001" } })).currentValueInr).toBe(120_000_000n); // not saved yet
      const id = t.pendingAction!.id;
      const c = await handlePendingActionDecision({ stores }, { userId: "U001", conversationId: t.conversationId, pendingActionId: id, decision: "confirm" });
      expect(c.reply).toContain("Saved");
      const p001 = await prisma.property.findUniqueOrThrow({ where: { id: "P001" } });
      expect(p001.currentValueInr).toBe(125_000_000n);
      expect(await prisma.propertyAudit.count({ where: { propertyId: "P001", pendingActionId: id } })).toBe(1);
      const again = await handlePendingActionDecision({ stores }, { userId: "U001", conversationId: t.conversationId, pendingActionId: id, decision: "confirm" });
      expect(again.reply).toMatch(/already/i);
      await expect(
        handlePendingActionDecision({ stores }, { userId: "U002", conversationId: t.conversationId, pendingActionId: id, decision: "confirm" }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("optimistic locking: a concurrent change makes the older proposal fail and roll back", async () => {
      await resetAndSeed();
      const conv = await stores.conversations.create("U001", new Date());
      const ctx = (runId: string) => ({ userId: "U001", conversationId: conv.id, runId, now: new Date() });
      const first = await proposeUpdate(stores, ctx("r1"), "P001", { value: { amount: 13, unit: "CRORE" } });
      await prisma.property.update({ where: { id: "P001" }, data: { version: { increment: 1 } } }); // someone else wrote
      if (first.status !== "proposed") throw new Error(first.status);
      const r = await confirmPendingAction(stores, ctx("r2"), first.pendingActionId, { via: "button" });
      expect(r.status).toBe("version_conflict");
      expect((await prisma.property.findUniqueOrThrow({ where: { id: "P001" } })).currentValueInr).toBe(120_000_000n);
      expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: first.pendingActionId } })).status).toBe("CANCELLED");
    });
  });

  describe("admin attention data", () => {
    it("failures flag conversations; admin lists them first; resolve keeps the reason; a later failure re-flags", async () => {
      await resetAndSeed();
      const ok = await handleChatTurn(deps([text("Hello.")]), { userId: "U003", message: "hi" });
      const bad = await handleChatTurn(deps([new Error("503")], scriptedModel("fallback", [new Error("503")])), { userId: "U002", message: "total?" });
      expect(bad.status).toBe("error");

      const list = await listConversationsForAdmin(stores);
      expect(list[0]).toMatchObject({ id: bad.conversationId, needsAttention: true, attentionReason: "model_unavailable", lastRunStatus: "ERROR" });
      expect(list.find((r) => r.id === ok.conversationId)).toMatchObject({ needsAttention: false, messages: 2 });
      const overview = await getOverview(stores);
      expect(overview.attention.map((a) => a.conversationId)).toEqual([bad.conversationId]);

      expect(await resolveAttention(stores, bad.conversationId, "admin")).toMatchObject({ resolved: true });
      const resolved = await prisma.conversation.findUniqueOrThrow({ where: { id: bad.conversationId } });
      expect(resolved).toMatchObject({ needsAttention: false, attentionReason: "model_unavailable", attentionResolvedBy: "admin" });

      await handleChatTurn(deps([new Error("503")]), { userId: "U002", conversationId: bad.conversationId, message: "again" });
      expect(await prisma.conversation.findUniqueOrThrow({ where: { id: bad.conversationId } })).toMatchObject({ needsAttention: true, attentionResolvedAt: null });

      const trace = await getConversationTrace(stores, bad.conversationId);
      expect(trace.runs.every((r) => r.status === "ERROR")).toBe(true);
      expect(trace.messages.length).toBe(4);
    });
  });

  // Live guard probes. Every probe runs in a transaction that is rolled back, so the dedicated test
  // database is left exactly as before; nothing is created outside it (no roles, no other DBs).
  describe("guard live inspection (rolled-back probes)", () => {
    const expected = () => (urlCheck.ok ? urlCheck.identity.database : "");

    it("materialized views and tables in another schema are seen by the catalog and refused before any write", async () => {
      await inRolledBackTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA guard_probe`);
        await tx.$executeRawUnsafe(`CREATE TABLE guard_probe.orders (id int)`);
        await tx.$executeRawUnsafe(`CREATE MATERIALIZED VIEW public.guard_probe_mv AS SELECT 1 AS x`);
        await tx.$executeRawUnsafe(`CREATE TABLE public.guard_probe_parted (id int) PARTITION BY RANGE (id)`);

        const viaCatalog = await tx.$queryRawUnsafe<TableRef[]>(LIST_RELATIONS_SQL);
        const viaInfo = await tx.$queryRawUnsafe<TableRef[]>(INFORMATION_SCHEMA_TABLES_SQL);
        expect(viaCatalog).toEqual(expect.arrayContaining([
          { schema: "guard_probe", name: "orders", kind: "r" },
          { schema: "public", name: "guard_probe_mv", kind: "m" },
          { schema: "public", name: "guard_probe_parted", kind: "p" },
        ]));
        expect(viaInfo.some((t) => t.name === "guard_probe_mv")).toBe(false); // information_schema omits matviews

        const calls: string[] = [];
        const live = await readLiveState(tx);
        await expect(
          prepareTestDatabase({ readState: async () => live, mark: async () => void calls.push("mark"), migrate: async () => void calls.push("migrate") }, expected()),
        ).rejects.toThrow(/outside "public"/);
        expect(calls).toEqual([]); // no marker write, no migration

        // Even inside public only, a matview makes a marked DB "foreign"; an unmarked one is non-empty.
        const publicOnly = { ...live, tables: live.tables.filter((t) => t.schema === "public") };
        expect(assessLiveState({ ...publicOnly, comment: TEST_DB_MARKER }, expected())).toMatchObject({ ok: false, reason: expect.stringMatching(/did not create/) });
        expect(assessLiveState({ ...publicOnly, comment: null }, expected())).toMatchObject({ ok: false, reason: expect.stringMatching(/not marked/) });
      });
    });

    it("objects hidden from information_schema by privileges are still seen via pg_class", async () => {
      await inRolledBackTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE public.guard_probe_hidden (id int)`);
        // Built-in, unprivileged role (no role is created); SET LOCAL ends with the transaction.
        await tx.$executeRawUnsafe(`SET LOCAL ROLE pg_monitor`);
        const viaInfo = await tx.$queryRawUnsafe<TableRef[]>(INFORMATION_SCHEMA_TABLES_SQL);
        const viaCatalog = await tx.$queryRawUnsafe<TableRef[]>(LIST_RELATIONS_SQL);
        expect(viaInfo.some((t) => t.name === "guard_probe_hidden")).toBe(false);
        expect(viaCatalog).toEqual(expect.arrayContaining([{ schema: "public", name: "guard_probe_hidden", kind: "r" }]));
        const live = await readLiveState(tx);
        expect(assessLiveState(live, expected())).toMatchObject({ ok: false });
      });
    });

    it("foreign tables are seen and refused (skipped if postgres_fdw is unavailable)", async (ctx) => {
      let available = true;
      try {
        await inRolledBackTransaction(async (tx) => {
          await tx.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
        });
      } catch {
        available = false;
      }
      if (!available) ctx.skip();
      await inRolledBackTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
        await tx.$executeRawUnsafe(`CREATE SERVER guard_probe_srv FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname 'nonexistent_probe')`);
        await tx.$executeRawUnsafe(`CREATE FOREIGN TABLE public.guard_probe_ft (id int) SERVER guard_probe_srv`);
        const viaCatalog = await tx.$queryRawUnsafe<TableRef[]>(LIST_RELATIONS_SQL);
        expect(viaCatalog).toEqual(expect.arrayContaining([{ schema: "public", name: "guard_probe_ft", kind: "f" }]));
        const live = await readLiveState(tx);
        expect(assessLiveState({ ...live, comment: TEST_DB_MARKER }, expected())).toMatchObject({ ok: false, reason: expect.stringMatching(/did not create/) });
      });
    });

    it("after the probes the database holds only this app's tables (rollback left nothing behind)", async () => {
      const live = await readLiveState(prisma);
      expect(live.comment).toBe(TEST_DB_MARKER);
      expect(live.tables.every((t) => t.schema === "public" && t.kind === "r")).toBe(true);
      expect(assessLiveState(live, expected())).toEqual({ ok: true, action: "already-marked" });
    });
  });
});

// Always present so the run reports clearly whether PostgreSQL was actually exercised.
describe("PostgreSQL integration status", () => {
  it(enabled ? "ENABLED: running against the test database" : `SKIPPED: ${urlCheck.ok ? "" : urlCheck.reason}`, () => {
    expect(true).toBe(true);
  });
});
