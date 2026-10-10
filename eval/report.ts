// Aggregates graded case results into metrics and a Markdown report.

import { percentile } from "@/lib/stats";
import type { CheckName } from "./graders";
import type { CaseResult } from "./harness";
import type { TokenEstimate } from "./tokens";
import { CATEGORIES } from "./types";

export interface RunMeta {
  mode: string;
  modelId: string;
  repeat: number;
  startedAt: string;
  node: string;
  platform: string;
  cpu: string;
  gitCommit: string;
  conditions: string;
}

const rate = (pass: number, total: number) => (total === 0 ? "n/a" : `${((pass / total) * 100).toFixed(1)}% (${pass}/${total})`);

function stats(values: number[]) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null };
}

export function summarize(results: CaseResult[], tokens: TokenEstimate[]) {
  const turns = results.flatMap((r) => r.turns);
  const checks = turns.flatMap((t) => t.checks);
  const by = (name: CheckName) => {
    const cs = checks.filter((c) => c.name === name);
    return { pass: cs.filter((c) => c.pass).length, total: cs.length };
  };
  const spans = (name: string) => turns.flatMap((t) => t.outcome.telemetry.spans.filter((s) => s.name === name).map((s) => s.ms));
  const okTurns = turns.filter((t) => t.outcome.status === "ok");
  return {
    cases: { total: results.length, passed: results.filter((r) => r.passed).length },
    turns: turns.length,
    checks: Object.fromEntries(
      (["tool_selection", "arguments", "figures", "content", "clarification", "proposal", "hypothetical", "handoff", "status", "fallback", "numeric_faithfulness", "reply_pattern"] as CheckName[]).map((n) => [n, by(n)]),
    ),
    safetyViolations: results.flatMap((r) => r.safety.map((s) => `${r.caseId}: ${s}`)),
    missingWrites: results.flatMap((r) => r.missingWrites.map((s) => `${r.caseId}: ${s}`)),
    byCategory: CATEGORIES.map((cat) => {
      const rs = results.filter((r) => r.category === cat);
      return { category: cat, cases: rs.length, turns: rs.reduce((s, r) => s + r.turns.length, 0), passed: rs.filter((r) => r.passed).length };
    }),
    latency: {
      totalMs: stats(okTurns.map((t) => t.outcome.telemetry.totalMs)),
      llmMs: stats(okTurns.map((t) => t.outcome.telemetry.llmMs)),
      toolMs: stats(okTurns.map((t) => t.outcome.telemetry.toolMs)),
      request_validation: stats(spans("request_validation")),
      context_load: stats(spans("context_load")),
      agent: stats(spans("agent")),
      persist: stats(spans("persist")),
    },
    llmCallsPerTurn: stats(turns.map((t) => t.outcome.telemetry.llmCalls)),
    toolCallsPerTurn: stats(turns.map((t) => t.outcome.telemetry.toolCalls)),
    tokenEstimates: {
      calls: tokens.length,
      input: stats(tokens.map((t) => t.inputTokens)),
      output: stats(tokens.map((t) => t.outputTokens)),
      inputTotal: tokens.reduce((s, t) => s + t.inputTokens, 0),
      outputTotal: tokens.reduce((s, t) => s + t.outputTokens, 0),
    },
    failures: results.flatMap((r) =>
      r.turns.flatMap((t) => t.checks.filter((c) => !c.pass).map((c) => ({ caseId: r.caseId, turn: t.outcome.turn, check: c.name, detail: c.detail, reply: t.outcome.reply.slice(0, 160) }))),
    ),
  };
}

export type Summary = ReturnType<typeof summarize>;

const fmt = (v: number | null) => (v === null ? "—" : String(v));

export function toMarkdown(meta: RunMeta, s: Summary): string {
  const c = s.checks;
  const lines = [
    `# Evaluation report — ${meta.mode}`,
    "",
    `> **Conditions:** ${meta.conditions}`,
    "",
    `| | |`,
    `|---|---|`,
    `| Model | ${meta.modelId} |`,
    `| Started | ${meta.startedAt} |`,
    `| Repeats | ${meta.repeat} |`,
    `| Machine | ${meta.cpu} · ${meta.platform} · Node ${meta.node} |`,
    `| Commit | ${meta.gitCommit} |`,
    "",
    "## Scores",
    "",
    "| Metric | Result |",
    "|---|---|",
    `| Cases fully passed | ${rate(s.cases.passed, s.cases.total)} |`,
    `| Tool selection | ${rate(c.tool_selection!.pass, c.tool_selection!.total)} |`,
    `| Argument accuracy | ${rate(c.arguments!.pass, c.arguments!.total)} |`,
    `| Expected figures stated | ${rate(c.figures!.pass, c.figures!.total)} |`,
    `| Numeric faithfulness (replies whose every number traces to tool output) | ${rate(c.numeric_faithfulness!.pass, c.numeric_faithfulness!.total)} |`,
    `| Clarification behaviour | ${rate(c.clarification!.pass, c.clarification!.total)} |`,
    `| Proposal / no-proposal correct | ${rate(c.proposal!.pass, c.proposal!.total)} |`,
    `| Hypothetical labelling | ${rate(c.hypothetical!.pass, c.hypothetical!.total)} |`,
    `| Content (must / must-not mention) | ${rate(c.content!.pass, c.content!.total)} |`,
    `| Reply patterns | ${rate(c.reply_pattern!.pass, c.reply_pattern!.total)} |`,
    `| Handoff / status / fallback | ${rate(c.handoff!.pass + c.status!.pass + c.fallback!.pass, c.handoff!.total + c.status!.total + c.fallback!.total)} |`,
    `| **Safety violations** | **${s.safetyViolations.length}** |`,
    `| Expected writes missing | ${s.missingWrites.length} |`,
    "",
    "## Coverage",
    "",
    "| Category | Cases | Turns | Passed |",
    "|---|---|---|---|",
    ...s.byCategory.map((b) => `| ${b.category} | ${b.cases} | ${b.turns} | ${b.passed} |`),
    `| **Total** | **${s.cases.total}** | **${s.turns}** | **${s.cases.passed}** |`,
    "",
    "## Server-side timings (ms, successful turns)",
    "",
    "| Span | n | p50 | p95 | max |",
    "|---|---|---|---|---|",
    ...Object.entries(s.latency).map(([k, v]) => `| ${k} | ${v.n} | ${fmt(v.p50)} | ${fmt(v.p95)} | ${fmt(v.max)} |`),
    "",
    `Model calls per turn: p50 ${fmt(s.llmCallsPerTurn.p50)}, max ${fmt(s.llmCallsPerTurn.max)}. Tool calls per turn: p50 ${fmt(s.toolCallsPerTurn.p50)}, max ${fmt(s.toolCallsPerTurn.max)}.`,
    "",
    "## Token estimates (cl100k approximation, for cost planning only)",
    "",
    s.tokenEstimates.calls
      ? `${s.tokenEstimates.calls} model calls · input tokens/call p50 ${fmt(s.tokenEstimates.input.p50)}, p95 ${fmt(s.tokenEstimates.input.p95)}, max ${fmt(s.tokenEstimates.input.max)} · output tokens/call p50 ${fmt(s.tokenEstimates.output.p50)}, max ${fmt(s.tokenEstimates.output.max)} · totals: ${s.tokenEstimates.inputTotal} in / ${s.tokenEstimates.outputTotal} out.`
      : "Not collected in this mode.",
    "",
    "## Safety violations",
    "",
    ...(s.safetyViolations.length ? s.safetyViolations.map((v) => `- ${v}`) : ["None."]),
    "",
    "## Failed checks",
    "",
    ...(s.failures.length
      ? ["| Case | Turn | Check | Detail |", "|---|---|---|---|", ...s.failures.map((f) => `| ${f.caseId} | ${f.turn} | ${f.check} | ${f.detail.replace(/\|/g, "\\|")} |`)]
      : ["None."]),
    "",
  ];
  return lines.join("\n");
}
