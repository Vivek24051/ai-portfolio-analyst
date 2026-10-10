// Conversation memory: stored message records ⇄ LangChain messages, with a bounded window.
//
// The window always starts at a user message, so an assistant tool-call message is never
// separated from its tool results (providers reject orphaned tool messages).

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { MessageRecord, NewMessage } from "@/server/stores/types";

/** Older tool payloads are trimmed; the structured state carries what follow-ups need. */
const MAX_HISTORY_TOOL_CHARS = 4_000;

export function windowHistory(records: MessageRecord[]): MessageRecord[] {
  const firstUser = records.findIndex((r) => r.role === "USER");
  return firstUser === -1 ? [] : records.slice(firstUser);
}

export function toLangChainMessages(records: MessageRecord[]): BaseMessage[] {
  return windowHistory(records).map((r) => {
    switch (r.role) {
      case "USER":
        return new HumanMessage(r.content);
      case "ASSISTANT":
        return new AIMessage({
          content: r.content,
          tool_calls: (r.toolCalls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: tc.args, type: "tool_call" as const })),
        });
      case "TOOL":
        return new ToolMessage({
          content:
            r.content.length > MAX_HISTORY_TOOL_CHARS
              ? `${r.content.slice(0, MAX_HISTORY_TOOL_CHARS)}…[truncated]`
              : r.content,
          tool_call_id: r.toolCallId ?? "unknown",
          name: r.toolName ?? undefined,
        });
    }
  });
}

/** Normalises LangChain content (string or content blocks) to plain text. */
export function messageText(m: BaseMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (typeof b === "string" ? b : "text" in b && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** Converts messages produced during a turn into records for persistence. */
export function toNewMessages(messages: BaseMessage[], runId: string): NewMessage[] {
  return messages.map((m): NewMessage => {
    if (AIMessage.isInstance(m)) {
      const calls = m.tool_calls ?? [];
      return {
        role: "ASSISTANT",
        content: messageText(m),
        toolCalls: calls.length ? calls.map((c) => ({ id: c.id ?? "", name: c.name, args: c.args })) : null,
        toolCallId: null,
        toolName: null,
        runId,
      };
    }
    if (ToolMessage.isInstance(m)) {
      return { role: "TOOL", content: messageText(m), toolCalls: null, toolCallId: m.tool_call_id, toolName: m.name ?? null, runId };
    }
    return { role: "USER", content: messageText(m), toolCalls: null, toolCallId: null, toolName: null, runId };
  });
}
