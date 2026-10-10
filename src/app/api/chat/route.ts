// POST /api/chat — one user turn. The user id comes from the signed session cookie only.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getContainer } from "@/server/container";
import { tooManyRequests } from "@/server/errors";
import { errorResponse, parseJsonBody, requireUserId } from "@/server/http";
import { handleChatTurn } from "@/server/services/chatService";

export const runtime = "nodejs";
// Platform ceiling; the turn deadline (CHAT_TURN_DEADLINE_MS, default 50 s) fires first.
export const maxDuration = 60;

const chatRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(64).optional(),
    message: z.string().trim().min(1, "Message is empty.").max(2000, "Message is too long (max 2000 characters)."),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId(req);
    const body = await parseJsonBody(req, chatRequestSchema);
    const c = await getContainer();
    if (!c.chatLimiter.take(userId)) throw tooManyRequests();

    const result = await handleChatTurn(
      { stores: c.stores, router: c.router, historyLimit: c.config.historyLimit, turnDeadlineMs: c.config.turnDeadlineMs },
      { userId, conversationId: body.conversationId, message: body.message },
    );
    return NextResponse.json({ ...result, modelMode: c.modelMode });
  } catch (e) {
    return errorResponse(e);
  }
}
