// Agent runtime configuration. All values come from server-side env; nothing here is exposed
// to the browser. No API key is required to build or test: without one the app uses the
// clearly-labelled dev stub model.
//
//   LLM_PROVIDER=stub                                          → dev stub, ALWAYS (keys are ignored)
//   LLM_PROVIDER=gemini + GEMINI_API_KEY + LLM_PRIMARY_MODEL  → Google Gemini (free tier possible)
//   LLM_PROVIDER omitted + OPENROUTER_API_KEY + LLM_PRIMARY_MODEL → OpenRouter (paid; not used here)
//   LLM_PROVIDER set to anything unrecognised                  → dev stub (fail safe, never a paid provider)
//   otherwise                                                  → dev stub

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

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const raw = env.LLM_PROVIDER?.trim().toLowerCase() || null;
  const known = raw && (PROVIDERS as readonly string[]).includes(raw) ? (raw as AgentConfig["provider"]) : null;
  return {
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
