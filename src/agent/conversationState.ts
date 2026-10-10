// Structured, backend-owned conversation state. Tools update it from their *results*; the model
// never writes it directly. It is what makes "which one…", "exclude it" and "how would that
// change things?" resolvable without trusting the model's memory.

import { z } from "zod";
import { scenarioInputSchema } from "@/domain/scenario";

export const conversationStateSchema = z.object({
  /** Property ids from the most recent result set (search / filtered analytics / comparison). */
  focusPropertyIds: z.array(z.string()).default([]),
  /** Last hypothetical scenario, in whole INR. Never applied to real data. */
  activeScenario: scenarioInputSchema.nullable().default(null),
  /** The current unconfirmed proposal, if any. */
  pendingActionId: z.string().nullable().default(null),
  /** Turns in a row that ended in an error; drives the needs-attention flag. */
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

export type ConversationState = z.infer<typeof conversationStateSchema>;

/** Lenient read: corrupt or legacy state resets to empty rather than breaking the conversation. */
export function parseConversationState(raw: unknown): ConversationState {
  const parsed = conversationStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : conversationStateSchema.parse({});
}
