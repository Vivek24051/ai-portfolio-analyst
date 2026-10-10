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

// ---------- Conversations ----------

export type MessageRole = "USER" | "ASSISTANT" | "TOOL";

export interface StoredToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** Assistant messages: tool calls the model requested. */
  toolCalls: StoredToolCall[] | null;
  /** Tool messages: which call this result answers. */
  toolCallId: string | null;
  toolName: string | null;
  runId: string | null;
  createdAt: Date;
}

export type NewMessage = Omit<MessageRecord, "id" | "conversationId" | "createdAt">;

export interface ConversationRecord {
  id: string;
  userId: string;
  /** Backend-owned structured state (validated by the agent layer on read). */
  state: unknown;
  needsAttention: boolean;
  attentionReason: string | null;
  attentionResolvedAt: Date | null;
  attentionResolvedBy: string | null;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface ConversationStore {
  create(userId: string, now: Date): Promise<ConversationRecord>;
  get(userId: string, conversationId: string): Promise<ConversationRecord | null>;
  listByUser(userId: string): Promise<ConversationRecord[]>;
  /** Last `limit` messages in chronological order. */
  recentMessages(userId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
  /**
   * Atomically appends a turn's messages and saves the new state. `attentionReason` sets the
   * needs-attention flag (and clears any earlier resolution); only an administrator clears it.
   */
  appendTurn(
    userId: string,
    conversationId: string,
    turn: { messages: NewMessage[]; state: unknown; attentionReason: string | null; now: Date },
  ): Promise<void>;
}

// ---------- Run telemetry ----------

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

export interface AgentRunRecord {
  id: string;
  conversationId: string;
  userId: string;
  status: "OK" | "ERROR";
  model: string | null;
  fallbackUsed: boolean;
  totalMs: number;
  llmMs: number;
  toolMs: number;
  llmCalls: number;
  toolCallCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  error: string | null;
  timings: unknown;
  startedAt: Date;
}

export interface RunStore {
  record(run: AgentRunRecord, toolCalls: ToolCallRecord[]): Promise<void>;
}

export interface Stores {
  users: UserStore;
  properties: PropertyStore;
  pendingActions: PendingActionStore;
  conversations: ConversationStore;
  runs: RunStore;
  admin: AdminStore;
  /** Runs fn atomically (DB transaction for Prisma; sequential for in-memory). */
  transaction<T>(fn: (tx: Stores) => Promise<T>): Promise<T>;
}

// ---------- Admin (cross-user, read-mostly) ----------

export interface RunWithToolCalls {
  run: AgentRunRecord;
  toolCalls: ToolCallRecord[];
}

/**
 * The ONLY cross-user access path. Used exclusively by admin-authenticated routes/pages
 * (src/server/admin/*); chat code must never import it. Every other port is user-scoped.
 */
export interface AdminStore {
  /** Flagged conversations first, then newest activity first. */
  listConversations(filter: { userId?: string; needsAttention?: boolean; limit: number }): Promise<ConversationRecord[]>;
  getConversation(conversationId: string): Promise<ConversationRecord | null>;
  /** Chronological, all roles (including tool messages). */
  listMessages(conversationId: string, limit: number): Promise<MessageRecord[]>;
  /** Newest first. */
  listRuns(filter: { conversationId?: string; limit: number }): Promise<RunWithToolCalls[]>;
  countMessages(conversationIds: string[]): Promise<Record<string, number>>;
  /** Clears the needs-attention flag, keeping the reason for the record. False if not flagged. */
  resolveAttention(conversationId: string, by: string, at: Date): Promise<boolean>;
}
