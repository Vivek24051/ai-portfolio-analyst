// Propose → confirm flow for every portfolio write.
//
// The agent can only *propose*. A proposal is validated, checked for near-duplicates, stored as
// a PendingAction and shown to the user as a confirmation card. It is applied only when:
//   1. it belongs to this user AND this conversation,
//   2. it is still PENDING and not expired,
//   3. confirmation arrives in a later turn than the proposal (the model cannot propose and
//      confirm in one turn), and
//   4. the user's latest message is an unambiguous "yes" — or the user tapped the Confirm
//      button, which is a deterministic path with no LLM involved.
// The write and the status change happen in one transaction; updates use optimistic locking.

import { toView, type PropertyView } from "@/domain/analytics";
import { isAffirmative } from "@/domain/affirmation";
import {
  findPossibleDuplicates,
  validateCreate,
  validateUpdate,
  type CreatePropertyInput,
  type DiffEntry,
  type UpdatePropertyChanges,
} from "@/domain/propertyChanges";
import type { PendingActionRecord, Stores } from "@/server/stores/types";

export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

export interface ActionContext {
  userId: string;
  conversationId: string;
  runId: string;
  now: Date;
}

export type ProposeResult =
  | { status: "needs_info"; missing: string[]; errors: string[] }
  | { status: "invalid"; errors: string[] }
  | { status: "not_found"; message: string }
  | { status: "possible_duplicate"; candidates: PropertyView[]; message: string }
  | {
      status: "proposed";
      pendingActionId: string;
      action: "CREATE_PROPERTY" | "UPDATE_PROPERTY";
      propertyId: string | null;
      diff: DiffEntry[];
      expiresAt: string;
      message: string;
    };

/** A new proposal supersedes any older unconfirmed one in the same conversation. */
async function supersedePending(stores: Stores, ctx: ActionContext) {
  for (const old of await stores.pendingActions.listPending(ctx.userId, ctx.conversationId)) {
    await stores.pendingActions.resolve(old.id, "CANCELLED", ctx.now);
  }
}

function proposed(record: PendingActionRecord): ProposeResult {
  return {
    status: "proposed",
    pendingActionId: record.id,
    action: record.type,
    propertyId: record.propertyId,
    diff: record.diff,
    expiresAt: record.expiresAt.toISOString(),
    message: "Not saved yet. Show the user these details and ask them to confirm.",
  };
}

export async function proposeCreate(stores: Stores, ctx: ActionContext, input: CreatePropertyInput): Promise<ProposeResult> {
  const v = validateCreate(input);
  if (v.status !== "ok") return v;

  if (!input.allowDuplicate) {
    const existing = await stores.properties.listByUser(ctx.userId);
    const candidates = findPossibleDuplicates(existing, v.data);
    if (candidates.length > 0) {
      return {
        status: "possible_duplicate",
        candidates,
        message:
          "This looks like an existing property. Ask whether they meant to update it or add a separate property; only retry with allowDuplicate=true if they confirm it is new.",
      };
    }
  }

  return stores.transaction(async (tx) => {
    await supersedePending(tx, ctx);
    const record = await tx.pendingActions.create({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      type: "CREATE_PROPERTY",
      propertyId: null,
      payload: { type: "CREATE_PROPERTY", data: v.data },
      diff: v.diff,
      expectedVersion: null,
      createdInRunId: ctx.runId,
      expiresAt: new Date(ctx.now.getTime() + PENDING_ACTION_TTL_MS),
    });
    return proposed(record);
  });
}

export async function proposeUpdate(
  stores: Stores,
  ctx: ActionContext,
  propertyId: string,
  changes: UpdatePropertyChanges,
): Promise<ProposeResult> {
  const current = await stores.properties.getForUser(ctx.userId, propertyId);
  if (!current || current.status !== "ACTIVE") {
    return { status: "not_found", message: `No active property ${propertyId} in this user's portfolio.` };
  }
  const v = validateUpdate(current, changes);
  if (v.status !== "ok") return v;

  return stores.transaction(async (tx) => {
    await supersedePending(tx, ctx);
    const record = await tx.pendingActions.create({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      type: "UPDATE_PROPERTY",
      propertyId,
      payload: { type: "UPDATE_PROPERTY", patch: v.patch },
      diff: v.diff,
      expectedVersion: current.version,
      createdInRunId: ctx.runId,
      expiresAt: new Date(ctx.now.getTime() + PENDING_ACTION_TTL_MS),
    });
    return proposed(record);
  });
}

class VersionConflict extends Error {}

export type ConfirmResult =
  | { status: "confirmed"; action: PendingActionRecord["type"]; property: PropertyView }
  | {
      status: "not_found" | "not_pending" | "expired" | "same_turn" | "not_affirmed" | "version_conflict";
      message: string;
    };

export interface ConfirmOptions {
  /** "button": explicit UI click (no text check). "agent": model-initiated after a user message. */
  via: "button" | "agent";
  /** Required for via="agent": the user message that triggered this turn. */
  latestUserMessage?: string;
}

export async function confirmPendingAction(
  stores: Stores,
  ctx: ActionContext,
  pendingActionId: string,
  opts: ConfirmOptions,
): Promise<ConfirmResult> {
  const action = await stores.pendingActions.get(ctx.userId, ctx.conversationId, pendingActionId);
  if (!action) return { status: "not_found", message: "No such pending action in this conversation." };
  if (action.status !== "PENDING") {
    return { status: "not_pending", message: `This change was already ${action.status.toLowerCase()}.` };
  }
  if (action.expiresAt.getTime() <= ctx.now.getTime()) {
    await stores.pendingActions.resolve(action.id, "EXPIRED", ctx.now);
    return { status: "expired", message: "This proposal expired. Propose it again if the user still wants it." };
  }
  if (opts.via === "agent") {
    if (action.createdInRunId === ctx.runId) {
      return { status: "same_turn", message: "Ask the user to confirm first; a proposal cannot be confirmed in the same turn." };
    }
    if (!opts.latestUserMessage || !isAffirmative(opts.latestUserMessage)) {
      return { status: "not_affirmed", message: "The user's reply is not a clear yes. Clarify or propose a revised change." };
    }
  }

  return stores.transaction(async (tx): Promise<ConfirmResult> => {
    // Claim first: a concurrent second confirm fails here instead of applying twice.
    if (!(await tx.pendingActions.resolve(action.id, "CONFIRMED", ctx.now))) {
      return { status: "not_pending", message: "This change was already handled." };
    }
    const audit = { pendingActionId: action.id };
    if (action.payload.type === "CREATE_PROPERTY") {
      const created = await tx.properties.create(ctx.userId, action.payload.data, audit);
      return { status: "confirmed", action: action.type, property: toView(created) };
    }
    const updated = await tx.properties.update(ctx.userId, action.propertyId!, action.expectedVersion!, action.payload.patch, audit);
    if (updated === null || updated === "version_conflict") {
      // Throwing rolls back the claim; then mark it cancelled outside the failed transaction.
      throw new VersionConflict();
    }
    return { status: "confirmed", action: action.type, property: toView(updated) };
  }).catch(async (e: unknown) => {
    if (!(e instanceof VersionConflict)) throw e;
    await stores.pendingActions.resolve(action.id, "CANCELLED", ctx.now);
    return {
      status: "version_conflict" as const,
      message: "The property changed after this was proposed. Re-read it and propose again.",
    };
  });
}

export async function cancelPendingAction(stores: Stores, ctx: ActionContext, pendingActionId: string) {
  const action = await stores.pendingActions.get(ctx.userId, ctx.conversationId, pendingActionId);
  if (!action) return { status: "not_found" as const };
  const ok = await stores.pendingActions.resolve(action.id, "CANCELLED", ctx.now);
  return { status: ok ? ("cancelled" as const) : ("not_pending" as const) };
}
