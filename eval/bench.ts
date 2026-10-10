// In-process benchmark of the server-side pipeline with ZERO model latency (oracle mock model,
// in-memory store). Isolates our own overhead: context load, graph + tool execution, persistence.
// It does NOT measure LLM latency, network, HTTP, or PostgreSQL.
//
//   npm run bench -- --iterations 30
// Output: docs/eval/bench-inprocess.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { buildSeed } from "@/data/seedData";
import { seedFile } from "@/data/paths";
import { percentile } from "@/lib/stats";
import { CASES } from "./cases";
import { runCase } from "./harness";
import { createOracleModel } from "./oracle";

const i = process.argv.indexOf("--iterations");
const iterations = (i >= 0 && Number(process.argv[i + 1])) || 30;
const seed = buildSeed(readFileSync(seedFile("users.csv"), "utf8"), readFileSync(seedFile("properties.csv"), "utf8"));
const cases = CASES.filter((c) => !c.fault); // fault cases exercise failure paths, not normal latency
const run = (c: (typeof CASES)[number]) => runCase(c, { seed, model: (x) => createOracleModel(x) });

const spans: Record<string, number[]> = {};
const tools: Record<string, number[]> = {};
const add = (bucket: Record<string, number[]>, k: string, v: number) => (bucket[k] ??= []).push(v);
const r3 = (n: number | null) => (n === null ? "—" : String(Math.round(n * 1000) / 1000));

async function main() {
  for (const c of cases) await run(c); // warm-up (JIT, module init) — not recorded

  for (let it = 0; it < iterations; it++) {
    for (const c of cases) {
      for (const t of (await run(c)).turns) {
        const o = t.outcome;
        if (o.status !== "ok") continue;
        add(spans, "turn wall time (high-res)", o.wallMs);
        add(spans, "server total (1 ms res.)", o.telemetry.totalMs);
        for (const s of o.telemetry.spans) add(spans, `span: ${s.name}`, s.ms);
        add(spans, "model calls (mock ≈ 0)", o.telemetry.llmMs);
        for (const tc of o.toolCalls) add(tools, tc.name, tc.durationMs);
      }
    }
  }

  const row = (name: string, v: number[]) => `| ${name} | ${v.length} | ${r3(percentile(v, 50))} | ${r3(percentile(v, 95))} | ${r3(Math.max(...v))} |`;
  const md = [
    "# In-process benchmark (mock model, in-memory store)",
    "",
    "> **Conditions:** server pipeline called in-process (no HTTP). Model = oracle mock (no network, ~0 ms). Store = in-memory.",
    "> This measures our own overhead only. It is **not** LLM latency, **not** HTTP latency and **not** PostgreSQL latency.",
    "",
    "| | |",
    "|---|---|",
    `| Date | ${new Date().toISOString()} |`,
    `| Machine | ${cpus()[0]?.model.trim()} ×${cpus().length} · ${platform()} ${release()} · Node ${process.versions.node} |`,
    `| Workload | ${cases.length} golden cases (${cases.reduce((s, c) => s + c.turns.length, 0)} turns, fault cases excluded) × ${iterations} iterations, after 1 warm-up pass |`,
    "",
    "## Per turn (ms)",
    "",
    "| Measure | n | p50 | p95 | max |",
    "|---|---|---|---|---|",
    ...Object.entries(spans).map(([k, v]) => row(k, v)),
    "",
    "## Per tool call (ms, 1 ms resolution)",
    "",
    "| Tool | n | p50 | p95 | max |",
    "|---|---|---|---|---|",
    ...Object.entries(tools)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => row(k, v)),
    "",
    "Production spans and tool durations are recorded in whole milliseconds (they are stored as integers), so sub-millisecond work shows as 0. The high-resolution wall time is measured by the harness around each turn.",
    "",
  ].join("\n");
  mkdirSync(join("docs", "eval"), { recursive: true });
  writeFileSync(join("docs", "eval", "bench-inprocess.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
