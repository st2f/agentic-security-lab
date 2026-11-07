import {
  actionSchema,
  conversationContinuationSchema,
  ModelRequestError,
} from "./contracts.ts";
import type {
  Action,
  Candidate,
  ModelBudget,
  Termination,
} from "./contracts.ts";
import type { InvestigationContext } from "./context.ts";
import {
  candidateReferences,
  hasEvidenceLines,
  isValidEvidenceRange,
} from "./evidence.ts";
import {
  candidateCheckpointUpdate,
  latestObservation,
  returnedEvidence,
} from "./state.ts";
import type { InvestigationState, InvestigationTraceEvent } from "./state.ts";
import {
  OutputBudgetError,
  serializedBytes,
} from "../infrastructure/repository/RepositoryInspector.ts";

class InvalidOutput extends Error {}

type Update = Partial<InvestigationState>;
type Inspection = Exclude<Action, { name: "finish" }>;

/** Investigation policy over explicit state; retains no run progress. */
export class InvestigationOperations {
  /** `choose_action`: enforce call limits, ask the model, validate its choice. */
  async chooseAction(
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Update> {
    const stopped = this.interruption(state, context);
    if (stopped) return { action: null, termination: stopped };
    const { limits } = context.config;
    if (state.usage.modelCalls >= limits.modelCalls)
      return {
        action: null,
        termination: { reason: "budget_exhausted", limit: "modelCalls" },
      };
    const budget = this.budget(state, context);
    const usage = { ...state.usage, modelCalls: state.usage.modelCalls + 1 };
    const entry = this.event(state, "model");
    const begin = context.execution.elapsedMs;
    const update: Update = { action: null, usage };
    let invoked = false;
    let receivedUsage = false;
    try {
      const reply = await context.execution.bounded((signal) => {
        invoked = true;
        return context.model.requestAction(
          {
            snapshotId: context.snapshot.snapshotId,
            config: structuredClone(context.config),
            observation: latestObservation(state),
            conversation: structuredClone(state.conversation),
            budget,
          },
          signal,
        );
      });
      const tokens = reply.usage;
      if (
        tokens &&
        [tokens.inputTokens, tokens.outputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      ) {
        usage.inputTokens += tokens.inputTokens;
        usage.outputTokens += tokens.outputTokens;
        receivedUsage = true;
      }
      if (
        typeof reply.actualModel === "string" &&
        reply.actualModel.length > 0 &&
        reply.actualModel.length <= 2000
      )
        entry.actualModel = reply.actualModel;
      // A reply arriving after interruption cannot introduce an action or evidence.
      const interrupted = this.interruption(state, context);
      if (interrupted) {
        entry.outcome = "stopped";
        update.termination = interrupted;
      } else {
        // Both come from the model boundary; a malformed continuation is a model error.
        const conversation = conversationContinuationSchema.parse(
          reply.conversation,
        );
        const parsed = actionSchema.safeParse(reply.action);
        if (!parsed.success) throw new InvalidOutput();
        const action = parsed.data;
        const returned = returnedEvidence(state);
        if (action.basedOnToolCallIds.some((id) => !returned.has(id)))
          throw new InvalidOutput();
        if (action.name !== "finish" && action.checkpoint !== null) {
          this.validateCandidates(action.checkpoint, state, context);
          Object.assign(update, candidateCheckpointUpdate(action.checkpoint));
        }
        entry.action = action;
        entry.outcome = "ok";
        update.conversation = conversation;
        if (action.name !== "finish" && budget.finishOnly)
          // The checkpoint is kept; the requested inspection cannot be afforded.
          update.termination = {
            reason: "budget_exhausted",
            limit:
              budget.modelCallsAfterThis === 0 ? "modelCalls" : "toolCalls",
          };
        else update.action = action;
      }
    } catch (error) {
      const interrupted = this.interruption(state, context);
      // Interruption before dispatch: nothing was sent, so nothing is counted.
      if (interrupted && !invoked)
        return { action: null, termination: interrupted };
      entry.outcome = "error";
      update.termination = interrupted ?? {
        reason:
          error instanceof InvalidOutput
            ? "invalid_model_output"
            : "model_error",
        detail:
          error instanceof ModelRequestError
            ? error.message
            : error instanceof InvalidOutput
              ? "Action structure, checkpoint evidence, or prior tool IDs failed validation"
              : "Model request failed",
      };
    }
    if (!receivedUsage) usage.tokenUsageComplete = false;
    return { ...update, trace: this.close(state, entry, begin, context) };
  }

  /** `execute_action`: run the chosen inspection or accept the final assessment. */
  async executeAction(
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Update> {
    const action = state.action;
    if (!action) throw new Error("No chosen action");
    const stopped = this.interruption(state, context);
    if (stopped) return { action: null, termination: stopped };
    return action.name === "finish"
      ? this.finish(action, state, context)
      : this.inspect(action, state, context);
  }

  private finish(
    action: Extract<Action, { name: "finish" }>,
    state: InvestigationState,
    context: InvestigationContext,
  ): Update {
    try {
      if (action.candidates.length > context.config.maxCandidates)
        throw new InvalidOutput();
      this.validateCandidates(action.candidates, state, context);
    } catch {
      return {
        action: null,
        termination: {
          reason: "invalid_model_output",
          detail: "Final candidates failed count or evidence validation",
        },
      };
    }
    return {
      action: null,
      finalCandidates: action.candidates,
      scopeAndLimitations: [
        ...state.scopeAndLimitations,
        ...action.scopeAndLimitations,
      ],
      termination: { reason: "model_finished" },
    };
  }

  private async inspect(
    action: Inspection,
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Update> {
    const { limits } = context.config;
    const usage = { ...state.usage, toolCalls: state.usage.toolCalls + 1 };
    const toolCallId = `tool-${usage.toolCalls}`;
    const { name, args } = inspectionArguments(action);
    const entry: InvestigationTraceEvent = {
      ...this.event(state, "tool"),
      toolCallId,
      arguments: { name, ...args },
    };
    const begin = context.execution.elapsedMs;
    const remaining =
      limits.totalToolResponseBytes - state.usage.toolResponseBytes;
    const allowance = Math.min(limits.toolResponseBytes, remaining);
    // The model receives `{toolCallId, result}`; the whole envelope is charged.
    const envelopeBytes = serializedBytes({ toolCallId, result: null }) - 4;
    const update: Update = { action: null, usage };
    let invoked = false;
    try {
      const result = await context.execution.bounded((signal) => {
        invoked = true;
        return context.inspector.execute(
          name,
          args,
          allowance - envelopeBytes,
          signal,
        );
      });
      const interrupted = this.interruption(state, context);
      if (interrupted) {
        entry.outcome = "stopped";
        update.termination = interrupted;
      } else {
        usage.toolResponseBytes += serializedBytes({ toolCallId, result });
        entry.result = result;
        entry.outcome = result.kind === "error" ? "error" : "ok";
      }
    } catch (error) {
      const interrupted = this.interruption(state, context);
      if (interrupted && !invoked)
        return { action: null, termination: interrupted };
      entry.outcome = "error";
      update.termination =
        interrupted ??
        (error instanceof OutputBudgetError
          ? {
              reason: "budget_exhausted",
              limit:
                remaining < limits.toolResponseBytes
                  ? "totalToolResponseBytes"
                  : "toolResponseBytes",
            }
          : { reason: "execution_error" });
    }
    return { ...update, trace: this.close(state, entry, begin, context) };
  }

  /** What remains after the model call about to be made. */
  private budget(
    state: InvestigationState,
    context: InvestigationContext,
  ): ModelBudget {
    const { limits } = context.config;
    const modelCallsAfterThis = limits.modelCalls - state.usage.modelCalls - 1;
    const inspections = limits.toolCalls - state.usage.toolCalls;
    return {
      modelCallsAfterThis,
      inspections,
      toolResponseBytes:
        limits.totalToolResponseBytes - state.usage.toolResponseBytes,
      milliseconds: Math.max(
        0,
        Math.floor(limits.elapsedMs - context.execution.elapsedMs),
      ),
      finishOnly: modelCallsAfterThis === 0 || inspections === 0,
    };
  }

  private close(
    state: InvestigationState,
    entry: InvestigationTraceEvent,
    begin: number,
    context: InvestigationContext,
  ): InvestigationTraceEvent[] {
    entry.durationMs = context.execution.elapsedMs - begin;
    return [...state.trace, entry];
  }

  private interruption(
    state: InvestigationState,
    context: InvestigationContext,
  ): Termination | null {
    return state.termination ?? context.execution.interruption();
  }

  private event(
    state: InvestigationState,
    type: InvestigationTraceEvent["type"],
  ): InvestigationTraceEvent {
    return {
      id: `event-${state.trace.length + 1}`,
      type,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      outcome: "ok",
    };
  }

  private validateCandidates(
    candidates: Candidate[],
    state: InvestigationState,
    context: InvestigationContext,
  ): void {
    if (new Set(candidates.map((item) => item.id)).size !== candidates.length)
      throw new InvalidOutput();
    const returned = returnedEvidence(state);
    for (const reference of candidateReferences(candidates)) {
      const exposed = returned.get(reference.toolCallId)?.get(reference.path);
      if (
        !isValidEvidenceRange(reference, context.snapshot.snapshotId) ||
        !exposed ||
        !hasEvidenceLines(reference, exposed)
      )
        throw new InvalidOutput();
    }
  }
}

/** Tool arguments are the action without its model-facing metadata. */
export function inspectionArguments(action: Inspection): {
  name: Inspection["name"];
  args: Record<string, unknown>;
} {
  const {
    name,
    rationale: _rationale,
    basedOnToolCallIds: _basis,
    checkpoint: _checkpoint,
    ...args
  } = action;
  return { name, args };
}
