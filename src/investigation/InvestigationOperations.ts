import { isDeepStrictEqual } from "node:util";
import {
  actionSchema,
  conversationContinuationSchema,
  inspectionResultSchema,
  ModelRequestError,
} from "./contracts.ts";
import type { Action, Candidate, Termination } from "./contracts.ts";
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
  SnapshotChangedError,
} from "../infrastructure/repository/RepositoryInspector.ts";

class InvalidOutput extends Error {}

/** Investigation policy and actions over explicit state; retains no run progress. */
export class InvestigationOperations {
  prepareModel(
    state: InvestigationState,
    context: InvestigationContext,
  ): Partial<InvestigationState> {
    this.assertIdle(state);
    const stopped = this.interruption(state, context);
    if (stopped) return { action: null, termination: stopped };
    if (state.usage.modelCalls >= context.config.limits.modelCalls)
      return {
        action: null,
        termination: { reason: "budget_exhausted", limit: "modelCalls" },
      };
    const entry = this.event(state, "model");
    return {
      action: null,
      usage: { ...state.usage, modelCalls: state.usage.modelCalls + 1 },
      trace: [...state.trace, entry],
      pendingAttempt: {
        eventId: entry.id,
        startedElapsedMs: context.execution.elapsedMs,
      },
    };
  }

  prepareAction(
    state: InvestigationState,
    context: InvestigationContext,
  ): Partial<InvestigationState> {
    this.assertIdle(state);
    const stopped = this.interruption(state, context);
    if (stopped) return { action: null, termination: stopped };
    const parsed = actionSchema.safeParse(state.action);
    if (!parsed.success)
      return { action: null, termination: { reason: "invalid_model_output" } };
    const action = parsed.data;
    // Finish rechecks retain their existing accounting: no inspection reservation.
    if (action.name === "finish") return { action };
    if (state.usage.toolCalls >= context.config.limits.toolCalls)
      return {
        action: null,
        termination: { reason: "budget_exhausted", limit: "toolCalls" },
      };
    const entry = this.event(state, "tool");
    const usage = { ...state.usage, toolCalls: state.usage.toolCalls + 1 };
    const {
      name,
      rationale: _rationale,
      basedOnToolCallIds: _basis,
      checkpoint: _checkpoint,
      ...args
    } = action;
    entry.toolCallId = `tool-${usage.toolCalls}`;
    entry.arguments = { name, ...args };
    return {
      action,
      usage,
      trace: [...state.trace, entry],
      pendingAttempt: {
        eventId: entry.id,
        startedElapsedMs: context.execution.elapsedMs,
      },
    };
  }

  async requestAction(
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Partial<InvestigationState>> {
    const { entry, begin } = this.attempt(state, "model");
    const usage = { ...state.usage };
    const update: Partial<InvestigationState> = {
      action: null,
      pendingAttempt: null,
      usage,
    };
    const stopped = this.interruption(state, context);
    if (stopped) {
      entry.outcome = "stopped";
      usage.tokenUsageComplete = false;
      return {
        ...update,
        termination: stopped,
        ...this.closeAttempt(state, entry, begin, context),
      };
    }
    let invoked = false;
    let receivedUsage = false;
    try {
      const reply = await context.execution.bounded((signal) => {
        const input = {
          snapshotId: context.snapshot.snapshotId,
          config: structuredClone(context.config),
          observation: latestObservation(state),
          conversation: structuredClone(state.conversation),
        };
        if (this.interruption(state, context))
          throw new Error("Execution interrupted before model invocation");
        invoked = true;
        return context.model.requestAction(input, signal);
      });
      if (
        reply.usage &&
        Number.isSafeInteger(reply.usage.inputTokens) &&
        reply.usage.inputTokens >= 0 &&
        Number.isSafeInteger(reply.usage.outputTokens) &&
        reply.usage.outputTokens >= 0
      ) {
        usage.inputTokens += reply.usage.inputTokens;
        usage.outputTokens += reply.usage.outputTokens;
        receivedUsage = true;
      }
      if (
        typeof reply.actualModel === "string" &&
        reply.actualModel.length > 0 &&
        reply.actualModel.length <= 2000
      )
        entry.actualModel = reply.actualModel;
      const interrupted = this.interruption(state, context);
      if (interrupted) {
        entry.outcome = "stopped";
        update.termination = interrupted;
      } else {
        const conversation = conversationContinuationSchema.parse(
          reply.conversation,
        );
        const parsed = actionSchema.safeParse(reply.action);
        if (!parsed.success) throw new InvalidOutput();
        const action = parsed.data;
        const returned = returnedEvidence(state);
        if (action.basedOnToolCallIds.some((id) => !returned.has(id)))
          throw new InvalidOutput();
        entry.action = action;
        if (action.name !== "finish" && action.checkpoint !== null) {
          this.validateCandidates(action.checkpoint, state, context);
          Object.assign(update, candidateCheckpointUpdate(action.checkpoint));
        }
        update.conversation = conversation;
        update.action = action;
        entry.outcome = "ok";
      }
    } catch (error) {
      const interrupted = this.interruption(state, context);
      entry.outcome = interrupted && !invoked ? "stopped" : "error";
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
    return { ...update, ...this.closeAttempt(state, entry, begin, context) };
  }

  async executeAction(
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Partial<InvestigationState>> {
    if (!state.action) throw new Error("No prepared action");
    const parsed = actionSchema.safeParse(state.action);
    if (!parsed.success) throw new Error("Prepared action failed validation");
    if (parsed.data.name === "finish") {
      this.assertIdle(state);
      const stopped = this.interruption(state, context);
      return stopped
        ? { action: null, termination: stopped }
        : this.finishInvestigation(parsed.data, state, context);
    }
    return this.executeInspection(parsed.data, state, context);
  }

  private async finishInvestigation(
    action: Extract<Action, { name: "finish" }>,
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Partial<InvestigationState>> {
    try {
      if (action.candidates.length > context.config.maxCandidates)
        throw new InvalidOutput();
      this.validateCandidates(action.candidates, state, context);
      await context.execution.bounded(async (signal) => {
        for (const reference of candidateReferences(action.candidates)) {
          await context.inspector.execute(
            "read_lines",
            {
              path: reference.path,
              startLine: reference.startLine,
              endLine: reference.endLine,
            },
            16_384,
            signal,
          );
        }
      });
      const interrupted = this.interruption(state, context);
      if (interrupted) return { action: null, termination: interrupted };
      return {
        action: null,
        finalCandidates: action.candidates,
        scopeAndLimitations: [
          ...state.scopeAndLimitations,
          ...action.scopeAndLimitations,
        ],
        termination: { reason: "model_finished" },
      };
    } catch (error) {
      return {
        action: null,
        termination: this.interruption(state, context) ?? {
          reason:
            error instanceof SnapshotChangedError
              ? "snapshot_changed"
              : error instanceof InvalidOutput
                ? "invalid_model_output"
                : "execution_error",
          detail:
            "Final candidates failed count, evidence, or snapshot validation",
        },
      };
    }
  }

  private async executeInspection(
    action: Exclude<Action, { name: "finish" }>,
    state: InvestigationState,
    context: InvestigationContext,
  ): Promise<Partial<InvestigationState>> {
    const { entry, begin } = this.attempt(state, "tool");
    const usage = { ...state.usage };
    const toolCallId = entry.toolCallId!;
    const {
      name,
      rationale: _rationale,
      basedOnToolCallIds: _basis,
      checkpoint: _checkpoint,
      ...args
    } = action;
    if (!isDeepStrictEqual(entry.arguments, { name, ...args }))
      throw new Error("Prepared tool arguments do not match its action");
    const remaining =
      context.config.limits.totalToolResponseBytes -
      state.usage.toolResponseBytes;
    const allowance = Math.min(
      context.config.limits.toolResponseBytes,
      remaining,
    );
    const envelopeBytes = serializedBytes({ toolCallId, result: null }) - 4;
    const update: Partial<InvestigationState> = {
      action: null,
      pendingAttempt: null,
      usage,
    };
    const stopped = this.interruption(state, context);
    if (stopped) {
      entry.outcome = "stopped";
      return {
        ...update,
        termination: stopped,
        ...this.closeAttempt(state, entry, begin, context),
      };
    }
    let invoked = false;
    try {
      const received = await context.execution.bounded((signal) => {
        if (this.interruption(state, context))
          throw new Error("Execution interrupted before inspection invocation");
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
        const response = inspectionResultSchema.parse(received);
        if (
          response.kind !== "error" &&
          (response.snapshotId !== context.snapshot.snapshotId ||
            response.kind !== name)
        )
          throw new SnapshotChangedError();
        const bytes = serializedBytes({ toolCallId, result: response });
        if (bytes > allowance) throw new OutputBudgetError();
        usage.toolResponseBytes += bytes;
        entry.result = response;
        entry.outcome = response.kind === "error" ? "error" : "ok";
      }
    } catch (error) {
      const interrupted = this.interruption(state, context);
      entry.outcome = interrupted && !invoked ? "stopped" : "error";
      update.termination =
        interrupted ??
        (error instanceof OutputBudgetError
          ? {
              reason: "budget_exhausted",
              limit:
                remaining < context.config.limits.toolResponseBytes
                  ? "totalToolResponseBytes"
                  : "toolResponseBytes",
            }
          : {
              reason:
                error instanceof SnapshotChangedError
                  ? "snapshot_changed"
                  : "execution_error",
            });
    }
    return { ...update, ...this.closeAttempt(state, entry, begin, context) };
  }

  private assertIdle(state: InvestigationState): void {
    if (state.pendingAttempt) throw new Error("An attempt is already pending");
  }

  private attempt(
    state: InvestigationState,
    type: InvestigationTraceEvent["type"],
  ) {
    const pending = state.pendingAttempt;
    const entry = state.trace.at(-1);
    if (
      !pending ||
      !entry ||
      entry.id !== pending.eventId ||
      entry.type !== type ||
      entry.outcome !== "pending" ||
      (type === "tool" && !entry.toolCallId)
    )
      throw new Error("No matching prepared attempt");
    return { entry: structuredClone(entry), begin: pending.startedElapsedMs };
  }

  private closeAttempt(
    state: InvestigationState,
    entry: InvestigationTraceEvent,
    begin: number,
    context: InvestigationContext,
  ): Partial<InvestigationState> {
    entry.durationMs = context.execution.elapsedMs - begin;
    return {
      pendingAttempt: null,
      trace: [...state.trace.slice(0, -1), entry],
    };
  }

  private interruption(
    state: InvestigationState,
    context: InvestigationContext,
  ): Termination | null {
    if (state.termination) return state.termination;
    if (state.snapshotId !== context.snapshot.snapshotId)
      return { reason: "snapshot_changed" };
    return context.execution.interruption();
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
      outcome: "pending",
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
