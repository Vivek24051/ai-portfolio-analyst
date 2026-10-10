"use client";

import { useEffect, useState } from "react";
import type { PendingActionView } from "@/server/services/chatService";

interface Props {
  action: PendingActionView;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
  onEdit(): void;
}

/** Confirmation card for a staged change. Nothing is saved until Confirm succeeds server-side. */
export function PendingActionCard({ action, busy, onConfirm, onCancel, onEdit }: Props) {
  const expiresAt = new Date(action.expiresAt);
  const [expired, setExpired] = useState(() => expiresAt.getTime() <= Date.now());
  useEffect(() => {
    const ms = new Date(action.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [action.expiresAt]);

  const title = action.type === "CREATE_PROPERTY" ? "Add this property?" : `Update ${action.propertyId}?`;
  return (
    <section className="pending-card" aria-label="Proposed change awaiting confirmation" data-testid="pending-card">
      <header>
        <span aria-hidden>📝</span> <strong>{title}</strong>
        <span className="pill">Not saved yet</span>
      </header>
      <table>
        <tbody>
          {action.diff.map((d) => (
            <tr key={d.field}>
              <th scope="row">{d.label}</th>
              <td>
                {d.before !== null && (
                  <>
                    <s className="muted">{d.before}</s> →{" "}
                  </>
                )}
                <strong>{d.after}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {expired ? (
        <p className="muted">This proposal expired. Ask again if you still want the change.</p>
      ) : (
        <div className="card-actions">
          <button type="button" className="btn primary" onClick={onConfirm} disabled={busy}>
            ✅ Confirm
          </button>
          <button type="button" className="btn" onClick={onEdit} disabled={busy}>
            ✏️ Edit
          </button>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <span className="muted small">Expires {expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      )}
    </section>
  );
}
