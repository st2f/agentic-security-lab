import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { END, START, StateGraph } from "@langchain/langgraph";
import { createExplorationWithModel } from "../src/composition.ts";
import { configSchema } from "../src/investigation/contracts.ts";
import type {
  Action,
  Candidate,
  InspectionResult,
} from "../src/investigation/contracts.ts";
import {
  candidateCheckpointUpdate,
  initialExplorationState,
  latestObservation,
  projectRunResult,
  returnedEvidence,
} from "../src/investigation/state.ts";
import type { ExplorationTraceEvent } from "../src/investigation/state.ts";
import type { ExplorationState } from "../src/investigation/state.ts";
import { hasEvidenceLines } from "../src/investigation/evidence.ts";
import { digest } from "../src/infrastructure/repository/snapshot.ts";
import { ReportValidator } from "../src/reporting/ReportValidator.ts";
import {
  ExplorationGraphState,
  explorationStateSchema,
} from "../src/workflows/exploration-state.ts";

const identity = { runId: "test-run", snapshotId: "a".repeat(64) };
const metadata = {
  request: {
    ...configSchema.parse({}),
    provider: "openai" as const,
    commit: "b".repeat(40),
    subtree: "",
  },
  exclusions: [],
};
const candidate: Candidate = {
  id: "candidate-1",
  claim: "The lookup may lack tenant filtering.",
  rationale: "Only an ID is passed to the lookup.",
  supportingEvidence: [
    {
      snapshotId: identity.snapshotId,
      toolCallId: "tool-1",
      path: "query.ts",
      startLine: 1,
      endLine: 1,
    },
  ],
  contradictoryEvidence: [],
  uncertainties: ["The callee might enforce tenancy."],
  priorityReason: "Possible cross-tenant disclosure.",
  nextChecks: ["Inspect the callee."],
};
const modelEvent: ExplorationTraceEvent = {
  id: "event-1",
  type: "model",
  startedAt: "2026-11-05T10:00:00.000Z",
  durationMs: 0,
  outcome: "error",
};

test("initial state is independently owned and JSON serializable; schema rejects execution resources", () => {
  const first = initialExplorationState(identity);
  const second = initialExplorationState(identity);
  assert.deepEqual(
    explorationStateSchema.parse(first),
    JSON.parse(JSON.stringify(first)),
  );
  first.provisionalCandidates.push(structuredClone(candidate));
  first.usage.modelCalls++;
  first.conversation.history.push({
    type: "reasoning",
    encrypted_content: "opaque",
  });
  assert.deepEqual(second.provisionalCandidates, []);
  assert.equal(second.usage.modelCalls, 0);
  assert.deepEqual(second.conversation.history, []);
  for (const invalid of [
    { ...second, controller: new AbortController() },
    {
      ...second,
      conversation: { history: [{ callback() {} }], pendingCallId: null },
    },
    {
      ...second,
      conversation: { history: [{ lines: new Set([1]) }], pendingCallId: null },
    },
    { ...second, usage: { ...second.usage, inputTokens: Infinity } },
  ])
    assert.equal(explorationStateSchema.safeParse(invalid).success, false);
});

test("graph channels preserve null checkpoints, clear with empty replacements, and replace trace and totals", async () => {
  const state = initialExplorationState(identity);
  state.provisionalCandidates = [structuredClone(candidate)];
  state.trace = [structuredClone(modelEvent)];
  state.usage.modelCalls = 1;
  const graph = new StateGraph(ExplorationGraphState)
    .addNode("keep", () => candidateCheckpointUpdate(null))
    .addNode("clear", (current) => {
      assert.deepEqual(current.provisionalCandidates, [candidate]);
      return candidateCheckpointUpdate([]);
    })
    .addNode("replace", (current) => {
      assert.deepEqual(current.provisionalCandidates, []);
      return {
        ...candidateCheckpointUpdate([candidate]),
        trace: [{ ...modelEvent, outcome: "ok" as const }],
        usage: { ...current.usage, modelCalls: 1 },
      };
    })
    .addEdge(START, "keep")
    .addEdge("keep", "clear")
    .addEdge("clear", "replace")
    .addEdge("replace", END)
    .compile();
  const result = await graph.invoke(state);
  assert.deepEqual(result.provisionalCandidates, [candidate]);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]!.outcome, "ok");
  assert.equal(result.usage.modelCalls, 1);
  assert.deepEqual(state.trace, [modelEvent]);
});

test("observations and exact evidence visibility derive from accepted trace results", () => {
  const state = initialExplorationState(identity);
  function tool(
    id: number,
    result?: InspectionResult,
    outcome: ExplorationTraceEvent["outcome"] = "ok",
  ): ExplorationTraceEvent {
    return {
      ...modelEvent,
      id: `event-${id}`,
      type: "tool",
      toolCallId: `tool-${id}`,
      outcome,
      ...(result ? { result } : {}),
    };
  }
  state.trace = [
    tool(1, {
      kind: "read_lines",
      snapshotId: identity.snapshotId,
      path: "query.ts",
      lines: [
        { line: 1, text: "lookup(id)" },
        { line: 3, text: "return item" },
      ],
      truncated: false,
      nextStartLine: null,
    }),
    tool(2, {
      kind: "search_text",
      snapshotId: identity.snapshotId,
      matches: [{ path: "other.ts", line: 8, text: "tenant" }],
      truncated: false,
      nextOffset: null,
    }),
    tool(3, {
      kind: "list_files",
      snapshotId: identity.snapshotId,
      files: ["unread.ts"],
      truncated: false,
      nextOffset: null,
    }),
    tool(
      4,
      { kind: "error", code: "invalid_request", message: "Denied path" },
      "error",
    ),
    tool(5, undefined, "error"),
    tool(
      6,
      {
        kind: "read_lines",
        snapshotId: identity.snapshotId,
        path: "late.ts",
        lines: [{ line: 1, text: "late" }],
        truncated: false,
        nextStartLine: null,
      },
      "stopped",
    ),
    tool(7, {
      kind: "list_files",
      snapshotId: "c".repeat(64),
      files: ["outside.ts"],
      truncated: false,
      nextOffset: null,
    }),
  ];
  const observed = latestObservation(state);
  assert.deepEqual(observed, {
    toolCallId: "tool-4",
    result: state.trace[3]!.result,
  });
  const evidence = returnedEvidence(state);
  assert.deepEqual(
    [...evidence.keys()],
    ["tool-1", "tool-2", "tool-3", "tool-4"],
  );
  assert.deepEqual([...evidence.get("tool-1")!.get("query.ts")!], [1, 3]);
  assert.equal(
    hasEvidenceLines(
      { ...candidate.supportingEvidence[0]!, endLine: 3 },
      evidence.get("tool-1")!.get("query.ts")!,
    ),
    false,
  );
  assert.equal(evidence.get("tool-2")!.get("other.ts")!.has(8), true);
  assert.equal(evidence.get("tool-3")!.size, 0);
  assert.equal(evidence.get("tool-4")!.size, 0);
  state.trace[3]!.result = undefined;
  assert.deepEqual(observed!.result, {
    kind: "error",
    code: "invalid_request",
    message: "Denied path",
  });
  assert.equal(latestObservation(initialExplorationState(identity)), null);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "investigation-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "const item = lookup(id);\nreturn item;\n";
  await writeFile(path.join(root, "query.ts"), content);
  const files = [{ path: "query.ts", sha256: digest(content) }];
  const manifest = {
    snapshotId: digest(JSON.stringify(files)),
    commit: metadata.request.commit,
    subtree: "",
    skipped: [],
    files,
    policy: {},
  };
  const item = structuredClone(candidate);
  item.supportingEvidence[0]!.snapshotId = manifest.snapshotId;
  const read: Action = {
    name: "read_lines",
    path: "query.ts",
    startLine: 1,
    endLine: 2,
    rationale: "Inspect the lookup.",
    basedOnToolCallIds: [],
    checkpoint: null,
  };
  const finish = (candidates: Candidate[]): Action => ({
    name: "finish",
    candidates,
    scopeAndLimitations: [],
    rationale: "Finish this bounded run.",
    basedOnToolCallIds: [],
  });
  return {
    root,
    manifest,
    snapshot: { root, ...manifest },
    item,
    read,
    finish,
  };
}

test("result projection exactly preserves current completed, empty, and incomplete saved runs", async (t) => {
  const f = await fixture(t);
  for (const actions of [
    [f.finish([])],
    [f.read, f.finish([f.item])],
    [f.read, { ...f.read, checkpoint: [f.item] }],
  ]) {
    let index = 0;
    const original = await createExplorationWithModel(
      f.snapshot,
      {},
      {
        async requestAction(input) {
          const action = actions[index++];
          if (!action) throw new Error("Scripted interruption");
          return {
            action,
            conversation: input.conversation,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      },
    ).run();
    const { elapsedMs, ...usage } = original.usage;
    const state = explorationStateSchema.parse({
      ...initialExplorationState(original),
      provisionalCandidates: original.provisionalCandidates,
      finalCandidates: original.finalCandidates,
      termination: original.termination,
      scopeAndLimitations: original.scopeAndLimitations,
      trace: original.trace,
      usage,
      conversation: {
        history: [
          { type: "reasoning", encrypted_content: "private-continuation" },
        ],
        pendingCallId: "provider-call-private",
      },
    });
    const projected = projectRunResult(state, original, elapsedMs);
    assert.deepEqual(projected, original);
    assert.equal(JSON.stringify(projected).includes("private"), false);
    await new ReportValidator().validate(projected, f.manifest, f.root);
    state.trace[0]!.outcome = "error";
    assert.equal(projected.trace[0]!.outcome, original.trace[0]!.outcome);
    projected.request.limits.modelCalls++;
    assert.notEqual(
      projected.request.limits.modelCalls,
      original.request.limits.modelCalls,
    );
  }
});

test("projection of an interrupted state keeps progress and omits working fields", () => {
  const state = initialExplorationState(identity);
  state.provisionalCandidates = [structuredClone(candidate)];
  state.trace = [structuredClone(modelEvent)];
  state.usage.modelCalls = 1;
  state.usage.inputTokens = 10;
  const result = projectRunResult(state, metadata, 12);
  assert.equal(result.completion, "incomplete");
  assert.equal(result.finalCandidates, null);
  assert.deepEqual(result.provisionalCandidates, [candidate]);
  assert.deepEqual(result.termination, { reason: "execution_error" });
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal("action" in result, false);
  assert.equal("conversation" in result, false);
});

test("projection rejects contradictory completion and invalid elapsed time", () => {
  const state = initialExplorationState(identity);
  assert.throws(
    () =>
      projectRunResult(
        { ...state, termination: { reason: "model_finished" } },
        metadata,
        1,
      ),
    /inconsistent/,
  );
  assert.throws(
    () =>
      projectRunResult(
        { ...state, termination: { reason: "cancelled" }, finalCandidates: [] },
        metadata,
        1,
      ),
    /inconsistent/,
  );
  for (const elapsedMs of [-1, Infinity, NaN])
    assert.throws(
      () => projectRunResult(state, metadata, elapsedMs),
      /Elapsed/,
    );
});

test("public projection selects metadata fields and rejects unexpected nested diagnostic data", async (t) => {
  const f = await fixture(t);
  const actions = [f.read, f.finish([f.item])];
  const original = await createExplorationWithModel(
    f.snapshot,
    {},
    {
      async requestAction(input) {
        return { action: actions.shift(), conversation: input.conversation };
      },
    },
  ).run();
  const { elapsedMs, ...usage } = original.usage;
  const state: ExplorationState = {
    ...initialExplorationState(original),
    finalCandidates: original.finalCandidates,
    termination: original.termination,
    trace: original.trace as ExplorationTraceEvent[],
    usage,
  };
  const secret = "private-diagnostic-sentinel";
  const input = Object.assign(structuredClone(state), { credentials: secret });
  const metadata = {
    request: Object.assign(structuredClone(original.request), {
      apiKey: secret,
    }),
    exclusions: [
      { path: "excluded.txt", reason: "Excluded by policy", internal: secret },
    ],
  };
  const projected = projectRunResult(input, metadata, elapsedMs);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  const mutations: ((value: ExplorationState) => void)[] = [
    (value) => {
      Object.assign(value.usage, { apiKey: secret });
    },
    (value) => {
      Object.assign(value.trace[0]!, { conversation: secret });
    },
    (value) => {
      Object.assign(value.trace[1]!.arguments!, { apiKey: secret });
    },
    (value) => {
      Object.assign(value.trace[1]!.result!, { history: secret });
    },
    (value) => {
      Object.assign(value.finalCandidates![0]!, { continuation: secret });
    },
    (value) => {
      Object.assign(value.trace[0]!, { actualModel: { apiKey: secret } });
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(state);
    mutate(invalid);
    assert.throws(() => projectRunResult(invalid, original, elapsedMs));
  }
});
