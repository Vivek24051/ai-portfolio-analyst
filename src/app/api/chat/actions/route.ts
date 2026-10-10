// POST /api/chat/actions — Confirm / Cancel buttons on a proposal card.
// Deterministic path: no LLM call, so it is fast and cannot be steered by prompt injection.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getContainer } from "@/server/container";
import { errorResponse, parseJsonBody, requireUserId } from "@/server/http";
import { handlePendingActionDecision } from "@/server/services/chatService";

export const runtime = "nodejs";

const actionSchema = z
  .object({
    conversationId: z.string().min(1).max(64),
    pendingActionId: z.string().min(1).max(64),
    decision: z.enum(["confirm", "cancel"]),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId(req);
    const body = await parseJsonBody(req, actionSchema);
    const c = await getContainer();
    const result = await handlePendingActionDecision({ stores: c.stores }, { userId, ...body });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
