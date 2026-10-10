"use client";

// WhatsApp-style chat shell. Owns only UI state (via chatReducer); every decision — numbers,
// scoping, confirmations — is made by the server endpoints in src/app/api.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError, streamChat, type SessionInfo } from "@/lib/chatClient";
import { chatReducer, initialChatState } from "@/lib/chatState";
import type { ConversationSummary } from "@/server/services/conversationView";
import { Composer, type ComposerHandle } from "./Composer";
import { DraftBubble, MessageBubble } from "./MessageBubble";
import { PendingActionCard } from "./PendingActionCard";
import { initials, UserPicker } from "./UserPicker";

export const SUGGESTIONS = [
  "What does my portfolio look like?",
  "Which property generates the most rent?",
  "How much of my portfolio is retail?",
  "Compare my residential and commercial exposure",
  "What if I exclude my highest-value property?",
];

const nowIso = () => new Date().toISOString();
const errorText = (e: unknown) =>
  e instanceof ApiError ? e.message : "Couldn't reach the server. Check your connection and try again.";

export function ChatApp() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const lastLocalId = useRef<string | null>(null);

  const user = session?.users.find((u) => u.id === session.currentUserId) ?? null;

  const refreshConversations = useCallback(async () => {
    try {
      setConversations((await api.conversations()).conversations);
    } catch {
      /* list is non-critical */
    }
  }, []);

  useEffect(() => {
    api.session().then(setSession, (e) => setBootError(errorText(e)));
  }, []);

  useEffect(() => {
    if (user) void refreshConversations();
  }, [user, refreshConversations]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.draft?.text, state.draft?.activity.length, state.pendingAction]);

  async function pickUser(id: string) {
    setSwitching(true);
    try {
      inFlight.current?.abort();
      await api.selectUser(id);
      setSession(await api.session());
      dispatch({ type: "reset" });
    } catch (e) {
      setBootError(errorText(e));
    } finally {
      setSwitching(false);
    }
  }

  async function signOut() {
    inFlight.current?.abort();
    await api.signOut().catch(() => undefined);
    dispatch({ type: "reset" });
    setConversations([]);
    setSession(await api.session());
  }

  async function openConversation(id: string) {
    if (state.phase !== "idle") return;
    setSidebarOpen(false);
    setLoadingConversation(true);
    try {
      dispatch({ type: "loaded", view: await api.conversation(id) });
    } catch (e) {
      dispatch({ type: "decide_failed", message: errorText(e) });
    } finally {
      setLoadingConversation(false);
    }
  }

  function newChat() {
    if (state.phase !== "idle") return;
    setSidebarOpen(false);
    dispatch({ type: "reset" });
  }

  async function send(text: string) {
    if (state.phase !== "idle") return;
    const localId = `local-${Date.now()}`;
    lastLocalId.current = localId;
    dispatch({ type: "send", text, localId, at: nowIso() });
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      await streamChat(
        { conversationId: state.conversationId ?? undefined, message: text },
        (event) => dispatch({ type: "event", event, at: nowIso() }),
        controller.signal,
      );
      void refreshConversations();
    } catch (e) {
      if (controller.signal.aborted) return;
      dispatch({ type: "send_failed", localId, message: errorText(e), retryText: text });
      if (e instanceof ApiError && e.status === 401) setSession((s) => (s ? { ...s, currentUserId: null } : s));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  function retry() {
    const text = state.error?.retryText;
    if (!text) return;
    dispatch({ type: "retry", localId: lastLocalId.current });
    void send(text);
  }

  async function decide(decision: "confirm" | "cancel") {
    const action = state.pendingAction;
    if (!action || !state.conversationId || state.phase !== "idle") return;
    dispatch({ type: "decide_start" });
    try {
      const result = await api.decide(state.conversationId, action.id, decision);
      dispatch({ type: "decide_done", label: decision === "confirm" ? "✅ Confirm" : "✖ Cancel", result, at: nowIso() });
      void refreshConversations();
    } catch (e) {
      dispatch({ type: "decide_failed", message: errorText(e) });
    }
  }

  if (bootError && !session) {
    return (
      <main className="picker">
        <div className="picker-card">
          <h1>Portfolio Analyst</h1>
          <p className="error-text">{bootError}</p>
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
  if (!session) return <main className="picker" aria-busy="true" />;
  if (!user) return <UserPicker users={session.users} busy={switching} onPick={pickUser} />;

  const busy = state.phase !== "idle";
  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
      <aside className="sidebar" aria-label="Conversations">
        <div className="sidebar-head">
          <span className="avatar" aria-hidden>
            {initials(user.name)}
          </span>
          <div className="who">
            <strong>{user.name}</strong>
            <span className="muted small">{user.city}</span>
          </div>
        </div>
        <div className="sidebar-actions">
          <button type="button" className="btn primary block" onClick={newChat} disabled={busy}>
            + New chat
          </button>
          <label className="switch-user">
            <span className="muted small">Demo client</span>
            <select value={user.id} disabled={busy || switching} onChange={(e) => void pickUser(e.target.value)} aria-label="Switch demo client">
              {session.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.city}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link-btn small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        <ul className="conversation-list">
          {conversations.length === 0 && <li className="muted small empty">No conversations yet</li>}
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`conversation ${c.id === state.conversationId ? "active" : ""}`}
                onClick={() => void openConversation(c.id)}
                disabled={busy}
              >
                <span className="preview">{c.preview || "New conversation"}</span>
                <time className="muted small" dateTime={c.lastMessageAt}>
                  {new Date(c.lastMessageAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </time>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <button type="button" className="scrim" aria-label="Close conversations" onClick={() => setSidebarOpen(false)} tabIndex={-1} />

      <main className="chat">
        <header className="chat-head">
          <button type="button" className="icon-btn menu" aria-label="Open conversations" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          <span className="avatar bot" aria-hidden>
            🏢
          </span>
          <div className="who">
            <strong>Portfolio Analyst</strong>
            <span className="small status-line" aria-live="polite">
              {busy ? state.draft?.statusLabel ?? "typing…" : "online"}
            </span>
          </div>
        </header>

        {session.modelMode === "dev-stub" && (
          <div className="mode-banner" role="status">
            <strong>Demo mode:</strong> no LLM configured. Replies come from a keyword stub that calls the real tools.
            {session.dataBackend === "memory" && " Data is in memory and resets on restart."}
          </div>
        )}

        <div className="messages" ref={scroller} data-testid="messages">
          {loadingConversation && <p className="center muted">Loading conversation…</p>}
          {!loadingConversation && state.messages.length === 0 && !state.draft && (
            <div className="empty-state">
              <p className="system-note">
                Hi {user.name.split(" ")[0]}! Ask me anything about your portfolio. Every figure comes from your records, and
                nothing changes without your confirmation.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => void send(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {state.messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRetry={m.failed ? retry : undefined} />
          ))}
          {state.draft && <DraftBubble draft={state.draft} />}
          {state.pendingAction && (
            <PendingActionCard
              action={state.pendingAction}
              busy={busy}
              onConfirm={() => void decide("confirm")}
              onCancel={() => void decide("cancel")}
              onEdit={() => composer.current?.prefill("Change the proposal: ")}
            />
          )}
          {state.error && (
            <div className="error-banner" role="alert">
              <span>{state.error.message}</span>
              {state.error.retryText && (
                <button type="button" className="btn small" onClick={retry} disabled={busy}>
                  Retry
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dispatch({ type: "dismiss_error" })}>
                ✕
              </button>
            </div>
          )}
        </div>

        <Composer ref={composer} disabled={busy} onSend={(t) => void send(t)} />
      </main>
    </div>
  );
}
