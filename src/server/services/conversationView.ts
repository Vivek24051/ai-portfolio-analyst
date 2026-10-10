// Read models for the chat UI: conversation list and a display-ready transcript.
// Business logic stays server-side; the UI only renders these shapes.

import { parseConversationState } from "@/agent/conversationState";
import { summarizeToolOutcome, toolLabel } from "@/agent/events";
import { notFound } from "@/server/errors";
import type { MessageRecord, Stores } from "@/server/stores/types";
import type { PendingActionView, ToolActivity } from "./chatService";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  hypothetical: boolean;
  toolActivity: ToolActivity[];
}

export interface ConversationView {
  id: string;
  messages: DisplayMessage[];
  pendingAction: PendingActionView | null;
}

export interface ConversationSummary {
  id: string;
  lastMessageAt: string;
  preview: string;
}

/** Max messages returned to the UI for one conversation (older ones are not shown). */
export const VIEW_MESSAGE_LIMIT = 200;

function parseToolContent(content: string): { ok: boolean; result: unknown; error: string | null } {
  try {
    const result = JSON.parse(content) as Record<string, unknown> | null;
    const error = result && typeof result === "object" && typeof result.error === "string" ? result.error : null;
    return { ok: error === null, result, error };
  } catch {
    return { ok: false, result: null, error: "internal_error" };
  }
}

export function toDisplayMessages(records: MessageRecord[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let activity: ToolActivity[] = [];
  let hypothetical = false;

  for (const r of records) {
    if (r.role === "USER") {
      activity = [];
      hypothetical = false;
      out.push({ id: r.id, role: "user", text: r.content, createdAt: r.createdAt.toISOString(), hypothetical: false, toolActivity: [] });
    } else if (r.role === "TOOL") {
      const name = r.toolName ?? "unknown";
      const { ok, result, error } = parseToolContent(r.content);
      activity.push({ name, label: toolLabel(name), ok, summary: summarizeToolOutcome(name, ok, result, error) });
      if (name === "run_scenario" && ok) hypothetical = true;
    } else if (!r.toolCalls?.length && r.content.trim()) {
      // Final assistant answer for the turn (intermediate tool-call messages are skipped).
      out.push({ id: r.id, role: "assistant", text: r.content, createdAt: r.createdAt.toISOString(), hypothetical, toolActivity: activity });
      activity = [];
    }
  }
  return out;
}

function previewOf(records: MessageRecord[]): string {
  const last = [...records].reverse().find((r) => r.role === "USER" || (r.role === "ASSISTANT" && !r.toolCalls?.length && r.content));
  const text = last?.content.replace(/\s+/g, " ").trim() ?? "";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export async function listConversations(stores: Stores, userId: string): Promise<ConversationSummary[]> {
  const conversations = await stores.conversations.listByUser(userId);
  return Promise.all(
    conversations.map(async (c) => ({
      id: c.id,
      lastMessageAt: c.lastMessageAt.toISOString(),
      preview: previewOf(await stores.conversations.recentMessages(userId, c.id, 6)),
    })),
  );
}

export async function getConversationView(stores: Stores, userId: string, conversationId: string, now = new Date()): Promise<ConversationView> {
  const conversation = await stores.conversations.get(userId, conversationId);
  if (!conversation) throw notFound("Conversation");
  const records = await stores.conversations.recentMessages(userId, conversationId, VIEW_MESSAGE_LIMIT);

  const state = parseConversationState(conversation.state);
  let pendingAction: PendingActionView | null = null;
  if (state.pendingActionId) {
    const a = await stores.pendingActions.get(userId, conversationId, state.pendingActionId);
    if (a && a.status === "PENDING" && a.expiresAt > now) {
      pendingAction = { id: a.id, type: a.type, propertyId: a.propertyId, diff: a.diff, expiresAt: a.expiresAt.toISOString() };
    }
  }
  return { id: conversation.id, messages: toDisplayMessages(records), pendingAction };
}
