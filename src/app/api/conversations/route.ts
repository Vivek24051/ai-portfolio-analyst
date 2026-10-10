// GET /api/conversations — the signed-in user's conversations (newest first).
import { NextResponse, type NextRequest } from "next/server";
import { getContainer } from "@/server/container";
import { errorResponse, requireUserId } from "@/server/http";
import { listConversations } from "@/server/services/conversationView";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const userId = await requireUserId(req);
    const c = await getContainer();
    return NextResponse.json({ conversations: await listConversations(c.stores, userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
