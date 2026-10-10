// GET /api/admin/conversations?user=U001&attention=1 — cross-user conversation list. Admin only.
import { requireAdmin } from "@/server/admin/auth";
import { listConversationsForAdmin } from "@/server/admin/adminService";
import { adminErrorResponse, adminJson } from "@/server/admin/http";
import { getContainer } from "@/server/container";
import { badRequest } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    requireAdmin(req);
    const params = new URL(req.url).searchParams;
    const user = params.get("user") ?? undefined;
    if (user !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(user)) throw badRequest("Invalid user filter.");
    const attention = params.get("attention");
    const needsAttention = attention === "1" ? true : attention === "0" ? false : undefined;
    const c = await getContainer();
    return adminJson({ conversations: await listConversationsForAdmin(c.stores, { userId: user, needsAttention }) });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
