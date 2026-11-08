import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import {
  actionSchema,
  conversationContinuationSchema,
} from "../investigation/contracts.ts";
import { explorationProgressSchema } from "../investigation/state.ts";
import type { ExplorationState } from "../investigation/state.ts";

/** Explicit validation schema; graph channels alone do not replace policy checks. */
export const explorationStateSchema = z.strictObject({
  ...explorationProgressSchema.shape,
  action: actionSchema.nullable(),
  conversation: conversationContinuationSchema,
}) satisfies z.ZodType<ExplorationState>;

/** Every field uses replacement semantics; no append or summing reducers. */
export const ExplorationGraphState = new StateSchema(
  explorationStateSchema.shape,
);
