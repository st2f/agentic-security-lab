import { z } from "zod";
import {
  actionSchema,
  actionSchemas,
  candidateSchema,
  configSchema,
  inspectionResultSchema,
  limitsSchema,
} from "./contracts.ts";
import type {
  Action,
  Candidate,
  ConversationContinuation,
  InspectionResult,
  JsonObject,
  RunResult,
  Termination,
  TraceEvent,
} from "./contracts.ts";

export type ExplorationTraceEvent = Omit<TraceEvent, "arguments" | "result"> & {
  arguments?: JsonObject;
  result?: InspectionResult;
};

/** Invocation-local investigation progress; execution resources live in context. */
export type ExplorationState = {
  runId: string;
  snapshotId: string;
  /** Chosen by `choose_action`, consumed by `execute_action`. */
  action: Action | null;
  provisionalCandidates: Candidate[];
  finalCandidates: Candidate[] | null;
  termination: Termination | null;
  scopeAndLimitations: string[];
  usage: Omit<RunResult["usage"], "elapsedMs">;
  trace: ExplorationTraceEvent[];
  conversation: ConversationContinuation;
};

/** Committed recovery/output view; never used to resume graph execution. */
export type ExplorationProgress = Pick<
  ExplorationState,
  | "runId"
  | "snapshotId"
  | "provisionalCandidates"
  | "finalCandidates"
  | "termination"
  | "scopeAndLimitations"
  | "usage"
  | "trace"
>;

const text = z.string().min(1).max(2000);
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inspectionArgumentsSchema: z.ZodType<JsonObject> = z.discriminatedUnion(
  "name",
  [
    actionSchemas.list_files
      .omit({ rationale: true, basedOnToolCallIds: true, checkpoint: true })
      .extend({ name: z.literal("list_files") }),
    actionSchemas.search_text
      .omit({ rationale: true, basedOnToolCallIds: true, checkpoint: true })
      .extend({ name: z.literal("search_text") }),
    actionSchemas.read_lines
      .omit({ rationale: true, basedOnToolCallIds: true, checkpoint: true })
      .extend({ name: z.literal("read_lines") }),
  ],
);
/** Explicit validation schema; graph channels alone do not replace policy checks. */
export const explorationProgressSchema = z.strictObject({
  runId: text,
  snapshotId: hash,
  provisionalCandidates: z.array(candidateSchema).max(20),
  finalCandidates: z.array(candidateSchema).max(10).nullable(),
  termination: z
    .strictObject({
      reason: z.enum([
        "model_finished",
        "budget_exhausted",
        "cancelled",
        "model_error",
        "invalid_model_output",
        "execution_error",
      ]),
      limit: limitsSchema.keyof().optional(),
      detail: text.optional(),
    })
    .nullable(),
  scopeAndLimitations: z.array(text),
  usage: z.strictObject({
    modelCalls: count,
    toolCalls: count,
    toolResponseBytes: count,
    inputTokens: count,
    outputTokens: count,
    tokenUsageComplete: z.boolean(),
  }),
  trace: z
    .array(
      z.strictObject({
        id: text,
        type: z.enum(["model", "tool"]),
        startedAt: z.iso.datetime({ offset: true }),
        durationMs: z.number().nonnegative(),
        outcome: z.enum(["ok", "error", "stopped"]),
        action: actionSchema.optional(),
        arguments: inspectionArgumentsSchema.optional(),
        result: inspectionResultSchema.optional(),
        toolCallId: text.optional(),
        actualModel: text.optional(),
      }),
    )
    .max(2200),
}) satisfies z.ZodType<ExplorationProgress>;

/** Allowlisted, detached view for recovery observers and output. */
export function projectExplorationProgress(
  state: ExplorationProgress,
): ExplorationProgress {
  // Validation must not reorder recorded arguments when reports serialize them.
  return structuredClone({
    runId: state.runId,
    snapshotId: state.snapshotId,
    provisionalCandidates: state.provisionalCandidates,
    finalCandidates: state.finalCandidates,
    termination: state.termination,
    scopeAndLimitations: state.scopeAndLimitations,
    usage: state.usage,
    trace: state.trace,
  });
}

export function initialExplorationState(identity: {
  runId: string;
  snapshotId: string;
}): ExplorationState {
  return {
    runId: identity.runId,
    snapshotId: identity.snapshotId,
    action: null,
    provisionalCandidates: [],
    finalCandidates: null,
    termination: null,
    scopeAndLimitations: [
      "Read-only source inspection; runtime verification was not performed.",
      "No credible candidates does not establish that the repository is secure.",
    ],
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      toolResponseBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokenUsageComplete: true,
    },
    trace: [],
    conversation: { history: [], pendingCallId: null },
  };
}

/** Call only after policy has validated a model's provisional replacement. */
export function candidateCheckpointUpdate(
  checkpoint: Candidate[] | null,
): Partial<Pick<ExplorationState, "provisionalCandidates">> {
  return checkpoint === null
    ? {}
    : { provisionalCandidates: structuredClone(checkpoint) };
}

function returnedObservation(event: ExplorationTraceEvent, snapshotId: string) {
  if (event.type !== "tool" || !event.toolCallId || !event.result) return null;
  const result = event.result;
  if (
    result.kind === "error"
      ? event.outcome !== "error"
      : event.outcome !== "ok" || result.snapshotId !== snapshotId
  )
    return null;
  return { toolCallId: event.toolCallId, result };
}

/** No independent mutable copy of the latest tool observation is retained. */
export function latestObservation(
  state: Pick<ExplorationState, "snapshotId" | "trace">,
): { toolCallId: string; result: InspectionResult } | null {
  for (let index = state.trace.length - 1; index >= 0; index--) {
    const observation = returnedObservation(
      state.trace[index]!,
      state.snapshotId,
    );
    if (observation) return structuredClone(observation);
  }
  return null;
}

/** Derived visibility includes listings/errors as known calls with no code lines. */
export function returnedEvidence(
  state: Pick<ExplorationState, "snapshotId" | "trace">,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>>> {
  const calls = new Map<string, Map<string, Set<number>>>();
  for (const event of state.trace) {
    const observation = returnedObservation(event, state.snapshotId);
    if (!observation) continue;
    const files = new Map<string, Set<number>>();
    const result = observation.result;
    if (result.kind === "read_lines")
      files.set(result.path, new Set(result.lines.map((line) => line.line)));
    if (result.kind === "search_text") {
      for (const match of result.matches) {
        const lines = files.get(match.path) ?? new Set<number>();
        lines.add(match.line);
        files.set(match.path, lines);
      }
    }
    calls.set(observation.toolCallId, files);
  }
  return calls;
}

/** Project trusted state into the existing artifact contract, detached from inputs. */
export function projectRunResult(
  committed: ExplorationProgress,
  metadata: Pick<RunResult, "request" | "exclusions">,
  elapsedMs: number,
): RunResult {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new Error("Elapsed time must be finite and nonnegative");
  const state = projectExplorationProgress(committed);
  // One strict check at the output boundary, before anything is saved.
  explorationProgressSchema.parse(state);
  const completed = state.termination?.reason === "model_finished";
  if (completed !== (state.finalCandidates !== null))
    throw new Error(
      "Accepted final candidates and termination are inconsistent",
    );
  return structuredClone({
    runId: state.runId,
    snapshotId: state.snapshotId,
    request: {
      question: metadata.request.question,
      maxCandidates: metadata.request.maxCandidates,
      limits: configSchema.shape.limits.parse(metadata.request.limits),
      model: metadata.request.model,
      reasoning: metadata.request.reasoning,
      provider: metadata.request.provider,
      commit: metadata.request.commit,
      subtree: metadata.request.subtree,
    },
    completion: completed ? "completed" : "incomplete",
    termination: state.termination ?? { reason: "execution_error" },
    finalCandidates: completed ? state.finalCandidates : null,
    provisionalCandidates: completed ? [] : state.provisionalCandidates,
    scopeAndLimitations: state.scopeAndLimitations,
    exclusions: metadata.exclusions.map(({ path, reason }) => ({
      path,
      reason,
    })),
    trace: state.trace,
    usage: { ...state.usage, elapsedMs },
  });
}
