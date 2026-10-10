// Admin authentication: HTTP Basic auth over the app's HTTPS origin, checked server-side.
//
// - Fails closed: if ADMIN_PASSWORD is unset or weak (< 12 chars) the admin surface is disabled
//   (503) in EVERY environment. There is no development fallback.
// - Constant-time comparison (SHA-256 digests + timingSafeEqual) so length/prefix don't leak.
// - Repeated failures from one client are throttled (per instance).
// - Credentials live only in server env; nothing about them is ever sent to the browser.
// The proxy (src/proxy.ts) triggers the browser's login prompt, but every admin page and API
// handler calls these checks itself — the proxy is not the authorization boundary.

import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/server/errors";
import { RateLimiter } from "@/server/rateLimit";

export const ADMIN_REALM = 'Basic realm="Portfolio Admin", charset="UTF-8"';
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export type AdminAuthResult =
  | { ok: true; username: string }
  | { ok: false; reason: "not_configured" | "missing" | "invalid" | "throttled" };

interface AdminCredentials {
  username: string;
  password: string;
}

export function adminCredentials(env: NodeJS.ProcessEnv = process.env): AdminCredentials | null {
  const password = env.ADMIN_PASSWORD ?? "";
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) return null;
  return { username: env.ADMIN_USERNAME?.trim() || "admin", password };
}

export function parseBasicAuth(header: string | null | undefined): { username: string; password: string } | null {
  if (!header) return null;
  const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

// 10 failed attempts per client per 5 minutes.
const failures = new RateLimiter(10, 5 * 60_000);

export function clientKey(headers: Pick<Headers, "get">): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}

export function checkAdminAuth(headers: Pick<Headers, "get">, env: NodeJS.ProcessEnv = process.env, limiter = failures): AdminAuthResult {
  const creds = adminCredentials(env);
  if (!creds) return { ok: false, reason: "not_configured" };
  const given = parseBasicAuth(headers.get("authorization"));
  if (!given) return { ok: false, reason: "missing" };
  // Locked-out clients are refused before comparing, so a correct guess during lockout fails too.
  const key = clientKey(headers);
  if (limiter.blocked(key)) return { ok: false, reason: "throttled" };
  // Evaluate both comparisons regardless, so timing does not reveal which part was wrong.
  const userOk = safeEqual(given.username, creds.username);
  const passOk = safeEqual(given.password, creds.password);
  if (userOk && passOk) return { ok: true, username: creds.username };
  limiter.take(key); // count the failure
  return { ok: false, reason: "invalid" };
}

const MESSAGES: Record<Exclude<AdminAuthResult, { ok: true }>["reason"], [number, string]> = {
  not_configured: [503, "Admin dashboard is not configured. Set ADMIN_PASSWORD (at least 12 characters) on the server."],
  missing: [401, "Admin authentication required."],
  invalid: [401, "Invalid admin credentials."],
  throttled: [429, "Too many failed attempts. Try again later."],
};

export function adminAuthError(reason: Exclude<AdminAuthResult, { ok: true }>["reason"]): HttpError {
  const [status, message] = MESSAGES[reason];
  return new HttpError(status, `admin_${reason}`, message);
}

/** For admin API route handlers. Returns the admin username or throws an HttpError. */
export function requireAdmin(req: Request): string {
  const r = checkAdminAuth(req.headers);
  if (!r.ok) throw adminAuthError(r.reason);
  return r.username;
}

/**
 * CSRF guard for state-changing admin requests. Browsers re-send Basic credentials
 * automatically, so a cross-site form could otherwise ride on an admin's login.
 */
export function requireSameOrigin(req: Request): void {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!host || originHost !== host) throw new HttpError(403, "cross_origin", "Cross-origin admin request rejected.");
}
