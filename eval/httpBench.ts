// HTTP benchmark against a RUNNING server (normally `next start` locally with the dev stub).
// Client-observed latency for the JSON and the SSE endpoints, plus the server's own totals.
//
//   1) npm run build
//   2) SESSION_SECRET=<32+ chars> DEV_STUB_STREAM_DELAY_MS=0 CHAT_RATE_LIMIT_PER_MIN=100000 npx next start -p 3123
//   3) BENCH_URL=http://localhost:3123 npm run bench:http -- --iterations 25
// Output: docs/eval/bench-http.md
//
// With the dev stub there is no LLM: this measures Next.js routing, auth, validation, the agent
// pipeline, persistence and SSE framing on one machine over loopback. Not internet, not an LLM.

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { percentile } from "@/lib/stats";
import { SseParser } from "@/lib/sse";

const BASE = process.env.BENCH_URL ?? "http://localhost:3123";
const ii = process.argv.indexOf("--iterations");
const iterations = (ii >= 0 && Number(process.argv[ii + 1])) || 25;

const PROMPTS: Array<{ userId: string; message: string }> = [
  { userId: "U001", message: "portfolio overview" },
  { userId: "U003", message: "Which property has the highest rent?" },
  { userId: "U002", message: "Show me my properties in Mumbai" },
  { userId: "U001", message: "show my retail properties" },
];

async function login(userId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

const series: Record<string, number[]> = {};
const add = (k: string, v: number) => (series[k] ??= []).push(v);

async function jsonTurn(cookie: string, message: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message }) });
  const body = (await res.json()) as { status?: string; telemetry?: { totalMs: number } };
  const t1 = performance.now();
  if (!res.ok || body.status !== "ok") throw new Error(`json turn failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  add("JSON /api/chat — client total", t1 - t0);
  add("JSON /api/chat — server totalMs", body.telemetry!.totalMs);
}

async function streamTurn(cookie: string, message: string) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/chat/stream`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message }) });
  const tHeaders = performance.now();
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let firstEvent: number | null = null;
  let firstDelta: number | null = null;
  let done: number | null = null;
  let serverTotal: number | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    for (const e of parser.push(decoder.decode(value, { stream: true }))) {
      const now = performance.now();
      firstEvent ??= now;
      if (e.type === "delta") firstDelta ??= now;
      if (e.type === "done") {
        done = now;
        serverTotal = e.result.telemetry.totalMs;
      }
      if (e.type === "error") throw new Error(`stream error: ${e.message}`);
    }
  }
  if (done === null || firstEvent === null) throw new Error("stream ended without done");
  add("SSE /api/chat/stream — response headers", tHeaders - t0);
  add("SSE /api/chat/stream — first event", firstEvent - t0);
  if (firstDelta !== null) add("SSE /api/chat/stream — first answer token", firstDelta - t0);
  add("SSE /api/chat/stream — done", done - t0);
  add("SSE /api/chat/stream — server totalMs", serverTotal!);
}

async function main() {
  const session = (await (await fetch(`${BASE}/api/session`)).json()) as { modelMode: string; dataBackend: string };
  const cookies = Object.fromEntries(await Promise.all([...new Set(PROMPTS.map((p) => p.userId))].map(async (u) => [u, await login(u)] as const)));

  for (const p of PROMPTS) await jsonTurn(cookies[p.userId]!, p.message); // warm-up (route compilation, JIT)
  for (const k of Object.keys(series)) delete series[k];

  for (let i = 0; i < iterations; i++) {
    for (const p of PROMPTS) {
      await jsonTurn(cookies[p.userId]!, p.message);
      await streamTurn(cookies[p.userId]!, p.message);
    }
  }

  const r1 = (n: number | null) => (n === null ? "—" : (Math.round(n * 10) / 10).toFixed(1));
  const md = [
    "# HTTP benchmark (local production build, dev stub)",
    "",
    `> **Conditions:** \`next start\` on the same machine, loopback HTTP. Model mode reported by the server: **${session.modelMode}**; data backend: **${session.dataBackend}**.`,
    "> With the dev stub there is **no LLM**: these numbers are our HTTP + auth + validation + agent pipeline + persistence + SSE overhead only. They are **not** real-model latency and **not** internet latency.",
    "",
    "| | |",
    "|---|---|",
    `| Date | ${new Date().toISOString()} |`,
    `| Server | ${BASE} |`,
    `| Machine | ${cpus()[0]?.model.trim()} ×${cpus().length} · ${platform()} ${release()} · Node ${process.versions.node} (client and server on the same machine) |`,
    `| Workload | ${PROMPTS.length} prompts × ${iterations} iterations per endpoint, sequential, after 1 warm-up pass |`,
    "",
    "| Measure (ms) | n | p50 | p95 | max |",
    "|---|---|---|---|---|",
    ...Object.entries(series).map(([k, v]) => `| ${k} | ${v.length} | ${r1(percentile(v, 50))} | ${r1(percentile(v, 95))} | ${r1(Math.max(...v))} |`),
    "",
  ].join("\n");
  mkdirSync(join("docs", "eval"), { recursive: true });
  writeFileSync(join("docs", "eval", "bench-http.md"), md);
  console.log(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
