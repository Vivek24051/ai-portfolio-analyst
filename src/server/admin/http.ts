import { NextResponse } from "next/server";
import { errorResponse } from "@/server/http";
import { ADMIN_REALM } from "./auth";

/** Like errorResponse, plus the Basic-auth challenge on 401 and no-store caching. */
export function adminErrorResponse(e: unknown): NextResponse {
  const res = errorResponse(e);
  if (res.status === 401) res.headers.set("WWW-Authenticate", ADMIN_REALM);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function adminJson(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
