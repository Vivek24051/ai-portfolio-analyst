// The agent loop as an explicit LangGraph state machine:
//
//   START → agent ──(tool calls, rounds < 5)──→ tools → agent
//             │──(tool calls, budget spent)──→ limit → END
//             └──(no tool calls)────────────→ END
//
// - The graph is compiled once; per-request dependencies (trusted ToolContext, model router,
//   recorder, deadline) arrive through config.configurable, so nothing leaks between users.
// - After MAX_TOOL_ROUNDS the model is called once more WITHOUT tools to answer with what it
//   has; if it still asks for tools, the `limit` node ends the turn with a fixed message.

import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, messagesStateReducer, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { MAX_TOOL_ROUNDS } from "./config";
import { summarizeToolOutcome, toolLabel, type EmitFn } from "./events";
import { invokeWithFallback, type ModelRouter } from "./model";
import type { RunRecorder } from "./telemetry";
import { executeToolRound, MALFORMED_ARGS_KEY, TOOL_SPECS, type ToolContext } from "./tools";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  toolRounds: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stopReason: Annotation<"completed" | "tool_limit" | null>({ reducer: (_, next) => next, default: () => null }),
});
type State = typeof AgentState.State;

export interface AgentDeps {
  router: ModelRouter;
  toolCtx: ToolContext;
  recorder: RunRecorder;
  systemPrompt: string;
  turnSignal: AbortSignal;
  /** Filled by the agent node: which model produced the final answer. */
  usage: { modelId: string | null; usedFallback: boolean };
  /** Progress events for the client (already wrapped so it can never throw). */
  emit: EmitFn;
}

export const TOOL_LIMIT_REPLY =
  "Sorry — I couldn't finish working that out. I've flagged this conversation so the team can take a look. Could you try asking in a simpler way?";

const BUDGET_EXHAUSTED_NOTE =
  "\n\nTOOL BUDGET EXHAUSTED: answer now using only the tool results above, and say plainly what you could not determine.";

function deps(config: LangGraphRunnableConfig): AgentDeps {
  const d = config.configurable?.deps as AgentDeps | undefined;
  if (!d) throw new Error("Agent graph invoked without deps");
  return d;
}

/** Tool calls with unparseable JSON arguments become calls the executor will reject cleanly. */
function normaliseToolCalls(msg: AIMessage): AIMessage {
  const invalid = msg.invalid_tool_calls ?? [];
  if (invalid.length === 0) return msg;
  return new AIMessage({
    content: msg.content,
    tool_calls: [
      ...(msg.tool_calls ?? []),
      ...invalid.map((c, i) => ({
        id: c.id ?? `invalid_${i}`,
        name: c.name ?? "unknown",
        args: { [MALFORMED_ARGS_KEY]: true },
        type: "tool_call" as const,
      })),
    ],
    usage_metadata: msg.usage_metadata,
  });
}

async function agentNode(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const d = deps(config);
  const budgetLeft = state.toolRounds < MAX_TOOL_ROUNDS;
  const system = new SystemMessage(d.systemPrompt + (budgetLeft ? "" : BUDGET_EXHAUSTED_NOTE));
  d.emit({ type: "status", label: state.toolRounds === 0 ? "Thinking…" : "Putting the answer together…" });
  let streamedText = false;
  const { message, modelId, usedFallback } = await invokeWithFallback(
    d.router,
    [system, ...state.messages],
    {
      tools: budgetLeft ? TOOL_SPECS : null,
      turnSignal: d.turnSignal,
      stream: {
        onDelta: (text) => {
          streamedText = true;
          d.emit({ type: "delta", text });
        },
        onReset: () => {
          streamedText = false;
          d.emit({ type: "reset" });
        },
      },
    },
    d.recorder,
  );
  d.usage.modelId = modelId;
  d.usage.usedFallback ||= usedFallback;
  const normalised = normaliseToolCalls(message);
  // Text streamed alongside tool calls is a preamble ("let me check…"), not the answer.
  if (streamedText && (normalised.tool_calls?.length ?? 0) > 0) d.emit({ type: "reset" });
  return { messages: [normalised] };
}

async function toolsNode(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const d = deps(config);
  const last = state.messages.at(-1) as AIMessage;
  const calls = (last.tool_calls ?? []).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, args: c.args }));
  for (const c of calls) d.emit({ type: "tool_start", callId: c.id, name: c.name, label: toolLabel(c.name) });
  const outcomes = await executeToolRound(d.toolCtx, calls);
  for (const o of outcomes) {
    d.emit({ type: "tool_end", callId: o.callId, name: o.name, ok: o.ok, summary: summarizeToolOutcome(o.name, o.ok, o.result, o.error) });
    d.recorder.toolCalls.push({
      name: o.name,
      args: calls.find((c) => c.id === o.callId)?.args ?? null,
      result: o.result,
      ok: o.ok,
      error: o.error,
      durationMs: o.durationMs,
    });
  }
  return {
    messages: outcomes.map((o) => new ToolMessage({ content: o.content, tool_call_id: o.callId, name: o.name })),
    toolRounds: state.toolRounds + 1,
  };
}

async function limitNode(): Promise<Partial<State>> {
  return { messages: [new AIMessage(TOOL_LIMIT_REPLY)], stopReason: "tool_limit" };
}

function routeAfterAgent(state: State): "tools" | "limit" | typeof END {
  const last = state.messages.at(-1);
  const hasCalls = last && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0;
  if (!hasCalls) return END;
  return state.toolRounds < MAX_TOOL_ROUNDS ? "tools" : "limit";
}

export const agentGraph = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolsNode)
  .addNode("limit", limitNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeAfterAgent, ["tools", "limit", END])
  .addEdge("tools", "agent")
  .addEdge("limit", END)
  .compile();

/** Upper bound on graph steps: (agent + tools) per round, the final agent call, limit node, slack. */
export const RECURSION_LIMIT = MAX_TOOL_ROUNDS * 2 + 4;

export async function runAgent(history: BaseMessage[], d: AgentDeps) {
  const final = await agentGraph.invoke(
    { messages: history },
    { configurable: { deps: d }, recursionLimit: RECURSION_LIMIT, signal: d.turnSignal },
  );
  const newMessages = final.messages.slice(history.length);
  return { newMessages, toolRounds: final.toolRounds, stopReason: final.stopReason ?? "completed" };
}
