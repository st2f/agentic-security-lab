import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import {
  actionSchema,
  conversationContinuationSchema,
} from "../investigation/contracts.ts";
import { investigationProgressSchema } from "../investigation/state.ts";
import type { InvestigationState } from "../investigation/state.ts";

/** Explicit validation schema; graph channels alone do not replace policy checks. */
export const investigationStateSchema = z.strictObject({
  ...investigationProgressSchema.shape,
  action: actionSchema.nullable(),
  pendingAttempt: z
    .strictObject({
      eventId: z.string().min(1).max(2000),
      startedElapsedMs: z.number().nonnegative(),
    })
    .nullable(),
  conversation: conversationContinuationSchema,
}) satisfies z.ZodType<InvestigationState>;

/** Every field uses replacement semantics; no append or summing reducers. */
export const InvestigationGraphState = new StateSchema(
  investigationStateSchema.shape,
);
