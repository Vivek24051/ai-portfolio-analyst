// POST /api/chat/stream — one user turn, streamed as Server-Sent Events.
//
// Everything that can be rejected (auth, body, rate limit, conversation ownership) is checked
// BEFORE the stream opens, so those failures are ordinary HTTP errors. Once streaming, failures
// arrive as an `error` event. If the client disconnects, the turn still completes and is saved.

import type { NextRequest } from "next/server";
import type { ChatStreamEvent } from "@/agent/events";
import { encodeSse, SSE_HEARTBEAT } from "@/lib/sse";
import { getContainer } from "@/server/container";
import { HttpError, notFound, tooManyRequests } from "@/server/errors";
import { errorResponse, parseJsonBody, requireUserId } from "@/server/http";
import { chatRequestSchema } from "@/server/schemas";
import { handleChatTurn } from "@/server/services/chatService";

export const runtime = "nodejs";
export const maxDuration = 60;

const HEARTBEAT_MS = 15_000;

export async function POST(req: NextRequest) {
  let userId: string;
  let body: { conversationId?: string; message: string };
  let c: Awaited<ReturnType<typeof getContainer>>;
  try {
    userId = await requireUserId(req);
    body = await parseJsonBody(req, chatRequestSchema);
    c = await getContainer();
    if (body.conversationId && !(await c.stores.conversations.get(userId, body.conversationId))) throw notFound("Conversation");
    if (!c.chatLimiter.take(userId)) throw tooManyRequests();
  } catch (e) {
    return errorResponse(e);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false; // client disconnected; keep processing the turn
        }
      };
      const send = (event: ChatStreamEvent) => write(encodeSse(event));
      const heartbeat = setInterval(() => write(SSE_HEARTBEAT), HEARTBEAT_MS);
      try {
        const result = await handleChatTurn(
          { stores: c.stores, router: c.router, historyLimit: c.config.historyLimit, turnDeadlineMs: c.config.turnDeadlineMs },
          { userId, conversationId: body.conversationId, message: body.message },
          send,
        );
        send({ type: "done", result });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error("[api/chat/stream] unhandled error", e);
        send({
          type: "error",
          code: e instanceof HttpError ? e.code : "internal_error",
          message: e instanceof HttpError ? e.message : "Something went wrong. Please try again.",
        });
      } finally {
        clearInterval(heartbeat);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
