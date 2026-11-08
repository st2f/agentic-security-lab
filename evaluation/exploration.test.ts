import type { ActionModel } from "../src/investigation/ActionModel.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { configSchema, defaultLimits } from "../src/investigation/contracts.ts";
import { ExplorationRunner } from "../src/investigation/ExplorationRunner.ts";
import { ExecutionScope } from "../src/investigation/ExecutionScope.ts";
import { ExplorationOperations } from "../src/investigation/ExplorationOperations.ts";
import { initialExplorationState } from "../src/investigation/state.ts";
import type { ExplorationState } from "../src/investigation/state.ts";
import type { ExplorationContext } from "../src/investigation/context.ts";
import { ExplorationWorkflow } from "../src/workflows/ExplorationWorkflow.ts";
import { ReportValidator } from "../src/reporting/ReportValidator.ts";
import { RepositoryInspector } from "../src/infrastructure/repository/RepositoryInspector.ts";
import type {
  Action,
  Candidate,
  ConversationContinuation,
  ModelInput,
} from "../src/investigation/contracts.ts";
import {
  createExplorationWithModel,
  createExploration,
} from "../src/composition.ts";
import { digest } from "../src/infrastructure/repository/snapshot.ts";
import type { Snapshot } from "../src/infrastructure/repository/snapshot.ts";

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
): ActionModel {
  let index = 0;
  return {
    requestAction: async (input) => ({
      action: await steps[index++]!(input),
      conversation: input.conversation,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };
}

test("assembly is inert and execution owns resources and permits only one run", async (t) => {
  const snapshot = await source(t);
  const schedule = t.mock.method(globalThis, "setTimeout");
  let calls = 0;
  const investigation = createExplorationWithModel(
    snapshot,
    {},
    {
      async requestAction(input) {
        calls++;
        return { action: finish(), conversation: input.conversation };
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(schedule.mock.callCount(), 0);

  const controller = new AbortController();
  const result = await investigation.run(controller.signal);
  assert.equal(result.completion, "completed");
  assert.equal(calls, 1);
  assert.ok(schedule.mock.callCount() > 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(investigation.run(), /only run once/);
  assert.equal(calls, 1);
});

test("unexpected workflow failure produces an incomplete result and releases execution resources", async (t) => {
  const snapshot = await source(t);
  const dispose = t.mock.method(ExecutionScope.prototype, "dispose");
  const runner = new ExplorationRunner(
    initialExplorationState({
      runId: "workflow-failure",
      snapshotId: snapshot.snapshotId,
    }),
    {
      async run() {
        throw new Error("workflow failed");
      },
    },
    {
      snapshot,
      config: configSchema.parse({}),
      model: scripted([]),
      inspector: new RepositoryInspector(snapshot),
    },
  );
  const controller = new AbortController();
  const result = await runner.run(controller.signal);
  assert.equal(result.completion, "incomplete");
  assert.equal(result.termination.reason, "execution_error");
  assert.equal(result.usage.modelCalls, 0);
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("unexpected graph failure preserves committed evidence and the latest validated checkpoint", async (t) => {
  const snapshot = await source(t);
  const saved = candidate(snapshot);
  const operations = new ExplorationOperations();
  const model = scripted([() => read(), () => read([saved], ["tool-1"])]);
  const invokeModel = t.mock.method(model, "requestAction");
  const chooseAction = operations.chooseAction.bind(operations);
  t.mock.method(
    operations,
    "chooseAction",
    async (state: ExplorationState, context: ExplorationContext) => {
      if (state.usage.modelCalls === 2)
        throw new Error("unexpected node failure");
      return chooseAction(state, context);
    },
  );
  const runner = new ExplorationRunner(
    initialExplorationState({
      runId: "committed-failure",
      snapshotId: snapshot.snapshotId,
    }),
    new ExplorationWorkflow(operations),
    {
      snapshot,
      config: configSchema.parse({}),
      model,
      inspector: new RepositoryInspector(snapshot),
    },
  );
  const controller = new AbortController();
  const result = await runner.run(controller.signal);
  assert.equal(result.termination.reason, "execution_error");
  assert.equal(result.finalCandidates, null);
  assert.deepEqual(result.provisionalCandidates, [saved]);
  // The third node failed before dispatch, so only two calls exist.
  assert.equal(result.usage.modelCalls, 2);
  assert.equal(invokeModel.mock.callCount(), 2);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.toolCalls, 2);
  assert.equal(result.trace.length, 4);
  assert.equal(result.usage.tokenUsageComplete, true);
  assert.equal(result.trace[1]!.outcome, "ok");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const { root, ...manifest } = snapshot;
  await new ReportValidator().validate(
    result,
    { ...manifest, policy: {} },
    root,
  );
});

test("production composition connects inspection to the adapter with a fresh conversation per run", async (t) => {
  const snapshot = await source(t);
  const requests: { input: { type?: string; output?: string }[] }[] = [];
  const modelOptions: Parameters<typeof createExploration>[2] = {
    apiKey: "test-key-not-a-secret",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(JSON.parse(await request.text()));
      const action = requests.length % 2 === 1 ? read() : finish();
      const { name, ...args } = action;
      return new Response(
        JSON.stringify({
          id: `response-${requests.length}`,
          object: "response",
          created_at: 1,
          model: "configured-model-version",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: `function-${requests.length}`,
              call_id: `provider-call-${requests.length}`,
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  };
  for (let run = 0; run < 2; run++) {
    const result = await createExploration(snapshot, {}, modelOptions).run();
    assert.equal(result.completion, "completed");
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.usage.toolCalls, 1);
    assert.equal(requests[run * 2]!.input.length, 1);
    const observation = requests[run * 2 + 1]!.input.find(
      (item) => item.type === "function_call_output",
    );
    const output = JSON.parse(observation!.output!);
    assert.equal(output.toolCallId, "tool-1");
    assert.deepEqual(output.result, result.trace[1]!.result);
    assert.equal(output.budget.modelCallsLeft, 10);
    assert.equal(output.budget.toolCallsLeft, 39);
    assert.equal(
      (result.trace[1]!.result as { path: string }).path,
      "query.ts",
    );
  }
});

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
      const observed = input.message as {
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
  const result = await createExplorationWithModel(snapshot, {}, model).run();
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
  const complete = await createExplorationWithModel(
    snapshot,
    {},
    scripted([() => finish()]),
  ).run();
  assert.equal(complete.completion, "completed");
  assert.deepEqual(complete.finalCandidates, []);
  assert.ok(
    complete.scopeAndLimitations.some((entry) =>
      entry.includes("does not establish"),
    ),
  );
  const incomplete = await createExplorationWithModel(
    snapshot,
    {},
    {
      requestAction: async () => {
        throw new Error("provider failed");
      },
    },
  ).run();
  assert.equal(incomplete.completion, "incomplete");
  assert.equal(incomplete.finalCandidates, null);
  assert.equal(incomplete.termination.reason, "model_error");
  assert.equal(incomplete.usage.tokenUsageComplete, false);
});

test("model/tool limits stop execution and retain only the latest validated checkpoint", async (t) => {
  const snapshot = await source(t);
  const modelLimited = await createExplorationWithModel(
    snapshot,
    { limits: { ...defaultLimits, modelCalls: 1 } },
    scripted([() => read()]),
  ).run();
  assert.equal(modelLimited.termination.limit, "modelCalls");
  assert.equal(modelLimited.usage.modelCalls, 1);
  const saved = candidate(snapshot);
  const toolLimited = await createExplorationWithModel(
    snapshot,
    { limits: { ...defaultLimits, toolCalls: 1 } },
    scripted([() => read(), () => read([saved], ["tool-1"])]),
  ).run();
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
  const result = await createExplorationWithModel(
    snapshot,
    { limits: { ...defaultLimits, modelCalls: 4 } },
    scripted([
      () => read(),
      () => read([initial], ["tool-1"]),
      () => read([revised], ["tool-1"]),
      () => read([], ["tool-1"]),
    ]),
  ).run();
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
    const result = await createExplorationWithModel(
      snapshot,
      { maxCandidates: 1 },
      scripted(steps),
    ).run();
    assert.equal(result.termination.reason, "invalid_model_output");
    assert.equal(result.finalCandidates, null);
  }
});

test("invalid continuation cannot replace an earlier valid provisional checkpoint", async (t) => {
  const snapshot = await source(t);
  const saved = candidate(snapshot);
  let calls = 0;
  const result = await createExplorationWithModel(
    snapshot,
    {},
    {
      async requestAction(input) {
        calls++;
        return {
          action:
            calls === 1
              ? read()
              : calls === 2
                ? read([saved], ["tool-1"])
                : read([]),
          conversation:
            calls === 3
              ? ({
                  history: [{ callback() {} }],
                  pendingCallId: null,
                } as unknown as ConversationContinuation)
              : input.conversation,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  ).run();
  assert.equal(result.termination.reason, "model_error");
  assert.deepEqual(result.provisionalCandidates, [saved]);
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.toolCalls, 2);
  assert.equal(result.trace.at(-1)!.outcome, "error");
  assert.equal("conversation" in result, false);
});

test("denied tool arguments return observations and do not escape the snapshot", async (t) => {
  const snapshot = await source(t);
  const result = await createExplorationWithModel(
    snapshot,
    {},
    scripted([
      () => ({ ...read(), path: "../docs/experiments/inventory-fixture.md" }),
      (input) => {
        assert.equal((input.message.result as { kind: string }).kind, "error");
        return finish();
      },
    ]),
  ).run();
  assert.equal(result.completion, "completed");
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.trace[1]?.outcome, "error");
});

test("cumulative response bytes and oversized lines terminate without extra model calls", async (t) => {
  const snapshot = await source(t);
  const result = await createExplorationWithModel(
    snapshot,
    { limits: { ...defaultLimits, totalToolResponseBytes: 512 } },
    scripted([() => read(), () => read()]),
  ).run();
  assert.equal(result.termination.reason, "budget_exhausted");
  assert.equal(result.termination.limit, "totalToolResponseBytes");
  assert.ok(result.usage.toolResponseBytes <= 512);
  const content = "x".repeat(20_000);
  await writeFile(path.join(snapshot.root, "query.ts"), content);
  const updated = {
    ...snapshot,
    files: [{ path: "query.ts", sha256: digest(content) }],
  };
  const oversized = await createExplorationWithModel(
    updated,
    {},
    scripted([() => read()]),
  ).run();
  assert.equal(oversized.termination.limit, "toolResponseBytes");
  assert.equal(oversized.usage.modelCalls, 1);
});

test("deadline aborts a noncooperating model and prevents subsequent actions", async (t) => {
  const snapshot = await source(t);
  let signal: AbortSignal | undefined;
  const result = await createExplorationWithModel(
    snapshot,
    { limits: { ...defaultLimits, elapsedMs: 30 } },
    {
      requestAction: async (_input, currentSignal) => {
        signal = currentSignal;
        return new Promise(() => {});
      },
    },
  ).run();
  assert.equal(signal?.aborted, true);
  assert.equal(result.termination.limit, "elapsedMs");
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.tokenUsageComplete, false);
});

test("user cancellation stops in-flight work and pre-cancelled runs dispatch nothing", async (t) => {
  const snapshot = await source(t);
  const controller = new AbortController();
  const result = await createExplorationWithModel(
    snapshot,
    {},
    {
      requestAction: async () => {
        controller.abort();
        return new Promise(() => {});
      },
    },
  ).run(controller.signal);
  assert.equal(result.termination.reason, "cancelled");
  const preCancelled = await createExplorationWithModel(
    snapshot,
    {},
    scripted([]),
  ).run(controller.signal);
  assert.equal(preCancelled.usage.modelCalls, 0);
  assert.equal(preCancelled.termination.reason, "cancelled");
});

test("invalid configuration fails before dispatch", async (t) => {
  const snapshot = await source(t);
  let calls = 0;
  assert.throws(() =>
    createExplorationWithModel(
      snapshot,
      { limits: { ...defaultLimits, modelCalls: 0 } },
      {
        requestAction: async (input) => {
          calls++;
          return { action: finish(), conversation: input.conversation };
        },
      },
    ),
  );
  assert.equal(calls, 0);
});
