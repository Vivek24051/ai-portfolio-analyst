// DEV STUB — not an LLM. A keyword router that lets the chat UI and API run locally without an
// OpenRouter key or any paid call. It exercises the real graph, tools and persistence, but its
// "understanding" is a handful of regexes, and its answers are fixed templates over the tool output.
// Replies are prefixed so nobody mistakes it for the agent.

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "./model";
import { formatToolResultForStub } from "./stubFormat";

export const DEV_STUB_ID = "dev-stub (no LLM configured)";
const PREFIX = "[dev stub — no LLM configured]";

let seq = 0;
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `stub_${++seq}`, name, args, type: "tool_call" }] });

const CITIES = ["mumbai", "bengaluru", "bangalore", "gurugram", "gurgaon", "noida", "delhi ncr", "alibaug"];

function route(text: string): AIMessage {
  const t = text.toLowerCase();
  if (/(highest|most|top).*rent|rent.*(highest|most)/.test(t)) return call("search_properties", { sortBy: "rent", limit: 1 });
  if (/yield|perform/.test(t)) return call("search_properties", { sortBy: "yield" });
  const cls = /retail/.test(t) ? "RETAIL" : /office/.test(t) ? "OFFICE" : /residential|apartment|villa/.test(t) ? "RESIDENTIAL" : null;
  if (cls && /(show|list|my)/.test(t)) return call("search_properties", { filter: { assetClasses: [cls] } });
  const city = CITIES.find((c) => t.includes(`in ${c}`));
  if (city) return call("search_properties", { filter: { city } });
  if (/total|overview|look like|summary|worth|portfolio/.test(t)) return call("portfolio_analytics", {});
  return new AIMessage(
    `${PREFIX} Set OPENROUTER_API_KEY and LLM_PRIMARY_MODEL to enable the real agent. ` +
      `Stub demos: "portfolio overview", "show my retail properties", "properties in Mumbai", "highest rent".`,
  );
}

function respond(messages: BaseMessage[]): AIMessage {
  const last = messages.at(-1);
  if (last && ToolMessage.isInstance(last)) {
    // Template reply built only from the tool's own output (see stubFormat.ts).
    return new AIMessage(formatToolResultForStub(last.name, String(last.content)));
  }
  const human = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
  return route(human ? String(human.content) : "");
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
