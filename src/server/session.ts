// Demo-user session: a signed (HS256), HTTP-only cookie holding the chosen user id.
// The user id used by every tool comes from here — never from the request body or the model.

import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "pa_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEV_SECRET = "dev-only-insecure-session-secret-change-me-0123456789";
let warned = false;

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET (≥32 chars) must be set in production");
  }
  if (!warned) {
    console.warn("[session] SESSION_SECRET not set; using an insecure development secret");
    warned = true;
  }
  return new TextEncoder().encode(DEV_SECRET);
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Returns the user id for a valid token, or null for missing/expired/tampered tokens. */
export async function verifySessionToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
