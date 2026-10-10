// Chat UI state as a pure reducer: every transition (send, stream events, confirm, retry) is a
// plain function of (state, action), so it is unit-testable without a browser.

import type { ChatStreamEvent } from "@/agent/events";
import type { ChatTurnResult, PendingActionView, ToolActivity } from "@/server/services/chatService";
import type { ConversationView, DisplayMessage } from "@/server/services/conversationView";

export interface UiMessage extends DisplayMessage {
  /** The safe apology shown when the turn failed server-side. */
  isError?: boolean;
  /** A user message whose request never reached the server (network / HTTP error). */
  failed?: boolean;
}

export interface DraftActivity {
  callId: string;
  label: string;
  state: "running" | "ok" | "failed";
  summary: string | null;
}

export interface Draft {
  text: string;
  statusLabel: string | null;
  activity: DraftActivity[];
}

export interface ChatState {
  conversationId: string | null;
  messages: UiMessage[];
  pendingAction: PendingActionView | null;
  phase: "idle" | "streaming" | "deciding";
  draft: Draft | null;
  error: { message: string; retryText: string | null } | null;
}

export type ChatAction =
  | { type: "reset" }
  | { type: "loaded"; view: ConversationView }
  | { type: "send"; text: string; localId: string; at: string }
  | { type: "event"; event: ChatStreamEvent; at: string }
  | { type: "send_failed"; localId: string; message: string; retryText: string }
  | { type: "retry"; localId: string | null }
  | { type: "decide_start" }
  | { type: "decide_done"; label: string; result: ChatTurnResult; at: string }
  | { type: "decide_failed"; message: string }
  | { type: "dismiss_error" };

export const initialChatState: ChatState = {
  conversationId: null,
  messages: [],
  pendingAction: null,
  phase: "idle",
  draft: null,
  error: null,
};

const RESOLVING_TOOLS = new Set(["confirm_pending_action", "cancel_pending_action"]);

function assistantFrom(result: ChatTurnResult, at: string, id: string): UiMessage {
  return {
    id,
    role: "assistant",
    text: result.reply,
    createdAt: at,
    hypothetical: result.hypothetical,
    toolActivity: result.toolActivity,
    isError: result.status === "error",
  };
}

/** After a turn: a new proposal replaces the card; a confirm/cancel in the turn clears it. */
function nextPending(current: PendingActionView | null, result: ChatTurnResult): PendingActionView | null {
  if (result.pendingAction) return result.pendingAction;
  if (result.toolActivity.some((a: ToolActivity) => RESOLVING_TOOLS.has(a.name))) return null;
  return current;
}

function lastUserText(messages: UiMessage[]): string | null {
  return [...messages].reverse().find((m) => m.role === "user")?.text ?? null;
}

function applyEvent(state: ChatState, event: ChatStreamEvent, at: string): ChatState {
  const draft = state.draft ?? { text: "", statusLabel: null, activity: [] };
  switch (event.type) {
    case "start":
      return { ...state, conversationId: event.conversationId };
    case "status":
      return { ...state, draft: { ...draft, statusLabel: event.label } };
    case "tool_start":
      return {
        ...state,
        draft: {
          ...draft,
          text: "", // any streamed preamble is superseded by tool work
          statusLabel: event.label,
          activity: [...draft.activity, { callId: event.callId, label: event.label, state: "running", summary: null }],
        },
      };
    case "tool_end":
      return {
        ...state,
        draft: {
          ...draft,
          activity: draft.activity.map((a) =>
            a.callId === event.callId ? { ...a, state: event.ok ? "ok" : "failed", summary: event.summary } : a,
          ),
        },
      };
    case "delta":
      return { ...state, draft: { ...draft, text: draft.text + event.text, statusLabel: null } };
    case "reset":
      return { ...state, draft: { ...draft, text: "" } };
    case "done": {
      const r = event.result;
      return {
        ...state,
        conversationId: r.conversationId,
        phase: "idle",
        draft: null,
        messages: [...state.messages, assistantFrom(r, at, `a-${r.runId}`)],
        pendingAction: nextPending(state.pendingAction, r),
        error: r.status === "error" ? { message: "The assistant couldn't complete that.", retryText: lastUserText(state.messages) } : null,
      };
    }
    case "error":
      return {
        ...state,
        phase: "idle",
        draft: null,
        error: { message: event.message, retryText: lastUserText(state.messages) },
      };
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState;
    case "loaded":
      return { ...initialChatState, conversationId: action.view.id, messages: action.view.messages, pendingAction: action.view.pendingAction };
    case "send":
      return {
        ...state,
        phase: "streaming",
        error: null,
        draft: { text: "", statusLabel: "Sending…", activity: [] },
        messages: [
          ...state.messages,
          { id: action.localId, role: "user", text: action.text, createdAt: action.at, hypothetical: false, toolActivity: [] },
        ],
      };
    case "event":
      return applyEvent(state, action.event, action.at);
    case "send_failed":
      return {
        ...state,
        phase: "idle",
        draft: null,
        messages: state.messages.map((m) => (m.id === action.localId ? { ...m, failed: true } : m)),
        error: { message: action.message, retryText: action.retryText },
      };
    case "retry":
      // A request that never reached the server is removed before re-sending, so it isn't duplicated.
      return {
        ...state,
        error: null,
        messages: action.localId ? state.messages.filter((m) => !(m.id === action.localId && m.failed)) : state.messages,
      };
    case "decide_start":
      return { ...state, phase: "deciding", error: null };
    case "decide_done":
      return {
        ...state,
        phase: "idle",
        pendingAction: null,
        messages: [
          ...state.messages,
          { id: `u-${action.result.runId}`, role: "user", text: action.label, createdAt: action.at, hypothetical: false, toolActivity: [] },
          assistantFrom(action.result, action.at, `a-${action.result.runId}`),
        ],
      };
    case "decide_failed":
      return { ...state, phase: "idle", error: { message: action.message, retryText: null } };
    case "dismiss_error":
      return { ...state, error: null };
  }
}
