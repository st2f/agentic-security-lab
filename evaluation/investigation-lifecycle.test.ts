import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  configSchema,
  defaultLimits,
  ModelRequestError,
} from "../src/investigation/contracts.ts";
import type {
  Action,
  Candidate,
  ModelReply,
  RunResult,
} from "../src/investigation/contracts.ts";
import type { InvestigationDependencies } from "../src/investigation/context.ts";
import { ExecutionScope } from "../src/investigation/ExecutionScope.ts";
import { InvestigationOperations } from "../src/investigation/InvestigationOperations.ts";
import { InvestigationRunner } from "../src/investigation/InvestigationRunner.ts";
import type { InvestigationWorkflow } from "../src/investigation/InvestigationRunner.ts";
import { initialInvestigationState } from "../src/investigation/state.ts";
import type { InvestigationState } from "../src/investigation/state.ts";
import {
  OutputBudgetError,
  RepositoryInspector,
} from "../src/infrastructure/repository/RepositoryInspector.ts";
import { digest } from "../src/infrastructure/repository/snapshot.ts";
import { ReportValidator } from "../src/reporting/ReportValidator.ts";
import { ExplorationWorkflow } from "../src/workflows/ExplorationWorkflow.ts";

const read: Action = {
  name: "read_lines",
  path: "query.ts",
  startLine: 1,
  endLine: 1,
  rationale: "Inspect source.",
  basedOnToolCallIds: [],
  checkpoint: null,
};
const finish: Action = {
  name: "finish",
  rationale: "Finish the bounded run.",
  basedOnToolCallIds: [],
  candidates: [],
  scopeAndLimitations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext): Promise<InvestigationDependencies> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "investigation-lifecycle-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "const item = lookup(id);\n";
  await writeFile(path.join(root, "query.ts"), source);
  const files = [{ path: "query.ts", sha256: digest(source) }];
  const snapshot = {
    root,
    files,
    snapshotId: digest(JSON.stringify(files)),
    commit: "a".repeat(40),
    subtree: "",
    skipped: [],
  };
  return {
    snapshot,
    config: configSchema.parse({}),
    inspector: new RepositoryInspector(snapshot),
    model: {
      async requestAction(input) {
        return {
          action: finish,
          conversation: input.conversation,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

/** Progress after one accepted model call whose inspection has not run. */
function afterModelCall(state: InvestigationState): InvestigationState {
  return {
    ...state,
    usage: { ...state.usage, modelCalls: 1, inputTokens: 10, outputTokens: 5 },
    trace: [
      {
        id: "event-1",
        type: "model",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        outcome: "ok",
        action: read,
      },
    ],
  };
}

function runner(
  dependencies: InvestigationDependencies,
  workflow: InvestigationWorkflow = new ExplorationWorkflow(
    new InvestigationOperations(),
  ),
) {
  return new InvestigationRunner(
    initialInvestigationState({
      runId: "lifecycle-run",
      snapshotId: dependencies.snapshot.snapshotId,
    }),
    workflow,
    dependencies,
  );
}

async function validate(
  result: RunResult,
  dependencies: InvestigationDependencies,
) {
  const { root, ...manifest } = dependencies.snapshot;
  await new ReportValidator().validate(
    result,
    { ...manifest, policy: {} },
    root,
  );
}

test("every termination path clears its timer and both cancellation listener sets", async (t) => {
  const base = await fixture(t);
  const schedule = t.mock.method(globalThis, "setTimeout");
  const clear = t.mock.method(globalThis, "clearTimeout");
  const start = ExecutionScope.prototype.start;
  const scopes: { scope: ExecutionScope; handle: unknown }[] = [];
  let failStart = false;
  t.mock.method(
    ExecutionScope.prototype,
    "start",
    function (this: ExecutionScope, signal?: AbortSignal) {
      start.call(this, signal);
      scopes.push({ scope: this, handle: schedule.mock.calls.at(-1)!.result });
      if (failStart)
        throw new Error("startup failed after resource acquisition");
    },
  );
  for (const mode of [
    "complete",
    "model_error",
    "invalid",
    "calls",
    "bytes",
    "cancel",
    "pre_cancel",
    "deadline",
    "unexpected",
    "start_error",
  ] as const) {
    failStart = mode === "start_error";
    const controller = new AbortController();
    if (mode === "pre_cancel") controller.abort();
    const dependencies = {
      ...base,
      config: configSchema.parse({
        limits: {
          ...defaultLimits,
          ...(mode === "calls" ? { modelCalls: 1 } : {}),
          ...(mode === "deadline" ? { elapsedMs: 30 } : {}),
        },
      }),
    };
    dependencies.model = {
      async requestAction(input) {
        if (mode === "model_error") throw new ModelRequestError(429);
        if (mode === "cancel") controller.abort();
        if (mode === "cancel" || mode === "deadline")
          return new Promise<never>(() => {});
        return {
          action:
            mode === "invalid"
              ? null
              : ["calls", "bytes"].includes(mode)
                ? read
                : finish,
          conversation: input.conversation,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    if (mode === "bytes")
      dependencies.inspector = {
        async execute() {
          throw new OutputBudgetError();
        },
      };
    const operations = new InvestigationOperations();
    if (mode === "unexpected")
      t.mock.method(operations, "chooseAction", async () => {
        throw new Error("unexpected node failure");
      });
    const beforeStart = scopes.length;
    const beforeSchedule = schedule.mock.callCount();
    const investigation = runner(
      dependencies,
      new ExplorationWorkflow(operations),
    );
    assert.equal(scopes.length, beforeStart, mode);
    assert.equal(schedule.mock.callCount(), beforeSchedule, mode);
    const result = await investigation.run(controller.signal);
    const expected =
      mode === "complete"
        ? "model_finished"
        : mode === "invalid"
          ? "invalid_model_output"
          : ["calls", "bytes", "deadline"].includes(mode)
            ? "budget_exhausted"
            : ["cancel", "pre_cancel"].includes(mode)
              ? "cancelled"
              : mode === "unexpected" || mode === "start_error"
                ? "execution_error"
                : "model_error";
    assert.equal(result.termination.reason, expected, mode);
    assert.equal(scopes.length, beforeStart + 1, mode);
    const { scope, handle } = scopes.at(-1)!;
    assert.ok(
      clear.mock.calls.some((call) => call.arguments[0] === handle),
      mode,
    );
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, mode);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0, mode);
    assert.equal(scope.signal.aborted, true, mode);
    assert.equal(result.usage.elapsedMs, scope.elapsedMs, mode);
    await validate(result, dependencies);
  }
});

test("runner seals committed state before cleanup callbacks and ignores later observer notifications", async (t) => {
  const dependencies = await fixture(t);
  for (const completed of [true, false]) {
    let notify!: (state: InvestigationState) => void;
    let poisoned!: InvestigationState;
    const workflow: InvestigationWorkflow = {
      async run(state, context, observe) {
        notify = observe;
        const committed: InvestigationState = completed
          ? {
              ...state,
              finalCandidates: [],
              termination: { reason: "model_finished" },
              usage: {
                ...state.usage,
                modelCalls: 1,
                inputTokens: 10,
                outputTokens: 5,
              },
              trace: [
                {
                  id: "event-1",
                  type: "model",
                  startedAt: new Date().toISOString(),
                  durationMs: 0,
                  outcome: "ok",
                  action: finish,
                },
              ],
            }
          : afterModelCall(state);
        observe(committed);
        poisoned = {
          ...committed,
          termination: { reason: completed ? "model_error" : "model_finished" },
          finalCandidates: completed ? null : [],
          usage: { ...committed.usage, modelCalls: 99 },
        };
        context.execution.signal.addEventListener(
          "abort",
          () => observe(poisoned),
          { once: true },
        );
        if (!completed) throw new Error("workflow failed after commit");
        return committed;
      },
    };
    const result = await runner(dependencies, workflow).run();
    assert.equal(
      result.termination.reason,
      completed ? "model_finished" : "execution_error",
    );
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(result.usage.tokenUsageComplete, true);
    const published = structuredClone(result);
    notify(poisoned);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(result, published);
    await validate(result, dependencies);
  }
});

test("unexpected failure preserves a committed reason or recognizes cancellation and clock expiry", async (t) => {
  const dependencies = await fixture(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const cause of [
    "cancel",
    "deadline",
    "none",
    "already_stopped",
  ] as const) {
    now = 0;
    const controller = new AbortController();
    const workflow: InvestigationWorkflow = {
      async run(state, context, observe) {
        const committed = afterModelCall(state);
        if (cause === "already_stopped")
          committed.termination = { reason: "model_error" };
        observe(committed);
        if (cause === "deadline") now = context.config.limits.elapsedMs + 1;
        if (cause === "cancel" || cause === "already_stopped")
          controller.abort();
        throw new Error("workflow failed without a terminal update");
      },
    };
    const result = await runner(dependencies, workflow).run(controller.signal);
    assert.equal(
      result.termination.reason,
      cause === "cancel"
        ? "cancelled"
        : cause === "deadline"
          ? "budget_exhausted"
          : cause === "already_stopped"
            ? "model_error"
            : "execution_error",
    );
    assert.equal(result.usage.modelCalls, 1);
    assert.equal(result.trace[0]!.outcome, "ok");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await validate(result, dependencies);
  }
});

test("one runner rejects concurrent execution while allowing its first invocation to finish", async (t) => {
  const dependencies = await fixture(t);
  const entered = deferred<void>();
  const reply = deferred<ModelReply>();
  dependencies.model = {
    async requestAction() {
      entered.resolve(undefined);
      return reply.promise;
    },
  };
  const investigation = runner(dependencies);
  const first = investigation.run();
  await entered.promise;
  await assert.rejects(investigation.run(), /only run once/);
  reply.resolve({
    action: finish,
    conversation: { history: [], pendingCallId: null },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const result = await first;
  assert.equal(result.completion, "completed");
  assert.equal(result.usage.modelCalls, 1);
  await validate(result, dependencies);
});

test("late model and inspection outcomes cannot change a cancelled result or its valid checkpoint", async (t) => {
  for (const kind of ["model", "inspection"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      const dependencies = await fixture(t);
      const controller = new AbortController();
      const pendingModel = deferred<ModelReply>();
      const pendingInspection =
        deferred<Awaited<ReturnType<typeof dependencies.inspector.execute>>>();
      const candidate: Candidate = {
        id: "candidate-1",
        claim: "The lookup may lack tenant filtering.",
        rationale: "Only an ID is supplied.",
        supportingEvidence: [
          {
            snapshotId: dependencies.snapshot.snapshotId,
            toolCallId: "tool-1",
            path: "query.ts",
            startLine: 1,
            endLine: 1,
          },
        ],
        contradictoryEvidence: [],
        uncertainties: ["The callee might enforce tenancy."],
        priorityReason: "Potential tenant-boundary violation.",
        nextChecks: ["Inspect the callee."],
      };
      let models = 0;
      let inspections = 0;
      dependencies.model = {
        async requestAction(input) {
          models++;
          if (kind === "model" && models === 3) {
            controller.abort();
            return pendingModel.promise;
          }
          return {
            action: models === 1 ? read : { ...read, checkpoint: [candidate] },
            conversation: input.conversation,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
      const inspector = dependencies.inspector;
      dependencies.inspector = {
        async execute(...args) {
          inspections++;
          if (kind === "inspection" && inspections === 2) {
            controller.abort();
            return pendingInspection.promise;
          }
          return inspector.execute(...args);
        },
      };
      const result = await runner(dependencies).run(controller.signal);
      assert.equal(result.termination.reason, "cancelled");
      assert.equal(result.finalCandidates, null);
      assert.deepEqual(result.provisionalCandidates, [candidate]);
      assert.equal(result.usage.modelCalls, kind === "model" ? 3 : 2);
      assert.equal(result.usage.toolCalls, 2);
      assert.equal(result.usage.tokenUsageComplete, kind === "inspection");
      const published = structuredClone(result);
      const before = { models, inspections };
      if (kind === "model") {
        if (outcome === "resolve")
          pendingModel.resolve({
            action: finish,
            conversation: {
              history: [{ content: "late continuation" }],
              pendingCallId: null,
            },
            usage: { inputTokens: 999, outputTokens: 999 },
          });
        else pendingModel.reject(new Error("late model rejection"));
      } else {
        if (outcome === "resolve")
          pendingInspection.resolve({
            kind: "read_lines",
            snapshotId: dependencies.snapshot.snapshotId,
            path: "query.ts",
            lines: [{ line: 1, text: "late source" }],
            truncated: false,
            nextStartLine: null,
          });
        else pendingInspection.reject(new Error("late inspection rejection"));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(result, published);
      assert.deepEqual({ models, inspections }, before);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      await validate(result, dependencies);
    }
  }
});
