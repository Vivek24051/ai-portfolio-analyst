// Agent tools: strict zod schemas + execution against the user-scoped stores.
//
// Trust boundary:
//  - The model supplies only the arguments described by each schema. No schema has a userId
//    field, and every schema is .strict(), so `{"userId": "U002"}` is rejected as invalid.
//  - userId / conversationId / runId come from ToolContext, built server-side from the session.
//  - Every figure returned is produced by src/domain (deterministic) and pre-formatted.
//  - Tool failures are returned to the model as structured errors, never thrown into the loop.

import { z } from "zod";
import { logError } from "@/server/redact";
import { compareGroups, pct, rankProperties, RANK_METRICS, summarizePortfolio, toView } from "@/domain/analytics";
import { applyFilter, propertyFilterSchema, type PropertyFilter } from "@/domain/filters";
import { formatInr, moneySchema, toInr, MoneyError } from "@/domain/money";
import { createPropertyInputSchema, updatePropertyChangesSchema } from "@/domain/propertyChanges";
import { applyPercentChange, runScenario, ScenarioError, scenarioInputSchema, type ScenarioInput } from "@/domain/scenario";
import { ASSET_CLASSES } from "@/domain/types";
import type { Property } from "@/domain/types";
import {
  cancelPendingAction,
  confirmPendingAction,
  proposeCreate,
  proposeUpdate,
  type ProposeResult,
} from "@/server/services/propertyActions";
import type { Stores } from "@/server/stores/types";
import type { ConversationState } from "./conversationState";
import { fmtDelta, fmtPct, fmtPp, presentGroup, presentProperty, presentRanked, presentSummary, SUMMARY_SECTIONS } from "./present";

// ---------- Context ----------

export interface TurnEvents {
  proposed: Extract<ProposeResult, { status: "proposed" }> | null;
  confirmedPropertyId: string | null;
  hypothetical: boolean;
  handoff: { reason: string; note: string } | null;
}

/** Trusted per-turn context. Built by the server, closed over by tools, invisible to the model. */
export interface ToolContext {
  userId: string;
  conversationId: string;
  runId: string;
  now: Date;
  stores: Stores;
  /** The user message that started this turn (used by the confirm safeguard). */
  latestUserMessage: string;
  /** Mutable copy of the conversation state; persisted at the end of the turn. */
  state: ConversationState;
  events: TurnEvents;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  /** Write tools run sequentially; read tools in the same round may run in parallel. */
  writes: boolean;
  run(ctx: ToolContext, args: z.output<S>): Promise<unknown>;
}

const defineTool = <S extends z.ZodObject>(t: ToolDefinition<S>) => t as unknown as ToolDefinition;

// ---------- Shared argument schemas ----------

/** Filter as the model sees it: money thresholds take {amount, unit}; the backend converts. */
const toolFilterSchema = propertyFilterSchema
  .omit({ valueAboveInr: true, valueBelowInr: true })
  .extend({
    valueAbove: moneySchema.optional().describe("Strictly above this current value, e.g. {amount:10, unit:'CRORE'}"),
    valueBelow: moneySchema.optional().describe("Strictly below this current value"),
  })
  .strict();
type ToolFilter = z.infer<typeof toolFilterSchema>;

function toDomainFilter(f: ToolFilter | undefined): PropertyFilter {
  if (!f) return {};
  const { valueAbove, valueBelow, ...rest } = f;
  return {
    ...rest,
    ...(valueAbove ? { valueAboveInr: toInr(valueAbove) } : {}),
    ...(valueBelow ? { valueBelowInr: toInr(valueBelow) } : {}),
  };
}

async function activePortfolio(ctx: ToolContext): Promise<Property[]> {
  const all = await ctx.stores.properties.listByUser(ctx.userId);
  return all.filter((p) => p.status === "ACTIVE");
}

const isEmptyFilter = (f: PropertyFilter) => Object.keys(f).length === 0;

// ---------- Read tools ----------

const searchProperties = defineTool({
  name: "search_properties",
  description:
    "List the user's properties, optionally filtered and ranked. Use for 'show me my retail', 'properties in Mumbai', " +
    "'above ₹10 Cr', and 'which property has the highest rent/yield/value' (sortBy + limit). Ties share a rank.",
  writes: false,
  schema: z
    .object({
      filter: toolFilterSchema.optional(),
      sortBy: z.enum(RANK_METRICS).optional().describe("Rank by value, rent, yield (gross), area or value_per_sqft"),
      order: z.enum(["desc", "asc"]).default("desc"),
      limit: z.number().int().min(1).max(50).optional().describe("Top N by rank (ties are never split)"),
    })
    .strict(),
  async run(ctx, args) {
    const filter = toDomainFilter(args.filter);
    const matches = applyFilter(await activePortfolio(ctx), filter);
    if (matches.length > 0) ctx.state.focusPropertyIds = matches.map((p) => p.id);

    if (!args.sortBy) {
      const shown = args.limit ? matches.slice(0, args.limit) : matches;
      return { matchCount: matches.length, properties: shown.map((p) => presentProperty(toView(p))) };
    }
    const ranking = rankProperties(matches, args.sortBy, args.order, args.limit);
    return {
      matchCount: matches.length,
      rankedBy: `${args.sortBy} (${args.order === "desc" ? "highest first" : "lowest first"})`,
      topIsTied: ranking.topIsTied,
      properties: ranking.entries.map(presentRanked),
      excludedFromRanking: ranking.excluded,
    };
  },
});

const portfolioAnalytics = defineTool({
  name: "portfolio_analytics",
  description:
    "Portfolio totals and breakdowns: total value, annual rent, gross yield, mix by asset class / sector " +
    "(COMMERCIAL = retail + office) / city / occupancy, highest & lowest value, highest rent, and data gaps. " +
    "Optional filter analyses a subset and reports its share of the whole portfolio.",
  writes: false,
  schema: z
    .object({
      filter: toolFilterSchema.optional(),
      sections: z.array(z.enum(SUMMARY_SECTIONS)).min(1).optional().describe("Omit for all sections"),
    })
    .strict(),
  async run(ctx, args) {
    const all = await activePortfolio(ctx);
    const filter = toDomainFilter(args.filter);
    if (isEmptyFilter(filter)) return { scope: "whole portfolio", ...presentSummary(summarizePortfolio(all), args.sections) };

    const subset = applyFilter(all, filter);
    if (subset.length > 0) ctx.state.focusPropertyIds = subset.map((p) => p.id);
    const whole = summarizePortfolio(all);
    const part = summarizePortfolio(subset);
    return {
      scope: `filtered: ${subset.length} of ${all.length} properties`,
      shareOfWholePortfolioValue: fmtPct(pct(part.totalValueInr, whole.totalValueInr)),
      wholePortfolio: { properties: whole.propertyCount, totalValue: formatInr(whole.totalValueInr) },
      ...presentSummary(part, args.sections),
    };
  },
});

const groupSchema = z.object({ label: z.string().min(1).max(40), filter: toolFilterSchema }).strict();

const compareGroupsTool = defineTool({
  name: "compare_groups",
  description:
    "Compare two groups of the user's properties side by side (value, share of portfolio, rent, gross yield, vacancy). " +
    "E.g. residential vs commercial: groupA {label:'Residential', filter:{sector:'RESIDENTIAL'}}, groupB {label:'Commercial', filter:{sector:'COMMERCIAL'}}.",
  writes: false,
  schema: z.object({ groupA: groupSchema, groupB: groupSchema }).strict(),
  async run(ctx, args) {
    const all = await activePortfolio(ctx);
    const a = applyFilter(all, toDomainFilter(args.groupA.filter));
    const b = applyFilter(all, toDomainFilter(args.groupB.filter));
    const c = compareGroups(all, { label: args.groupA.label, properties: a }, { label: args.groupB.label, properties: b });
    const focus = [...new Set([...c.a.propertyIds, ...c.b.propertyIds])];
    if (focus.length > 0) ctx.state.focusPropertyIds = focus;
    return {
      groupA: presentGroup(c.a),
      groupB: presentGroup(c.b),
      difference: {
        value: fmtDelta(c.difference.valueInr),
        annualRent: fmtDelta(c.difference.annualRentInr),
        grossYield: fmtPp(c.difference.grossYieldPctPoints),
        note: "difference = groupA minus groupB",
      },
      ...(c.overlappingPropertyIds.length ? { warning: `Groups overlap: ${c.overlappingPropertyIds.join(", ")}` } : {}),
    };
  },
});

// ---------- Scenario tool (hypothetical only) ----------

/** Either an absolute new figure or a percentage of the CURRENT real figure — never both. */
const percentChangeSchema = z
  .number()
  .min(-100)
  .max(1000)
  .describe("Percentage change from the current real figure, e.g. 10 for +10% or -5 for -5%. The backend computes the new figure.");
const exactlyOne = (a: unknown, b: unknown) => (a === undefined) !== (b === undefined);

/** Resolves a percentage change against the user's real figure (unknown ids fail like runScenario does). */
function resolvePercent(portfolio: Property[], propertyId: string, field: "currentValueInr" | "annualRentInr", changePct: number): number {
  const p = portfolio.find((x) => x.id === propertyId);
  if (!p) throw new ScenarioError(`Property not found in this portfolio: ${propertyId}`);
  return applyPercentChange(p[field], changePct);
}

const scenarioTool = defineTool({
  name: "run_scenario",
  description:
    "HYPOTHETICAL what-if analysis. Never changes real data. Exclude properties, change values or rents, or add an " +
    "imaginary property, and get baseline vs scenario with deltas. For 'rent up 10%' pass changePct (the backend " +
    "computes the new figure); otherwise pass the new amount. basedOn='active_scenario' builds on (or, with no " +
    "changes, re-runs) the previous scenario for follow-ups like 'how would that change my portfolio?'.",
  writes: false,
  schema: z
    .object({
      basedOn: z.enum(["new", "active_scenario"]).default("new"),
      excludePropertyIds: z.array(z.string().max(64)).max(50).optional(),
      valueChanges: z
        .array(
          z
            .object({ propertyId: z.string().max(64), newValue: moneySchema.optional(), changePct: percentChangeSchema.gt(-100).optional() })
            .strict()
            .refine((c) => exactlyOne(c.newValue, c.changePct), "Give exactly one of newValue or changePct"),
        )
        .max(50)
        .optional(),
      rentChanges: z
        .array(
          z
            .object({ propertyId: z.string().max(64), newAnnualRent: moneySchema.optional(), changePct: percentChangeSchema.optional() })
            .strict()
            .refine((c) => exactlyOne(c.newAnnualRent, c.changePct), "Give exactly one of newAnnualRent or changePct"),
        )
        .max(50)
        .optional(),
      additions: z
        .array(
          z
            .object({
              assetClass: z.enum(ASSET_CLASSES),
              city: z.string().min(1).max(60),
              locality: z.string().max(60).optional(),
              areaSqft: z.number().int().positive().optional(),
              value: moneySchema,
              annualRent: moneySchema.optional(),
            })
            .strict(),
        )
        .max(10)
        .optional(),
    })
    .strict(),
  async run(ctx, args) {
    const portfolio = await activePortfolio(ctx);
    const changes: Required<ScenarioInput> = {
      excludePropertyIds: args.excludePropertyIds ?? [],
      valueOverrides: (args.valueChanges ?? []).map((c) => ({
        propertyId: c.propertyId,
        newValueInr: c.newValue ? toInr(c.newValue) : resolvePercent(portfolio, c.propertyId, "currentValueInr", c.changePct!),
      })),
      rentOverrides: (args.rentChanges ?? []).map((c) => ({
        propertyId: c.propertyId,
        newAnnualRentInr: c.newAnnualRent ? toInr(c.newAnnualRent) : resolvePercent(portfolio, c.propertyId, "annualRentInr", c.changePct!),
      })),
      additions: (args.additions ?? []).map((a) => ({
        assetClass: a.assetClass,
        city: a.city,
        locality: a.locality,
        areaSqft: a.areaSqft,
        currentValueInr: toInr(a.value),
        annualRentInr: a.annualRent ? toInr(a.annualRent) : 0,
      })),
    };

    let input: Required<ScenarioInput> = changes;
    if (args.basedOn === "active_scenario") {
      const prev = ctx.state.activeScenario;
      if (!prev) throw new ToolError("no_active_scenario", "There is no previous scenario in this conversation; use basedOn='new'.");
      // Later changes to the same property replace earlier ones.
      const merge = <T extends { propertyId: string }>(a: T[], b: T[]) => [
        ...a.filter((x) => !b.some((y) => y.propertyId === x.propertyId)),
        ...b,
      ];
      input = {
        excludePropertyIds: [...new Set([...prev.excludePropertyIds, ...changes.excludePropertyIds])],
        valueOverrides: merge(prev.valueOverrides, changes.valueOverrides),
        rentOverrides: merge(prev.rentOverrides, changes.rentOverrides),
        additions: [...prev.additions, ...changes.additions],
      };
    }

    const r = runScenario(portfolio, input);
    ctx.state.activeScenario = scenarioInputSchema.parse(input);
    ctx.events.hypothetical = true;
    return {
      hypothetical: true,
      notice: "HYPOTHETICAL — the real portfolio is unchanged. Label this clearly in the reply.",
      changes: r.description,
      propertyChanges: r.propertyChanges.map((c) => ({
        propertyId: c.propertyId,
        field: c.field,
        before: formatInr(c.beforeInr),
        after: formatInr(c.afterInr),
        change: fmtDelta(c.deltaInr),
      })),
      baseline: presentSummaryBrief(r.baseline),
      scenario: presentSummaryBrief(r.scenario),
      deltas: {
        totalValue: fmtDelta(r.deltas.totalValueInr),
        annualRent: fmtDelta(r.deltas.totalAnnualRentInr),
        grossYield: fmtPp(r.deltas.portfolioGrossYieldPctPoints),
        assetClassShare: Object.fromEntries(Object.entries(r.deltas.assetClassSharePctPoints).map(([k, v]) => [k, fmtPp(v)])),
        sectorShare: Object.fromEntries(Object.entries(r.deltas.sectorSharePctPoints).map(([k, v]) => [k, fmtPp(v)])),
      },
    };
  },
});

function presentSummaryBrief(s: ReturnType<typeof summarizePortfolio>) {
  return presentSummary(s, ["totals", "by_asset_class", "by_sector"]);
}

// ---------- Write tools (propose / confirm) ----------

function recordProposal(ctx: ToolContext, result: ProposeResult) {
  if (result.status === "proposed") {
    ctx.state.pendingActionId = result.pendingActionId;
    ctx.events.proposed = result;
  }
  return result;
}

const proposeNewProperty = defineTool({
  name: "propose_new_property",
  description:
    "Stage a NEW property for the user's confirmation (nothing is saved yet). Returns needs_info with missing fields " +
    "(ask for all of them in one message), possible_duplicate (ask whether they meant an existing property), or proposed " +
    "(show the details and ask the user to confirm). Pass money as {amount, unit}.",
  writes: true,
  schema: createPropertyInputSchema,
  async run(ctx, args) {
    return recordProposal(ctx, await proposeCreate(ctx.stores, ctx, args));
  },
});

const proposePropertyUpdate = defineTool({
  name: "propose_property_update",
  description:
    "Stage a change to one existing property for the user's confirmation (nothing is saved yet). Identify the property " +
    "id from the property index or a search first; if the reference is ambiguous, ask the user.",
  writes: true,
  schema: z.object({ propertyId: z.string().min(1).max(64), changes: updatePropertyChangesSchema }).strict(),
  async run(ctx, args) {
    return recordProposal(ctx, await proposeUpdate(ctx.stores, ctx, args.propertyId, args.changes));
  },
});

const confirmAction = defineTool({
  name: "confirm_pending_action",
  description:
    "Apply a previously proposed change ONLY after the user has explicitly said yes in their latest message. " +
    "The backend independently verifies the confirmation and will refuse otherwise.",
  writes: true,
  schema: z.object({ pendingActionId: z.string().min(1).max(64) }).strict(),
  async run(ctx, args) {
    const r = await confirmPendingAction(ctx.stores, ctx, args.pendingActionId, {
      via: "agent",
      latestUserMessage: ctx.latestUserMessage,
    });
    if (r.status === "confirmed") {
      ctx.state.pendingActionId = null;
      ctx.events.confirmedPropertyId = r.property.id;
      return { status: "confirmed", action: r.action, property: presentProperty(r.property) };
    }
    if (r.status !== "same_turn" && r.status !== "not_affirmed") ctx.state.pendingActionId = null;
    return r;
  },
});

const cancelAction = defineTool({
  name: "cancel_pending_action",
  description: "Cancel a proposed change the user no longer wants.",
  writes: true,
  schema: z.object({ pendingActionId: z.string().min(1).max(64) }).strict(),
  async run(ctx, args) {
    const r = await cancelPendingAction(ctx.stores, ctx, args.pendingActionId);
    if (ctx.state.pendingActionId === args.pendingActionId) ctx.state.pendingActionId = null;
    return r;
  },
});

const flagForHuman = defineTool({
  name: "flag_for_human",
  description:
    "Hand the conversation to the business team: user asks for a person, wants tax/legal/investment advice, disputes " +
    "their data, is frustrated, or something keeps failing. Then tell the user a team member will follow up.",
  writes: true,
  schema: z
    .object({
      reason: z.enum(["user_requested_human", "advice_out_of_scope", "data_dispute", "repeated_failure", "user_frustrated", "other"]),
      note: z.string().min(1).max(500),
    })
    .strict(),
  async run(ctx, args) {
    ctx.events.handoff = { reason: args.reason, note: args.note };
    return { status: "flagged", message: "The business team will see this conversation." };
  },
});

export const TOOLS: readonly ToolDefinition[] = [
  searchProperties,
  portfolioAnalytics,
  compareGroupsTool,
  scenarioTool,
  proposeNewProperty,
  proposePropertyUpdate,
  confirmAction,
  cancelAction,
  flagForHuman,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- Model-facing specs ----------

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** OpenAI-format function specs (what OpenRouter expects). Computed once. */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  return { type: "function", function: { name: t.name, description: t.description, parameters } };
});

// ---------- Execution ----------

export interface ToolCallRequest {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolCallOutcome {
  callId: string;
  name: string;
  ok: boolean;
  /** JSON string sent back to the model. */
  content: string;
  result: unknown;
  error: string | null;
  durationMs: number;
}

export const TOOL_TIMEOUT_MS = 10_000;
const MAX_TOOL_OUTPUT_CHARS = 12_000;

/** Marker the graph uses for tool calls whose arguments were not valid JSON. */
export const MALFORMED_ARGS_KEY = "__malformed_arguments";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError("tool_timeout", `Tool did not finish within ${ms} ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function executeToolCall(ctx: ToolContext, call: ToolCallRequest): Promise<ToolCallOutcome> {
  const start = performance.now();
  const finish = (ok: boolean, result: unknown, error: string | null): ToolCallOutcome => {
    let content = JSON.stringify(result);
    if (content.length > MAX_TOOL_OUTPUT_CHARS) {
      content = JSON.stringify({ error: "output_truncated", message: "Result too large; narrow the filter or use a limit." });
    }
    return { callId: call.id, name: call.name, ok, content, result, error, durationMs: Math.round(performance.now() - start) };
  };

  const tool = TOOLS_BY_NAME.get(call.name);
  if (!tool) {
    return finish(false, { error: "unknown_tool", message: `No tool named ${call.name}.` }, "unknown_tool");
  }
  if (call.args && typeof call.args === "object" && MALFORMED_ARGS_KEY in call.args) {
    return finish(false, { error: "malformed_arguments", message: "Arguments were not valid JSON. Retry with valid JSON." }, "malformed_arguments");
  }
  const parsed = tool.schema.safeParse(call.args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return finish(false, { error: "invalid_arguments", issues }, "invalid_arguments");
  }
  try {
    const result = await withTimeout(tool.run(ctx, parsed.data), TOOL_TIMEOUT_MS);
    return finish(true, result, null);
  } catch (e) {
    if (e instanceof ToolError) return finish(false, { error: e.code, message: e.message }, e.code);
    if (e instanceof ScenarioError) return finish(false, { error: "invalid_scenario", message: e.message }, "invalid_scenario");
    if (e instanceof MoneyError) return finish(false, { error: "invalid_amount", message: e.message }, "invalid_amount");
    logError(`tool:${call.name}`, e);
    return finish(false, { error: "internal_error", message: "The tool failed unexpectedly. Do not guess the answer." }, "internal_error");
  }
}

/** Runs one round of tool calls: reads in parallel, but any write forces sequential order. */
export async function executeToolRound(ctx: ToolContext, calls: ToolCallRequest[]): Promise<ToolCallOutcome[]> {
  const anyWrite = calls.some((c) => TOOLS_BY_NAME.get(c.name)?.writes);
  if (!anyWrite) return Promise.all(calls.map((c) => executeToolCall(ctx, c)));
  const out: ToolCallOutcome[] = [];
  for (const c of calls) out.push(await executeToolCall(ctx, c));
  return out;
}

export function newTurnEvents(): TurnEvents {
  return { proposed: null, confirmedPropertyId: null, hypothetical: false, handoff: null };
}
