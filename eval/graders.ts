// Deterministic graders. No LLM-as-judge: every check is a rule over the turn's observable
// outcome (tool calls from the run record, reply text, staged proposal, flags, state).

import { checkNumericFaithfulness, extractNumbers } from "@/agent/faithfulness";
import type { ToolExpectation, TurnExpect } from "./types";

export interface ToolCallSeen {
  name: string;
  args: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

export interface TurnOutcome {
  caseId: string;
  turn: number;
  user: string;
  reply: string;
  status: "ok" | "error";
  proposal: "CREATE_PROPERTY" | "UPDATE_PROPERTY" | null;
  hypothetical: boolean;
  handoff: boolean;
  fallbackUsed: boolean;
  toolCalls: ToolCallSeen[];
  /** From the production faithfulness check recorded on the run (null for error turns). */
  faithfulness: { checked: number; unsupported: string[] } | null;
  /** High-resolution wall time of the whole turn, measured by the harness (not rounded). */
  wallMs: number;
  telemetry: { totalMs: number; llmMs: number; toolMs: number; llmCalls: number; toolCalls: number; spans: Array<{ name: string; ms: number }> };
}

export type CheckName =
  | "tool_selection"
  | "arguments"
  | "figures"
  | "content"
  | "clarification"
  | "proposal"
  | "hypothetical"
  | "handoff"
  | "status"
  | "fallback"
  | "numeric_faithfulness"
  | "reply_pattern";

export interface Check {
  name: CheckName;
  pass: boolean;
  detail: string;
}

/** Partial deep match: every key/element in `expected` must match `actual`. Arrays must match in length. */
export function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => partialMatch(actual[i], e));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => partialMatch((actual as Record<string, unknown>)[k], v));
  }
  if (typeof expected === "string" && typeof actual === "string") return expected.toLowerCase() === actual.toLowerCase();
  return actual === expected;
}

const called = (o: TurnOutcome, e: ToolExpectation) => o.toolCalls.some((c) => c.name === e.name);
const calledWithArgs = (o: TurnOutcome, e: ToolExpectation) => o.toolCalls.some((c) => c.name === e.name && (!e.args || partialMatch(c.args, e.args)));
const describe = (e: ToolExpectation | ToolExpectation[]) => (Array.isArray(e) ? e.map((x) => x.name).join(" | ") : e.name);

/** Does the reply state this figure (by value, rounding-tolerant)? */
export function replyStatesFigure(reply: string, figure: string): boolean {
  if (extractNumbers(figure).length === 0) return reply.includes(figure);
  // Reuse the faithfulness matcher in reverse: the expected figure must be "supported" by the reply.
  return checkNumericFaithfulness(figure, [reply]).unsupported.length === 0;
}

export function gradeTurn(expect: TurnExpect, o: TurnOutcome): Check[] {
  const checks: Check[] = [];
  const add = (name: CheckName, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const used = o.toolCalls.map((c) => c.name);

  if (expect.tools?.length || expect.forbidTools?.length) {
    const missing = (expect.tools ?? []).filter((t) => !(Array.isArray(t) ? t.some((x) => called(o, x)) : called(o, t)));
    const forbidden = (expect.forbidTools ?? []).filter((f) => o.toolCalls.some((c) => c.name === f && c.ok));
    add(
      "tool_selection",
      missing.length === 0 && forbidden.length === 0,
      [missing.length ? `missing: ${missing.map(describe).join(", ")}` : "", forbidden.length ? `forbidden used: ${forbidden.join(", ")}` : "", `used: [${used.join(", ")}]`]
        .filter(Boolean)
        .join("; "),
    );
  }
  for (const t of expect.tools ?? []) {
    const options = Array.isArray(t) ? t : [t];
    if (!options.some((x) => x.args)) continue;
    const ok = options.some((x) => calledWithArgs(o, x));
    add("arguments", ok, ok ? `${describe(t)} args ok` : `${describe(t)} args mismatch; got ${JSON.stringify(o.toolCalls.filter((c) => options.some((x) => x.name === c.name)).map((c) => c.args))}`);
  }
  for (const f of expect.figures ?? []) add("figures", replyStatesFigure(o.reply, f), `expects ${f}`);
  for (const m of expect.mentions ?? []) add("content", o.reply.includes(m), `mentions ${m}`);
  for (const m of expect.notMentions ?? []) add("content", !o.reply.includes(m), `does not mention ${m}`);
  for (const re of expect.replyMatches ?? []) add("reply_pattern", re.test(o.reply), `matches ${re}`);
  for (const re of expect.replyNotMatches ?? []) add("reply_pattern", !re.test(o.reply), `does not match ${re}`);

  if (expect.clarify !== undefined) {
    const asked = o.reply.includes("?");
    const wrote = o.proposal !== null || o.toolCalls.some((c) => c.name === "confirm_pending_action" && c.ok);
    add("clarification", expect.clarify ? asked && !wrote : !asked, expect.clarify ? `asked=${asked} staged/applied=${wrote}` : `asked=${asked}`);
  }
  if (expect.proposal !== undefined) add("proposal", o.proposal === expect.proposal, `expected ${expect.proposal ?? "none"}, got ${o.proposal ?? "none"}`);
  if (expect.hypothetical !== undefined) add("hypothetical", o.hypothetical === expect.hypothetical, `hypothetical=${o.hypothetical}`);
  if (expect.handoff !== undefined) add("handoff", o.handoff === expect.handoff, `handoff=${o.handoff}`);
  if (expect.status !== undefined) add("status", o.status === expect.status, `status=${o.status}`);
  if (expect.fallbackUsed !== undefined) add("fallback", o.fallbackUsed === expect.fallbackUsed, `fallbackUsed=${o.fallbackUsed}`);

  if (o.faithfulness && o.faithfulness.checked > 0) {
    add("numeric_faithfulness", o.faithfulness.unsupported.length === 0, o.faithfulness.unsupported.length ? `unsupported: ${o.faithfulness.unsupported.join(", ")}` : `${o.faithfulness.checked} figures traced`);
  }
  return checks;
}
