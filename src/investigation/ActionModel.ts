import type { ModelInput, ModelReply } from "./contracts.ts";

/** Each call consumes and returns explicit continuation owned by its caller. */
export interface ActionModel {
  requestAction(input: ModelInput, signal: AbortSignal): Promise<ModelReply>;
}
