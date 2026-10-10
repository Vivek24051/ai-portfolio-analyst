// Agent runtime configuration. All values come from server-side env; nothing here is exposed
// to the browser. No API key is required to build or test: without one the app uses the
// clearly-labelled dev stub model.

export const MAX_TOOL_ROUNDS = 5;

export interface AgentConfig {
  openRouterApiKey: string | null;
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

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
    primaryModel: env.LLM_PRIMARY_MODEL?.trim() || null,
    fallbackModel: env.LLM_FALLBACK_MODEL?.trim() || null,
    llmCallTimeoutMs: int(env.LLM_CALL_TIMEOUT_MS, 20_000),
    turnDeadlineMs: int(env.CHAT_TURN_DEADLINE_MS, 50_000),
    historyLimit: int(env.CHAT_HISTORY_LIMIT, 30),
  };
}
