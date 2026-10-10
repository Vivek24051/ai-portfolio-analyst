// In-memory Stores for unit tests and offline evaluation runs. Mirrors the Prisma scoping rules.
// The transaction snapshots state and restores it if fn throws, so tests can rely on atomicity.

import type { Property, UserProfile } from "@/domain/types";
import type {
  AgentRunRecord,
  ConversationRecord,
  MessageRecord,
  PendingActionRecord,
  Stores,
  ToolCallRecord,
} from "./types";

interface MemoryState {
  users: UserProfile[];
  properties: Property[];
  pendingActions: PendingActionRecord[];
  audits: Array<{ propertyId: string; userId: string; action: string; pendingActionId: string }>;
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  runs: Array<{ run: AgentRunRecord; toolCalls: ToolCallRecord[] }>;
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
    conversations: [],
    messages: [],
    runs: [],
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
    conversations: {
      async create(userId, now) {
        const c: ConversationRecord = {
          id: nextId("C"),
          userId,
          state: {},
          needsAttention: false,
          attentionReason: null,
          attentionResolvedAt: null,
          attentionResolvedBy: null,
          createdAt: now,
          lastMessageAt: now,
        };
        state.conversations.push(c);
        return clone(c);
      },
      async get(userId, conversationId) {
        return clone(state.conversations.find((c) => c.id === conversationId && c.userId === userId) ?? null);
      },
      async listByUser(userId) {
        return clone(
          state.conversations
            .filter((c) => c.userId === userId)
            .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime()),
        );
      },
      async recentMessages(userId, conversationId, limit) {
        if (!state.conversations.some((c) => c.id === conversationId && c.userId === userId)) return [];
        // Array order is insertion order, which is the conversation's sequence.
        return clone(state.messages.filter((m) => m.conversationId === conversationId).slice(-limit));
      },
      async appendTurn(userId, conversationId, turn) {
        const c = state.conversations.find((x) => x.id === conversationId && x.userId === userId);
        if (!c) throw new Error(`Conversation ${conversationId} not found for user`);
        for (const m of turn.messages) {
          state.messages.push({ ...clone(m), id: nextId("M"), conversationId, createdAt: turn.now });
        }
        c.state = clone(turn.state);
        c.lastMessageAt = turn.now;
        if (turn.attentionReason) {
          c.needsAttention = true;
          c.attentionReason = turn.attentionReason;
          c.attentionResolvedAt = null;
          c.attentionResolvedBy = null;
        }
      },
    },
    runs: {
      async record(run, toolCalls) {
        state.runs.push(clone({ run, toolCalls }));
      },
    },
    admin: {
      async listConversations({ userId, needsAttention, limit }) {
        return clone(
          state.conversations
            .filter((c) => (userId === undefined || c.userId === userId) && (needsAttention === undefined || c.needsAttention === needsAttention))
            .sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
            .slice(0, limit),
        );
      },
      async getConversation(conversationId) {
        return clone(state.conversations.find((c) => c.id === conversationId) ?? null);
      },
      async listMessages(conversationId, limit) {
        return clone(state.messages.filter((m) => m.conversationId === conversationId).slice(-limit));
      },
      async listRuns({ conversationId, limit }) {
        return clone(
          state.runs
            .filter((r) => conversationId === undefined || r.run.conversationId === conversationId)
            .slice()
            .reverse()
            .slice(0, limit),
        );
      },
      async countMessages(conversationIds) {
        return Object.fromEntries(conversationIds.map((id) => [id, state.messages.filter((m) => m.conversationId === id).length]));
      },
      async resolveAttention(conversationId, by, at) {
        const c = state.conversations.find((x) => x.id === conversationId);
        if (!c || !c.needsAttention) return false;
        c.needsAttention = false;
        c.attentionResolvedAt = at;
        c.attentionResolvedBy = by;
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
