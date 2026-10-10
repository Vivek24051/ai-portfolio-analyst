// Demo-user session: a signed (HS256), HTTP-only cookie holding the chosen user id.
// The user id used by every tool comes from here — never from the request body or the model.

import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "pa_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Public, intentionally weak, and only ever accepted in local development/test (see secretKey).
const DEV_ONLY_SECRET = "dev-only-insecure-session-secret-change-me-0123456789";
const MIN_SECRET_LENGTH = 32;
let warned = false;

export class SessionConfigError extends Error {}

/**
 * Resolves the HMAC key. Fails closed:
 *  - SESSION_SECRET set → must be ≥ 32 chars and must not be the published dev value.
 *  - not set → allowed only when NODE_ENV is explicitly "development" or "test".
 *    Production, preview, or an unset NODE_ENV all throw — there is no production fallback.
 */
export function secretKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const secret = env.SESSION_SECRET?.trim();
  if (secret) {
    if (secret.length < MIN_SECRET_LENGTH) throw new SessionConfigError(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    if (secret === DEV_ONLY_SECRET) throw new SessionConfigError("SESSION_SECRET must not be the published development value");
    return new TextEncoder().encode(secret);
  }
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new SessionConfigError("SESSION_SECRET is required outside local development");
  }
  if (!warned) {
    console.warn("[session] SESSION_SECRET not set; using an insecure development-only secret");
    warned = true;
  }
  return new TextEncoder().encode(DEV_ONLY_SECRET);
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
