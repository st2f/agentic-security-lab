import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { ExecutionScope } from "../src/investigation/ExecutionScope.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("execution starts its clock and timer explicitly, closes once, and freezes elapsed time", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const schedule = t.mock.method(globalThis, "setTimeout");
  const clear = t.mock.method(globalThis, "clearTimeout");
  const controller = new AbortController();
  const scope = new ExecutionScope(10_000);
  t.after(() => scope.dispose());
  assert.equal(scope.elapsedMs, 0);
  assert.equal(schedule.mock.callCount(), 0);
  let entered = false;
  await assert.rejects(
    scope.bounded(async () => {
      entered = true;
    }),
    /not started/,
  );
  now = 5000;
  scope.start(controller.signal);
  assert.equal(scope.elapsedMs, 0);
  assert.equal(schedule.mock.callCount(), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  assert.throws(() => scope.start(), /already started/);
  now = 5040;
  scope.dispose();
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(
    clear.mock.calls[0]!.arguments[0],
    schedule.mock.calls[0]!.result,
  );
  assert.equal(scope.signal.reason, "disposed");
  assert.equal(scope.elapsedMs, 40);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  now = 9000;
  controller.abort();
  assert.equal(scope.signal.reason, "disposed");
  assert.equal(scope.elapsedMs, 40);
  scope.dispose();
  assert.equal(clear.mock.callCount(), 1);
  assert.throws(() => scope.start(), /disposed/);
  await assert.rejects(
    scope.bounded(async () => {
      entered = true;
    }),
    /disposed/,
  );
  assert.equal(entered, false);
});

test("bounded work removes its abort listener on both success and rejection", async (t) => {
  const controller = new AbortController();
  const scope = new ExecutionScope(10_000);
  t.after(() => scope.dispose());
  scope.start(controller.signal);
  const value = await scope.bounded(async (signal) => {
    assert.equal(signal, scope.signal);
    assert.equal(getEventListeners(signal, "abort").length, 1);
    return "result";
  });
  assert.equal(value, "result");
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  const error = new Error("operation failed");
  await assert.rejects(
    scope.bounded(async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
});

test("deadline interrupts noncooperating work and cleans listeners without waiting for it to settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const scope = new ExecutionScope(100);
  t.after(() => scope.dispose());
  scope.start(controller.signal);
  const entered = deferred<void>();
  const pending = scope.bounded(() => {
    entered.resolve(undefined);
    return new Promise<never>(() => {});
  });
  await entered.promise;
  const stopped = assert.rejects(pending, (reason) => reason === "deadline");
  t.mock.timers.tick(100);
  await stopped;
  assert.deepEqual(scope.interruption(), {
    reason: "budget_exhausted",
    limit: "elapsedMs",
  });
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  scope.dispose();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("disposing a scope interrupts outstanding waits, blocks queued work, and consumes late rejection", async (t) => {
  const scope = new ExecutionScope(10_000);
  t.after(() => scope.dispose());
  scope.start();
  const entered = deferred<void>();
  const operation = deferred<string>();
  const pending = scope.bounded(() => {
    entered.resolve(undefined);
    return operation.promise;
  });
  await entered.promise;
  let queuedCalls = 0;
  const queued = scope.bounded(async () => {
    queuedCalls++;
  });
  const stopped = assert.rejects(pending, (reason) => reason === "disposed");
  const skipped = assert.rejects(queued);
  scope.dispose();
  await Promise.all([stopped, skipped]);
  assert.equal(queuedCalls, 0);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  operation.reject(new Error("late operation failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
});

test("clock expiry before dispatch and an already-cancelled signal enter no operation", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const expired = new ExecutionScope(10_000);
  const cancelled = new ExecutionScope(10_000);
  t.after(() => {
    expired.dispose();
    cancelled.dispose();
  });
  expired.start();
  now = 10_001;
  let calls = 0;
  await assert.rejects(
    expired.bounded(async () => {
      calls++;
    }),
  );
  assert.equal(expired.signal.reason, "deadline");
  const controller = new AbortController();
  controller.abort();
  cancelled.start(controller.signal);
  await assert.rejects(
    cancelled.bounded(async () => {
      calls++;
    }),
  );
  assert.equal(cancelled.signal.reason, "cancelled");
  assert.equal(calls, 0);
});
