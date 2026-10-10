import "server-only";
// Read models for the operations dashboard. Uses ONLY the storage abstraction (AdminStore +
// user/pending-action ports), so it behaves the same over Prisma and in-memory stores.
//
// Data hygiene for the trace views:
//  - tool args/results are previews (redacted, size-capped), not unrestricted raw payloads;
//  - metrics a provider did not report stay null ("not reported"), never 0.

import { parseConversationState } from "@/agent/conversationState";
import type { LlmCallRecord, Span } from "@/agent/telemetry";
import { notFound } from "@/server/errors";
import { percentile } from "@/lib/stats";
import { redactSecrets, truncate } from "@/server/redact";
import type { AgentRunRecord, ConversationRecord, MessageRecord, PendingActionRecord, Stores } from "@/server/stores/types";

export const PAYLOAD_PREVIEW_CHARS = 1_500;
const LIST_LIMIT = 200;

/** Pretty JSON preview: redacted and capped. */
export function previewPayload(value: unknown, max = PAYLOAD_PREVIEW_CHARS): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return truncate(redactSecrets(text ?? "null"), max);
}

// ---------- Overview ----------

export interface AdminUserRow {
  id: string;
  name: string;
  city: string;
  conversations: number;
  flagged: number;
  lastActivity: string | null;
}

export interface AttentionRow {
  conversationId: string;
  userId: string;
  userName: string;
  reason: string;
  lastMessageAt: string;
}

/** Aggregates over runs actually recorded in this store. Null where there is no data. */
export interface RunMetrics {
  runs: number;
  errorRuns: number;
  fallbackRuns: number;
  /** Over successful runs that made at least one model call. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Runs whose token usage was fully reported by the provider. */
  runsWithTokenUsage: number;
  runsWithCost: number;
  modelsSeen: string[];
}

export { percentile };

export function runMetrics(runs: AgentRunRecord[]): RunMetrics {
  const okModelRuns = runs.filter((r) => r.status === "OK" && r.llmCalls > 0).map((r) => r.totalMs);
  return {
    runs: runs.length,
    errorRuns: runs.filter((r) => r.status === "ERROR").length,
    fallbackRuns: runs.filter((r) => r.fallbackUsed).length,
    latencyP50Ms: percentile(okModelRuns, 50),
    latencyP95Ms: percentile(okModelRuns, 95),
    runsWithTokenUsage: runs.filter((r) => r.promptTokens !== null && r.completionTokens !== null).length,
    runsWithCost: runs.filter((r) => r.costUsd !== null).length,
    modelsSeen: [...new Set(runs.map((r) => r.model).filter((m): m is string => !!m))],
  };
}

export async function getOverview(stores: Stores) {
  const [users, conversations, recent] = await Promise.all([
    stores.users.list(),
    stores.admin.listConversations({ limit: LIST_LIMIT }),
    stores.admin.listRuns({ limit: 500 }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const userRows: AdminUserRow[] = users.map((u) => {
    const mine = conversations.filter((c) => c.userId === u.id);
    const last = mine.map((c) => c.lastMessageAt.getTime()).sort((a, b) => b - a)[0];
    return {
      id: u.id,
      name: u.name,
      city: u.city,
      conversations: mine.length,
      flagged: mine.filter((c) => c.needsAttention).length,
      lastActivity: last === undefined ? null : new Date(last).toISOString(),
    };
  });
  const attention: AttentionRow[] = conversations
    .filter((c) => c.needsAttention)
    .map((c) => ({
      conversationId: c.id,
      userId: c.userId,
      userName: names.get(c.userId) ?? c.userId,
      reason: c.attentionReason ?? "(no reason recorded)",
      lastMessageAt: c.lastMessageAt.toISOString(),
    }));
  return { users: userRows, attention, metrics: runMetrics(recent.map((r) => r.run)), sampledRuns: recent.length };
}

// ---------- Conversation list ----------

export interface AdminConversationRow {
  id: string;
  userId: string;
  userName: string;
  messages: number;
  runs: number;
  errorRuns: number;
  lastRunStatus: "OK" | "ERROR" | null;
  needsAttention: boolean;
  attentionReason: string | null;
  attentionResolvedAt: string | null;
  lastMessageAt: string;
}

export async function listConversationsForAdmin(
  stores: Stores,
  filter: { userId?: string; needsAttention?: boolean } = {},
): Promise<AdminConversationRow[]> {
  const [users, conversations] = await Promise.all([stores.users.list(), stores.admin.listConversations({ ...filter, limit: LIST_LIMIT })]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const counts = await stores.admin.countMessages(conversations.map((c) => c.id));
  return Promise.all(
    conversations.map(async (c) => {
      const runs = (await stores.admin.listRuns({ conversationId: c.id, limit: 100 })).map((r) => r.run);
      return {
        id: c.id,
        userId: c.userId,
        userName: names.get(c.userId) ?? c.userId,
        messages: counts[c.id] ?? 0,
        runs: runs.length,
        errorRuns: runs.filter((r) => r.status === "ERROR").length,
        lastRunStatus: runs[0]?.status ?? null,
        needsAttention: c.needsAttention,
        attentionReason: c.attentionReason,
        attentionResolvedAt: c.attentionResolvedAt?.toISOString() ?? null,
        lastMessageAt: c.lastMessageAt.toISOString(),
      };
    }),
  );
}

// ---------- Conversation trace ----------

export interface TraceMessage {
  id: string;
  role: MessageRecord["role"];
  text: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  toolName: string | null;
  runId: string | null;
  createdAt: string;
}

export interface TraceToolCall {
  position: number;
  name: string;
  ok: boolean;
  error: string | null;
  durationMs: number;
  argsPreview: string;
  resultPreview: string;
}

export interface TraceRun {
  id: string;
  startedAt: string;
  status: "OK" | "ERROR";
  model: string | null;
  fallbackUsed: boolean;
  totalMs: number;
  llmMs: number;
  toolMs: number;
  toolRounds: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  error: string | null;
  spans: Span[];
  llmCalls: LlmCallRecord[];
  toolCalls: TraceToolCall[];
  /** null = not checked (error turn or older run). */
  faithfulness: { checked: number; unsupported: string[] } | null;
}

export interface ConversationTrace {
  conversation: {
    id: string;
    userId: string;
    userName: string;
    createdAt: string;
    lastMessageAt: string;
    needsAttention: boolean;
    attentionReason: string | null;
    attentionResolvedAt: string | null;
    attentionResolvedBy: string | null;
    state: ReturnType<typeof parseConversationState>;
  };
  pendingActions: Array<Pick<PendingActionRecord, "id" | "type" | "propertyId" | "diff"> & { expiresAt: string }>;
  messages: TraceMessage[];
  runs: TraceRun[];
}

interface StoredTimings {
  spans?: Span[];
  llmCalls?: Partial<LlmCallRecord>[];
  toolRounds?: number;
  faithfulness?: { checked: number; unsupported: string[] } | null;
}

function normaliseLlmCall(c: Partial<LlmCallRecord>): LlmCallRecord {
  // Older rows may lack newer fields: absent means "not recorded", which we keep as null.
  return {
    model: c.model ?? "unknown",
    ms: c.ms ?? 0,
    ttftMs: c.ttftMs ?? null,
    streamed: c.streamed ?? false,
    ok: c.ok ?? false,
    error: c.error ? redactSecrets(c.error) : null,
    isFallback: c.isFallback ?? false,
    provider: c.provider ?? null,
    lastResort: c.lastResort ?? false,
    withTools: c.withTools ?? false,
    promptTokens: c.promptTokens ?? null,
    completionTokens: c.completionTokens ?? null,
    costUsd: c.costUsd ?? null,
  };
}

function conversationHeader(c: ConversationRecord, userName: string): ConversationTrace["conversation"] {
  return {
    id: c.id,
    userId: c.userId,
    userName,
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
    needsAttention: c.needsAttention,
    attentionReason: c.attentionReason,
    attentionResolvedAt: c.attentionResolvedAt?.toISOString() ?? null,
    attentionResolvedBy: c.attentionResolvedBy,
    state: parseConversationState(c.state),
  };
}

export async function getConversationTrace(stores: Stores, conversationId: string): Promise<ConversationTrace> {
  const c = await stores.admin.getConversation(conversationId);
  if (!c) throw notFound("Conversation");
  const [user, records, runs, pending] = await Promise.all([
    stores.users.get(c.userId),
    stores.admin.listMessages(c.id, 500),
    stores.admin.listRuns({ conversationId: c.id, limit: 100 }),
    stores.pendingActions.listPending(c.userId, c.id),
  ]);

  return {
    conversation: conversationHeader(c, user?.name ?? c.userId),
    pendingActions: pending.map((a) => ({ id: a.id, type: a.type, propertyId: a.propertyId, diff: a.diff, expiresAt: a.expiresAt.toISOString() })),
    messages: records.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.role === "TOOL" ? previewPayload(safeParse(m.content)) : m.content,
      toolCalls: (m.toolCalls ?? []).map((t) => ({ name: t.name, argsPreview: previewPayload(t.args, 600) })),
      toolName: m.toolName,
      runId: m.runId,
      createdAt: m.createdAt.toISOString(),
    })),
    runs: runs.map(({ run, toolCalls }) => {
      const timings = (run.timings ?? {}) as StoredTimings;
      return {
        id: run.id,
        startedAt: run.startedAt.toISOString(),
        status: run.status,
        model: run.model,
        fallbackUsed: run.fallbackUsed,
        totalMs: run.totalMs,
        llmMs: run.llmMs,
        toolMs: run.toolMs,
        toolRounds: timings.toolRounds ?? null,
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        costUsd: run.costUsd,
        error: run.error ? redactSecrets(run.error) : null,
        spans: timings.spans ?? [],
        faithfulness: timings.faithfulness ?? null,
        llmCalls: (timings.llmCalls ?? []).map(normaliseLlmCall),
        toolCalls: toolCalls.map((t, position) => ({
          position,
          name: t.name,
          ok: t.ok,
          error: t.error,
          durationMs: t.durationMs,
          argsPreview: previewPayload(t.args),
          resultPreview: previewPayload(t.result),
        })),
      };
    }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- Control ----------

export async function resolveAttention(stores: Stores, conversationId: string, admin: string, now = new Date()) {
  const c = await stores.admin.getConversation(conversationId);
  if (!c) throw notFound("Conversation");
  const changed = await stores.admin.resolveAttention(conversationId, admin, now);
  return { conversationId, resolved: changed, alreadyClear: !changed };
}
