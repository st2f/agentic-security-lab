import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  actionSchema,
  candidateSchema,
  configSchema,
  limitsSchema,
  inspectionLineSchema as lineSchema,
  inspectionResultSchema as resultSchema,
} from "../investigation/contracts.ts";
import type { Action, RunResult } from "../investigation/contracts.ts";
import {
  candidateReferences,
  evidenceKey,
  hasEvidenceLines,
  isValidEvidenceRange,
} from "../investigation/evidence.ts";
import {
  RepositoryInspector,
  serializedBytes,
  SnapshotChangedError,
} from "../infrastructure/repository/RepositoryInspector.ts";
import {
  digest,
  excludedPath,
  validRelativePath,
} from "../infrastructure/repository/snapshot.ts";
import type { Snapshot } from "../infrastructure/repository/snapshot.ts";

const text = z.string().min(1).max(2000);
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const skipped = z.array(z.strictObject({ path: z.string(), reason: text }));
const savedRunSchema: z.ZodType<RunResult> = z.strictObject({
  runId: text,
  snapshotId: hash,
  request: z.strictObject({
    question: configSchema.shape.question,
    maxCandidates: configSchema.shape.maxCandidates.removeDefault(),
    limits: limitsSchema,
    model: configSchema.shape.model.removeDefault(),
    reasoning: configSchema.shape.reasoning.removeDefault(),
    provider: z.literal("openai"),
    commit,
    subtree: z.string(),
  }),
  completion: z.enum(["completed", "incomplete"]),
  termination: z.strictObject({
    reason: z.enum([
      "model_finished",
      "budget_exhausted",
      "cancelled",
      "model_error",
      "invalid_model_output",
      "snapshot_changed",
      "execution_error",
    ]),
    limit: limitsSchema.keyof().optional(),
    detail: text.optional(),
  }),
  finalCandidates: z.array(candidateSchema).max(10).nullable(),
  provisionalCandidates: z.array(candidateSchema).max(20),
  scopeAndLimitations: z.array(text),
  exclusions: skipped,
  trace: z
    .array(
      z.strictObject({
        id: text,
        type: z.enum(["model", "tool"]),
        startedAt: z.iso.datetime({ offset: true }),
        durationMs: z.number().nonnegative(),
        outcome: z.enum(["pending", "ok", "error", "stopped"]),
        action: actionSchema.optional(),
        arguments: z.unknown().optional(),
        result: z.unknown().optional(),
        toolCallId: text.optional(),
        actualModel: text.optional(),
      }),
    )
    .max(2200),
  usage: z.strictObject({
    modelCalls: count,
    toolCalls: count,
    toolResponseBytes: count,
    elapsedMs: z.number().nonnegative(),
    inputTokens: count,
    outputTokens: count,
    tokenUsageComplete: z.boolean(),
  }),
});
const manifestSchema = z.strictObject({
  snapshotId: hash,
  commit,
  subtree: z.string(),
  policy: z.record(z.string(), z.unknown()),
  files: z
    .array(z.strictObject({ path: text, sha256: hash }))
    .min(1)
    .max(10_000),
  skipped,
});

export class ReportValidationError extends Error {}
function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReportValidationError(message);
}
export type SourceLine = z.infer<typeof lineSchema>;
export type CheckedEvidence = { lines: SourceLine[]; verified: boolean };
export type ValidatedReport = {
  run: RunResult;
  snapshot: Snapshot;
  evidence: Map<string, CheckedEvidence>;
  warnings: string[];
};

export class ReportValidator {
  /** Validate saved data without trusting its TypeScript type or re-running the model. */
  async validate(
    rawRun: unknown,
    rawManifest: unknown,
    sourceRoot: string,
  ): Promise<ValidatedReport> {
    const parsedRun = savedRunSchema.safeParse(rawRun);
    const parsedManifest = manifestSchema.safeParse(rawManifest);
    requireValid(
      parsedRun.success && parsedManifest.success,
      "Saved run or manifest has an invalid structure",
    );
    const run = parsedRun.data;
    const manifest = parsedManifest.data;
    const paths = manifest.files.map((file) => file.path);
    requireValid(
      paths.every((file) => validRelativePath(file) && !excludedPath(file)) &&
        new Set(paths).size === paths.length &&
        isDeepStrictEqual(paths, [...paths].sort()),
      "Manifest paths are invalid, excluded, duplicated, or unsorted",
    );
    requireValid(
      digest(JSON.stringify(manifest.files)) === manifest.snapshotId &&
        manifest.snapshotId === run.snapshotId &&
        manifest.commit === run.request.commit &&
        manifest.subtree === run.request.subtree &&
        isDeepStrictEqual(manifest.skipped, run.exclusions),
      "Snapshot identity or provenance does not match the saved run",
    );
    requireValid(
      run.completion === "completed"
        ? run.termination.reason === "model_finished" &&
            run.finalCandidates !== null &&
            run.finalCandidates.length <= run.request.maxCandidates &&
            run.provisionalCandidates.length === 0
        : run.termination.reason !== "model_finished" &&
            run.finalCandidates === null,
      "Run completion and candidate state are inconsistent",
    );
    const candidates = run.finalCandidates ?? run.provisionalCandidates;
    requireValid(
      new Set(candidates.map((candidate) => candidate.id)).size ===
        candidates.length,
      "Candidate IDs are duplicated",
    );
    const snapshot: Snapshot = { root: sourceRoot, ...manifest };
    const observations = new Map<string, Map<string, Map<number, string>>>();
    const ids = new Set<string>();
    let modelCalls = 0;
    let toolCalls = 0;
    let responseBytes = 0;
    let pendingAction: Action | null = null;
    for (const event of run.trace) {
      requireValid(!ids.has(event.id), "Trace event IDs are duplicated");
      ids.add(event.id);
      if (event.type === "model") {
        modelCalls++;
        requireValid(
          !event.action ||
            event.action.basedOnToolCallIds.every((id) => observations.has(id)),
          "A model action refers to a future or unknown tool call",
        );
        pendingAction = event.outcome === "ok" ? (event.action ?? null) : null;
        continue;
      }
      toolCalls++;
      requireValid(
        event.toolCallId && !observations.has(event.toolCallId),
        "Tool call IDs are missing or duplicated",
      );
      requireValid(
        pendingAction && pendingAction.name !== "finish",
        "Tool invocation has no preceding inspection action",
      );
      const {
        name,
        rationale: _rationale,
        basedOnToolCallIds: _basis,
        checkpoint: _checkpoint,
        ...args
      } = pendingAction;
      requireValid(
        isDeepStrictEqual(event.arguments, { name, ...args }),
        "Tool arguments do not match the model's requested action",
      );
      pendingAction = null;
      const files = new Map<string, Map<number, string>>();
      observations.set(event.toolCallId, files);
      if (event.result === undefined) {
        requireValid(
          event.outcome !== "ok",
          "Successful tool event has no recorded result",
        );
        continue;
      }
      const parsed = resultSchema.safeParse(event.result);
      requireValid(parsed.success, "Tool result has an invalid structure");
      const response = parsed.data;
      requireValid(
        response.kind === "error" || response.kind === name,
        "Tool result kind does not match its invocation",
      );
      const bytes = serializedBytes({
        toolCallId: event.toolCallId,
        result: event.result,
      });
      requireValid(
        bytes <= run.request.limits.toolResponseBytes,
        "Recorded tool response exceeds its byte limit",
      );
      responseBytes += bytes;
      if (response.kind === "error") {
        requireValid(
          event.outcome === "error",
          "Tool error is labelled as successful",
        );
        continue;
      }
      requireValid(
        event.outcome === "ok" && response.snapshotId === run.snapshotId,
        "Tool outcome or snapshot identity is inconsistent",
      );
      if (response.kind === "list_files") {
        requireValid(
          response.files.every((file) => paths.includes(file)),
          "Listing contains a path outside the manifest",
        );
        continue;
      }
      const returned =
        response.kind === "read_lines"
          ? response.lines.map((line) => ({ path: response.path, ...line }))
          : response.matches;
      for (const line of returned) {
        requireValid(
          paths.includes(line.path),
          "Source result contains a path outside the manifest",
        );
        const content = files.get(line.path) ?? new Map<number, string>();
        requireValid(!content.has(line.line), "Source result repeats a line");
        content.set(line.line, line.text);
        files.set(line.path, content);
      }
    }
    requireValid(
      modelCalls === run.usage.modelCalls &&
        toolCalls === run.usage.toolCalls &&
        responseBytes === run.usage.toolResponseBytes &&
        modelCalls <= run.request.limits.modelCalls &&
        toolCalls <= run.request.limits.toolCalls &&
        responseBytes <= run.request.limits.totalToolResponseBytes,
      "Trace counts or response-byte accounting do not match recorded usage",
    );
    if (run.completion === "completed") {
      const lastModel = run.trace
        .filter((event) => event.type === "model")
        .at(-1);
      requireValid(
        lastModel?.outcome === "ok" &&
          lastModel.action?.name === "finish" &&
          isDeepStrictEqual(lastModel.action.candidates, run.finalCandidates),
        "Completed candidates do not match the model finish action",
      );
    } else {
      const updates = run.trace.flatMap((event) =>
        event.type === "model" &&
        event.outcome === "ok" &&
        event.action &&
        event.action.name !== "finish" &&
        event.action.checkpoint !== null
          ? [event.action.checkpoint]
          : [],
      );
      requireValid(
        isDeepStrictEqual(updates.at(-1) ?? [], run.provisionalCandidates),
        "Provisional candidates do not match the latest recorded checkpoint",
      );
    }
    const inspector = new RepositoryInspector(snapshot);
    const evidence = new Map<string, CheckedEvidence>();
    const warnings: string[] = [];
    for (const reference of candidateReferences(candidates)) {
      const key = evidenceKey(reference);
      if (evidence.has(key)) continue;
      const observed = observations
        .get(reference.toolCallId)
        ?.get(reference.path);
      requireValid(
        observed && isValidEvidenceRange(reference, run.snapshotId),
        "Candidate evidence does not identify a valid returned source range",
      );
      requireValid(
        hasEvidenceLines(reference, observed),
        "Candidate cites lines that were not returned by its tool call",
      );
      const recorded: SourceLine[] = [];
      for (let line = reference.startLine; line <= reference.endLine; line++) {
        recorded.push({ line, text: observed.get(line)! });
      }
      try {
        const current = await inspector.execute("read_lines", {
          path: reference.path,
          startLine: reference.startLine,
          endLine: reference.endLine,
        });
        requireValid(
          current.kind === "read_lines" &&
            !current.truncated &&
            isDeepStrictEqual(current.lines, recorded),
          "Saved evidence text does not match the snapshot",
        );
        evidence.set(key, { lines: recorded, verified: true });
      } catch (error) {
        if (
          run.completion !== "incomplete" ||
          !(error instanceof SnapshotChangedError)
        ) {
          if (error instanceof ReportValidationError) throw error;
          throw new ReportValidationError(
            "Cited snapshot evidence could not be revalidated; no completed report was produced",
          );
        }
        evidence.set(key, { lines: recorded, verified: false });
        warnings.push(
          `Provisional evidence for ${reference.path}:${reference.startLine}–${reference.endLine} is historical only: the snapshot file is changed or unavailable.`,
        );
      }
    }
    return { run, snapshot, evidence, warnings };
  }
}
