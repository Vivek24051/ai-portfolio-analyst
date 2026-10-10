// POST /admin/conversations/:id/resolve — mark a flagged conversation as handled.
// Lives under /admin (not /api/admin) so browsers send the same cached Basic-auth credentials
// as the dashboard pages (credentials are scoped by path).
// Admin only + same-origin (CSRF) check. HTML form posts get a 303 back to the trace page.
import { NextResponse } from "next/server";
import { requireAdmin, requireSameOrigin } from "@/server/admin/auth";
import { resolveAttention } from "@/server/admin/adminService";
import { adminErrorResponse, adminJson } from "@/server/admin/http";
import { getContainer } from "@/server/container";
import { badRequest } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = requireAdmin(req);
    requireSameOrigin(req);
    const { id } = await params;
    if (!id || id.length > 64) throw badRequest("Invalid conversation id.");
    const c = await getContainer();
    const result = await resolveAttention(c.stores, id, admin);
    if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      return NextResponse.redirect(new URL(`/admin/conversations/${encodeURIComponent(id)}`, req.url), 303);
    }
    return adminJson(result);
  } catch (e) {
    return adminErrorResponse(e);
  }
}
