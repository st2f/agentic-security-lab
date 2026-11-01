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

// A narrow call boundary for deterministic testing, not a provider routing system.
export type ModelInput = {
  snapshotId: string;
  config: RunConfig;
  observation: { toolCallId: string; result: unknown } | null;
};
export type ModelReply = {
  action: unknown;
  actualModel?: string;
  usage?: { inputTokens: number; outputTokens: number };
};
export type RequestAction = (
  input: ModelInput,
  signal: AbortSignal,
) => Promise<ModelReply>;

export class ModelRequestError extends Error {
  constructor(status?: number) {
    super(
      status === undefined
        ? "Model request failed before a response was received"
        : `Model provider returned HTTP ${status}`,
    );
  }
}
