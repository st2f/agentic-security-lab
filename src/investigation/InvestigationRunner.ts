import type { RunResult } from "./contracts.ts";
import type {
  InvestigationContext,
  InvestigationDependencies,
} from "./context.ts";
import { ExecutionScope } from "./ExecutionScope.ts";
import { projectRunResult, projectInvestigationProgress } from "./state.ts";
import type { InvestigationState, InvestigationProgress } from "./state.ts";

/** Execution boundary; the runner does not depend on LangGraph APIs. */
export interface InvestigationWorkflow {
  run(
    state: InvestigationState,
    context: InvestigationContext,
    observe: (state: InvestigationProgress) => void,
  ): Promise<InvestigationProgress>;
}

/** Execute one investigation and project the last committed graph state. */
export class InvestigationRunner {
  private readonly initialState: InvestigationState;
  private readonly workflow: InvestigationWorkflow;
  private readonly dependencies: InvestigationDependencies;
  private started = false;

  constructor(
    initialState: InvestigationState,
    workflow: InvestigationWorkflow,
    dependencies: InvestigationDependencies,
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
    let state = projectInvestigationProgress(this.initialState);
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
