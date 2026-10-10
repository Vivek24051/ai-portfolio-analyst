// Agent runtime configuration. All values come from server-side env; nothing here is exposed
// to the browser. No API key is required to build or test: without one the app uses the
// clearly-labelled dev stub model.
//
//   LLM_PROVIDER=stub                                          → dev stub, ALWAYS (keys are ignored)
//   LLM_PROVIDER=gemini + GEMINI_API_KEY + LLM_PRIMARY_MODEL  → Google Gemini (free tier possible)
//   LLM_PROVIDER omitted + OPENROUTER_API_KEY + LLM_PRIMARY_MODEL → OpenRouter (paid; not used here)
//   LLM_PROVIDER set to anything unrecognised                  → dev stub (fail safe, never a paid provider)
//   otherwise                                                  → dev stub
//
// Fallback chain (only when a real primary model is configured):
//   LLM_FALLBACK_PROVIDER = gemini | openrouter | stub (default: same provider as the primary)
//   LLM_FALLBACK_MODEL    = model id for that provider (its own API key must be set)
//   LLM_STUB_LAST_RESORT  = true (default) | false — the labelled dev stub answers if every real model fails
//
// Free-only guard: an OpenRouter model id must end in ":free" unless OPENROUTER_ALLOW_PAID=true
// (default false). A refused id is treated as "not configured" — it never falls through to a paid model.

export const MAX_TOOL_ROUNDS = 5;

export interface AgentConfig {
  /**
   * "stub" forces the dev stub; "gemini" selects Google Gemini; "openrouter" selects OpenRouter;
   * null (LLM_PROVIDER omitted) keeps the legacy rule: OpenRouter if its key is set, else the stub.
   */
  provider: "stub" | "openrouter" | "gemini" | null;
  /** The raw LLM_PROVIDER value when it was set but not recognised (forces the stub). */
  unrecognizedProvider: string | null;
  openRouterApiKey: string | null;
  geminiApiKey: string | null;
  primaryModel: string | null;
  fallbackModel: string | null;
  /** Provider of the fallback model; null = same as the primary (the original behaviour). */
  fallbackProvider: "stub" | "openrouter" | "gemini" | null;
  /** LLM_FALLBACK_PROVIDER was set but not recognised: no cross-provider fallback is built. */
  unrecognizedFallbackProvider: boolean;
  /** The dev stub answers (labelled) when every real model fails. Default true. */
  stubLastResort: boolean;
  /** Explicit opt-in to paid OpenRouter models (ids without ":free"). Default false. */
  openRouterAllowPaid: boolean;
  /** Per model call. */
  llmCallTimeoutMs: number;
  /** Whole turn (all model calls + tools). Must be below the platform function limit. */
  turnDeadlineMs: number;
  /** Messages of history loaded per turn. */
  historyLimit: number;
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const PROVIDERS = ["stub", "gemini", "openrouter"] as const;

/**
 * The single free-only rule, shared by the app (container) and the evaluation runner: an OpenRouter
 * model id is usable when it ends in ":free", or when paid usage was explicitly allowed.
 */
export function isAllowedOpenRouterModel(modelId: string, allowPaid: boolean): boolean {
  return allowPaid || modelId.trim().endsWith(":free");
}

/** OPENROUTER_ALLOW_PAID: default OFF; only an explicit "true"/"1" enables paid OpenRouter models. */
export function openRouterPaidAllowed(env: NodeJS.ProcessEnv): boolean {
  return /^(true|1)$/i.test(env.OPENROUTER_ALLOW_PAID?.trim() ?? "");
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase() || null;
  const known = raw && (PROVIDERS as readonly string[]).includes(raw) ? (raw as AgentConfig["provider"]) : null;
  const rawFallback = env.LLM_FALLBACK_PROVIDER?.trim().toLowerCase() || null;
  const knownFallback = rawFallback && (PROVIDERS as readonly string[]).includes(rawFallback) ? (rawFallback as AgentConfig["fallbackProvider"]) : null;
  return {
    fallbackProvider: knownFallback,
    unrecognizedFallbackProvider: rawFallback !== null && knownFallback === null,
    // Default ON; only an explicit "false"/"0"/"no"/"off" disables the stub last resort.
    stubLastResort: !/^(false|0|no|off)$/i.test(env.LLM_STUB_LAST_RESORT?.trim() ?? ""),
    openRouterAllowPaid: openRouterPaidAllowed(env),
    // An explicit but unknown value (typo, "none", …) must never fall through to a paid provider.
    provider: raw === null ? null : (known ?? "stub"),
    unrecognizedProvider: raw !== null && known === null ? raw : null,
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    primaryModel: env.LLM_PRIMARY_MODEL?.trim() || null,
    fallbackModel: env.LLM_FALLBACK_MODEL?.trim() || null,
    llmCallTimeoutMs: int(env.LLM_CALL_TIMEOUT_MS, 20_000),
    turnDeadlineMs: int(env.CHAT_TURN_DEADLINE_MS, 50_000),
    historyLimit: int(env.CHAT_HISTORY_LIMIT, 30),
  };
}
