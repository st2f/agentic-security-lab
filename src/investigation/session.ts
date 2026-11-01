import { randomUUID } from "node:crypto";
import { actionSchema, configSchema, ModelRequestError } from "./contract.ts";
import type {
  Action,
  Candidate,
  ModelInput,
  RequestAction,
  RunResult,
  Termination,
  TraceEvent,
} from "./contract.ts";
import type { Snapshot } from "../repository/snapshot.ts";
import {
  createRepositoryInspector,
  OutputBudgetError,
  serializedBytes,
  SnapshotChangedError,
} from "../repository/inspection.ts";

class InvalidOutput extends Error {}

/** Application policy; no graph or provider SDK dependencies. One session per run. */
export function createInvestigationSession(
  snapshot: Snapshot,
  configuration: unknown,
  model: RequestAction,
  externalSignal?: AbortSignal,
) {
  const config = configSchema.parse(configuration);
  const inspector = createRepositoryInspector(
    snapshot,
    config.limits.toolResponseBytes,
  );
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("deadline"),
    config.limits.elapsedMs,
  );
  const cancel = () => controller.abort("cancelled");
  externalSignal?.addEventListener("abort", cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  let observation: ModelInput["observation"] = null;
  let checkpoint: Candidate[] = [];
  let termination: Termination | null = null;
  const returned = new Map<string, Map<string, Set<number>>>();
  const result: RunResult = {
    runId: randomUUID(),
    snapshotId: snapshot.snapshotId,
    request: {
      ...config,
      provider: "openai",
      commit: snapshot.commit,
      subtree: snapshot.subtree,
    },
    completion: "incomplete",
    termination: { reason: "execution_error" },
    finalCandidates: null,
    provisionalCandidates: [],
    scopeAndLimitations: [
      "Read-only source inspection; runtime verification was not performed.",
      "No credible candidates does not establish that the repository is secure.",
    ],
    exclusions: snapshot.skipped,
    trace: [],
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      toolResponseBytes: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokenUsageComplete: true,
    },
  };

  function stop(reason: Termination) {
    termination ??= reason;
  }
  function checkTime() {
    if (externalSignal?.aborted) stop({ reason: "cancelled" });
    else if (
      controller.signal.aborted ||
      performance.now() - started >= config.limits.elapsedMs
    ) {
      controller.abort("deadline");
      stop({ reason: "budget_exhausted", limit: "elapsedMs" });
    }
    return termination === null;
  }
  async function bounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    controller.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then(resolve, reject)
        .finally(() => {
          controller.signal.removeEventListener("abort", aborted);
        });
    });
  }
  function event(type: TraceEvent["type"]): TraceEvent {
    const entry: TraceEvent = {
      id: `event-${result.trace.length + 1}`,
      type,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      outcome: "pending",
    };
    result.trace.push(entry);
    return entry;
  }
  function validateCandidates(candidates: Candidate[]) {
    if (new Set(candidates.map((item) => item.id)).size !== candidates.length)
      throw new InvalidOutput();
    for (const candidate of candidates) {
      const evidence = [
        ...candidate.supportingEvidence,
        ...candidate.contradictoryEvidence.map((item) => item.reference),
      ];
      for (const reference of evidence) {
        const exposed = returned.get(reference.toolCallId)?.get(reference.path);
        if (
          reference.snapshotId !== snapshot.snapshotId ||
          !exposed ||
          reference.endLine < reference.startLine ||
          reference.endLine - reference.startLine >= 200
        )
          throw new InvalidOutput();
        for (
          let line = reference.startLine;
          line <= reference.endLine;
          line++
        ) {
          if (!exposed.has(line)) throw new InvalidOutput();
        }
      }
    }
  }
  async function recheckEvidence(candidates: Candidate[]) {
    const references = candidates.flatMap((candidate) => [
      ...candidate.supportingEvidence,
      ...candidate.contradictoryEvidence.map((item) => item.reference),
    ]);
    for (const reference of references) {
      await inspector.execute(
        "read_lines",
        {
          path: reference.path,
          startLine: reference.startLine,
          endLine: reference.endLine,
        },
        16_384,
        controller.signal,
      );
    }
  }
  function recordReturned(
    id: string,
    response: Awaited<ReturnType<typeof inspector.execute>>,
  ) {
    const files = new Map<string, Set<number>>();
    if (response.kind === "read_lines")
      files.set(
        response.path,
        new Set(response.lines.map((line) => line.line)),
      );
    if (response.kind === "search_text") {
      for (const match of response.matches) {
        const set = files.get(match.path) ?? new Set<number>();
        set.add(match.line);
        files.set(match.path, set);
      }
    }
    returned.set(id, files);
  }

  async function ask(): Promise<Action | null> {
    if (!checkTime()) return null;
    if (result.usage.modelCalls >= config.limits.modelCalls) {
      stop({ reason: "budget_exhausted", limit: "modelCalls" });
      return null;
    }
    const entry = event("model");
    const begin = performance.now();
    result.usage.modelCalls++;
    let receivedUsage = false;
    try {
      const reply = await bounded((signal) =>
        model({ snapshotId: snapshot.snapshotId, config, observation }, signal),
      );
      if (
        reply.usage &&
        Number.isSafeInteger(reply.usage.inputTokens) &&
        reply.usage.inputTokens >= 0 &&
        Number.isSafeInteger(reply.usage.outputTokens) &&
        reply.usage.outputTokens >= 0
      ) {
        result.usage.inputTokens += reply.usage.inputTokens;
        result.usage.outputTokens += reply.usage.outputTokens;
        receivedUsage = true;
      }
      entry.actualModel = reply.actualModel;
      if (!checkTime()) {
        entry.outcome = "stopped";
        return null;
      }
      const parsed = actionSchema.safeParse(reply.action);
      if (!parsed.success) throw new InvalidOutput();
      const action = parsed.data;
      if (action.basedOnToolCallIds.some((id) => !returned.has(id)))
        throw new InvalidOutput();
      entry.action = action;
      if (action.name !== "finish" && action.checkpoint !== null) {
        validateCandidates(action.checkpoint);
        checkpoint = action.checkpoint;
      }
      entry.outcome = "ok";
      return action;
    } catch (error) {
      entry.outcome = "error";
      if (checkTime())
        stop({
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
        });
      return null;
    } finally {
      if (!receivedUsage) result.usage.tokenUsageComplete = false;
      entry.durationMs = performance.now() - begin;
    }
  }

  async function act(action: Action | null) {
    if (!action || !checkTime()) return;
    if (action.name === "finish") {
      try {
        if (action.candidates.length > config.maxCandidates)
          throw new InvalidOutput();
        validateCandidates(action.candidates);
        await bounded(() => recheckEvidence(action.candidates));
        if (!checkTime()) return;
        result.finalCandidates = action.candidates;
        result.scopeAndLimitations.push(...action.scopeAndLimitations);
        result.completion = "completed";
        stop({ reason: "model_finished" });
      } catch (error) {
        if (checkTime())
          stop({
            reason:
              error instanceof SnapshotChangedError
                ? "snapshot_changed"
                : error instanceof InvalidOutput
                  ? "invalid_model_output"
                  : "execution_error",
            detail:
              "Final candidates failed count, evidence, or snapshot validation",
          });
      }
      return;
    }
    if (result.usage.toolCalls >= config.limits.toolCalls) {
      stop({ reason: "budget_exhausted", limit: "toolCalls" });
      return;
    }
    const entry = event("tool");
    const begin = performance.now();
    const toolCallId = `tool-${++result.usage.toolCalls}`;
    const {
      name,
      rationale: _rationale,
      basedOnToolCallIds: _basis,
      checkpoint: _checkpoint,
      ...args
    } = action;
    entry.toolCallId = toolCallId;
    entry.arguments = { name, ...args };
    const remaining =
      config.limits.totalToolResponseBytes - result.usage.toolResponseBytes;
    const allowance = Math.min(config.limits.toolResponseBytes, remaining);
    const envelopeBytes = serializedBytes({ toolCallId, result: null }) - 4;
    try {
      const response = await bounded((signal) =>
        inspector.execute(name, args, allowance - envelopeBytes, signal),
      );
      if (!checkTime()) {
        entry.outcome = "stopped";
        return;
      }
      observation = { toolCallId, result: response };
      result.usage.toolResponseBytes += serializedBytes(observation);
      entry.result = response;
      entry.outcome = response.kind === "error" ? "error" : "ok";
      recordReturned(toolCallId, response);
    } catch (error) {
      entry.outcome = "error";
      if (checkTime())
        stop(
          error instanceof OutputBudgetError
            ? {
                reason: "budget_exhausted",
                limit:
                  remaining < config.limits.toolResponseBytes
                    ? "totalToolResponseBytes"
                    : "toolResponseBytes",
              }
            : {
                reason:
                  error instanceof SnapshotChangedError
                    ? "snapshot_changed"
                    : "execution_error",
              },
        );
    } finally {
      entry.durationMs = performance.now() - begin;
    }
  }

  return {
    result,
    ask,
    act,
    stopped: () => termination !== null,
    fail: () => {
      stop({ reason: "execution_error" });
    },
    close() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
      result.termination = termination ?? { reason: "execution_error" };
      result.provisionalCandidates =
        result.completion === "incomplete" ? checkpoint : [];
      result.usage.elapsedMs = performance.now() - started;
      return result;
    },
  };
}
