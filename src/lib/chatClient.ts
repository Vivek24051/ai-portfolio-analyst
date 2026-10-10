// Browser API client. Thin: all business logic lives behind these endpoints.
// Identity is carried only by the HTTP-only session cookie (sent automatically, same origin).

import type { ChatStreamEvent } from "@/agent/events";
import type { ChatTurnResult } from "@/server/services/chatService";
import type { ConversationSummary, ConversationView } from "@/server/services/conversationView";
import { SseParser } from "./sse";

export interface DemoUser {
  id: string;
  name: string;
  city: string;
}

export interface SessionInfo {
  currentUserId: string | null;
  users: DemoUser[];
  modelMode: "openrouter" | "gemini" | "dev-stub";
  dataBackend: "memory" | "prisma";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let code = "http_error";
  let message = `Request failed (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(res.status, code, message);
}

const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

export const api = {
  session: () => fetch("/api/session").then((r) => json<SessionInfo>(r)),
  selectUser: (userId: string) => post("/api/session", { userId }).then((r) => json<{ currentUserId: string }>(r)),
  signOut: () => fetch("/api/session", { method: "DELETE" }).then((r) => json<{ currentUserId: null }>(r)),
  conversations: () => fetch("/api/conversations").then((r) => json<{ conversations: ConversationSummary[] }>(r)),
  conversation: (id: string) => fetch(`/api/conversations/${encodeURIComponent(id)}`).then((r) => json<ConversationView>(r)),
  decide: (conversationId: string, pendingActionId: string, decision: "confirm" | "cancel") =>
    post("/api/chat/actions", { conversationId, pendingActionId, decision }).then((r) => json<ChatTurnResult>(r)),
};

/**
 * Sends one message and streams events back. Resolves when the stream ends.
 * Throws ApiError for HTTP-level rejections (401/400/404/429) before streaming starts.
 */
export async function streamChat(
  body: { conversationId?: string; message: string },
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await post("/api/chat/stream", body, signal);
  if (!res.ok || !res.body) await json(res); // throws ApiError
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let sawTerminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      if (event.type === "done" || event.type === "error") sawTerminal = true;
      onEvent(event);
    }
  }
  if (!sawTerminal) {
    onEvent({ type: "error", code: "stream_interrupted", message: "The connection dropped before the reply finished." });
  }
}
