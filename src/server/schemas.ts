// Request body schemas shared by the JSON and streaming chat routes.
import { z } from "zod";

export const chatRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(64).optional(),
    message: z.string().trim().min(1, "Message is empty.").max(2000, "Message is too long (max 2000 characters)."),
  })
  .strict();

export const pendingActionDecisionSchema = z
  .object({
    conversationId: z.string().min(1).max(64),
    pendingActionId: z.string().min(1).max(64),
    decision: z.enum(["confirm", "cancel"]),
  })
  .strict();
