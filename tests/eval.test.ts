// The golden evaluation set as a regression gate (MOCKED models — no LLM, no network).
//  - oracle (positive control) must pass every case with zero safety violations;
//  - perturbed oracle (negative control) must be caught by the numeric-faithfulness metric;
//  - grader and spend-guard unit tests.
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { assertPaidAllowed, budgeted, BudgetExceeded } from "../eval/budget";
import { CASES } from "../eval/cases";
import { gradeTurn, partialMatch, replyStatesFigure, type TurnOutcome } from "../eval/graders";
import { runCase } from "../eval/harness";
import { createOracleModel, createPerturbedOracleModel, perturbFigures } from "../eval/oracle";
import { summarize } from "../eval/report";
import { CATEGORIES } from "../eval/types";
import { loadSeed } from "./helpers";

const seed = loadSeed();

describe("golden set", () => {
  it("covers every category, has unique ids and ≥ 40 cases", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const cat of CATEGORIES) expect(CASES.some((c) => c.category === cat)).toBe(true);
    for (const id of ["R001", "R002", "R003", "R004", "R005", "R006"]) expect(CASES.some((c) => c.id === id)).toBe(true);
  });

  it("oracle (positive control) passes every case with no safety violations", async () => {
    const results = [];
    for (const c of CASES) results.push(await runCase(c, { seed, model: (x) => createOracleModel(x) }));
    const s = summarize(results, []);
    const failing = results.filter((r) => !r.passed).map((r) => ({ id: r.caseId, safety: r.safety, missing: r.missingWrites, failed: r.turns.flatMap((t) => t.checks.filter((c) => !c.pass)) }));
    expect(failing).toEqual([]);
    expect(s.safetyViolations).toEqual([]);
    expect(s.checks.numeric_faithfulness!.pass).toBe(s.checks.numeric_faithfulness!.total);
  }, 60_000);

  it("perturbed oracle (negative control) is caught by numeric faithfulness and figure checks", async () => {
    const results = [];
    for (const c of CASES) results.push(await runCase(c, { seed, model: (x) => createPerturbedOracleModel(x) }));
    const s = summarize(results, []);
    const f = s.checks.numeric_faithfulness!;
    expect(f.pass / f.total).toBeLessThan(0.1);
    expect(s.checks.figures!.pass / s.checks.figures!.total).toBeLessThan(0.1);
    // Tool behaviour is unchanged, so those checks still pass: the metrics are independent.
    expect(s.checks.tool_selection!.pass).toBe(s.checks.tool_selection!.total);
  }, 60_000);
});

describe("graders", () => {
  it("partialMatch: nested objects, arrays by position, case-insensitive strings", () => {
    expect(partialMatch({ filter: { assetClasses: ["RETAIL"], city: "x" } }, { filter: { assetClasses: ["retail"] } })).toBe(true);
    expect(partialMatch({ filter: { assetClasses: ["RETAIL", "OFFICE"] } }, { filter: { assetClasses: ["RETAIL"] } })).toBe(false);
    expect(partialMatch({ value: { amount: 12.5, unit: "CRORE" } }, { value: { amount: 12.5 } })).toBe(true);
    expect(partialMatch(undefined, { a: 1 })).toBe(false);
  });

  it("replyStatesFigure matches by value with rounding tolerance", () => {
    expect(replyStatesFigure("Worth ₹29.7 crore in total", "₹29.7 Cr")).toBe(true);
    expect(replyStatesFigure("Retail is about 71.4%", "71.38%")).toBe(true);
    expect(replyStatesFigure("Worth ₹30 Cr", "₹29.7 Cr")).toBe(false);
  });

  it("clarification requires a question AND no staged or applied change", () => {
    const base: TurnOutcome = {
      caseId: "x", turn: 1, user: "", reply: "Which one?", status: "ok", proposal: null, hypothetical: false, handoff: false,
      fallbackUsed: false, toolCalls: [], faithfulness: null, wallMs: 0, telemetry: { totalMs: 0, llmMs: 0, toolMs: 0, llmCalls: 0, toolCalls: 0, spans: [] },
    };
    expect(gradeTurn({ clarify: true }, base)[0]!.pass).toBe(true);
    expect(gradeTurn({ clarify: true }, { ...base, proposal: "UPDATE_PROPERTY" })[0]!.pass).toBe(false);
    expect(gradeTurn({ clarify: true }, { ...base, reply: "Done." })[0]!.pass).toBe(false);
  });

  it("forbidden tools only count when they actually succeeded", () => {
    const o = (ok: boolean): TurnOutcome => ({
      caseId: "x", turn: 1, user: "", reply: "", status: "ok", proposal: null, hypothetical: false, handoff: false, fallbackUsed: false,
      toolCalls: [{ name: "confirm_pending_action", args: {}, ok, error: ok ? null : "same_turn", durationMs: 0 }], faithfulness: null, wallMs: 0,
      telemetry: { totalMs: 0, llmMs: 0, toolMs: 0, llmCalls: 0, toolCalls: 0, spans: [] },
    });
    expect(gradeTurn({ forbidTools: ["confirm_pending_action"] }, o(true))[0]!.pass).toBe(false);
    expect(gradeTurn({ forbidTools: ["confirm_pending_action"] }, o(false))[0]!.pass).toBe(true);
  });

  it("perturbFigures changes ₹ and % figures", () => {
    expect(perturbFigures("₹29.7 Cr and 71.38%")).toBe("₹32.67 Cr and 74.38%");
  });
});

describe("paid-run spend guards (no network)", () => {
  const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv;

  it("refuses unless every guard is present", () => {
    expect(() => assertPaidAllowed(env({}), [])).toThrow(/EVAL_ALLOW_PAID=1, --confirm-paid, OPENROUTER_API_KEY, LLM_PRIMARY_MODEL, --max-calls N, --max-cost-usd X/);
    const ok = assertPaidAllowed(env({ EVAL_ALLOW_PAID: "1", OPENROUTER_API_KEY: "k", LLM_PRIMARY_MODEL: "m" }), ["--confirm-paid", "--max-calls", "10", "--max-cost-usd", "0.5"]);
    expect(ok).toEqual({ apiKey: "k", model: "m", maxCalls: 10, maxCostUsd: 0.5 });
  });

  it("stops after max calls and after the reported cost cap", async () => {
    const priced = { id: "m", invoke: async () => new AIMessage({ content: "x", response_metadata: { usage: { cost: 0.3 } } }) };
    const b = { maxCalls: 5, maxCostUsd: 0.5, calls: 0, costUsd: 0 };
    const m = budgeted(priced, b);
    const opts = { tools: null, signal: new AbortController().signal };
    await m.invoke([], opts);
    await m.invoke([], opts); // cost now 0.6 ≥ 0.5
    await expect(m.invoke([], opts)).rejects.toBeInstanceOf(BudgetExceeded);
    const b2 = { maxCalls: 1, maxCostUsd: 100, calls: 0, costUsd: 0 };
    const m2 = budgeted({ id: "m", invoke: async () => new AIMessage("x") }, b2);
    await m2.invoke([], opts);
    await expect(m2.invoke([], opts)).rejects.toThrow(/max calls/);
  });
});
