// POST /api/chat/actions — Confirm / Cancel buttons on a proposal card.
// Deterministic path: no LLM call, so it is fast and cannot be steered by prompt injection.

import { NextResponse, type NextRequest } from "next/server";
import { getContainer } from "@/server/container";
import { errorResponse, parseJsonBody, requireUserId } from "@/server/http";
import { pendingActionDecisionSchema } from "@/server/schemas";
import { handlePendingActionDecision } from "@/server/services/chatService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId(req);
    const body = await parseJsonBody(req, pendingActionDecisionSchema);
    const c = await getContainer();
    const result = await handlePendingActionDecision({ stores: c.stores }, { userId, ...body });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
