import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { badRequest, HttpError, unauthorized } from "./errors";
import { logError } from "./redact";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/** The authenticated demo user, from the signed cookie only. */
export async function requireUserId(req: NextRequest): Promise<string> {
  const userId = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) throw unauthorized();
  return userId;
}

const MAX_BODY_BYTES = 16 * 1024;

export async function parseJsonBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.output<S>> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw badRequest("Request body too large.");
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw badRequest("Request body too large.");
    body = JSON.parse(text);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("Body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

/** Maps known errors to their status; everything else is a generic 500 without internals. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  logError("api", e);
  return NextResponse.json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } }, { status: 500 });
}
