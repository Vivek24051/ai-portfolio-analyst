// Redaction for anything that is logged or stored as an error string (run.error, LLM call
// errors shown in the admin trace). Provider errors can echo request details, so we strip
// credentials and cap length before they leave the process or reach the database.

/** Whole-match secrets. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI/OpenRouter-style keys
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\bAQ\.[0-9A-Za-z_.-]{20,}/g, // Google key/token format seen in this project
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi, // connection strings carry passwords
];

/** `key=value` / `"key": "value"` pairs: keep the key, redact the value. */
const KEY_VALUE = /\b(api[_-]?key|authorization|password|passwd|secret|token)\b(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi;

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const key of ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "SESSION_SECRET", "ADMIN_PASSWORD", "DATABASE_URL", "DIRECT_URL"]) {
    const v = env[key];
    if (v && v.length >= 6) out = out.split(v).join("[REDACTED]");
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "Name: message", redacted and capped — safe to log or persist. */
export function safeErrorMessage(e: unknown, max = 300): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return truncate(redactSecrets(raw), max);
}

/** Server log line without stack traces or raw provider payloads. */
export function logError(scope: string, e: unknown): void {
  console.error(`[${scope}] ${safeErrorMessage(e, 500)}`);
}
