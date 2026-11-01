import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { defaultLimits } from "../src/investigation/contract.ts";
import type {
  Action,
  Candidate,
  ModelInput,
  RequestAction,
} from "../src/investigation/contract.ts";
import { explore } from "../src/orchestration/explore.ts";
import { digest } from "../src/repository/snapshot.ts";
import type { Snapshot } from "../src/repository/snapshot.ts";

async function source(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "exploration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content =
    "const item = repository.findById(id);\nreturn item.quantity;\n";
  await writeFile(path.join(root, "query.ts"), content);
  const files = [{ path: "query.ts", sha256: digest(content) }];
  const snapshot: Snapshot = {
    root,
    snapshotId: digest(JSON.stringify(files)),
    files,
    skipped: [],
    commit: "a".repeat(40),
    subtree: "",
  };
  return snapshot;
}
const read = (
  checkpoint: Candidate[] | null = null,
  basis: string[] = [],
): Action => ({
  name: "read_lines",
  path: "query.ts",
  startLine: 1,
  endLine: 2,
  rationale: "Inspect the lookup and returned data.",
  basedOnToolCallIds: basis,
  checkpoint,
});
const finish = (candidates: Candidate[] = []): Action => ({
  name: "finish",
  rationale: "Enough source evidence for this bounded run.",
  basedOnToolCallIds: [],
  candidates,
  scopeAndLimitations: [
    "Caller and repository implementations remain outside this sample.",
  ],
});
function candidate(snapshot: Snapshot): Candidate {
  return {
    id: "candidate-1",
    claim: "The lookup may return another tenant's quantity.",
    rationale: "The observed call has only an item ID.",
    supportingEvidence: [
      {
        snapshotId: snapshot.snapshotId,
        path: "query.ts",
        startLine: 1,
        endLine: 2,
        toolCallId: "tool-1",
      },
    ],
    contradictoryEvidence: [],
    uncertainties: ["The repository might enforce tenancy internally."],
    priorityReason: "Potential cross-tenant disclosure.",
    nextChecks: ["Inspect repository implementation."],
  };
}
function scripted(
  steps: ((input: ModelInput) => unknown | Promise<unknown>)[],
): RequestAction {
  let index = 0;
  return async (input) => ({
    action: await steps[index++]!(input),
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

test("graph follows a prior result and returns source-supported hypotheses with measured usage", async (t) => {
  const snapshot = await source(t);
  const model = scripted([
    () => ({
      name: "list_files",
      directory: ".",
      offset: 0,
      limit: 50,
      rationale: "Find source files.",
      basedOnToolCallIds: [],
      checkpoint: null,
    }),
    (input) => {
      const observed = input.observation as {
        toolCallId: string;
        result: { files: string[] };
      };
      return {
        ...read(),
        path: observed.result.files[0],
        basedOnToolCallIds: [observed.toolCallId],
      };
    },
    () => {
      const item = candidate(snapshot);
      item.supportingEvidence[0]!.toolCallId = "tool-2";
      return finish([item]);
    },
  ]);
  const result = await explore(snapshot, {}, model);
  assert.equal(result.completion, "completed");
  assert.equal(result.termination.reason, "model_finished");
  assert.equal(result.finalCandidates?.length, 1);
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.toolCalls, 2);
  assert.equal(result.usage.inputTokens, 30);
  assert.equal(result.usage.tokenUsageComplete, true);
  assert.ok(result.usage.toolResponseBytes > 0);
  assert.deepEqual(result.trace[2]?.action?.basedOnToolCallIds, ["tool-1"]);
});

test("zero candidates is a completed assessment; absence of a response is incomplete", async (t) => {
  const snapshot = await source(t);
  const complete = await explore(snapshot, {}, scripted([() => finish()]));
  assert.equal(complete.completion, "completed");
  assert.deepEqual(complete.finalCandidates, []);
  assert.ok(
    complete.scopeAndLimitations.some((entry) =>
      entry.includes("does not establish"),
    ),
  );
  const incomplete = await explore(snapshot, {}, async () => {
    throw new Error("provider failed");
  });
  assert.equal(incomplete.completion, "incomplete");
  assert.equal(incomplete.finalCandidates, null);
  assert.equal(incomplete.termination.reason, "model_error");
  assert.equal(incomplete.usage.tokenUsageComplete, false);
});

test("model/tool limits stop execution and retain only the latest validated checkpoint", async (t) => {
  const snapshot = await source(t);
  const modelLimited = await explore(
    snapshot,
    { limits: { ...defaultLimits, modelCalls: 1 } },
    scripted([() => read()]),
  );
  assert.equal(modelLimited.termination.limit, "modelCalls");
  assert.equal(modelLimited.usage.modelCalls, 1);
  const saved = candidate(snapshot);
  const toolLimited = await explore(
    snapshot,
    { limits: { ...defaultLimits, toolCalls: 1 } },
    scripted([() => read(), () => read([saved], ["tool-1"])]),
  );
  assert.equal(toolLimited.termination.limit, "toolCalls");
  assert.equal(toolLimited.usage.toolCalls, 1);
  assert.equal(toolLimited.finalCandidates, null);
  assert.deepEqual(toolLimited.provisionalCandidates, [saved]);
});

test("candidate replacements preserve revision history while discarded candidates stay out of partial results", async (t) => {
  const snapshot = await source(t);
  const initial = candidate(snapshot);
  const revised = {
    ...initial,
    claim: "The repository implementation still needs inspection.",
  };
  const result = await explore(
    snapshot,
    { limits: { ...defaultLimits, modelCalls: 4 } },
    scripted([
      () => read(),
      () => read([initial], ["tool-1"]),
      () => read([revised], ["tool-1"]),
      () => read([], ["tool-1"]),
    ]),
  );
  assert.equal(result.termination.limit, "modelCalls");
  assert.deepEqual(result.provisionalCandidates, []);
  const updates = result.trace.flatMap((entry) =>
    entry.action &&
    entry.action.name !== "finish" &&
    entry.action.checkpoint !== null
      ? [entry.action.checkpoint]
      : [],
  );
  assert.deepEqual(updates, [[initial], [revised], []]);
});

test("application rejects unread evidence, invented causal IDs, and excessive final counts", async (t) => {
  const snapshot = await source(t);
  const unread = candidate(snapshot);
  unread.supportingEvidence[0]!.endLine = 3;
  for (const steps of [
    [() => read(), () => finish([unread])],
    [() => ({ ...read(), basedOnToolCallIds: ["invented"] })],
    [
      () => read(),
      () =>
        finish([
          candidate(snapshot),
          { ...candidate(snapshot), id: "candidate-2" },
        ]),
    ],
  ]) {
    const result = await explore(
      snapshot,
      { maxCandidates: 1 },
      scripted(steps),
    );
    assert.equal(result.termination.reason, "invalid_model_output");
    assert.equal(result.finalCandidates, null);
  }
});

test("denied tool arguments return observations and do not escape the snapshot", async (t) => {
  const snapshot = await source(t);
  const result = await explore(
    snapshot,
    {},
    scripted([
      () => ({ ...read(), path: "../evaluation/README.md" }),
      (input) => {
        assert.equal(
          (input.observation?.result as { kind: string }).kind,
          "error",
        );
        return finish();
      },
    ]),
  );
  assert.equal(result.completion, "completed");
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.trace[1]?.outcome, "error");
});

test("cumulative response bytes and oversized lines terminate without extra model calls", async (t) => {
  const snapshot = await source(t);
  const result = await explore(
    snapshot,
    { limits: { ...defaultLimits, totalToolResponseBytes: 512 } },
    scripted([() => read(), () => read()]),
  );
  assert.equal(result.termination.reason, "budget_exhausted");
  assert.equal(result.termination.limit, "totalToolResponseBytes");
  assert.ok(result.usage.toolResponseBytes <= 512);
  const content = "x".repeat(20_000);
  await writeFile(path.join(snapshot.root, "query.ts"), content);
  const updated = {
    ...snapshot,
    files: [{ path: "query.ts", sha256: digest(content) }],
  };
  const oversized = await explore(updated, {}, scripted([() => read()]));
  assert.equal(oversized.termination.limit, "toolResponseBytes");
  assert.equal(oversized.usage.modelCalls, 1);
});

test("snapshot mutation after inspection prevents final acceptance", async (t) => {
  const snapshot = await source(t);
  const result = await explore(
    snapshot,
    {},
    scripted([
      () => read(),
      async () => {
        await writeFile(path.join(snapshot.root, "query.ts"), "changed\n");
        return finish([candidate(snapshot)]);
      },
    ]),
  );
  assert.equal(result.termination.reason, "snapshot_changed");
  assert.equal(result.finalCandidates, null);
});

test("deadline aborts a noncooperating model and prevents subsequent actions", async (t) => {
  const snapshot = await source(t);
  let signal: AbortSignal | undefined;
  const result = await explore(
    snapshot,
    { limits: { ...defaultLimits, elapsedMs: 30 } },
    async (_input, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => {});
    },
  );
  assert.equal(signal?.aborted, true);
  assert.equal(result.termination.limit, "elapsedMs");
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.tokenUsageComplete, false);
});

test("user cancellation stops in-flight work and pre-cancelled runs dispatch nothing", async (t) => {
  const snapshot = await source(t);
  const controller = new AbortController();
  const result = await explore(
    snapshot,
    {},
    async () => {
      controller.abort();
      return new Promise(() => {});
    },
    controller.signal,
  );
  assert.equal(result.termination.reason, "cancelled");
  const preCancelled = await explore(
    snapshot,
    {},
    scripted([]),
    controller.signal,
  );
  assert.equal(preCancelled.usage.modelCalls, 0);
  assert.equal(preCancelled.termination.reason, "cancelled");
});

test("invalid configuration fails before dispatch", async (t) => {
  const snapshot = await source(t);
  let calls = 0;
  await assert.rejects(
    explore(
      snapshot,
      { limits: { ...defaultLimits, modelCalls: 0 } },
      async () => {
        calls++;
        return { action: finish() };
      },
    ),
  );
  assert.equal(calls, 0);
});
