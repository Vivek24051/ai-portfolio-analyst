// GET /api/admin/overview — users, attention queue, run metrics. Admin only.
import { requireAdmin } from "@/server/admin/auth";
import { getOverview } from "@/server/admin/adminService";
import { adminErrorResponse, adminJson } from "@/server/admin/http";
import { getContainer } from "@/server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    requireAdmin(req);
    const c = await getContainer();
    return adminJson({ ...(await getOverview(c.stores)), modelMode: c.modelMode, dataBackend: c.dataBackend });
  } catch (e) {
    return adminErrorResponse(e);
  }
}
