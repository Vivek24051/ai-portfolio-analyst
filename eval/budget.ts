// Spend guards for paid evaluation runs. Defence in depth on top of the OpenRouter key's own
// credit limit (which is the authoritative cap — see PERFORMANCE.md "Paid evaluation plan").

import { extractCostUsd, type ChatModel } from "@/agent/model";

export class BudgetExceeded extends Error {}

export interface Budget {
  maxCalls: number;
  maxCostUsd: number;
  calls: number;
  /** Sum of provider-REPORTED cost. If the provider reports nothing, only maxCalls protects. */
  costUsd: number;
}

/** Stops issuing calls once N calls were made or reported cost reached the cap. */
export function budgeted(inner: ChatModel, budget: Budget): ChatModel {
  return {
    id: inner.id,
    async invoke(messages, opts) {
      if (budget.calls >= budget.maxCalls) throw new BudgetExceeded(`max calls (${budget.maxCalls}) reached`);
      if (budget.costUsd >= budget.maxCostUsd) throw new BudgetExceeded(`max cost ($${budget.maxCostUsd}) reached`);
      budget.calls++;
      const out = await inner.invoke(messages, opts);
      budget.costUsd += extractCostUsd(out) ?? 0;
      return out;
    },
  };
}

export interface PaidConfig {
  apiKey: string;
  model: string;
  maxCalls: number;
  maxCostUsd: number;
}

/** All guards must be present; otherwise the paid run is refused before any network activity. */
export function assertPaidAllowed(env: NodeJS.ProcessEnv, argv: string[]): PaidConfig {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const maxCalls = Number(arg("max-calls") ?? 0);
  const maxCostUsd = Number(arg("max-cost-usd") ?? 0);
  const problems = [
    env.EVAL_ALLOW_PAID !== "1" && "EVAL_ALLOW_PAID=1",
    !argv.includes("--confirm-paid") && "--confirm-paid",
    !env.OPENROUTER_API_KEY && "OPENROUTER_API_KEY",
    !env.LLM_PRIMARY_MODEL && "LLM_PRIMARY_MODEL",
    !(maxCalls > 0) && "--max-calls N",
    !(maxCostUsd > 0) && "--max-cost-usd X",
  ].filter(Boolean);
  if (problems.length) throw new Error(`Paid evaluation refused. Missing: ${problems.join(", ")}.`);
  return { apiKey: env.OPENROUTER_API_KEY!, model: env.LLM_PRIMARY_MODEL!, maxCalls, maxCostUsd };
}
