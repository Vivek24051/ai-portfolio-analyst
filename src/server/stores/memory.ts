// In-memory Stores for unit tests and offline evaluation runs. Mirrors the Prisma scoping rules.
// The transaction snapshots state and restores it if fn throws, so tests can rely on atomicity.

import type { Property, UserProfile } from "@/domain/types";
import type { PendingActionRecord, Stores } from "./types";

interface MemoryState {
  users: UserProfile[];
  properties: Property[];
  pendingActions: PendingActionRecord[];
  audits: Array<{ propertyId: string; userId: string; action: string; pendingActionId: string }>;
}

export interface MemoryStores extends Stores {
  state: MemoryState;
}

export function createMemoryStores(seed: { users: UserProfile[]; properties: Property[] }): MemoryStores {
  const state: MemoryState = {
    users: structuredClone(seed.users),
    properties: structuredClone(seed.properties),
    pendingActions: [],
    audits: [],
  };
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;
  const clone = <T>(v: T): T => structuredClone(v);

  const stores: MemoryStores = {
    state,
    users: {
      async list() {
        return clone(state.users);
      },
      async get(userId) {
        return clone(state.users.find((u) => u.id === userId) ?? null);
      },
    },
    properties: {
      async listByUser(userId) {
        return clone(state.properties.filter((p) => p.userId === userId));
      },
      async getForUser(userId, propertyId) {
        return clone(state.properties.find((p) => p.id === propertyId && p.userId === userId) ?? null);
      },
      async create(userId, data, audit) {
        const property: Property = { ...clone(data), id: nextId("PN"), userId, status: "ACTIVE", version: 1 };
        state.properties.push(property);
        state.audits.push({ propertyId: property.id, userId, action: "CREATE", pendingActionId: audit.pendingActionId });
        return clone(property);
      },
      async update(userId, propertyId, expectedVersion, patch, audit) {
        const p = state.properties.find((x) => x.id === propertyId && x.userId === userId);
        if (!p) return null;
        if (p.version !== expectedVersion) return "version_conflict";
        Object.assign(p, patch, { version: p.version + 1 });
        state.audits.push({ propertyId, userId, action: "UPDATE", pendingActionId: audit.pendingActionId });
        return clone(p);
      },
    },
    pendingActions: {
      async create(action) {
        const record: PendingActionRecord = {
          ...clone(action),
          id: nextId("PA"),
          status: "PENDING",
          createdAt: new Date(),
          resolvedAt: null,
        };
        state.pendingActions.push(record);
        return clone(record);
      },
      async get(userId, conversationId, id) {
        const a = state.pendingActions.find(
          (x) => x.id === id && x.userId === userId && x.conversationId === conversationId,
        );
        return clone(a ?? null);
      },
      async listPending(userId, conversationId) {
        return clone(
          state.pendingActions.filter(
            (x) => x.userId === userId && x.conversationId === conversationId && x.status === "PENDING",
          ),
        );
      },
      async resolve(id, to, at) {
        const a = state.pendingActions.find((x) => x.id === id);
        if (!a || a.status !== "PENDING") return false;
        a.status = to;
        a.resolvedAt = at;
        return true;
      },
    },
    async transaction(fn) {
      const snapshot = clone({ properties: state.properties, pendingActions: state.pendingActions, audits: state.audits });
      try {
        return await fn(stores);
      } catch (e) {
        state.properties = snapshot.properties;
        state.pendingActions = snapshot.pendingActions;
        state.audits = snapshot.audits;
        throw e;
      }
    },
  };
  return stores;
}
