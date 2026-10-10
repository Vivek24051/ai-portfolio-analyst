import "server-only";
// Composition root: picks the store backend and the model router from env.
//
//   DATA_BACKEND=memory (default)  in-memory stores seeded from data/original/*.csv; resets on restart
//   DATA_BACKEND=prisma            PostgreSQL via Prisma (requires DATABASE_URL + migrations)
//
//   OPENROUTER_API_KEY + LLM_PRIMARY_MODEL set → OpenRouter (optional LLM_FALLBACK_MODEL)
//   otherwise                                   → dev stub model (no LLM, no cost)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentConfig, type AgentConfig } from "@/agent/config";
import { createDevStubModel } from "@/agent/devStubModel";
import { createOpenRouterModel, type ModelRouter } from "@/agent/model";
import { buildSeed } from "@/data/seedData";
import { RateLimiter } from "./rateLimit";
import { createMemoryStores } from "./stores/memory";
import type { Stores } from "./stores/types";

interface Container {
  stores: Stores;
  router: ModelRouter;
  config: AgentConfig;
  modelMode: "openrouter" | "dev-stub";
  dataBackend: "memory" | "prisma";
  chatLimiter: RateLimiter;
}

const g = globalThis as unknown as { __container?: Promise<Container> };

async function createStores(backend: "memory" | "prisma"): Promise<Stores> {
  if (backend === "prisma") {
    const [{ prisma }, { createPrismaStores }] = await Promise.all([import("./db"), import("./stores/prisma")]);
    return createPrismaStores(prisma);
  }
  const dir = join(process.cwd(), "data", "original");
  const seed = buildSeed(readFileSync(join(dir, "users.csv"), "utf8"), readFileSync(join(dir, "properties.csv"), "utf8"));
  return createMemoryStores(seed);
}

function createRouter(config: AgentConfig): { router: ModelRouter; modelMode: Container["modelMode"] } {
  if (config.openRouterApiKey && config.primaryModel) {
    return {
      modelMode: "openrouter",
      router: {
        primary: createOpenRouterModel(config.primaryModel, config.openRouterApiKey),
        fallback: config.fallbackModel ? createOpenRouterModel(config.fallbackModel, config.openRouterApiKey) : null,
        callTimeoutMs: config.llmCallTimeoutMs,
      },
    };
  }
  return { modelMode: "dev-stub", router: { primary: createDevStubModel(), fallback: null, callTimeoutMs: config.llmCallTimeoutMs } };
}

export function getContainer(): Promise<Container> {
  if (g.__container) return g.__container;
  const created = (async (): Promise<Container> => {
    const config = loadAgentConfig();
    const dataBackend: Container["dataBackend"] = process.env.DATA_BACKEND === "prisma" ? "prisma" : "memory";
    const { router, modelMode } = createRouter(config);
    const stores = await createStores(dataBackend);
    console.info(`[container] data=${dataBackend} model=${modelMode}${modelMode === "openrouter" ? ` (${config.primaryModel})` : ""}`);
    return { stores, router, config, modelMode, dataBackend, chatLimiter: new RateLimiter(20, 60_000) };
  })().catch((e) => {
    g.__container = undefined; // allow a retry instead of caching the failure
    throw e;
  });
  g.__container = created;
  return created;
}
