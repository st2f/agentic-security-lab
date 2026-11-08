import type { RunResult } from "./contracts.ts";
import type { ExplorationContext, ExplorationDependencies } from "./context.ts";
import { ExecutionScope } from "./ExecutionScope.ts";
import { projectRunResult, projectExplorationProgress } from "./state.ts";
import type { ExplorationState, ExplorationProgress } from "./state.ts";

/** Execution boundary; the runner does not depend on LangGraph APIs. */
export interface ExplorationLoop {
  run(
    state: ExplorationState,
    context: ExplorationContext,
    observe: (state: ExplorationProgress) => void,
  ): Promise<ExplorationProgress>;
}

/** Execute one investigation and project the last committed graph state. */
export class ExplorationRunner {
  private readonly initialState: ExplorationState;
  private readonly workflow: ExplorationLoop;
  private readonly dependencies: ExplorationDependencies;
  private started = false;

  constructor(
    initialState: ExplorationState,
    workflow: ExplorationLoop,
    dependencies: ExplorationDependencies,
  ) {
    this.initialState = structuredClone(initialState);
    this.workflow = workflow;
    this.dependencies = dependencies;
  }

  async run(signal?: AbortSignal): Promise<RunResult> {
    if (this.started) throw new Error("An investigation can only run once");
    this.started = true;
    const execution = new ExecutionScope(
      this.dependencies.config.limits.elapsedMs,
    );
    let state = projectExplorationProgress(this.initialState);
    let acceptingUpdates = true;
    try {
      execution.start(signal);
      state = await this.workflow.run(
        this.initialState,
        { ...this.dependencies, execution },
        (committed) => {
          if (acceptingUpdates) state = committed;
        },
      );
    } catch {
      // An abort callback must not replace committed progress during recovery.
      acceptingUpdates = false;
      state = {
        ...state,
        termination: state.termination ??
          execution.interruption() ?? { reason: "execution_error" },
      };
    } finally {
      // Disposal can synchronously notify listeners; stop observing first.
      acceptingUpdates = false;
      execution.dispose();
    }
    const { config, snapshot } = this.dependencies;
    return projectRunResult(
      state,
      {
        request: {
          ...config,
          provider: "openai",
          commit: snapshot.commit,
          subtree: snapshot.subtree,
        },
        exclusions: snapshot.skipped,
      },
      execution.elapsedMs,
    );
  }
}
