// ORACLE model — a mock, not an LLM. Replays each case's reference behaviour through the real
// graph, tools and stores. It is a POSITIVE CONTROL: if it does not score ~100%, the harness,
// tools or expectations are wrong. Its scores say nothing about real model quality.

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatModel } from "@/agent/model";
import type { EvalCase, RefContext } from "./types";

let seq = 0;

export function createOracleModel(evalCase: EvalCase, id = "oracle (reference policy, mock)"): ChatModel {
  return {
    id,
    async invoke(messages: BaseMessage[]) {
      const humans = messages.filter((m) => HumanMessage.isInstance(m));
      const turn = evalCase.turns[humans.length - 1];
      if (!turn) throw new Error(`oracle: no reference for turn ${humans.length}`);

      const lastHuman = messages.map((m) => HumanMessage.isInstance(m)).lastIndexOf(true);
      const sinceHuman = messages.slice(lastHuman + 1);
      const roundsDone = sinceHuman.filter((m) => AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0).length;
      const ctx: RefContext = {
        system: SystemMessage.isInstance(messages[0]!) ? String(messages[0]!.content) : "",
        results: sinceHuman
          .filter((m) => ToolMessage.isInstance(m))
          .map((m) => {
            try {
              return JSON.parse(String(m.content)) as Record<string, any>;
            } catch {
              return {};
            }
          }),
      };

      const round = turn.reference.rounds[roundsDone];
      if (round) {
        return new AIMessage({
          content: "",
          tool_calls: round.map((c) => ({
            id: `oracle_${++seq}`,
            name: c.name,
            args: typeof c.args === "function" ? c.args(ctx) : c.args,
            type: "tool_call" as const,
          })),
        });
      }
      return new AIMessage(turn.reference.reply(ctx));
    },
  };
}

/** A model that always fails — used for fault-injection cases. */
export function downModel(id: string): ChatModel {
  return {
    id,
    async invoke() {
      throw new Error(`${id}: simulated provider outage (503)`);
    },
  };
}

/**
 * NEGATIVE CONTROL for numeric faithfulness: the oracle, but every figure in the final reply is
 * falsified (₹ amounts +10%, percentages +3 points). The faithfulness metric must catch this.
 */
export function perturbFigures(text: string): string {
  return text
    .replace(/₹(\d+(?:\.\d+)?)\s?(Cr|L)\b/g, (_m, n: string, u: string) => `₹${Math.round(Number(n) * 1.1 * 100) / 100} ${u}`)
    .replace(/(-?\d+(?:\.\d+)?)%/g, (_m, n: string) => `${Math.round((Number(n) + 3) * 100) / 100}%`);
}

export function createPerturbedOracleModel(evalCase: EvalCase): ChatModel {
  const inner = createOracleModel(evalCase, "oracle-perturbed (falsified figures, mock)");
  return {
    id: inner.id,
    async invoke(messages, opts) {
      const out = await inner.invoke(messages, opts);
      if (out.tool_calls?.length) return out;
      return new AIMessage(perturbFigures(String(out.content)));
    },
  };
}
