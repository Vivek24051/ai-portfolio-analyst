// Golden-set types. A case is a scripted conversation with expectations per turn.
// `reference` is an ideal agent's behaviour, replayed by the ORACLE model (a positive control
// for the harness and tools). Real or stub models ignore it and are graded on `expect` only.

export interface RefContext {
  /** Parsed JSON of every tool result so far in this turn, in order. */
  results: Array<Record<string, any>>;
  /** The system prompt for this call (contains focus ids, pending change id, scenario). */
  system: string;
}

export type ArgsSpec = Record<string, unknown> | ((ctx: RefContext) => Record<string, unknown>);

export interface RefCall {
  name: string;
  args: ArgsSpec;
}

export interface Reference {
  /** Tool rounds the ideal agent performs; calls in one round run together. */
  rounds: RefCall[][];
  /** Final reply, built only from tool-result strings (so it is faithful by construction). */
  reply: (ctx: RefContext) => string;
}

export interface ToolExpectation {
  name: string;
  /** Partial deep match against the call's arguments. */
  args?: Record<string, unknown>;
}

export interface TurnExpect {
  /** Each entry must be satisfied this turn; an array entry is "any of". */
  tools?: Array<ToolExpectation | ToolExpectation[]>;
  forbidTools?: string[];
  /** Figures that must appear in the reply (matched by value, rounding-tolerant). */
  figures?: string[];
  /** Property ids / words that must (not) appear in the reply. */
  mentions?: string[];
  notMentions?: string[];
  replyMatches?: RegExp[];
  replyNotMatches?: RegExp[];
  /** The agent should ask for clarification (a question, and no staged/applied change). */
  clarify?: boolean;
  /** Expected staged proposal type this turn, or null for "no proposal". */
  proposal?: "CREATE_PROPERTY" | "UPDATE_PROPERTY" | null;
  hypothetical?: boolean;
  handoff?: boolean;
  status?: "ok" | "error";
  fallbackUsed?: boolean;
}

export interface EvalTurn {
  user: string;
  reference: Reference;
  expect: TurnExpect;
}

export type Fault = "primary_down" | "all_down";

export interface AllowedWrites {
  updates?: Array<{ propertyId: string; currentValueInr?: number }>;
  /** Number of new properties allowed (and expected) for the case's user. */
  creates?: number;
}

export const CATEGORIES = [
  "sample_request",
  "analysis",
  "calculation",
  "ambiguity_data_gap",
  "multi_turn",
  "hypothetical",
  "property_update",
  "authorization_safety",
  "failure",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface EvalCase {
  id: string;
  category: Category;
  title: string;
  userId: string;
  source?: string;
  turns: EvalTurn[];
  fault?: Fault;
  /** Real-portfolio changes this case is allowed (and expected) to make. Anything else is a safety failure. */
  writes?: AllowedWrites;
}
