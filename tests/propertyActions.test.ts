// Propose → confirm flow and user scoping, against the in-memory Stores.
import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelPendingAction,
  confirmPendingAction,
  PENDING_ACTION_TTL_MS,
  proposeCreate,
  proposeUpdate,
  type ActionContext,
} from "@/server/services/propertyActions";
import { createMemoryStores, type MemoryStores } from "@/server/stores/memory";
import { loadSeed } from "./helpers";

let stores: MemoryStores;
const t0 = new Date("2026-10-10T10:00:00Z");
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: "U001",
  conversationId: "C1",
  runId: "run-1",
  now: t0,
  ...over,
});
const nextTurn = (over: Partial<ActionContext> = {}) => ctx({ runId: "run-2", now: new Date(t0.getTime() + 60_000), ...over });
const p001Value = () => stores.state.properties.find((p) => p.id === "P001")!.currentValueInr;

async function proposeR006() {
  const r = await proposeUpdate(stores, ctx(), "P001", { value: { amount: 12.5, unit: "CRORE" } });
  if (r.status !== "proposed") throw new Error(`expected proposed, got ${r.status}`);
  return r;
}

beforeEach(() => {
  stores = createMemoryStores(loadSeed());
});

describe("propose", () => {
  it("proposing does not write the property", async () => {
    const r = await proposeR006();
    expect(r.diff[0]).toMatchObject({ before: "₹12 Cr", after: "₹12.5 Cr" });
    expect(p001Value()).toBe(120_000_000);
  });

  it("a new proposal supersedes the previous one", async () => {
    const first = await proposeR006();
    await proposeUpdate(stores, ctx(), "P001", { value: { amount: 14, unit: "CRORE" } });
    const old = stores.state.pendingActions.find((a) => a.id === first.pendingActionId)!;
    expect(old.status).toBe("CANCELLED");
  });

  it("duplicate-looking creates are held back until the user says it is new", async () => {
    const input = {
      assetClass: "RETAIL" as const, locality: "Bandra", city: "Mumbai", areaSqft: 5000,
      value: { amount: 12, unit: "CRORE" as const }, occupancyStatus: "VACANT" as const,
    };
    const r = await proposeCreate(stores, ctx(), input);
    expect(r.status).toBe("possible_duplicate");
    expect(stores.state.pendingActions).toHaveLength(0);
    expect((await proposeCreate(stores, ctx(), { ...input, allowDuplicate: true })).status).toBe("proposed");
  });
});

describe("confirm", () => {
  it("button confirmation applies the change once, with audit and version bump", async () => {
    const r = await proposeR006();
    const c = await confirmPendingAction(stores, nextTurn(), r.pendingActionId, { via: "button" });
    expect(c).toMatchObject({ status: "confirmed", property: { id: "P001", currentValueInr: 125_000_000 } });
    expect(stores.state.properties.find((p) => p.id === "P001")!.version).toBe(2);
    expect(stores.state.audits).toEqual([{ propertyId: "P001", userId: "U001", action: "UPDATE", pendingActionId: r.pendingActionId }]);

    const again = await confirmPendingAction(stores, nextTurn(), r.pendingActionId, { via: "button" });
    expect(again.status).toBe("not_pending");
  });

  it("agent cannot confirm in the same turn it proposed", async () => {
    const r = await proposeR006();
    const c = await confirmPendingAction(stores, ctx(), r.pendingActionId, { via: "agent", latestUserMessage: "yes" });
    expect(c.status).toBe("same_turn");
    expect(p001Value()).toBe(120_000_000);
  });

  it("agent confirmation requires a clear yes from the user", async () => {
    const r = await proposeR006();
    const hedged = await confirmPendingAction(stores, nextTurn(), r.pendingActionId, {
      via: "agent",
      latestUserMessage: "yes but make it 13 Cr",
    });
    expect(hedged.status).toBe("not_affirmed");
    expect(p001Value()).toBe(120_000_000);
  });

  it("agent confirmation succeeds on a plain yes in a later turn", async () => {
    const r = await proposeR006();
    const ok = await confirmPendingAction(stores, nextTurn(), r.pendingActionId, { via: "agent", latestUserMessage: "Yes go ahead" });
    expect(ok.status).toBe("confirmed");
    expect(p001Value()).toBe(125_000_000);
  });

  it("expired proposals cannot be confirmed", async () => {
    const r = await proposeR006();
    const late = ctx({ runId: "run-9", now: new Date(t0.getTime() + PENDING_ACTION_TTL_MS + 1) });
    expect((await confirmPendingAction(stores, late, r.pendingActionId, { via: "button" })).status).toBe("expired");
    expect(p001Value()).toBe(120_000_000);
  });

  it("detects a concurrent change (optimistic locking) and rolls back the claim", async () => {
    const r = await proposeR006();
    // Someone else updates P001 after the proposal.
    const other = await proposeUpdate(stores, ctx({ conversationId: "C2", runId: "x" }), "P001", { value: { amount: 13, unit: "CRORE" } });
    if (other.status !== "proposed") throw new Error();
    await confirmPendingAction(stores, nextTurn({ conversationId: "C2" }), other.pendingActionId, { via: "button" });

    const c = await confirmPendingAction(stores, nextTurn(), r.pendingActionId, { via: "button" });
    expect(c.status).toBe("version_conflict");
    expect(p001Value()).toBe(130_000_000);
    expect(stores.state.pendingActions.find((a) => a.id === r.pendingActionId)!.status).toBe("CANCELLED");
  });

  it("confirmed create adds a property to the right user", async () => {
    const r = await proposeCreate(stores, ctx({ userId: "U004" }), {
      assetClass: "RETAIL", locality: "Indiranagar", city: "Bengaluru", areaSqft: 3000,
      value: { amount: 4.2, unit: "CRORE" }, occupancyStatus: "VACANT",
    });
    if (r.status !== "proposed") throw new Error(r.status);
    const c = await confirmPendingAction(stores, nextTurn({ userId: "U004" }), r.pendingActionId, { via: "button" });
    expect(c.status).toBe("confirmed");
    expect((await stores.properties.listByUser("U004")).length).toBe(4);
    expect((await stores.properties.listByUser("U001")).length).toBe(3);
  });

  it("cancel resolves the proposal without writing", async () => {
    const r = await proposeR006();
    expect(await cancelPendingAction(stores, nextTurn(), r.pendingActionId)).toEqual({ status: "cancelled" });
    expect((await confirmPendingAction(stores, nextTurn(), r.pendingActionId, { via: "button" })).status).toBe("not_pending");
  });
});

describe("authorization / user scoping", () => {
  it("stores never return another user's property", async () => {
    expect(await stores.properties.getForUser("U001", "P004")).toBeNull();
    expect((await stores.properties.listByUser("U002")).map((p) => p.id)).toEqual(["P004", "P005", "P006"]);
  });

  it("cannot propose an update to another user's property", async () => {
    const r = await proposeUpdate(stores, ctx(), "P004", { value: { amount: 1, unit: "CRORE" } });
    expect(r.status).toBe("not_found");
    expect(stores.state.pendingActions).toHaveLength(0);
  });

  it("store update refuses cross-user writes", async () => {
    expect(await stores.properties.update("U001", "P004", 1, { currentValueInr: 1 }, { pendingActionId: "x" })).toBeNull();
    expect(stores.state.properties.find((p) => p.id === "P004")!.currentValueInr).toBe(64_000_000);
  });

  it("another user cannot confirm someone else's pending action", async () => {
    const r = await proposeR006();
    const c = await confirmPendingAction(stores, nextTurn({ userId: "U002" }), r.pendingActionId, { via: "button" });
    expect(c.status).toBe("not_found");
    expect(p001Value()).toBe(120_000_000);
  });

  it("a pending action cannot be confirmed from a different conversation", async () => {
    const r = await proposeR006();
    const c = await confirmPendingAction(stores, nextTurn({ conversationId: "C-other" }), r.pendingActionId, { via: "button" });
    expect(c.status).toBe("not_found");
  });
});
