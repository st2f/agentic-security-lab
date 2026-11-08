import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import type { ActionModel } from "../src/investigation/ActionModel.ts";
import { configSchema, defaultLimits } from "../src/investigation/contracts.ts";
import type { Action } from "../src/investigation/contracts.ts";
import type {
  ExplorationContext,
  ExplorationDependencies,
} from "../src/investigation/context.ts";
import { ExplorationOperations } from "../src/investigation/ExplorationOperations.ts";
import { ExplorationRunner } from "../src/investigation/ExplorationRunner.ts";
import { ExecutionScope } from "../src/investigation/ExecutionScope.ts";
import { initialExplorationState } from "../src/investigation/state.ts";
import type { ExplorationState } from "../src/investigation/state.ts";
import { RepositoryInspector } from "../src/infrastructure/repository/RepositoryInspector.ts";
import { digest } from "../src/infrastructure/repository/snapshot.ts";
import { ReportValidator } from "../src/reporting/ReportValidator.ts";
import { ExplorationWorkflow } from "../src/workflows/ExplorationWorkflow.ts";

const read: Action = {
  name: "read_lines",
  path: "query.ts",
  startLine: 1,
  endLine: 1,
  rationale: "Read source.",
  basedOnToolCallIds: [],
  checkpoint: null,
};
const finish: Action = {
  name: "finish",
  rationale: "Stop this bounded run.",
  basedOnToolCallIds: [],
  candidates: [],
  scopeAndLimitations: [],
};

async function fixture(
  t: TestContext,
  name = "run",
): Promise<ExplorationDependencies> {
  const root = await mkdtemp(path.join(os.tmpdir(), "exploration-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = `export const label = ${JSON.stringify(name)};\n`;
  await writeFile(path.join(root, "query.ts"), content);
  const files = [{ path: "query.ts", sha256: digest(content) }];
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
    config: configSchema.parse({ question: name }),
    inspector: new RepositoryInspector(snapshot),
    model: {
      async requestAction(input) {
        return {
          action: read,
          conversation: input.conversation,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  };
}

function runner(
  workflow: ExplorationWorkflow,
  dependencies: ExplorationDependencies,
) {
  return new ExplorationRunner(
    initialExplorationState({
      runId: dependencies.config.question ?? "run",
      snapshotId: dependencies.snapshot.snapshotId,
    }),
    workflow,
    dependencies,
  );
}

async function validate(
  result: Awaited<ReturnType<ExplorationRunner["run"]>>,
  dependencies: ExplorationDependencies,
) {
  const { root, ...manifest } = dependencies.snapshot;
  await new ReportValidator().validate(
    result,
    { ...manifest, policy: {} },
    root,
  );
}

test("cancellation observed by a node before dispatch counts and records no call", async (t) => {
  for (const kind of ["model", "tool"] as const) {
    const dependencies = await fixture(t, kind);
    const controller = new AbortController();
    const operations = new ExplorationOperations();
    let modelCalls = 0;
    let toolCalls = 0;
    const model = dependencies.model;
    const inspector = dependencies.inspector;
    dependencies.model = {
      requestAction(input, signal) {
        modelCalls++;
        return model.requestAction(input, signal);
      },
    };
    dependencies.inspector = {
      execute(...args) {
        toolCalls++;
        return inspector.execute(...args);
      },
    };
    const method = kind === "model" ? "chooseAction" : "executeAction";
    const original = operations[method].bind(operations);
    t.mock.method(
      operations,
      method,
      async (state: ExplorationState, context: ExplorationContext) => {
        controller.abort();
        return original(state, context);
      },
    );
    const result = await runner(
      new ExplorationWorkflow(operations),
      dependencies,
    ).run(controller.signal);
    assert.equal(result.termination.reason, "cancelled");
    assert.equal(result.usage.modelCalls, kind === "tool" ? 1 : 0);
    assert.equal(result.usage.toolCalls, 0);
    assert.equal(result.usage.tokenUsageComplete, true);
    assert.equal(modelCalls, kind === "tool" ? 1 : 0);
    assert.equal(toolCalls, 0);
    assert.equal(result.trace.length, kind === "tool" ? 1 : 0);
    await validate(result, dependencies);
  }
});

test("a failed inspection node keeps committed progress without inventing a tool event", async (t) => {
  const dependencies = await fixture(t);
  const operations = new ExplorationOperations();
  const execute = t.mock.method(operations, "executeAction", async () => {
    throw new Error("node failed before inspection");
  });
  const result = await runner(
    new ExplorationWorkflow(operations),
    dependencies,
  ).run();
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(result.termination.reason, "execution_error");
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.toolResponseBytes, 0);
  assert.equal(result.usage.tokenUsageComplete, true);
  assert.equal(result.trace.length, 1);
  await validate(result, dependencies);
});

test("one compiled workflow isolates concurrent invocation state and receives stable runtime dependencies", async (t) => {
  const first = await fixture(t, "first");
  const second = await fixture(t, "second");
  const dependencies = [first, second];
  const model: ActionModel = {
    async requestAction(input) {
      const own = dependencies.find(
        (item) => item.snapshot.snapshotId === input.snapshotId,
      )!;
      const invocation = own.config.question!;
      const following = input.conversation.history.length > 0;
      if (following) {
        assert.deepEqual(input.conversation.history, [{ invocation }]);
        assert.equal(
          (input.message.result as { snapshotId: string }).snapshotId,
          input.snapshotId,
        );
      } else assert.equal(input.message.task, invocation);
      return {
        action: following ? finish : read,
        conversation: {
          history: [{ invocation }],
          pendingCallId: null,
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  first.model = model;
  second.model = model;
  const operations = new ExplorationOperations();
  const choose = operations.chooseAction.bind(operations);
  const contexts = new Map<string, ExplorationContext>();
  t.mock.method(
    operations,
    "chooseAction",
    (state: ExplorationState, context: ExplorationContext) => {
      const own = dependencies.find(
        (item) => item.config.question === state.runId,
      )!;
      assert.equal(context.snapshot, own.snapshot);
      assert.equal(context.model, model);
      assert.equal(context.inspector, own.inspector);
      assert.equal(Object.isFrozen(context), true);
      assert.equal("model" in state, false);
      assert.equal("execution" in state, false);
      if (contexts.has(state.runId))
        assert.equal(context, contexts.get(state.runId));
      else contexts.set(state.runId, context);
      return choose(state, context);
    },
  );
  const workflow = new ExplorationWorkflow(operations);
  const results = await Promise.all(
    dependencies.map((own) => runner(workflow, own).run()),
  );
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    assert.equal(result.completion, "completed");
    assert.equal(result.runId, dependencies[index]!.config.question);
    assert.equal(result.snapshotId, dependencies[index]!.snapshot.snapshotId);
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.usage.toolCalls, 1);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.trace.length, 3);
    assert.equal("conversation" in result, false);
    await validate(result, dependencies[index]!);
  }
  assert.notEqual(contexts.get("first"), contexts.get("second"));
});

test("two-node rounds exhaust the application budget before the graph recursion safeguard", async (t) => {
  const dependencies = await fixture(t);
  dependencies.config = configSchema.parse({
    limits: { ...defaultLimits, modelCalls: 3 },
  });
  const result = await runner(
    new ExplorationWorkflow(new ExplorationOperations()),
    dependencies,
  ).run();
  assert.deepEqual(result.termination, {
    reason: "budget_exhausted",
    limit: "modelCalls",
  });
  // The scripted model ignores the finish-only offer on its last call: its
  // inspection runs, and the model-call limit then ends the run.
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.toolCalls, 3);
  assert.equal(result.trace.length, 6);
  assert.ok(result.trace.every((event) => event.outcome === "ok"));
  await validate(result, dependencies);
});

test("committed progress streams omit continuation and dependencies and cannot mutate graph state", async (t) => {
  const dependencies = await fixture(t);
  const secret = "encrypted-reasoning-private-sentinel";
  let calls = 0;
  dependencies.model = {
    async requestAction(input) {
      if (calls++) {
        assert.deepEqual(input.conversation, {
          history: [{ encrypted_content: secret }],
          pendingCallId: "private-provider-call",
        });
        assert.equal(input.message.toolCallId, "tool-1");
      }
      return {
        action: calls === 1 ? read : finish,
        conversation: {
          history: [{ encrypted_content: secret }],
          pendingCallId: "private-provider-call",
        },
        actualModel: "observed-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const execution = new ExecutionScope(dependencies.config.limits.elapsedMs);
  execution.start();
  const snapshots: unknown[] = [];
  try {
    const result = await new ExplorationWorkflow(
      new ExplorationOperations(),
    ).run(
      initialExplorationState({
        runId: "privacy",
        snapshotId: dependencies.snapshot.snapshotId,
      }),
      { ...dependencies, execution },
      (progress) => {
        assert.deepEqual(
          Object.keys(progress).sort(),
          [
            "runId",
            "snapshotId",
            "provisionalCandidates",
            "finalCandidates",
            "termination",
            "scopeAndLimitations",
            "usage",
            "trace",
          ].sort(),
        );
        snapshots.push(structuredClone(progress));
        progress.trace.length = 0;
        progress.usage.modelCalls = 999;
        progress.termination = { reason: "execution_error" };
      },
    );
    assert.equal(result.termination!.reason, "model_finished");
    assert.equal(result.usage.modelCalls, 2);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.trace.length, 3);
    assert.equal(result.trace[0]!.actualModel, "observed-model");
    assert.equal(result.trace[1]!.toolCallId, "tool-1");
    const serialized = JSON.stringify([snapshots, result]);
    for (const privateValue of [
      secret,
      "private-provider-call",
      dependencies.snapshot.root,
    ])
      assert.equal(serialized.includes(privateValue), false);
  } finally {
    execution.dispose();
  }
});

test("ambient framework callbacks and tracing do not inherit investigation state", async (t) => {
  const dependencies = await fixture(t);
  dependencies.model = {
    async requestAction() {
      return {
        action: finish,
        conversation: {
          history: [{ encrypted_content: "private-continuation" }],
          pendingCallId: null,
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  let callbackCalls = 0;
  const callbacks = [
    {
      name: "ambient-callback",
      handleChainStart() {
        callbackCalls++;
      },
      handleChainEnd() {
        callbackCalls++;
      },
      handleChainError() {
        callbackCalls++;
      },
    },
  ];
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  const logs = ["log", "warn", "error"].map((method) =>
    t.mock.method(console, method as "log", () => {}),
  );
  const provider = AsyncLocalStorageProviderSingleton;
  await provider.runWithConfig({ callbacks }, async () => {
    const parent = provider.getInstance().getStore();
    parent.tracingEnabled = true;
    const result = await runner(
      new ExplorationWorkflow(new ExplorationOperations()),
      dependencies,
    ).run();
    assert.equal(result.completion, "completed");
    assert.equal(provider.getInstance().getStore(), parent);
    assert.equal(provider.getRunnableConfig().callbacks, callbacks);
    await validate(result, dependencies);
  });
  assert.equal(callbackCalls, 0);
  assert.equal(network.mock.callCount(), 0);
  assert.ok(logs.every((log) => log.mock.callCount() === 0));
});

test("environment-enabled raw framework diagnostics stop before graph or external dispatch", async (t) => {
  const dependencies = await fixture(t);
  let modelCalls = 0;
  dependencies.model = {
    async requestAction() {
      modelCalls++;
      throw new Error("Must not dispatch");
    },
  };
  const flags = [
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_VERBOSE",
  ];
  const original = flags.map((flag) => [flag, process.env[flag]] as const);
  t.after(() => {
    for (const [flag, value] of original) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  });
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  const logs = ["log", "warn", "error"].map((method) =>
    t.mock.method(console, method as "log", () => {}),
  );
  for (const flag of flags) {
    for (const other of flags)
      process.env[other] = other === flag ? "true" : "false";
    const result = await runner(
      new ExplorationWorkflow(new ExplorationOperations()),
      dependencies,
    ).run();
    assert.equal(result.completion, "incomplete", flag);
    assert.equal(result.termination.reason, "execution_error", flag);
    assert.match(result.termination.detail!, /Disable LANGSMITH_TRACING/);
    assert.equal(result.usage.modelCalls, 0);
    assert.equal(result.trace.length, 0);
    await validate(result, dependencies);
  }
  assert.equal(modelCalls, 0);
  assert.equal(network.mock.callCount(), 0);
  assert.ok(logs.every((log) => log.mock.callCount() === 0));
});
