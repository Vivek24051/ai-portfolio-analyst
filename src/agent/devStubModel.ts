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
import { APPRECIATION_QUESTION, formatToolResultForStub, STUB_TEMPLATE_LABEL } from "./stubFormat";

/** The stub as the configured model (LLM_PROVIDER=stub, or no real model configured). */
export const DEV_STUB_ID = "dev-stub (no LLM configured)";
const PREFIX = "[dev stub — no LLM configured]";

/**
 * The stub behind a real model (explicit fallback or last resort): it only answers because that model
 * failed, hit a quota cooldown or the per-turn call cap — so it must not say "no LLM configured".
 */
export const DEV_STUB_LAST_RESORT_ID = "dev-stub (last resort, no LLM)";
export const LAST_RESORT_PREFIX = "[dev stub — AI model unavailable, keyword fallback, no LLM]";
export const LAST_RESORT_TEMPLATE_LABEL = "[dev stub — AI model unavailable; template reply, no LLM]";

/** Swaps the stub-mode labels for the last-resort ones (tool-call messages have no text and pass through). */
function relabelForLastResort(message: AIMessage): AIMessage {
  const text = message.content;
  if (typeof text !== "string") return message;
  const swap = text.startsWith(PREFIX)
    ? LAST_RESORT_PREFIX + text.slice(PREFIX.length)
    : text.startsWith(STUB_TEMPLATE_LABEL)
      ? LAST_RESORT_TEMPLATE_LABEL + text.slice(STUB_TEMPLATE_LABEL.length)
      : null;
  return swap === null ? message : new AIMessage({ content: swap, tool_calls: message.tool_calls });
}

// Ids must be unique across the whole conversation, which is reloaded from the database: a per-process
// counter restarts on every serverless cold start and collided with ids already in the history.
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `stub_${crypto.randomUUID()}`, name, args, type: "tool_call" }] });

const CITIES = ["mumbai", "bengaluru", "bangalore", "gurugram", "gurgaon", "noida", "delhi ncr", "alibaug"];

const SHARE_QUESTION = /how much of|percent|%|share|proportion|portion|fraction|exposure/;
/** Portfolio-level income and yield, as opposed to "which property has the best yield". */
const TOTALS_QUESTION = /\b(rental income|annual rent(al)? income|total rent|overall (gross )?yield|portfolio (gross )?yield|average yield|my (gross )?yield)\b/;
const RANKING_WORDS = /\b(which|highest|lowest|best|worst|top|rank|ranking|most|least)\b/;
/** The message asks for something (vs. stating a fact like "It's vacant"). */
const ASKS = /\?|\b(which|what|show|list|find|any|are there|is there|do i have)\b/;
const REFERS_TO_PREVIOUS = /\b(those|these|them|they|their|both|of the two|which one|that one)\b/;
const SCENARIO_QUESTION = /\bwhat if\b|\bsuppose\b|\bimagine\b|hypothetical|\bscenario\b/;

/** One PROPERTY INDEX line: "P002 | Office (Office floor) | Andheri East, Mumbai | Vacant" (labels only, no figures). */
interface IndexEntry {
  id: string;
  /** Lower-cased locality ("andheri east") and the original spelling. */
  locality: string;
  localityRaw: string;
  city: string;
  /** Lower-cased asset-class label: "retail" | "office" | "residential". */
  type: string;
  /** Lower-cased occupancy label: "tenanted" | "vacant" | "self-occupied". */
  occupancy: string;
}

/** What the system prompt tells the model about this user and conversation. */
interface StubContext {
  index: IndexEntry[];
  focus: string[];
  hasActiveScenario: boolean;
  /** Id of the change awaiting the user's confirmation (PENDING CHANGE line), if any. */
  pendingActionId: string | null;
  /** The last tool call of the IMMEDIATELY previous turn and its result (for "It's vacant" follow-ups). */
  previous: { name: string; args: Record<string, unknown>; result: Record<string, unknown> } | null;
}

/**
 * The last tool call made in the turn right before the current user message, with its parsed result.
 * Only that one turn is considered, so an old draft can never leak into a new conversation topic.
 */
function previousTurnCall(messages: BaseMessage[]): StubContext["previous"] {
  const current = messages.map((m) => HumanMessage.isInstance(m)).lastIndexOf(true);
  if (current <= 0) return null;
  for (let i = current - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (HumanMessage.isInstance(m)) return null; // reached the turn before the previous one
    if (AIMessage.isInstance(m) && m.tool_calls?.length) {
      const c = m.tool_calls.at(-1)!;
      const tool = messages.slice(i + 1, current).find((x) => ToolMessage.isInstance(x) && x.tool_call_id === c.id);
      try {
        return { name: c.name, args: c.args, result: tool ? JSON.parse(String(tool.content)) : {} };
      } catch {
        return null; // truncated or non-JSON result: do not guess
      }
    }
  }
  return null;
}

function readContext(messages: BaseMessage[]): StubContext {
  const system = messages.find((m) => SystemMessage.isInstance(m));
  const text = system ? String(system.content) : "";
  const indexBlock = /PROPERTY INDEX[^\n]*\n([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1] ?? "";
  const index: IndexEntry[] = indexBlock
    .split("\n")
    .map((line) => line.split(" | "))
    .filter((cols) => cols.length >= 4)
    .map(([id, type, location, occupancy]) => {
      const [localityRaw = "", city = ""] = location!.split(",").map((s) => s.trim());
      return {
        id: id!.trim(),
        locality: localityRaw.toLowerCase(),
        localityRaw,
        city,
        type: type!.trim().split(" ")[0]!.toLowerCase(),
        occupancy: occupancy!.trim().toLowerCase(),
      };
    });
  const focus = /^FOCUS \(most recent result set\): (.+)$/m.exec(text)?.[1]?.split(", ").filter(Boolean) ?? [];
  const pendingActionId = /^PENDING CHANGE awaiting the client's confirmation: id=([^,\s]+)/m.exec(text)?.[1] ?? null;
  return { index, focus, hasActiveScenario: /^ACTIVE HYPOTHETICAL SCENARIO:/m.test(text), pendingActionId, previous: previousTurnCall(messages) };
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

/** "vacant", "tenanted", "self-occupied" → the tools' occupancy filter. */
function occupancyFilter(t: string): { occupancy: string[] } | Record<string, never> {
  if (/\b(vacant|empty)\b/.test(t)) return { occupancy: ["VACANT"] };
  if (/\b(tenanted|rented out|leased out|let out)\b/.test(t)) return { occupancy: ["TENANTED"] };
  if (/\bself[- ]occupied\b/.test(t)) return { occupancy: ["SELF_OCCUPIED"] };
  return {};
}

const MONEY_TEXT = /(₹|rs\.?|inr)?\s*([\d,]*\.?\d+)\s*(crores?|crs?|lakhs?|lacs?|l|k|thousand)?(?![a-z\d%])/gi;

/** First amount that is clearly money (has ₹/Rs or a unit), so "5,000 sq ft" is never read as rupees. */
function firstMoney(t: string): Money | null {
  for (const m of t.matchAll(MONEY_TEXT)) {
    if (m[1] || m[3]) return parseMoneyText(`${m[2]} ${m[3] ?? ""}`);
  }
  return null;
}

/**
 * "above ₹10 crore" / "under ₹5 Cr" → the current-value filter (strict, as the tools define it).
 * Skipped when the sentence is about rent, because these filters apply to current value only.
 */
function valueThreshold(t: string): Record<string, Money> {
  if (/\brent/.test(t)) return {};
  const m = /\b(above|over|more than|greater than|exceeding|below|under|less than)\s+((₹|rs\.?|inr)?\s*[\d,]*\.?\d+\s*(crores?|crs?|lakhs?|lacs?|l|k|thousand)?)(?![a-z\d%])/.exec(t);
  if (!m || !(m[3] || m[4])) return {};
  const money = parseMoneyText(m[2]!.replace(/^(₹|rs\.?|inr)\s*/, ""));
  if (!money) return {};
  return /^(below|under|less than)$/.test(m[1]!) ? { valueBelow: money } : { valueAbove: money };
}

const GROUP_WORDS: Array<[RegExp, { label: string; filter: Record<string, unknown> }]> = [
  [/\bresidential\b/, { label: "Residential", filter: { sector: "RESIDENTIAL" } }],
  [/\bcommercial\b/, { label: "Commercial (retail + office)", filter: { sector: "COMMERCIAL" } }],
  [/\bretail\b/, { label: "Retail", filter: { assetClasses: ["RETAIL"] } }],
  [/\boffices?\b/, { label: "Office", filter: { assetClasses: ["OFFICE"] } }],
];

/** "Compare my residential and commercial exposure" → exactly two groups for compare_groups, in the order named. */
function comparisonGroups(t: string) {
  if (!/\b(compare|comparison|versus|vs\.?)\b/.test(t)) return null;
  const found = GROUP_WORDS.map(([re, g]) => ({ at: t.search(re), g })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  return found.length === 2 ? [found[0]!.g, found[1]!.g] : null;
}

/**
 * "my vacant office" → the user's own properties whose index labels match the described type and/or
 * occupancy. Used only for what-ifs; an ambiguous description is never guessed.
 */
function describedRefs(t: string, ctx: StubContext): string[] {
  const type = /\boffices?\b/.test(t)
    ? "office"
    : /\b(retail|shops?)\b/.test(t)
      ? "retail"
      : /\b(residential|apartments?|villas?|flats?|homes?)\b/.test(t)
        ? "residential"
        : null;
  const occ = occupancyFilter(t).occupancy?.[0]?.toLowerCase().replace("_", "-") ?? null;
  if (!type && !occ) return [];
  return ctx.index.filter((p) => (!type || p.type === type) && (!occ || p.occupancy === occ)).map((p) => p.id);
}

const PURCHASE = /\b(buy|bought|buying|purchase|purchased|acquire|acquired)\b/;
const PURCHASE_HELP =
  `${PREFIX} For a hypothetical purchase I need the type, the price and where it is, for example ` +
  `"What if I bought a <amount> crore office in <locality or city>?". Nothing is added to your real portfolio.`;

/**
 * "What if I bought a ₹5 Cr office in Whitefield?" → a hypothetical addition. The city comes from a
 * known city in the message or from the user's own index (Whitefield → Bengaluru); otherwise ask.
 */
function hypotheticalPurchase(t: string, ctx: StubContext): AIMessage {
  const assetClass = /\boffices?\b/.test(t)
    ? "OFFICE"
    : /\b(retail|shops?)\b/.test(t)
      ? "RETAIL"
      : /\b(residential|apartments?|villas?|flats?|homes?)\b/.test(t)
        ? "RESIDENTIAL"
        : null;
  const value = firstMoney(t);
  const place = /\bin ([a-z][a-z .-]*?)\s*(?:[?.!,]|$)/.exec(t)?.[1]?.trim() ?? null;
  if (!assetClass || !value || !place) return new AIMessage(PURCHASE_HELP);
  const known = CITIES.includes(place) ? { city: place.replace(/\b\w/g, (c) => c.toUpperCase()) } : null;
  const fromIndex = known ? null : ctx.index.find((p) => p.locality === place || p.locality.startsWith(`${place} `));
  if (!known && !fromIndex) return new AIMessage(PURCHASE_HELP);
  const area = /([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)/.exec(t)?.[1];
  return call("run_scenario", {
    additions: [
      {
        assetClass,
        ...(known ?? { city: fromIndex!.city, locality: fromIndex!.localityRaw }),
        ...(area ? { areaSqft: Number(area.replace(/,/g, "")) } : {}),
        value,
      },
    ],
  });
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
  // A hypothetical purchase names a new property, not one of the user's, so it is handled first.
  if (PURCHASE.test(t)) return hypotheticalPurchase(t, ctx);

  let refs = propertyRefs(t, ctx);
  if (refs.length === 0) {
    const described = describedRefs(t, ctx); // "my vacant office"
    if (described.length !== 1) return new AIMessage(SCENARIO_HELP); // none, or ambiguous: never guess
    refs = described;
  }

  const pctMatch = /(-?\d+(?:\.\d+)?)\s*%/.exec(t);
  if (pctMatch) {
    const down = /\b(decreas|drop|fall|fell|reduc|cut|lower|declin|down)/.test(t);
    const changePct = Math.abs(Number(pctMatch[1])) * (down ? -1 : 1);
    if (/\brent|income/.test(t)) return call("run_scenario", { rentChanges: refs.map((propertyId) => ({ propertyId, changePct })) });
    if (/value|price|worth|valuation/.test(t)) return call("run_scenario", { valueChanges: refs.map((propertyId) => ({ propertyId, changePct })) });
    return new AIMessage(SCENARIO_HELP);
  }
  // Absolute what-if: "value dropped to ₹10 Cr" → that new figure (parsed by the domain money grammar;
  // the backend converts and computes every total). Still run_scenario: nothing is proposed or saved.
  const amount = newAmount(t);
  if (amount) {
    const field = updateField(t);
    if (field === "annualRent") return call("run_scenario", { rentChanges: refs.map((propertyId) => ({ propertyId, newAnnualRent: amount })) });
    if (field === "value") return call("run_scenario", { valueChanges: refs.map((propertyId) => ({ propertyId, newValue: amount })) });
    return new AIMessage(SCENARIO_HELP);
  }
  // Exclusion needs an explicit verb. "drop" is not one: "value dropped to …" is a revaluation.
  if (/exclud|without|remove|sell|sold|leave out/.test(t)) return call("run_scenario", { excludePropertyIds: refs });
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

// ---------- New properties: propose_new_property (existing validation, duplicate check, confirmation) ----------

const ADD_REQUEST = /^\s*(please |kindly |can you |could you |i want to |i'd like to )?add\b|\badd (it|this|that)\b|\badd\b.*\bto my portfolio\b/;
const SEPARATE_PROPERTY = /\b(separate|different|another one|a new one|it'?s new|not the same)\b/;

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Details stated in one message, as propose_new_property arguments. Only what the user said is
 * filled in; everything else is left for the backend's needs_info to ask about. Money stays
 * {amount, unit}; the backend converts. The city of a new locality is taken from a known city in
 * the message, or from the user's OWN properties in that locality when they all share one city.
 */
function draftDetails(t: string, ctx: StubContext): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  const cls = /\boffices?\b/.test(t) ? "OFFICE" : /\b(retail|shops?)\b/.test(t) ? "RETAIL" : /\b(residential|apartments?|villas?|flats?|homes?)\b/.test(t) ? "RESIDENTIAL" : null;
  if (cls) d.assetClass = cls;
  const area = /([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)/.exec(t)?.[1];
  if (area) d.areaSqft = Number(area.replace(/,/g, ""));
  const rentClause = /\b(?:rent(?:ed)?(?: out)?(?: (?:at|for|of|is))?|earns?|earning)\s+((?:₹|rs\.?|inr)?\s*[\d,]*\.?\d+\s*(?:crores?|crs?|lakhs?|lacs?|l|k|thousand)?)/.exec(t);
  const rent = rentClause ? firstMoney(rentClause[1]!) : null;
  if (rent) d.annualRent = rent;
  const value = firstMoney(rentClause ? t.replace(rentClause[0], " ") : t);
  if (value) d.value = value;
  const occ = occupancyFilter(t).occupancy?.[0];
  if (occ) d.occupancyStatus = occ;
  if (occ && occ !== "TENANTED" && !rent) d.annualRent = { amount: 0, unit: "INR" }; // vacant / self-occupied earn no rent

  const place = /\bin ([a-z][a-z .-]*?)(?=\s+(?:worth|valued|for|at|with|and|which|that)\b|\s*[?.!,]|\s*$)/.exec(t)?.[1]?.trim();
  if (place) {
    if (CITIES.includes(place)) d.city = titleCase(place);
    else {
      d.locality = titleCase(place);
      const cities = [...new Set(ctx.index.filter((p) => p.locality === place || p.locality.startsWith(`${place} `)).map((p) => p.city))];
      if (cities.length === 1 && cities[0]) d.city = cities[0];
    }
  }
  const namedCity = CITIES.find((c) => new RegExp(`\\b${c}\\b`).test(t) && c !== place);
  if (namedCity && !d.city) d.city = titleCase(namedCity);
  return d;
}

/** "It's vacant" right after a needs_info / possible-duplicate answer continues that same draft. */
function continueDraft(t: string, ctx: StubContext): AIMessage | null {
  const prev = ctx.previous;
  if (!prev || prev.name !== "propose_new_property") return null;
  if (prev.result.status === "possible_duplicate" && SEPARATE_PROPERTY.test(t)) {
    return call("propose_new_property", { ...prev.args, allowDuplicate: true }); // the user said it is a different property
  }
  if (prev.result.status !== "needs_info" && prev.result.status !== "possible_duplicate") return null;
  const more = draftDetails(t, ctx);
  if (Object.keys(more).length === 0) return null;
  return call("propose_new_property", { ...prev.args, ...more });
}

// ---------- Status-only changes ("My Andheri office is now tenanted") ----------

const STATUS_CHANGE = /\b(is|are) now\b|\bnow (tenanted|vacant|self[- ]occupied|rented out|let out)\b|\b(has|have) (become|been) (tenanted|vacant|let|rented)\b|\bbecame\b|\bis no longer\b/;

/**
 * Proposes the occupancy change through the normal update path. Tenanted without a rent figure is
 * rejected by the backend's own validation ("needs its annual rent"), which becomes a rent question;
 * vacant / self-occupied set the rent to zero, shown in the proposal for confirmation.
 */
function statusChange(t: string, ctx: StubContext): AIMessage {
  let refs = propertyRefs(t, ctx);
  if (refs.length === 0) refs = describedRefs(t.replace(/\b(tenanted|vacant|self[- ]occupied|rented out|let out)\b/g, " "), ctx);
  if (refs.length !== 1) return new AIMessage(ASK_WHICH_PROPERTY);
  const occupancy = occupancyFilter(t).occupancy![0]!;
  const rent = firstMoney(t);
  const changes: Record<string, unknown> = { occupancyStatus: occupancy };
  if (occupancy !== "TENANTED") changes.annualRent = { amount: 0, unit: "INR" };
  else if (rent) changes.annualRent = rent;
  return call("propose_property_update", { propertyId: refs[0], changes });
}

/** The rent asked for after a "now tenanted" message: re-propose with it (still needs confirmation). */
function continueRent(t: string, ctx: StubContext): AIMessage | null {
  const prev = ctx.previous;
  const changes = prev?.args.changes as Record<string, unknown> | undefined;
  if (prev?.name !== "propose_property_update" || prev.result.status !== "invalid" || changes?.occupancyStatus !== "TENANTED") return null;
  const rent = firstMoney(t);
  return rent ? call("propose_property_update", { propertyId: prev.args.propertyId, changes: { occupancyStatus: "TENANTED", annualRent: rent } }) : null;
}

// ---------- Hand-off to the business team ----------

const HANDOFF = /\b(speak|talk|chat)\s+(to|with)\s+(a |an |the )?(human|person|someone|advisor|adviser|agent|representative|team)\b|\b(real person|human advisor|human adviser)\b/;
const ADVICE = /\b(tax|legal|lawyer|investment advice|should i (buy|sell))\b/;

/** Flags the conversation for the team (flag_for_human). The user's own words become the note. */
function handoff(text: string, t: string): AIMessage {
  const reason = HANDOFF.test(t) ? "user_requested_human" : "advice_out_of_scope";
  return call("flag_for_human", { reason, note: text.trim().slice(0, 500) || "User asked for a person" });
}

function route(text: string, ctx: StubContext): AIMessage {
  const t = text.toLowerCase();

  // A change is awaiting confirmation: a clean "yes" confirms, "no/cancel" discards. The backend
  // re-checks the affirmation, the user, the conversation, expiry and the version independently.
  if (ctx.pendingActionId) {
    if (isAffirmative(text)) return call("confirm_pending_action", { pendingActionId: ctx.pendingActionId });
    if (CANCEL_REPLY.test(t)) return call("cancel_pending_action", { pendingActionId: ctx.pendingActionId });
  }

  // A request for a person (or for tax / legal advice) is handed to the business team first.
  if (HANDOFF.test(t) || (ADVICE.test(t) && /\b(advice|advise|advisor|adviser|help)\b/.test(t))) return handoff(text, t);

  // Follow-ups to the previous turn's draft or rent question ("It's vacant", "₹45 lakh a year").
  // Questions ("Show my retail properties?") are never merged into a draft.
  if (!SCENARIO_QUESTION.test(t) && !UPDATE_REQUEST.test(t) && !ADD_REQUEST.test(t) && !ASKS.test(t)) {
    const followUp = continueDraft(t, ctx) ?? continueRent(t, ctx);
    if (followUp) return followUp;
  }

  // Explicit real update ("Update P001's annual rent to ₹80 lakh") — proposed only, never saved here.
  if (UPDATE_REQUEST.test(t) && !SCENARIO_QUESTION.test(t)) return updateRequest(text, t, ctx);

  // New property ("Add a 3000 sq ft retail property in Indiranagar worth ₹4.2 crore") — proposed only.
  if (ADD_REQUEST.test(t) && !SCENARIO_QUESTION.test(t)) return call("propose_new_property", draftDetails(t, ctx));

  // Status-only change stated as a fact ("My Andheri office is now tenanted") — proposed only.
  if (STATUS_CHANGE.test(t) && Object.keys(occupancyFilter(t)).length && !SCENARIO_QUESTION.test(t)) return statusChange(t, ctx);

  // Appreciation / ROI: fetch the totals and data gaps so the reply can say exactly what is missing.
  if (APPRECIATION_QUESTION.test(t)) return call("portfolio_analytics", { sections: ["totals", "data_gaps"] });

  if (SCENARIO_QUESTION.test(t) || (ctx.hasActiveScenario && /how would (that|this|it) change/.test(t))) return scenario(t, ctx);

  // "Compare my residential and commercial exposure" → side-by-side figures from compare_groups.
  const groups = comparisonGroups(t);
  if (groups) return call("compare_groups", { groupA: groups[0], groupB: groups[1] });

  const subset = assetFilter(t);

  // "How much of my portfolio is retail?" → that slice's value, the whole portfolio and the share.
  if (subset && SHARE_QUESTION.test(t)) return call("portfolio_analytics", { filter: subset, sections: ["totals"] });

  const referential = REFERS_TO_PREVIOUS.test(t) && ctx.focus.length > 0;

  // "What's their combined value?" → totals over the previous result set (FOCUS).
  if (referential && /\b(combined|together|altogether|sum|total)\b/.test(t)) {
    return call("portfolio_analytics", { filter: { propertyIds: ctx.focus }, sections: ["totals"] });
  }

  // "What is my annual rental income and overall yield?" → portfolio totals, not a ranking.
  if (TOTALS_QUESTION.test(t) && !RANKING_WORDS.test(t)) return call("portfolio_analytics", { sections: ["totals"] });

  // Narrowing filters the tools support: occupancy ("vacant") and current-value thresholds ("above ₹10 crore").
  const narrowing = { ...occupancyFilter(t), ...valueThreshold(t) };
  const city = CITIES.find((c) => t.includes(`in ${c}`));
  const scope = referential ? { propertyIds: ctx.focus } : { ...(subset ?? {}), ...(city ? { city } : {}) };
  const filter = { ...scope, ...narrowing };
  const hasFilter = Object.keys(filter).length > 0;

  // Rankings. "Which of those earns more rent?" ranks the previous result set (FOCUS).
  // Yield first: "best rental yield" is a yield question even though "rental" starts like "rent".
  const lowest = /\b(lowest|least|smallest|minimum|less|fewest|worst)\b/.test(t);
  const metric = /yield|perform/.test(t)
    ? "yield"
    : /\b(rent|income|earn)/.test(t) && /(highest|most|top|more|higher|better|best|biggest|largest|lowest|least|smallest|minimum|less)/.test(t)
      ? "rent"
      : null;
  if (metric) {
    const order = lowest ? { order: "asc" } : {};
    if (hasFilter) return call("search_properties", { filter, sortBy: metric, ...order });
    return call("search_properties", metric === "rent" ? { sortBy: "rent", ...order, limit: 1 } : { sortBy: "yield", ...order });
  }

  // "Which of my offices are vacant?", "Which one is vacant?", "Which of my properties are above ₹10 crore?"
  // Only for questions: a statement such as "It's vacant" or "My office is now tenanted" is information
  // about a change (handled elsewhere), not a search, so it keeps its previous routing.
  if (Object.keys(narrowing).length && ASKS.test(t)) return call("search_properties", { filter });

  if (subset && /(show|list|my|tell me)/.test(t)) return call("search_properties", { filter: subset });
  if (city) return call("search_properties", { filter: { city } });
  if (/total|overview|look like|summary|worth|portfolio/.test(t)) return call("portfolio_analytics", {});
  return new AIMessage(
    `${PREFIX} This keyword stub is not an AI model, so it only understands certain phrasings. ` +
      `Try: "portfolio overview", "how much of my portfolio is retail?", "which of those earns more rent?", ` +
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
export function createDevStubModel(opts: { streamDelayMs?: number; lastResort?: boolean } = {}): ChatModel {
  const delay = opts.streamDelayMs ?? 12;
  const answer = (messages: BaseMessage[]) => (opts.lastResort ? relabelForLastResort(respond(messages)) : respond(messages));
  return {
    id: opts.lastResort ? DEV_STUB_LAST_RESORT_ID : DEV_STUB_ID,
    provider: "stub",
    async invoke(messages) {
      return answer(messages);
    },
    async stream(messages, { signal }, onDelta) {
      const message = answer(messages);
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
