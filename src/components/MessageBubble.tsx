"use client";

import { useState } from "react";
import type { ToolActivity } from "@/server/services/chatService";
import type { Draft, UiMessage } from "@/lib/chatState";
import { RichText } from "@/lib/richText";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function HypotheticalBanner() {
  return (
    <div className="hypo-banner" role="note">
      <span aria-hidden>🔮</span> <strong>Hypothetical scenario</strong> — your real portfolio is unchanged
    </div>
  );
}

function ActivityList({ items }: { items: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="activity">
      <button type="button" className="activity-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {items.length === 1 ? "1 step" : `${items.length} steps`} · how I worked this out
      </button>
      {open && (
        <ul className="activity-list">
          {items.map((a, i) => (
            <li key={i} className={a.ok ? "ok" : "failed"}>
              <span aria-hidden>{a.ok ? "✓" : "⚠"}</span> {a.label} — <span className="muted">{a.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MessageBubble({ message, onRetry }: { message: UiMessage; onRetry?: () => void }) {
  const mine = message.role === "user";
  const classes = ["bubble", mine ? "mine" : "theirs", message.hypothetical ? "hypothetical" : "", message.isError ? "is-error" : ""];
  return (
    <div className={`row ${mine ? "row-mine" : "row-theirs"}`}>
      <div className={classes.filter(Boolean).join(" ")} data-testid={`msg-${message.role}`}>
        {message.hypothetical && <HypotheticalBanner />}
        <div className="bubble-text">{mine ? <p>{message.text}</p> : <RichText text={message.text} />}</div>
        {!mine && <ActivityList items={message.toolActivity} />}
        <div className="meta">
          {message.failed ? (
            <span className="failed-note">
              Not sent{" "}
              {onRetry && (
                <button type="button" className="link-btn" onClick={onRetry}>
                  Retry
                </button>
              )}
            </span>
          ) : (
            <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
          )}
          {mine && !message.failed && <span className="ticks" aria-label="sent">✓✓</span>}
        </div>
      </div>
    </div>
  );
}

/** The in-progress assistant reply: status, live tool steps and streamed text. */
export function DraftBubble({ draft }: { draft: Draft }) {
  return (
    <div className="row row-theirs">
      <div className="bubble theirs draft" aria-live="polite" aria-busy="true" data-testid="draft">
        {draft.activity.length > 0 && (
          <ul className="activity-list live">
            {draft.activity.map((a) => (
              <li key={a.callId} className={a.state}>
                <span aria-hidden>{a.state === "running" ? "⏳" : a.state === "ok" ? "✓" : "⚠"}</span> {a.label}
                {a.summary && <span className="muted"> — {a.summary}</span>}
              </li>
            ))}
          </ul>
        )}
        {draft.text ? (
          <div className="bubble-text">
            <RichText text={draft.text} />
            <span className="cursor" aria-hidden>▍</span>
          </div>
        ) : (
          <div className="typing">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="muted">{draft.statusLabel ?? "Typing…"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
