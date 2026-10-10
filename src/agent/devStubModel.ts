// DEV STUB — not an LLM. A keyword router that lets the chat UI and API run locally without an
// OpenRouter key or any paid call. It exercises the real graph, tools and persistence, but its
// "understanding" is a handful of regexes. Replies are prefixed so nobody mistakes it for the agent.

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "./model";

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

export function createDevStubModel(): ChatModel {
  return {
    id: DEV_STUB_ID,
    async invoke(messages: BaseMessage[]) {
      const last = messages.at(-1);
      if (last && ToolMessage.isInstance(last)) {
        return new AIMessage(`${PREFIX} Raw tool result:\n${String(last.content).slice(0, 1500)}`);
      }
      const human = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
      return route(human ? String(human.content) : "");
    },
  };
}
