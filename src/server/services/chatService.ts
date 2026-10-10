// One chat turn, end to end:
//   authorise → load conversation, history, state, portfolio → build prompt → run agent graph
//   (with deadline) → persist messages + state atomically → record run telemetry → reply.
//
// Failure policy: the user always gets a reply. Model outages, deadlines and unexpected errors
// produce a safe fallback message, the conversation is flagged for attention, and the error is
// recorded on the run. No partial agent output (e.g. half a tool loop) is persisted on failure.

import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { parseConversationState, type ConversationState } from "@/agent/conversationState";
import { runAgent } from "@/agent/graph";
import { messageText, toLangChainMessages, toNewMessages } from "@/agent/memory";
import { ModelUnavailableError, type ModelRouter } from "@/agent/model";
import { createDeadline } from "@/agent/deadline";
import { checkNumericFaithfulness } from "@/agent/faithfulness";
import { safeEmitter, summarizeToolOutcome, toolLabel, type EmitFn } from "@/agent/events";
import { buildSystemPrompt } from "@/agent/prompt";
import { RunRecorder } from "@/agent/telemetry";
import { newTurnEvents, type ToolContext } from "@/agent/tools";
import type { DiffEntry } from "@/domain/propertyChanges";
import { notFound, unauthorized } from "@/server/errors";
import { logError, safeErrorMessage } from "@/server/redact";
import { cancelPendingAction, confirmPendingAction, type ActionContext } from "@/server/services/propertyActions";
import type { NewMessage, PendingActionRecord, Stores } from "@/server/stores/types";
import { formatInr } from "@/domain/money";

export interface ChatDeps {
  stores: Stores;
  router: ModelRouter;
  historyLimit: number;
  turnDeadlineMs: number;
  now?: () => Date;
}

export interface PendingActionView {
  id: string;
  type: PendingActionRecord["type"];
  propertyId: string | null;
  diff: DiffEntry[];
  expiresAt: string;
}

export interface ChatTurnResult {
  conversationId: string;
  runId: string;
  reply: string;
  status: "ok" | "error";
  pendingAction: PendingActionView | null;
  hypothetical: boolean;
  handoff: boolean;
  /** User-safe summary of tools used this turn (labels + outcomes, no raw args/results). */
  toolActivity: ToolActivity[];
  needsAttention: boolean;
  telemetry: {
    totalMs: number;
    llmMs: number;
    toolMs: number;
    llmCalls: number;
    toolCalls: number;
    toolRounds: number;
    model: string | null;
    fallbackUsed: boolean;
  };
}

export const MODEL_UNAVAILABLE_REPLY =
  "Sorry, I'm having trouble reaching my analysis engine right now. Your portfolio is unchanged. Please try again in a minute — I've also flagged this for the team.";
export const INTERNAL_ERROR_REPLY =
  "Sorry, something went wrong on my side and I couldn't answer that. Your portfolio is unchanged, and I've flagged this for the team.";

async function loadPending(stores: Stores, userId: string, conversationId: string, state: ConversationState) {
  if (!state.pendingActionId) return null;
  const a = await stores.pendingActions.get(userId, conversationId, state.pendingActionId);
  if (!a || a.status !== "PENDING") {
    state.pendingActionId = null;
    return null;
  }
  return a;
}

const viewOf = (a: { id: string; type: PendingActionRecord["type"]; propertyId: string | null; diff: DiffEntry[]; expiresAt: string | Date }): PendingActionView => ({
  id: a.id,
  type: a.type,
  propertyId: a.propertyId,
  diff: a.diff,
  expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : a.expiresAt.toISOString(),
});

async function resolveConversation(stores: Stores, userId: string, conversationId: string | undefined, now: Date) {
  if (!conversationId) return stores.conversations.create(userId, now);
  const c = await stores.conversations.get(userId, conversationId);
  if (!c) throw notFound("Conversation"); // includes "belongs to another user"
  return c;
}

export async function handleChatTurn(
  deps: ChatDeps,
  input: { userId: string; conversationId?: string; message: string; /** performance.now() when the HTTP request arrived */ receivedAt?: number },
  onEvent?: EmitFn,
): Promise<ChatTurnResult> {
  const now = (deps.now ?? (() => new Date()))();
  // Timing starts at request receipt when the route provides it, so totals include auth/validation.
  const recorder = new RunRecorder(input.receivedAt);
  if (input.receivedAt !== undefined) recorder.addSpan("request_validation", performance.now() - input.receivedAt);
  const runId = randomUUID();
  const { stores } = deps;

  const user = await stores.users.get(input.userId);
  if (!user) throw unauthorized();
  const conversation = await resolveConversation(stores, user.id, input.conversationId, now);
  const emit = safeEmitter(onEvent);
  emit({ type: "start", conversationId: conversation.id, runId });

  const { history, properties, state, pending } = await recorder.span("context_load", async () => {
    const [records, properties] = await Promise.all([
      stores.conversations.recentMessages(user.id, conversation.id, deps.historyLimit),
      stores.properties.listByUser(user.id),
    ]);
    const state = parseConversationState(conversation.state);
    const pending = await loadPending(stores, user.id, conversation.id, state);
    return { history: toLangChainMessages(records), properties, state, pending };
  });

  const toolCtx: ToolContext = {
    userId: user.id, // trusted: from the authenticated session, never from the model
    conversationId: conversation.id,
    runId,
    now,
    stores,
    latestUserMessage: input.message,
    state: structuredClone(state),
    events: newTurnEvents(),
  };
  const usage: { modelId: string | null; usedFallback: boolean; usedLastResort?: boolean } = { modelId: null, usedFallback: false };
  const userMessage = new HumanMessage(input.message);
  const systemPrompt = buildSystemPrompt({ user, properties, state, pendingAction: pending, now });

  let reply: string;
  let status: "ok" | "error" = "ok";
  let errorText: string | null = null;
  let toolRounds = 0;
  let faithfulness: { checked: number; unsupported: string[] } | null = null;
  let attention: string | null = null;
  let turnMessages: NewMessage[];
  let finalState: ConversationState;

  const deadline = createDeadline(deps.turnDeadlineMs);
  try {
    const result = await recorder.span("agent", () =>
      runAgent([...history, userMessage], { router: deps.router, toolCtx, recorder, systemPrompt, turnSignal: deadline.signal, usage, emit }),
    );
    toolRounds = result.toolRounds;
    const last = result.newMessages.at(-1);
    reply = (last ? messageText(last) : "").trim() || "Sorry, I don't have an answer for that.";
    turnMessages = [...toNewMessages([userMessage], runId), ...toNewMessages(result.newMessages, runId)];
    finalState = { ...toolCtx.state, consecutiveFailures: 0 };

    if (result.stopReason === "tool_limit") attention = "tool_limit: agent hit the tool-round limit";
    // Every figure in the reply must trace to tool output, the user's own words, or data labels.
    const sources = [
      ...[...history, ...result.newMessages].filter((m) => ToolMessage.isInstance(m) || HumanMessage.isInstance(m)).map(messageText),
      input.message,
      ...properties.map((p) => p.locationRaw),
    ];
    const check = checkNumericFaithfulness(reply, sources);
    faithfulness = { checked: check.numbers.length, unsupported: check.unsupported.map((n) => n.raw) };
    if (check.unsupported.length > 0) attention ??= `unsupported_numbers: ${faithfulness.unsupported.slice(0, 5).join(", ")}`;
    const failedTools = recorder.toolCalls.filter((t) => !t.ok).length;
    if (failedTools >= 2) attention ??= `tool_errors: ${failedTools} failed tool calls in one turn`;
    // A real model was configured but unavailable: the reply is a labelled stub answer. Keep the outage visible.
    if (usage.usedLastResort) attention ??= "model_degraded: real model unavailable; answered by the dev stub (last resort)";
    if (toolCtx.events.handoff) attention = `handoff (${toolCtx.events.handoff.reason}): ${toolCtx.events.handoff.note}`;
  } catch (e) {
    status = "error";
    // LangGraph may surface the deadline as its own abort error, so check the signal too.
    const timedOut = deadline.signal.aborted;
    const isModel = e instanceof ModelUnavailableError;
    // Stored on the run and shown in the admin trace: redacted and length-capped.
    errorText = isModel
      ? safeErrorMessage(`${e.message}: ${e.causes.join(" | ")}`, 1000)
      : timedOut
        ? `Turn deadline of ${deps.turnDeadlineMs} ms exceeded`
        : safeErrorMessage(e);
    if (!isModel && !timedOut) logError("chat", e);
    reply = isModel || timedOut ? MODEL_UNAVAILABLE_REPLY : INTERNAL_ERROR_REPLY;
    if (toolCtx.events.confirmedPropertyId) {
      // A confirmed write committed before the failure: never claim nothing changed.
      reply = `Your confirmed change to ${toolCtx.events.confirmedPropertyId} was saved, but I hit a problem finishing my reply. I've flagged this for the team.`;
    }
    // Persist only the user message and the apology. Other side effects in a failed turn are
    // proposals, which are never applied without a later confirmation.
    turnMessages = [
      ...toNewMessages([userMessage], runId),
      { role: "ASSISTANT", content: reply, toolCalls: null, toolCallId: null, toolName: null, runId },
    ];
    finalState = { ...toolCtx.state, consecutiveFailures: state.consecutiveFailures + 1 };
    attention = timedOut ? "turn_timeout" : isModel ? "model_unavailable" : "internal_error";
  } finally {
    deadline.clear();
  }

  await recorder.span("persist", () =>
    stores.conversations.appendTurn(user.id, conversation.id, {
      messages: turnMessages,
      state: finalState,
      attentionReason: attention,
      now,
    }),
  );

  const telemetry = {
    totalMs: recorder.elapsedMs(),
    llmMs: recorder.llmMs(),
    toolMs: recorder.toolMs(),
    llmCalls: recorder.llmCalls.length,
    toolCalls: recorder.toolCalls.length,
    toolRounds,
    model: usage.modelId,
    fallbackUsed: usage.usedFallback,
  };
  await recordRun(stores, recorder, {
    runId, conversationId: conversation.id, userId: user.id, status: status === "ok" ? "OK" : "ERROR", errorText, startedAt: now, telemetry, faithfulness,
  });

  const proposed = toolCtx.events.proposed;
  return {
    conversationId: conversation.id,
    runId,
    reply,
    status,
    pendingAction: proposed && status === "ok" ? viewOf({ ...proposed, id: proposed.pendingActionId, type: proposed.action }) : null,
    hypothetical: toolCtx.events.hypothetical,
    handoff: toolCtx.events.handoff !== null,
    toolActivity: toToolActivity(recorder),
    needsAttention: attention !== null,
    telemetry,
  };
}

async function recordRun(
  stores: Stores,
  recorder: RunRecorder,
  r: {
    runId: string;
    conversationId: string;
    userId: string;
    status: "OK" | "ERROR";
    errorText: string | null;
    startedAt: Date;
    telemetry: ChatTurnResult["telemetry"];
    faithfulness?: { checked: number; unsupported: string[] } | null;
  },
) {
  try {
    const tokens = recorder.tokens();
    await stores.runs.record(
      {
        id: r.runId,
        conversationId: r.conversationId,
        userId: r.userId,
        status: r.status,
        model: r.telemetry.model,
        fallbackUsed: r.telemetry.fallbackUsed,
        totalMs: r.telemetry.totalMs,
        llmMs: r.telemetry.llmMs,
        toolMs: r.telemetry.toolMs,
        llmCalls: r.telemetry.llmCalls,
        toolCallCount: r.telemetry.toolCalls,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        costUsd: recorder.costUsd(), // provider-reported only; null = unknown
        error: r.errorText,
        timings: { spans: recorder.spans, llmCalls: recorder.llmCalls, toolRounds: r.telemetry.toolRounds, faithfulness: r.faithfulness ?? null },
        startedAt: r.startedAt,
      },
      recorder.toolCalls,
    );
  } catch (e) {
    // Telemetry must never break the user's reply.
    logError("chat:record-run", e);
  }
}

// ---------- Deterministic confirm / cancel (button path, no LLM) ----------

export async function handlePendingActionDecision(
  deps: Pick<ChatDeps, "stores" | "now">,
  input: { userId: string; conversationId: string; pendingActionId: string; decision: "confirm" | "cancel" },
): Promise<ChatTurnResult> {
  const now = (deps.now ?? (() => new Date()))();
  const recorder = new RunRecorder();
  const runId = randomUUID();
  const { stores } = deps;

  const user = await stores.users.get(input.userId);
  if (!user) throw unauthorized();
  const conversation = await stores.conversations.get(user.id, input.conversationId);
  if (!conversation) throw notFound("Conversation");
  const state = parseConversationState(conversation.state);
  const ctx: ActionContext = { userId: user.id, conversationId: conversation.id, runId, now };

  let reply: string;
  if (input.decision === "cancel") {
    const r = await cancelPendingAction(stores, ctx, input.pendingActionId);
    if (r.status === "not_found") throw notFound("Pending change");
    reply = r.status === "cancelled" ? "Cancelled — nothing was changed." : "That change was already handled.";
  } else {
    const r = await confirmPendingAction(stores, ctx, input.pendingActionId, { via: "button" });
    if (r.status === "not_found") throw notFound("Pending change");
    if (r.status === "confirmed") {
      const p = r.property;
      reply =
        r.action === "CREATE_PROPERTY"
          ? `✅ Saved. Added ${p.id}: ${p.location}, worth ${formatInr(p.currentValueInr)}.`
          : `✅ Saved. ${p.id} (${p.location}) is updated.`;
      state.focusPropertyIds = [p.id];
    } else {
      reply = `Not saved: ${r.message}`;
    }
  }
  if (state.pendingActionId === input.pendingActionId) state.pendingActionId = null;

  const label = input.decision === "confirm" ? "✅ Confirm" : "✖ Cancel";
  await stores.conversations.appendTurn(user.id, conversation.id, {
    messages: [
      { role: "USER", content: label, toolCalls: null, toolCallId: null, toolName: null, runId },
      { role: "ASSISTANT", content: reply, toolCalls: null, toolCallId: null, toolName: null, runId },
    ],
    state,
    attentionReason: null,
    now,
  });
  const telemetry = {
    totalMs: recorder.elapsedMs(), llmMs: 0, toolMs: 0, llmCalls: 0, toolCalls: 0, toolRounds: 0, model: null, fallbackUsed: false,
  };
  await recordRun(stores, recorder, {
    runId, conversationId: conversation.id, userId: user.id, status: "OK", errorText: null, startedAt: now, telemetry,
  });
  return {
    conversationId: conversation.id, runId, reply, status: "ok", pendingAction: null,
    hypothetical: false, handoff: false, toolActivity: [], needsAttention: false, telemetry,
  };
}


export interface ToolActivity {
  name: string;
  label: string;
  ok: boolean;
  summary: string;
}

export function toToolActivity(recorder: RunRecorder): ToolActivity[] {
  return recorder.toolCalls.map((t) => ({
    name: t.name,
    label: toolLabel(t.name),
    ok: t.ok,
    summary: summarizeToolOutcome(t.name, t.ok, t.result, t.error),
  }));
}
