import { z } from "zod";

const text = z.string().min(1).max(2000);
const strings = z.array(text).max(30);
export const evidenceSchema = z.strictObject({
  snapshotId: text,
  path: text,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  toolCallId: text,
});
export const candidateSchema = z.strictObject({
  id: text,
  claim: text,
  rationale: text,
  supportingEvidence: z.array(evidenceSchema).min(1).max(20),
  contradictoryEvidence: z
    .array(z.strictObject({ reference: evidenceSchema, explanation: text }))
    .max(20),
  uncertainties: strings,
  priorityReason: text,
  nextChecks: strings,
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type Candidate = z.infer<typeof candidateSchema>;

export const inspectionLineSchema = z.strictObject({
  line: z.number().int().positive(),
  text: z.string().refine((value) => !value.includes("\n")),
});
export const inspectionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("read_lines"),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    path: text,
    lines: z.array(inspectionLineSchema).max(200),
    truncated: z.boolean(),
    nextStartLine: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal("search_text"),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    matches: z.array(inspectionLineSchema.extend({ path: text })).max(100),
    truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal("list_files"),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(text).max(100),
    truncated: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.literal("invalid_request"),
    message: text,
  }),
]);

export type InspectionLine = z.infer<typeof inspectionLineSchema>;
export type InspectionResult = z.infer<typeof inspectionResultSchema>;

const meta = {
  rationale: text,
  basedOnToolCallIds: z.array(text).max(40),
  checkpoint: z.array(candidateSchema).max(20).nullable(),
};
export const actionSchemas = {
  list_files: z.strictObject({
    ...meta,
    directory: z.string(),
    offset: z.number().int(),
    limit: z.number().int(),
  }),
  search_text: z.strictObject({
    ...meta,
    directory: z.string(),
    query: z.string(),
    offset: z.number().int(),
    limit: z.number().int(),
  }),
  read_lines: z.strictObject({
    ...meta,
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
  }),
  finish: z.strictObject({
    rationale: text,
    basedOnToolCallIds: z.array(text).max(40),
    candidates: z.array(candidateSchema).max(10),
    scopeAndLimitations: strings,
  }),
};
export const actionSchema = z.discriminatedUnion("name", [
  actionSchemas.list_files.extend({ name: z.literal("list_files") }),
  actionSchemas.search_text.extend({ name: z.literal("search_text") }),
  actionSchemas.read_lines.extend({ name: z.literal("read_lines") }),
  actionSchemas.finish.extend({ name: z.literal("finish") }),
]);
export type Action = z.infer<typeof actionSchema>;

// The model chooses evidence; the application owns the snapshot identity.
const modelEvidenceSchema = evidenceSchema.omit({ snapshotId: true });
const modelCandidateSchema = candidateSchema.extend({
  supportingEvidence: z.array(modelEvidenceSchema).min(1).max(20),
  contradictoryEvidence: z
    .array(
      z.strictObject({ reference: modelEvidenceSchema, explanation: text }),
    )
    .max(20),
});
const modelCheckpoint = z.array(modelCandidateSchema).max(20).nullable();
export const modelActionSchemas = {
  list_files: actionSchemas.list_files.extend({ checkpoint: modelCheckpoint }),
  search_text: actionSchemas.search_text.extend({
    checkpoint: modelCheckpoint,
  }),
  read_lines: actionSchemas.read_lines.extend({ checkpoint: modelCheckpoint }),
  finish: actionSchemas.finish.extend({
    candidates: z.array(modelCandidateSchema).max(10),
  }),
};
const modelActionSchema = z.discriminatedUnion("name", [
  modelActionSchemas.list_files.extend({ name: z.literal("list_files") }),
  modelActionSchemas.search_text.extend({ name: z.literal("search_text") }),
  modelActionSchemas.read_lines.extend({ name: z.literal("read_lines") }),
  modelActionSchemas.finish.extend({ name: z.literal("finish") }),
]);

export function bindModelAction(
  raw: unknown,
  snapshotId: string,
): Action | null {
  const parsed = modelActionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const bind = (
    candidate: z.infer<typeof modelCandidateSchema>,
  ): Candidate => ({
    ...candidate,
    supportingEvidence: candidate.supportingEvidence.map((reference) => ({
      ...reference,
      snapshotId,
    })),
    contradictoryEvidence: candidate.contradictoryEvidence.map((entry) => ({
      ...entry,
      reference: { ...entry.reference, snapshotId },
    })),
  });
  const action = parsed.data;
  return actionSchema.parse(
    action.name === "finish"
      ? { ...action, candidates: action.candidates.map(bind) }
      : { ...action, checkpoint: action.checkpoint?.map(bind) ?? null },
  );
}

export const limitsSchema = z.strictObject({
  modelCalls: z.number().int().min(1).max(100),
  toolCalls: z.number().int().min(1).max(1000),
  elapsedMs: z.number().int().min(1).max(3_600_000),
  toolResponseBytes: z.number().int().min(512).max(16_384),
  totalToolResponseBytes: z.number().int().min(512).max(10_485_760),
});
export const defaultLimits: z.infer<typeof limitsSchema> = {
  modelCalls: 12,
  toolCalls: 40,
  elapsedMs: 180_000,
  toolResponseBytes: 16_384,
  totalToolResponseBytes: 262_144,
};
export const configSchema = z.strictObject({
  question: text.optional(),
  maxCandidates: z.number().int().min(1).max(10).default(3),
  limits: limitsSchema.default(defaultLimits),
  model: z.string().min(1).max(100).default("gpt-6-luna"),
  reasoning: z
    .enum(["none", "low", "medium", "high", "xhigh", "max"])
    .default("medium"),
});
export type RunConfig = z.infer<typeof configSchema>;
export type Termination = {
  reason:
    | "model_finished"
    | "budget_exhausted"
    | "cancelled"
    | "model_error"
    | "invalid_model_output"
    | "snapshot_changed"
    | "execution_error";
  limit?: keyof RunConfig["limits"];
  detail?: string;
};
export type TraceEvent = {
  id: string;
  type: "model" | "tool";
  startedAt: string;
  durationMs: number;
  outcome: "pending" | "ok" | "error" | "stopped";
  action?: Action;
  arguments?: unknown;
  result?: unknown;
  toolCallId?: string;
  actualModel?: string;
};
export type RunResult = {
  runId: string;
  snapshotId: string;
  request: RunConfig & { provider: "openai"; commit: string; subtree: string };
  completion: "completed" | "incomplete";
  termination: Termination;
  finalCandidates: Candidate[] | null;
  provisionalCandidates: Candidate[];
  scopeAndLimitations: string[];
  exclusions: readonly { path: string; reason: string }[];
  trace: TraceEvent[];
  usage: {
    modelCalls: number;
    toolCalls: number;
    toolResponseBytes: number;
    elapsedMs: number;
    inputTokens: number;
    outputTokens: number;
    tokenUsageComplete: boolean;
  };
};

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Provider wire data only: no SDK objects, credentials, or execution resources. */
export const conversationContinuationSchema = z.strictObject({
  history: z.array(z.record(z.string(), z.json())),
  pendingCallId: text.nullable(),
});
export type ConversationContinuation = z.infer<
  typeof conversationContinuationSchema
>;

// A narrow call boundary for deterministic testing, not a provider routing system.
export type ModelInput = {
  snapshotId: string;
  config: RunConfig;
  observation: { toolCallId: string; result: unknown } | null;
  conversation: ConversationContinuation;
};
export type ModelReply = {
  action: unknown;
  conversation: ConversationContinuation;
  actualModel?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export class ModelRequestError extends Error {
  constructor(status?: number) {
    super(
      status === undefined
        ? "Model request failed before a response was received"
        : `Model provider returned HTTP ${status}`,
    );
  }
}
