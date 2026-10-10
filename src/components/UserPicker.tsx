"use client";

import type { DemoUser } from "@/lib/chatClient";

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Demo sign-in: choosing a user sets a signed HTTP-only cookie on the server. */
export function UserPicker({ users, busy, onPick }: { users: DemoUser[]; busy: boolean; onPick(id: string): void }) {
  return (
    <main className="picker">
      <div className="picker-card">
        <h1>Portfolio Analyst</h1>
        <p className="muted">Choose a demo client to start chatting about their real-estate portfolio.</p>
        <ul>
          {users.map((u) => (
            <li key={u.id}>
              <button type="button" className="user-option" disabled={busy} onClick={() => onPick(u.id)}>
                <span className="avatar" aria-hidden>
                  {initials(u.name)}
                </span>
                <span>
                  <strong>{u.name}</strong>
                  <span className="muted small"> · {u.city}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">Demo sign-in only: no password. Each client can see only their own portfolio.</p>
      </div>
    </main>
  );
}
