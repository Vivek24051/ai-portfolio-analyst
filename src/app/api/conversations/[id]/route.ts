// GET /api/conversations/:id — display-ready transcript + any open proposal (owner only).
import { NextResponse, type NextRequest } from "next/server";
import { getContainer } from "@/server/container";
import { badRequest } from "@/server/errors";
import { errorResponse, requireUserId } from "@/server/http";
import { getConversationView } from "@/server/services/conversationView";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId(req);
    const { id } = await params;
    if (!id || id.length > 64) throw badRequest("Invalid conversation id.");
    const c = await getContainer();
    return NextResponse.json(await getConversationView(c.stores, userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
