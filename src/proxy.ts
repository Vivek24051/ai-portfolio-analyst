// Next.js 16 Proxy (formerly middleware). For /admin and /api/admin it:
//   - answers unauthenticated requests with 401 + WWW-Authenticate (browser login prompt),
//   - marks admin responses no-store / noindex.
// It is NOT the only check: every admin page and API handler re-verifies credentials itself.

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_REALM, adminAuthError, checkAdminAuth } from "@/server/admin/auth";

export function proxy(request: NextRequest) {
  const auth = checkAdminAuth(request.headers);
  if (!auth.ok) {
    const err = adminAuthError(auth.reason);
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (err.status === 401) headers["WWW-Authenticate"] = ADMIN_REALM;
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status, headers });
  }
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/admin/:path*"],
};
