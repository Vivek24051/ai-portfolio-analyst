// GET /api/admin/conversations/:id — full execution trace. Admin only.
import { requireAdmin } from "@/server/admin/auth";
import { getConversationTrace } from "@/server/admin/adminService";
import { adminErrorResponse, adminJson } from "@/server/admin/http";
import { getContainer } from "@/server/container";
import { badRequest } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAdmin(req);
    const { id } = await params;
    if (!id || id.length > 64) throw badRequest("Invalid conversation id.");
    const c = await getContainer();
    return adminJson(await getConversationTrace(c.stores, id));
  } catch (e) {
    return adminErrorResponse(e);
  }
}
