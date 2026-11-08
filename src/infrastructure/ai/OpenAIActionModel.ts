import OpenAI from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import {
  bindModelAction,
  modelActionSchemas,
  ModelRequestError,
} from "../../investigation/contracts.ts";
import type {
  ActionName,
  ConversationContinuation,
  ModelInput,
  ModelReply,
} from "../../investigation/contracts.ts";
import {
  actionDescriptions,
  instructions,
} from "../../investigation/prompt.ts";
import type { ActionModel } from "../../investigation/ActionModel.ts";

const tools = Object.fromEntries(
  Object.entries(modelActionSchemas).map(([name, parameters]) => [
    name,
    zodResponsesFunction({
      name,
      parameters,
      description: actionDescriptions[name as ActionName],
    }),
  ]),
);

/** Provider translation; conversation progress is supplied and returned as wire data. */
export class OpenAIActionModel implements ActionModel {
  private readonly client: OpenAI;

  constructor(client: OpenAI) {
    this.client = client;
  }

  async requestAction(
    input: ModelInput,
    signal: AbortSignal,
  ): Promise<ModelReply> {
    // Continuation contains trusted provider wire items; SDK types stay in this adapter.
    const history = structuredClone(
      input.conversation.history,
    ) as unknown as ResponseInputItem[];
    if (!input.allowedActions.length) throw new Error("No allowed actions");
    const content = JSON.stringify(input.message);
    if (!history.length) history.push({ role: "user", content });
    else if (input.conversation.pendingCallId)
      history.push({
        type: "function_call_output",
        call_id: input.conversation.pendingCallId,
        output: content,
      });
    else throw new Error("Missing tool call to answer in conversation");
    const response = await this.client.responses
      .create(
        {
          model: input.model,
          reasoning: { effort: input.reasoning },
          instructions,
          input: history,
          tools: input.allowedActions.map((name) => tools[name]!),
          // One permitted action is forced; otherwise any offered tool must be called.
          tool_choice:
            input.allowedActions.length === 1
              ? { type: "function", name: input.allowedActions[0]! }
              : "required",
          parallel_tool_calls: false,
          max_output_tokens: 8192,
          store: false,
          include: ["reasoning.encrypted_content"],
        },
        { signal },
      )
      .catch((error: unknown) => {
        throw new ModelRequestError(
          error instanceof OpenAI.APIError ? error.status : undefined,
        );
      });
    history.push(
      ...response.output.filter(
        (item) =>
          item.type === "function_call" ||
          item.type === "reasoning" ||
          item.type === "message",
      ),
    );
    const calls = response.output.filter(
      (item) => item.type === "function_call",
    );
    const call =
      calls.length === 1 && response.status === "completed"
        ? calls[0]
        : undefined;
    let action: unknown = null;
    if (call) {
      try {
        action = bindModelAction(
          { ...JSON.parse(call.arguments), name: call.name },
          input.snapshotId,
        );
      } catch {
        /* Invalid output is handled by the application. */
      }
    }
    return {
      action,
      // Normalize provider items to detached JSON, without SDK-only properties.
      conversation: JSON.parse(
        JSON.stringify({
          history,
          pendingCallId: call?.call_id ?? null,
        }),
      ) as ConversationContinuation,
      actualModel: response.model,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
    };
  }
}
