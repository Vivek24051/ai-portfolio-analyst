// Evaluation runner.
//
//   npm run eval -- --mode oracle      positive control (reference policy, mock) — zero cost
//   npm run eval -- --mode perturbed   negative control for numeric faithfulness (oracle with falsified figures)
//   npm run eval -- --mode dev-stub    negative control (keyword stub, mock) — zero cost
//   npm run eval -- --mode openrouter --confirm-paid --max-calls 400 --max-cost-usd 2
//                                      REAL model; refuses to run without all guards, and only with a
//                                      ":free" OpenRouter id unless OPENROUTER_ALLOW_PAID=true (default off)
//
// Options: --repeat N (default 1), --cases R001,M1,…, --no-write (skip report files)
// Output: docs/eval/<mode>.md (committed summary) and eval/results/<mode>-<timestamp>.json (raw, git-ignored).

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { createDevStubModel } from "@/agent/devStubModel";
import { createOpenRouterModel, type ChatModel } from "@/agent/model";
import { buildSeed } from "@/data/seedData";
import { seedFile } from "@/data/paths";
import { isAllowedOpenRouterModel, openRouterPaidAllowed } from "@/agent/config";
import { assertPaidAllowed, budgeted, type Budget } from "./budget";
import { CASES } from "./cases";
import { runCase, type CaseResult } from "./harness";
import { createOracleModel, createPerturbedOracleModel } from "./oracle";
import { summarize, toMarkdown } from "./report";
import { withTokenEstimates, type TokenEstimate } from "./tokens";

type Mode = "oracle" | "perturbed" | "dev-stub" | "openrouter";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const CONDITIONS: Record<Mode, string> = {
  oracle:
    "MOCK. The model is the oracle reference policy (scripted ideal tool calls and replies). This validates the harness, tools, graders and safety checks — it is NOT evidence of LLM quality. Timings exclude any model latency.",
  perturbed:
    "MOCK. Negative control for numeric faithfulness: the oracle with every figure in its replies falsified (+10% on ₹, +3 on %). The faithfulness metric and expected-figure checks should fail; tool/argument checks should still pass. NOT evidence of LLM quality.",
  "dev-stub":
    "MOCK. The model is the keyword dev stub (no LLM). This is a negative control showing the graders detect a weak agent — it is NOT evidence of LLM quality. Timings exclude any model latency.",
  openrouter:
    "REAL model via OpenRouter. Free-only by default (\":free\" model ids); a paid model needs OPENROUTER_ALLOW_PAID=true. Spend caps always apply. See model id and budget in the run log.",
};

async function main() {
  const mode = (arg("mode") ?? "oracle") as Mode;
  if (!["oracle", "perturbed", "dev-stub", "openrouter"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const repeat = Number(arg("repeat") ?? 1);
  const only = arg("cases")?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const seed = buildSeed(readFileSync(seedFile("users.csv"), "utf8"), readFileSync(seedFile("properties.csv"), "utf8"));
  const tokens: TokenEstimate[] = [];

  let model: (c: (typeof CASES)[number]) => ChatModel;
  let modelId: string;
  let budget: Budget | null = null;
  if (mode === "oracle") {
    modelId = "oracle (reference policy, mock)";
    model = (c) => withTokenEstimates(createOracleModel(c), tokens);
  } else if (mode === "perturbed") {
    modelId = "oracle-perturbed (falsified figures, mock)";
    model = (c) => withTokenEstimates(createPerturbedOracleModel(c), tokens);
  } else if (mode === "dev-stub") {
    modelId = "dev-stub (keyword router, mock)";
    model = () => withTokenEstimates(createDevStubModel({ streamDelayMs: 0 }), tokens);
  } else {
    const paid = assertPaidAllowed(process.env, process.argv);
    // Defence in depth: the same free-only rule as the app, checked again right before the client exists.
    if (!isAllowedOpenRouterModel(paid.model, openRouterPaidAllowed(process.env))) throw new Error("Refused: non-free OpenRouter model without opt-in.");
    budget = { maxCalls: paid.maxCalls, maxCostUsd: paid.maxCostUsd, calls: 0, costUsd: 0 };
    modelId = paid.model;
    const real = createOpenRouterModel(paid.model, paid.apiKey);
    model = () => withTokenEstimates(budgeted(real, budget!), tokens);
  }

  const results: CaseResult[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const c of cases) {
      results.push(await runCase(c, { seed, model }));
      process.stdout.write(results.at(-1)!.passed ? "." : "F");
    }
  }
  process.stdout.write("\n");

  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }
  const meta = {
    mode,
    modelId,
    repeat,
    startedAt: new Date().toISOString(),
    node: process.versions.node,
    platform: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model.trim() ?? "unknown CPU"} ×${cpus().length}`,
    gitCommit,
    conditions: CONDITIONS[mode] + (budget ? ` Calls used: ${budget.calls}/${budget.maxCalls}; reported cost $${budget.costUsd.toFixed(4)} (cap $${budget.maxCostUsd}).` : ""),
  };
  const summary = summarize(results, tokens);
  const md = toMarkdown(meta, summary);

  if (!flag("no-write")) {
    mkdirSync(join("docs", "eval"), { recursive: true });
    mkdirSync(join("eval", "results"), { recursive: true });
    writeFileSync(join("docs", "eval", `${mode}.md`), md);
    writeFileSync(join("eval", "results", `${mode}-${meta.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify({ meta, summary, results }, null, 2));
  }
  console.log(md.split("## Coverage")[0]);
  console.log(`Cases passed: ${summary.cases.passed}/${summary.cases.total}; safety violations: ${summary.safetyViolations.length}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
