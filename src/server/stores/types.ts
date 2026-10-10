// Persistence ports. Every method takes userId and scopes by it: a property or pending action
// owned by someone else is indistinguishable from one that does not exist (returns null).
// Two implementations: Prisma (runtime) and in-memory (unit tests, offline evals).

import type { DiffEntry, NewPropertyData, PropertyPatch } from "@/domain/propertyChanges";
import type { Property, UserProfile } from "@/domain/types";

export type PendingActionType = "CREATE_PROPERTY" | "UPDATE_PROPERTY";
export type PendingActionStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export type PendingActionPayload =
  | { type: "CREATE_PROPERTY"; data: NewPropertyData }
  | { type: "UPDATE_PROPERTY"; patch: PropertyPatch };

export interface PendingActionRecord {
  id: string;
  userId: string;
  conversationId: string;
  type: PendingActionType;
  propertyId: string | null;
  payload: PendingActionPayload;
  diff: DiffEntry[];
  expectedVersion: number | null;
  status: PendingActionStatus;
  createdInRunId: string;
  expiresAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
}

export type NewPendingAction = Omit<PendingActionRecord, "id" | "status" | "createdAt" | "resolvedAt">;

export interface AuditInfo {
  pendingActionId: string;
}

export interface UserStore {
  list(): Promise<UserProfile[]>;
  get(userId: string): Promise<UserProfile | null>;
}

export interface PropertyStore {
  /** All of the user's properties (any status). */
  listByUser(userId: string): Promise<Property[]>;
  getForUser(userId: string, propertyId: string): Promise<Property | null>;
  create(userId: string, data: NewPropertyData, audit: AuditInfo): Promise<Property>;
  /**
   * Applies the patch only if the row still has `expectedVersion` (optimistic locking).
   * Returns null if not found for this user, "version_conflict" if it changed meanwhile.
   */
  update(
    userId: string,
    propertyId: string,
    expectedVersion: number,
    patch: PropertyPatch,
    audit: AuditInfo,
  ): Promise<Property | "version_conflict" | null>;
}

export interface PendingActionStore {
  create(action: NewPendingAction): Promise<PendingActionRecord>;
  get(userId: string, conversationId: string, id: string): Promise<PendingActionRecord | null>;
  listPending(userId: string, conversationId: string): Promise<PendingActionRecord[]>;
  /** Compare-and-set from PENDING; returns false if it was no longer PENDING (prevents double-apply). */
  resolve(id: string, to: Exclude<PendingActionStatus, "PENDING">, at: Date): Promise<boolean>;
}

export interface Stores {
  users: UserStore;
  properties: PropertyStore;
  pendingActions: PendingActionStore;
  /** Runs fn atomically (DB transaction for Prisma; sequential for in-memory). */
  transaction<T>(fn: (tx: Stores) => Promise<T>): Promise<T>;
}
