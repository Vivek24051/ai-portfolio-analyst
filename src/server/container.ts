import "server-only";
// Composition root: picks the store backend and the model router from env.
//
//   DATA_BACKEND=memory (default)  in-memory stores seeded from data/seed/*.csv; resets on restart
//   DATA_BACKEND=prisma            PostgreSQL via Prisma (requires DATABASE_URL + migrations)
//
//   LLM_PROVIDER=stub                                            → dev stub, always (keys ignored)
//   LLM_PROVIDER=gemini + GEMINI_API_KEY + LLM_PRIMARY_MODEL      → Google Gemini (optional LLM_FALLBACK_MODEL)
//   LLM_PROVIDER=openrouter or omitted + OPENROUTER_API_KEY + LLM_PRIMARY_MODEL
//                                                                → OpenRouter (paid; optional LLM_FALLBACK_MODEL)
//   unrecognised LLM_PROVIDER, missing key/model, or nothing set → dev stub model (no LLM, no cost)
//
//   With a real primary: fallback = LLM_FALLBACK_PROVIDER (default: same provider) + LLM_FALLBACK_MODEL,
//   then the labelled dev stub as last resort (LLM_STUB_LAST_RESORT, default on). OpenRouter ids must end
//   in ":free" unless OPENROUTER_ALLOW_PAID=true (default off): a refused id is never used.

import { readFileSync } from "node:fs";
import { seedFile } from "@/data/paths";
import { isAllowedOpenRouterModel, loadAgentConfig, type AgentConfig } from "@/agent/config";
import { createDevStubModel } from "@/agent/devStubModel";
import { createGeminiModel, createOpenRouterModel, ModelCooldowns, type ChatModel, type ModelRouter } from "@/agent/model";
import { redactSecrets } from "./redact";
import { buildSeed } from "@/data/seedData";
import { RateLimiter } from "./rateLimit";
import { createMemoryStores } from "./stores/memory";
import type { Stores } from "./stores/types";

interface Container {
  stores: Stores;
  router: ModelRouter;
  config: AgentConfig;
  modelMode: "openrouter" | "gemini" | "dev-stub";
  dataBackend: "memory" | "prisma";
  chatLimiter: RateLimiter;
}

const g = globalThis as unknown as { __container?: Promise<Container> };

async function createStores(backend: "memory" | "prisma"): Promise<Stores> {
  if (backend === "prisma") {
    const [{ prisma }, { createPrismaStores }] = await Promise.all([import("./db"), import("./stores/prisma")]);
    return createPrismaStores(prisma);
  }
  const seed = buildSeed(readFileSync(seedFile("users.csv"), "utf8"), readFileSync(seedFile("properties.csv"), "utf8"));
  return createMemoryStores(seed);
}

// The free-only rule lives in @/agent/config (no server-only import) so the evaluation runner shares it.
export { isAllowedOpenRouterModel };

/**
 * Builds one real model, or null when it cannot be used (missing key, or a non-free OpenRouter id
 * without the paid opt-in). Warnings never echo values: a mis-pasted key would land in the logs.
 */
function buildModel(provider: "gemini" | "openrouter", modelId: string | null, config: AgentConfig, role: "primary" | "fallback"): ChatModel | null {
  if (!modelId) return null;
  if (provider === "gemini") {
    if (config.geminiApiKey) return createGeminiModel(modelId, config.geminiApiKey);
    if (role === "fallback") console.warn("[container] fallback provider gemini needs GEMINI_API_KEY; no fallback model is used");
    return null;
  }
  if (!config.openRouterApiKey) {
    if (role === "fallback") console.warn("[container] fallback provider openrouter needs OPENROUTER_API_KEY; no fallback model is used");
    return null;
  }
  if (!isAllowedOpenRouterModel(modelId, config.openRouterAllowPaid)) {
    console.warn(`[container] refused the ${role} OpenRouter model: only ":free" model ids are allowed (OPENROUTER_ALLOW_PAID is not enabled)`);
    return null;
  }
  return createOpenRouterModel(modelId, config.openRouterApiKey);
}

export function createRouter(config: AgentConfig): { router: ModelRouter; modelMode: Container["modelMode"]; modelChain: string[] } {
  if (config.unrecognizedProvider) {
    // Never echo the value: a mis-pasted secret would otherwise land in server logs.
    console.warn("[container] unrecognised LLM_PROVIDER value; using the dev stub (expected: stub, gemini, openrouter)");
  }
  if (config.provider === "stub") {
    // Forced stub: no model client is constructed at all, whatever keys are present.
    return devStubRouter(config);
  }
  const primaryProvider = config.provider === "gemini" ? "gemini" : "openrouter"; // null keeps the legacy OpenRouter rule
  if (primaryProvider === "openrouter" && !config.openRouterApiKey) return devStubRouter(config);
  const primary = buildModel(primaryProvider, config.primaryModel, config, "primary");
  if (!primary) {
    if (primaryProvider === "gemini") {
      console.warn("[container] LLM_PROVIDER=gemini but GEMINI_API_KEY or LLM_PRIMARY_MODEL is missing; using the dev stub");
    }
    return devStubRouter(config);
  }

  if (config.unrecognizedFallbackProvider) {
    console.warn("[container] unrecognised LLM_FALLBACK_PROVIDER value; no cross-provider fallback (expected: gemini, openrouter, stub)");
  }
  const fallbackProvider = config.unrecognizedFallbackProvider ? null : (config.fallbackProvider ?? primaryProvider);
  // Behind a real model the stub only answers when that model failed: it must not claim "no LLM configured".
  const stub = devStubModel({ lastResort: true });
  const fallback =
    fallbackProvider === "stub" ? stub : fallbackProvider ? buildModel(fallbackProvider, config.fallbackModel, config, "fallback") : null;
  const lastResort = config.stubLastResort && fallback !== stub ? stub : null;

  const label = (m: ChatModel) => (m.provider === "stub" ? "stub" : `${m.provider}:${m.id}`);
  return {
    modelMode: primaryProvider,
    modelChain: [primary, fallback, lastResort].filter((m): m is ChatModel => m !== null).map(label),
    router: {
      primary,
      fallback,
      lastResort,
      callTimeoutMs: config.llmCallTimeoutMs,
      // One router per server instance (the container is cached), so cooldowns span that instance's turns.
      cooldowns: new ModelCooldowns(),
      maxRealCallsPerTurn: config.maxModelCallsPerTurn,
    },
  };
}

function devStubModel(opts: { lastResort?: boolean } = {}): ChatModel {
  // DEV_STUB_STREAM_DELAY_MS: artificial per-word delay for demos (default 12); 0 for benchmarks.
  const delay = Number(process.env.DEV_STUB_STREAM_DELAY_MS);
  return createDevStubModel({ ...(Number.isFinite(delay) && delay >= 0 ? { streamDelayMs: delay } : {}), ...opts });
}

function devStubRouter(config: AgentConfig): { router: ModelRouter; modelMode: Container["modelMode"]; modelChain: string[] } {
  return { modelMode: "dev-stub", modelChain: ["stub"], router: { primary: devStubModel(), fallback: null, callTimeoutMs: config.llmCallTimeoutMs } };
}

/** Messages per user per minute (CHAT_RATE_LIMIT_PER_MIN, default 20). */
function chatRateLimit(): number {
  const n = Number(process.env.CHAT_RATE_LIMIT_PER_MIN);
  return Number.isInteger(n) && n > 0 ? n : 20;
}

export function getContainer(): Promise<Container> {
  if (g.__container) return g.__container;
  const created = (async (): Promise<Container> => {
    const config = loadAgentConfig();
    const dataBackend: Container["dataBackend"] = process.env.DATA_BACKEND === "prisma" ? "prisma" : "memory";
    const { router, modelMode, modelChain } = createRouter(config);
    const stores = await createStores(dataBackend);
    // Model ids only (never keys), redacted in case a key was pasted into a model variable.
    console.info(redactSecrets(`[container] data=${dataBackend} model=${modelMode} chain=${modelChain.join(" → ")}`));
    return { stores, router, config, modelMode, dataBackend, chatLimiter: new RateLimiter(chatRateLimit(), 60_000) };
  })().catch((e) => {
    g.__container = undefined; // allow a retry instead of caching the failure
    throw e;
  });
  g.__container = created;
  return created;
}
