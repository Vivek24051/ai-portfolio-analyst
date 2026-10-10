// DEV STUB — not an LLM. A keyword router that lets the chat UI and API run locally without any
// model API key or any paid call. It exercises the real graph, tools and persistence, but its
// "understanding" is a handful of regexes, and its answers are fixed templates over the tool output.
// Replies are prefixed so nobody mistakes it for the agent.
//
// It reads only what a real model would see: the user's messages and the system prompt's PROPERTY
// INDEX / FOCUS / ACTIVE HYPOTHETICAL SCENARIO sections (already scoped to the signed-in user). It
// never computes a figure: percentages go to run_scenario as changePct and the backend does the maths.

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { isAffirmative } from "@/domain/affirmation";
import { parseMoneyText, type Money } from "@/domain/money";
import type { ChatModel } from "./model";
import { APPRECIATION_QUESTION, formatToolResultForStub } from "./stubFormat";

export const DEV_STUB_ID = "dev-stub (no LLM configured)";
const PREFIX = "[dev stub — no LLM configured]";

// Ids must be unique across the whole conversation, which is reloaded from the database: a per-process
// counter restarts on every serverless cold start and collided with ids already in the history.
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `stub_${crypto.randomUUID()}`, name, args, type: "tool_call" }] });

const CITIES = ["mumbai", "bengaluru", "bangalore", "gurugram", "gurgaon", "noida", "delhi ncr", "alibaug"];

const SHARE_QUESTION = /how much of|percent|%|share|proportion|portion|fraction|exposure/;
const REFERS_TO_PREVIOUS = /\b(those|these|them|they|both|of the two|which one|that one)\b/;
const SCENARIO_QUESTION = /\bwhat if\b|\bsuppose\b|\bimagine\b|hypothetical|\bscenario\b/;

/** What the system prompt tells the model about this user and conversation. */
interface StubContext {
  index: Array<{ id: string; locality: string }>;
  focus: string[];
  hasActiveScenario: boolean;
  /** Id of the change awaiting the user's confirmation (PENDING CHANGE line), if any. */
  pendingActionId: string | null;
}

function readContext(messages: BaseMessage[]): StubContext {
  const system = messages.find((m) => SystemMessage.isInstance(m));
  const text = system ? String(system.content) : "";
  const indexBlock = /PROPERTY INDEX[^\n]*\n([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1] ?? "";
  const index = [...indexBlock.matchAll(/^([^\s|]+) \| [^|]+ \| ([^|,]+)/gm)].map((m) => ({ id: m[1]!, locality: m[2]!.trim().toLowerCase() }));
  const focus = /^FOCUS \(most recent result set\): (.+)$/m.exec(text)?.[1]?.split(", ").filter(Boolean) ?? [];
  const pendingActionId = /^PENDING CHANGE awaiting the client's confirmation: id=([^,\s]+)/m.exec(text)?.[1] ?? null;
  return { index, focus, hasActiveScenario: /^ACTIVE HYPOTHETICAL SCENARIO:/m.test(text), pendingActionId };
}

/**
 * Property references in the message: explicit ids ("P001"), else a locality from the user's own
 * index ("the Bandra property"), else "it/that property" when exactly one property is in focus.
 * Ids are passed through unchecked; the tools reject anything outside this user's portfolio.
 */
function propertyRefs(t: string, ctx: StubContext): string[] {
  const ids = [...new Set((t.match(/\bp\d{3,}\b/g) ?? []).map((id) => id.toUpperCase()))];
  if (ids.length) return ids;
  const byLocality = ctx.index.filter((p) => {
    const word = p.locality.split(" ")[0]!;
    return word.length >= 4 && new RegExp(`\\b${word.replace(/[^a-z0-9]/g, "")}\\b`).test(t);
  });
  if (byLocality.length) return byLocality.map((p) => p.id);
  if (/\b(it|that property|this property|that one)\b/.test(t) && ctx.focus.length === 1) return ctx.focus;
  return [];
}

function assetFilter(t: string): Record<string, unknown> | null {
  if (/commercial/.test(t)) return { sector: "COMMERCIAL" };
  const cls = /retail/.test(t) ? "RETAIL" : /office/.test(t) ? "OFFICE" : /residential|apartment|villa/.test(t) ? "RESIDENTIAL" : null;
  return cls ? { assetClasses: [cls] } : null;
}

// Help text is generic on purpose: no figures (they would not trace to tool output) and no property
// ids (an example id may belong to another user). Placeholders in <angle brackets> carry no digits.
const SCENARIO_HELP =
  `${PREFIX} I can run what-ifs on your real figures without changing them. Name one of your properties ` +
  `(by its id or locality) and the change, for example "What if the rent of <property> increases by <n>%?", ` +
  `"What if the value of <property> drops by <n>%?" or "What if I exclude <property>?".`;

function scenario(t: string, ctx: StubContext): AIMessage {
  if (/how would (that|this|it) change|what would (that|this) do|and then\??$/.test(t) && ctx.hasActiveScenario) {
    return call("run_scenario", { basedOn: "active_scenario" });
  }
  const refs = propertyRefs(t, ctx);
  if (refs.length === 0) return new AIMessage(SCENARIO_HELP);

  const pctMatch = /(-?\d+(?:\.\d+)?)\s*%/.exec(t);
  if (pctMatch) {
    const down = /\b(decreas|drop|fall|fell|reduc|cut|lower|declin|down)/.test(t);
    const changePct = Math.abs(Number(pctMatch[1])) * (down ? -1 : 1);
    if (/\brent|income/.test(t)) return call("run_scenario", { rentChanges: refs.map((propertyId) => ({ propertyId, changePct })) });
    if (/value|price|worth|valuation/.test(t)) return call("run_scenario", { valueChanges: refs.map((propertyId) => ({ propertyId, changePct })) });
    return new AIMessage(SCENARIO_HELP);
  }
  if (/exclud|without|remove|sell|sold|drop|leave out/.test(t)) return call("run_scenario", { excludePropertyIds: refs });
  return new AIMessage(SCENARIO_HELP);
}

// ---------- Real changes: propose → confirm (the existing write path; nothing is saved here) ----------

// An instruction, not a question: the verb leads ("Update…", "Please set…", "Can you change…"), so
// "How would that change my portfolio?" stays a what-if follow-up.
const UPDATE_REQUEST = /^\s*(please |kindly |can you |could you |i want to |i'd like to )?(update|change|set|correct|revise)\b/;
const CANCEL_REPLY = /^\s*(no|nope|cancel|stop|discard|don'?t|do not|never ?mind)\b|\bcancel\b/;

// Clarifying questions for an incomplete or ambiguous change: one question for the first missing piece.
// Like all help text, they carry no figures and no property ids.
const UPDATE_EXAMPLE = `for example "Update the annual rent of <property> to <amount> lakh". Nothing is saved until you confirm.`;
const ASK_WHICH_PROPERTY = `${PREFIX} To change a property: which one of your properties do you mean? Tell me its id or locality, ${UPDATE_EXAMPLE}`;
const ASK_WHICH_FIELD = `${PREFIX} To change a property: which figure should I change — the annual rent, the current value or the purchase price? ${UPDATE_EXAMPLE}`;
const ASK_NEW_AMOUNT = `${PREFIX} To change a property: what should the new figure be? Give the amount itself (not a percentage), ${UPDATE_EXAMPLE}`;

/** Field the request names. "purchase price" is checked before "value"/"price" wording. */
function updateField(t: string): "annualRent" | "value" | "purchasePrice" | null {
  if (/purchase price|bought (it )?for/.test(t)) return "purchasePrice";
  if (/\brent(al income)?\b|\bannual rent\b/.test(t)) return "annualRent";
  if (/\b(current )?(value|valuation|worth)\b/.test(t)) return "value";
  return null;
}

/**
 * The new figure after "to", e.g. "to ₹80 lakh per year" → {amount: 80, unit: "LAKH"}. Parsed by the
 * domain's money grammar; the backend converts to rupees. Percentages ("by 10%") are not accepted
 * here — a real change needs the new figure, and what-ifs go through run_scenario instead.
 */
function newAmount(text: string): Money | null {
  const m = /\bto\s*(?:₹|rs\.?|inr)?\s*([\d,]*\.?\d+)\s*(crores?|crs?|lakhs?|lacs?|l|k|thousand)?(?![a-z\d%])/i.exec(text);
  return m ? parseMoneyText(`${m[1]} ${m[2] ?? ""}`) : null;
}

function updateRequest(text: string, t: string, ctx: StubContext): AIMessage {
  const refs = propertyRefs(t, ctx);
  const field = updateField(t);
  const amount = newAmount(text);
  if (refs.length !== 1) return new AIMessage(ASK_WHICH_PROPERTY);
  if (!field) return new AIMessage(ASK_WHICH_FIELD);
  if (!amount) return new AIMessage(ASK_NEW_AMOUNT);
  return call("propose_property_update", { propertyId: refs[0], changes: { [field]: amount } });
}

function route(text: string, ctx: StubContext): AIMessage {
  const t = text.toLowerCase();

  // A change is awaiting confirmation: a clean "yes" confirms, "no/cancel" discards. The backend
  // re-checks the affirmation, the user, the conversation, expiry and the version independently.
  if (ctx.pendingActionId) {
    if (isAffirmative(text)) return call("confirm_pending_action", { pendingActionId: ctx.pendingActionId });
    if (CANCEL_REPLY.test(t)) return call("cancel_pending_action", { pendingActionId: ctx.pendingActionId });
  }

  // Explicit real update ("Update P001's annual rent to ₹80 lakh") — proposed only, never saved here.
  if (UPDATE_REQUEST.test(t) && !SCENARIO_QUESTION.test(t)) return updateRequest(text, t, ctx);

  // Appreciation / ROI: fetch the totals and data gaps so the reply can say exactly what is missing.
  if (APPRECIATION_QUESTION.test(t)) return call("portfolio_analytics", { sections: ["totals", "data_gaps"] });

  if (SCENARIO_QUESTION.test(t) || (ctx.hasActiveScenario && /how would (that|this|it) change/.test(t))) return scenario(t, ctx);

  const subset = assetFilter(t);

  // "How much of my portfolio is retail?" → that slice's value, the whole portfolio and the share.
  if (subset && SHARE_QUESTION.test(t)) return call("portfolio_analytics", { filter: subset, sections: ["totals"] });

  // Rankings. "Which of those earns more rent?" ranks the previous result set (FOCUS).
  // Yield first: "best rental yield" is a yield question even though "rental" starts like "rent".
  const metric = /yield|perform/.test(t)
    ? "yield"
    : /\b(rent|income|earn)/.test(t) && /(highest|most|top|more|higher|better|best|biggest|largest)/.test(t)
      ? "rent"
      : null;
  if (metric) {
    if (REFERS_TO_PREVIOUS.test(t) && ctx.focus.length) return call("search_properties", { filter: { propertyIds: ctx.focus }, sortBy: metric });
    if (subset) return call("search_properties", { filter: subset, sortBy: metric });
    return call("search_properties", metric === "rent" ? { sortBy: "rent", limit: 1 } : { sortBy: "yield" });
  }

  if (subset && /(show|list|my|tell me)/.test(t)) return call("search_properties", { filter: subset });
  const city = CITIES.find((c) => t.includes(`in ${c}`));
  if (city) return call("search_properties", { filter: { city } });
  if (/total|overview|look like|summary|worth|portfolio/.test(t)) return call("portfolio_analytics", {});
  return new AIMessage(
    `${PREFIX} To use a real model, set LLM_PROVIDER (gemini or openrouter), that provider's API key, and LLM_PRIMARY_MODEL; LLM_PROVIDER=stub always keeps this stub. ` +
      `Stub demos: "portfolio overview", "how much of my portfolio is retail?", "which of those earns more rent?", ` +
      `"what if the rent of <property> increases by <n>%?", "properties in Mumbai".`,
  );
}

function respond(messages: BaseMessage[]): AIMessage {
  const human = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
  const question = human ? String(human.content) : "";
  const last = messages.at(-1);
  if (last && ToolMessage.isInstance(last)) {
    // Template reply built only from the tool's own output (see stubFormat.ts).
    const args = messages
      .flatMap((m) => (AIMessage.isInstance(m) ? (m.tool_calls ?? []) : []))
      .reverse() // latest call wins, even if an old id repeats in the history
      .find((c) => c.id === last.tool_call_id)?.args;
    return new AIMessage(formatToolResultForStub(last.name, String(last.content), { question, args }));
  }
  return route(question, readContext(messages));
}

/** Word-by-word pseudo-streaming so the UI's streaming path can be demoed without an LLM. */
export function createDevStubModel(opts: { streamDelayMs?: number } = {}): ChatModel {
  const delay = opts.streamDelayMs ?? 12;
  return {
    id: DEV_STUB_ID,
    async invoke(messages) {
      return respond(messages);
    },
    async stream(messages, { signal }, onDelta) {
      const message = respond(messages);
      const text = typeof message.content === "string" ? message.content : "";
      for (const piece of text.match(/\S+\s*/g) ?? []) {
        if (signal.aborted) break;
        onDelta(piece);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      return message;
    },
  };
}
