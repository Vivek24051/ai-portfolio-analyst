// Streaming protocol between the chat service and the browser (Server-Sent Events).
//
// Tool activity is surfaced as friendly labels + short outcome summaries derived from safe
// fields only. Raw tool arguments, raw results, prompts and error internals never leave the server.

import type { ChatTurnResult } from "@/server/services/chatService";

export type ChatStreamEvent =
  | { type: "start"; conversationId: string; runId: string }
  | { type: "status"; label: string }
  | { type: "tool_start"; callId: string; name: string; label: string }
  | { type: "tool_end"; callId: string; name: string; ok: boolean; summary: string }
  /** Incremental answer text from the model. */
  | { type: "delta"; text: string }
  /** Discard streamed text so far (model switched to tool calls, or fell back to another model). */
  | { type: "reset" }
  | { type: "done"; result: ChatTurnResult }
  | { type: "error"; code: string; message: string };

export type EmitFn = (event: ChatStreamEvent) => void;

/** Wraps an emitter so a disconnected client can never break (or abort) the server-side turn. */
export function safeEmitter(emit: EmitFn | undefined): EmitFn {
  if (!emit) return () => {};
  return (event) => {
    try {
      emit(event);
    } catch {
      // Client went away; the turn still completes and is persisted.
    }
  };
}

export const TOOL_LABELS: Record<string, string> = {
  search_properties: "Looking up your properties",
  portfolio_analytics: "Calculating portfolio figures",
  compare_groups: "Comparing property groups",
  run_scenario: "Running a hypothetical scenario",
  propose_new_property: "Preparing a new property for your confirmation",
  propose_property_update: "Preparing a change for your confirmation",
  confirm_pending_action: "Saving your confirmed change",
  cancel_pending_action: "Cancelling the proposed change",
  flag_for_human: "Flagging this conversation for the team",
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? "Working on it";

const ERROR_SUMMARIES: Record<string, string> = {
  invalid_arguments: "retrying with corrected input",
  malformed_arguments: "retrying with corrected input",
  unknown_tool: "not available",
  invalid_scenario: "scenario not possible",
  no_active_scenario: "no earlier scenario to build on",
  invalid_amount: "amount out of range",
  tool_timeout: "timed out",
  output_truncated: "too many results",
  internal_error: "failed",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One-line, user-safe outcome for a tool call. */
export function summarizeToolOutcome(name: string, ok: boolean, result: unknown, error: string | null): string {
  if (!ok) return ERROR_SUMMARIES[error ?? ""] ?? "failed";
  const r = (result ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_properties":
      return typeof r.matchCount === "number" ? plural(r.matchCount, "match", "matches") : "done";
    case "portfolio_analytics":
      return typeof r.scope === "string" ? r.scope : "done";
    case "compare_groups":
      return "comparison ready";
    case "run_scenario":
      return "hypothetical result ready (real portfolio unchanged)";
    case "propose_new_property":
    case "propose_property_update":
      return (
        { proposed: "awaiting your confirmation", needs_info: "more details needed", possible_duplicate: "possible duplicate found", not_found: "property not found", invalid: "details need correcting" } as Record<string, string>
      )[String(r.status)] ?? "done";
    case "confirm_pending_action":
      return r.status === "confirmed" ? "saved" : "not saved";
    case "cancel_pending_action":
      return r.status === "cancelled" ? "cancelled" : "nothing to cancel";
    case "flag_for_human":
      return "team notified";
    default:
      return "done";
  }
}
