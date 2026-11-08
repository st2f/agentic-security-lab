import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { configSchema, defaultLimits } from "../src/investigation/contracts.ts";
import type {
  Action,
  Candidate,
  ModelBudget,
  ModelInput,
  ModelReply,
} from "../src/investigation/contracts.ts";
import { defaultTask } from "../src/investigation/prompt.ts";
import type { ExplorationContext } from "../src/investigation/context.ts";
import { ExecutionScope } from "../src/investigation/ExecutionScope.ts";
import { ExplorationOperations } from "../src/investigation/ExplorationOperations.ts";
import {
  initialExplorationState,
  latestObservation,
  returnedEvidence,
} from "../src/investigation/state.ts";
import type { ExplorationState } from "../src/investigation/state.ts";
import {
  RepositoryInspector,
  serializedBytes,
} from "../src/infrastructure/repository/RepositoryInspector.ts";
import { digest } from "../src/infrastructure/repository/snapshot.ts";

const operations = new ExplorationOperations();
const read: Action = {
  name: "read_lines",
  path: "query.ts",
  startLine: 1,
  endLine: 2,
  rationale: "Inspect the lookup.",
  basedOnToolCallIds: [],
  checkpoint: null,
};
const finish = (candidates: Candidate[] = []): Action => ({
  name: "finish",
  rationale: "Finish the bounded investigation.",
  basedOnToolCallIds: [],
  candidates,
  scopeAndLimitations: [],
});

function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "investigation-operations-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "const item = lookup(id);\nreturn item;\n";
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
  const signal = new AbortController().signal;
  const context: ExplorationContext = {
    snapshot,
    config: configSchema.parse({}),
    inspector: new RepositoryInspector(snapshot),
    model: {
      async requestAction(input) {
        return { action: read, conversation: input.conversation };
      },
    },
    execution: {
      signal,
      elapsedMs: 0,
      interruption: () => null,
      bounded: (operation) => operation(signal),
    },
  };
  const state = initialExplorationState({
    runId: "operations-run",
    snapshotId: snapshot.snapshotId,
  });
  const candidate: Candidate = {
    id: "candidate-1",
    claim: "The lookup might lack tenant filtering.",
    rationale: "The call uses only an item ID.",
    supportingEvidence: [
      {
        snapshotId: snapshot.snapshotId,
        toolCallId: "tool-1",
        path: "query.ts",
        startLine: 1,
        endLine: 2,
      },
    ],
    contradictoryEvidence: [],
    uncertainties: ["The callee might enforce tenancy."],
    priorityReason: "Possible cross-tenant access.",
    nextChecks: ["Inspect the callee."],
  };
  return { root, context, state, candidate };
}

async function step(
  state: ExplorationState,
  context: ExplorationContext,
  operation: "chooseAction" | "executeAction",
) {
  const before = structuredClone(state);
  freeze(state);
  const update = await operations[operation](state, context);
  assert.deepEqual(state, before);
  return { ...state, ...update };
}

test("unexpected provider metadata objects never enter the application trace", async (t) => {
  const { state, context } = await fixture(t);
  context.model = {
    async requestAction(input) {
      return {
        action: finish(),
        conversation: input.conversation,
        actualModel: { credential: "private-sentinel" },
        usage: { inputTokens: 10, outputTokens: 5 },
      } as unknown as ModelReply;
    },
  };
  const next = await step(state, context, "chooseAction");
  assert.equal(next.trace[0]!.outcome, "ok");
  assert.equal(next.trace[0]!.actualModel, undefined);
  assert.equal(next.usage.inputTokens, 10);
  assert.equal(next.usage.tokenUsageComplete, true);
  assert.equal(JSON.stringify(next.trace).includes("private-sentinel"), false);
});

test("missing or malformed usage remains partial after a later successful request and finish", async (t) => {
  for (const usage of [
    undefined,
    { inputTokens: -1, outputTokens: 5 },
    { inputTokens: 1.5, outputTokens: 5 },
  ]) {
    const f = await fixture(t);
    let calls = 0;
    f.context.model = {
      async requestAction(input) {
        return {
          action: calls++ ? finish() : read,
          conversation: input.conversation,
          usage: calls === 1 ? usage : { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    let state = await step(f.state, f.context, "chooseAction");
    assert.equal(state.usage.tokenUsageComplete, false);
    state = await step(state, f.context, "executeAction");
    state = await step(state, f.context, "chooseAction");
    state = await step(state, f.context, "executeAction");
    assert.equal(state.termination!.reason, "model_finished");
    assert.deepEqual(state.finalCandidates, []);
    assert.equal(state.usage.modelCalls, 2);
    assert.equal(state.usage.inputTokens, 10);
    assert.equal(state.usage.outputTokens, 5);
    assert.equal(state.usage.tokenUsageComplete, false);
  }
});

test("an available reply retains known usage when cancellation prevents accepting its action", async (t) => {
  const { state, context } = await fixture(t);
  context.model = {
    async requestAction() {
      // The reply is available, but execution is interrupted before acceptance.
      context.execution.interruption = () => ({ reason: "cancelled" });
      return {
        action: finish(),
        conversation: {
          history: [{ message: "unaccepted-continuation" }],
          pendingCallId: null,
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const next = await step(state, context, "chooseAction");
  assert.equal(next.termination!.reason, "cancelled");
  assert.equal(next.action, null);
  assert.equal(next.finalCandidates, null);
  assert.deepEqual(next.conversation, state.conversation);
  assert.equal(next.trace[0]!.outcome, "stopped");
  assert.equal(next.trace[0]!.action, undefined);
  assert.equal(next.usage.inputTokens, 10);
  assert.equal(next.usage.outputTokens, 5);
  assert.equal(next.usage.tokenUsageComplete, true);
});

test("each operation counts its own call once and records one trace event", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    operations.executeAction(f.state, f.context),
    /No chosen action/,
  );
  const chosen = await step(f.state, f.context, "chooseAction");
  assert.equal(chosen.usage.modelCalls, 1);
  assert.equal(chosen.usage.toolCalls, 0);
  assert.equal(chosen.trace.length, 1);
  assert.equal(chosen.trace[0]!.outcome, "ok");
  assert.deepEqual(chosen.action, read);
  const inspected = await step(chosen, f.context, "executeAction");
  assert.equal(inspected.usage.modelCalls, 1);
  assert.equal(inspected.usage.toolCalls, 1);
  assert.equal(inspected.action, null);
  assert.equal(inspected.trace.length, 2);
  assert.equal(inspected.trace[1]!.toolCallId, "tool-1");
  assert.equal(inspected.trace[1]!.outcome, "ok");
  assert.deepEqual(inspected.trace[1]!.arguments, {
    name: "read_lines",
    path: "query.ts",
    startLine: 1,
    endLine: 2,
  });
});

test("every model call reports the remaining budget; only finish is offered when nothing could follow", async (t) => {
  const f = await fixture(t);
  const inputs: ModelInput[] = [];
  f.context.model = {
    async requestAction(input) {
      inputs.push(structuredClone(input));
      return {
        action: read,
        conversation: input.conversation,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  f.context.config = configSchema.parse({
    limits: { ...defaultLimits, modelCalls: 2 },
  });
  let state = await step(f.state, f.context, "chooseAction");
  state = await step(state, f.context, "executeAction");
  state = await step(state, f.context, "chooseAction");
  const budgets = inputs.map((input) => input.message.budget as ModelBudget);
  assert.deepEqual(
    budgets.map((budget) => [budget.modelCallsLeft, budget.toolCallsLeft]),
    [
      [1, defaultLimits.toolCalls],
      [0, defaultLimits.toolCalls - 1],
    ],
  );
  assert.equal(
    budgets[1]!.toolResponseBytesLeft,
    defaultLimits.totalToolResponseBytes - state.usage.toolResponseBytes,
  );
  assert.equal(inputs[0]!.message.task, defaultTask);
  assert.equal(inputs[1]!.message.toolCallId, "tool-1");
  assert.deepEqual(inputs[0]!.allowedActions, [
    "list_files",
    "search_text",
    "read_lines",
    "finish",
  ]);
  assert.deepEqual(inputs[1]!.allowedActions, ["finish"]);
  // A model ignoring the restriction gains one inspection, never another model call.
  assert.equal(state.termination, null);
  state = await step(state, f.context, "executeAction");
  assert.equal(state.usage.toolCalls, 2);
  state = await step(state, f.context, "chooseAction");
  assert.deepEqual(state.termination, {
    reason: "budget_exhausted",
    limit: "modelCalls",
  });
  assert.equal(state.usage.modelCalls, 2);

  // With no tool calls left, only finish is offered and an inspection is refused.
  f.context.config = configSchema.parse({});
  let toolLimited = await step(
    { ...f.state, usage: { ...f.state.usage, toolCalls: 40 } },
    f.context,
    "chooseAction",
  );
  assert.deepEqual(inputs.at(-1)!.allowedActions, ["finish"]);
  toolLimited = await step(toolLimited, f.context, "executeAction");
  assert.deepEqual(toolLimited.termination, {
    reason: "budget_exhausted",
    limit: "toolCalls",
  });
  assert.equal(toolLimited.usage.toolCalls, 40);
});

test("operations return updates over frozen state without retaining progress or exposing trusted config to models", async (t) => {
  const f = await fixture(t);
  f.context.model = {
    async requestAction(input) {
      input.message.maxCandidates = 100;
      input.conversation.history.push({
        role: "user",
        content: input.snapshotId,
      });
      return {
        action: read,
        conversation: input.conversation,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const other = { ...f.state, runId: "other-run" };
  const [first, second] = await Promise.all([
    step(f.state, f.context, "chooseAction"),
    step(other, f.context, "chooseAction"),
  ]);
  assert.equal(first.usage.modelCalls, 1);
  assert.equal(second.usage.modelCalls, 1);
  assert.equal(first.trace[0]!.id, "event-1");
  assert.equal(second.trace[0]!.id, "event-1");
  assert.deepEqual(f.state.conversation.history, []);
  assert.equal(f.context.config.maxCandidates, 3);
  const inspected = await step(first, f.context, "executeAction");
  assert.equal(inspected.usage.toolCalls, 1);
  assert.equal(
    inspected.usage.toolResponseBytes,
    serializedBytes(latestObservation(inspected)),
  );
  assert.equal(
    returnedEvidence(inspected).get("tool-1")!.get("query.ts")!.size,
    2,
  );
  assert.equal(second.usage.toolCalls, 0);
  assert.equal(second.trace.length, 1);
});

test("operations preserve first termination and enforce time and call limits before dispatch", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.context.model = {
    async requestAction() {
      calls++;
      throw new Error("must not dispatch");
    },
  };
  f.context.inspector = {
    async execute() {
      calls++;
      throw new Error("must not inspect");
    },
  };
  const stopped = {
    ...f.state,
    termination: { reason: "model_error" as const },
  };
  f.context.execution.interruption = () => ({ reason: "cancelled" });
  assert.equal(
    (await step(stopped, f.context, "chooseAction")).termination!.reason,
    "model_error",
  );
  assert.equal(
    (await step(f.state, f.context, "chooseAction")).termination!.reason,
    "cancelled",
  );
  f.context.execution.interruption = () => null;
  const modelLimited = await step(
    { ...f.state, usage: { ...f.state.usage, modelCalls: 12 } },
    f.context,
    "chooseAction",
  );
  assert.equal(modelLimited.termination!.limit, "modelCalls");
  assert.equal(modelLimited.trace.length, 0);
  assert.equal(calls, 0);
});

test("untrusted model fields and unread candidate replacements cannot overwrite authoritative progress", async (t) => {
  const f = await fixture(t);
  for (const action of [
    {
      ...finish(),
      usage: { modelCalls: 0 },
      termination: { reason: "model_finished" },
    },
    { ...read, checkpoint: [f.candidate] },
    { ...read, basedOnToolCallIds: ["invented-tool"] },
  ]) {
    f.context.model = {
      async requestAction(input) {
        return {
          action,
          conversation: input.conversation,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const state = await step(f.state, f.context, "chooseAction");
    assert.equal(state.termination!.reason, "invalid_model_output");
    assert.equal(state.action, null);
    assert.deepEqual(state.provisionalCandidates, []);
    assert.equal(state.usage.modelCalls, 1);
    assert.equal(state.usage.inputTokens, 10);
    assert.equal(state.usage.tokenUsageComplete, true);
    assert.equal(state.trace[0]!.outcome, "error");
  }
});

test("denied inspection is a bounded observation and final acceptance adds no tool accounting", async (t) => {
  const f = await fixture(t);
  const denied = await step(
    { ...f.state, action: { ...read, path: "../outside" } },
    f.context,
    "executeAction",
  );
  assert.equal(denied.termination, null);
  assert.equal(denied.trace[0]!.outcome, "error");
  assert.equal(latestObservation(denied)!.result.kind, "error");
  assert.equal(denied.usage.toolCalls, 1);
  assert.equal(
    denied.usage.toolResponseBytes,
    serializedBytes(latestObservation(denied)),
  );
  assert.equal(returnedEvidence(denied).get("tool-1")!.size, 0);

  let inspected = await step(
    { ...f.state, action: read },
    f.context,
    "executeAction",
  );
  inspected = {
    ...inspected,
    action: finish([f.candidate]),
    provisionalCandidates: [f.candidate],
  };
  const originalUsage = structuredClone(inspected.usage);
  const accepted = await step(inspected, f.context, "executeAction");
  assert.equal(accepted.termination!.reason, "model_finished");
  assert.deepEqual(accepted.finalCandidates, [f.candidate]);
  assert.deepEqual(accepted.usage, originalUsage);
  assert.equal(accepted.trace.length, 1);
  const unread = await step(
    {
      ...inspected,
      action: finish([{ ...f.candidate, id: "x" }, f.candidate]),
    },
    { ...f.context, config: configSchema.parse({ maxCandidates: 1 }) },
    "executeAction",
  );
  assert.equal(unread.termination!.reason, "invalid_model_output");
  assert.equal(unread.finalCandidates, null);
  assert.deepEqual(unread.provisionalCandidates, [f.candidate]);
});

test("response budgets count failed inspection attempts without exposing oversized data", async (t) => {
  const f = await fixture(t);
  f.context.config = configSchema.parse({
    limits: {
      ...defaultLimits,
      toolResponseBytes: 512,
      totalToolResponseBytes: 512,
    },
  });
  f.context.inspector = new RepositoryInspector(f.context.snapshot, 512);
  const state = {
    ...f.state,
    action: read,
    usage: { ...f.state.usage, toolResponseBytes: 300 },
  };
  const result = await step(state, f.context, "executeAction");
  assert.equal(result.termination!.reason, "budget_exhausted");
  assert.equal(result.termination!.limit, "totalToolResponseBytes");
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.toolResponseBytes, 300);
  assert.equal(result.trace[0]!.result, undefined);
});

test("cancellation between scheduling and invocation dispatches and counts nothing", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const execution = new ExecutionScope(1000);
  execution.start(controller.signal);
  t.after(() => execution.dispose());
  f.context.execution = execution;
  let calls = 0;
  f.context.model = {
    async requestAction(input) {
      calls++;
      return { action: finish(), conversation: input.conversation };
    },
  };
  freeze(f.state);
  const pending = operations.chooseAction(f.state, f.context);
  controller.abort();
  const update = await pending;
  assert.equal(calls, 0);
  assert.equal(update.termination!.reason, "cancelled");
  assert.equal(update.usage, undefined);
  assert.equal(update.trace, undefined);
  assert.equal(update.action, null);
});

test("late noncooperating model responses cannot mutate returned updates or frozen input state", async (t) => {
  const f = await fixture(t);
  let release!: (reply: ModelReply) => void;
  f.context.model = {
    requestAction: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const execution = new ExecutionScope(30);
  execution.start();
  t.after(() => execution.dispose());
  f.context.execution = execution;
  const result = await step(f.state, f.context, "chooseAction");
  assert.equal(result.termination!.limit, "elapsedMs");
  assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.usage.tokenUsageComplete, false);
  const published = structuredClone(result);
  release({
    action: finish(),
    conversation: {
      history: [{ role: "user", content: "late" }],
      pendingCallId: null,
    },
    usage: { inputTokens: 999, outputTokens: 999 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(result, published);
  assert.deepEqual(f.state.conversation.history, []);
});
