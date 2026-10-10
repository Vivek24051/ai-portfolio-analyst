// Demo-user picker session.
//   GET    → current user (if any) + the selectable demo users
//   POST   { userId } → sets the signed HTTP-only cookie (user must exist)
//   DELETE → clears it

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getContainer } from "@/server/container";
import { notFound } from "@/server/errors";
import { errorResponse, parseJsonBody } from "@/server/http";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions, verifySessionToken } from "@/server/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const c = await getContainer();
    const users = await c.stores.users.list();
    const currentId = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({
      currentUserId: users.some((u) => u.id === currentId) ? currentId : null,
      users: users.map((u) => ({ id: u.id, name: u.name, city: u.city })),
      modelMode: c.modelMode,
      dataBackend: c.dataBackend,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await parseJsonBody(req, z.object({ userId: z.string().min(1).max(16) }).strict());
    const c = await getContainer();
    if (!(await c.stores.users.get(userId))) throw notFound("User");
    const res = NextResponse.json({ currentUserId: userId });
    res.cookies.set(SESSION_COOKIE, await createSessionToken(userId), sessionCookieOptions);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE() {
  const res = NextResponse.json({ currentUserId: null });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  return res;
}
