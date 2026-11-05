import type { Termination } from "./contracts.ts";

/** Invocation resources available to operations; contains no investigation progress. */
export interface ExecutionControl {
  readonly signal: AbortSignal;
  readonly elapsedMs: number;
  interruption(): Termination | null;
  bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** Owns the monotonic clock, deadline, cancellation, and bounded waiting. */
export class ExecutionScope implements ExecutionControl {
  private readonly limitMs: number;
  private readonly controller = new AbortController();
  private started?: number;
  private ended?: number;
  private disposed = false;
  private externalSignal?: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly cancel = () => this.controller.abort("cancelled");

  constructor(limitMs: number) {
    this.limitMs = limitMs;
  }

  start(signal?: AbortSignal): void {
    if (this.disposed) throw new Error("Execution is disposed");
    if (this.started !== undefined)
      throw new Error("Execution already started");
    this.started = performance.now();
    this.externalSignal = signal;
    this.timer = setTimeout(
      () => this.controller.abort("deadline"),
      this.limitMs,
    );
    signal?.addEventListener("abort", this.cancel, { once: true });
    if (signal?.aborted) this.cancel();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get elapsedMs(): number {
    return this.started === undefined
      ? 0
      : (this.ended ?? performance.now()) - this.started;
  }

  interruption(): Termination | null {
    if (this.started === undefined || this.disposed)
      return { reason: "execution_error" };
    if (this.externalSignal?.aborted) return { reason: "cancelled" };
    if (this.signal.aborted || this.elapsedMs >= this.limitMs) {
      this.controller.abort("deadline");
      return { reason: "budget_exhausted", limit: "elapsedMs" };
    }
    return null;
  }

  async bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    this.interruption();
    this.signal.throwIfAborted();
    let aborted!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      return await Promise.race([
        interrupted,
        Promise.resolve().then(() => {
          // Cancellation may arrive between scheduling and entering the operation.
          this.assertActive();
          this.interruption();
          this.signal.throwIfAborted();
          return operation(this.signal);
        }),
      ]);
    } finally {
      // Cleanup follows bounded waiting, even when the underlying work never settles.
      this.signal.removeEventListener("abort", aborted);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.externalSignal?.removeEventListener("abort", this.cancel);
    this.externalSignal = undefined;
    this.controller.abort("disposed");
    if (this.started !== undefined) this.ended = performance.now();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Execution is disposed");
    if (this.started === undefined)
      throw new Error("Execution has not started");
  }
}
