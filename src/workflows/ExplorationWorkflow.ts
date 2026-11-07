import { END, START, StateGraph } from "@langchain/langgraph";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { z } from "zod";
import { configSchema } from "../investigation/contracts.ts";
import type { InvestigationContext } from "../investigation/context.ts";
import type { InvestigationOperations } from "../investigation/InvestigationOperations.ts";
import {
  investigationProgressSchema,
  projectInvestigationProgress,
} from "../investigation/state.ts";
import type {
  InvestigationState,
  InvestigationProgress,
} from "../investigation/state.ts";
import { InvestigationGraphState } from "./investigation-state.ts";

// Live services are invocation context, not serializable progress channels.
const contextSchema = z.object({
  config: configSchema,
  snapshot: z.custom<InvestigationContext["snapshot"]>(),
  model: z.custom<InvestigationContext["model"]>(),
  inspector: z.custom<InvestigationContext["inspector"]>(),
  execution: z.custom<InvestigationContext["execution"]>(),
});

// Framework diagnostics receive raw node input, independently of stream filtering.
const rawDiagnosticsFlags = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_VERBOSE",
];
const progressKeys = Object.keys(
  investigationProgressSchema.shape,
) as (keyof InvestigationProgress)[];

function invocationContext(runtime: {
  context?: InvestigationContext;
}): InvestigationContext {
  if (!runtime.context) throw new Error("Investigation context is required");
  return runtime.context;
}

/**
 * One compiled graph; all run-specific dependencies arrive through runtime context.
 * The loop is `choose_action → execute_action → choose_action`, ending on termination.
 */
export class ExplorationWorkflow {
  private readonly graph;

  constructor(operations: InvestigationOperations) {
    const next =
      (node: "choose_action" | "execute_action") =>
      (state: InvestigationState) => (state.termination ? END : node);
    this.graph = new StateGraph(InvestigationGraphState, {
      context: contextSchema,
    })
      .addNode("choose_action", (state, runtime) =>
        operations.chooseAction(state, invocationContext(runtime)),
      )
      .addNode("execute_action", (state, runtime) =>
        operations.executeAction(state, invocationContext(runtime)),
      )
      .addEdge(START, "choose_action")
      .addConditionalEdges("choose_action", next("execute_action"), [
        END,
        "execute_action",
      ])
      .addConditionalEdges("execute_action", next("choose_action"), [
        END,
        "choose_action",
      ])
      .compile();
  }

  async run(
    initialState: InvestigationState,
    context: InvestigationContext,
    observe: (state: InvestigationProgress) => void,
  ): Promise<InvestigationProgress> {
    if (rawDiagnosticsFlags.some((flag) => process.env[flag] === "true")) {
      return {
        ...projectInvestigationProgress(initialState),
        termination: initialState.termination ?? {
          reason: "execution_error",
          detail:
            "Disable LANGSMITH_TRACING, LANGSMITH_TRACING_V2, LANGCHAIN_TRACING, LANGCHAIN_TRACING_V2, and LANGCHAIN_VERBOSE before running investigations.",
        },
      };
    }
    // Drop inherited runnable callbacks, trace trees and context-variable hooks.
    // This scope is async-local: concurrent callers' configuration is unchanged.
    return AsyncLocalStorageProviderSingleton.getInstance().run(
      undefined,
      async () => {
        let state = projectInvestigationProgress(initialState);
        const stream = await this.graph.stream(initialState, {
          context: Object.freeze({ ...context }),
          callbacks: [],
          streamMode: "values",
          outputKeys: progressKeys,
          // Two nodes per model round, plus a final budget check and routing margin.
          recursionLimit: context.config.limits.modelCalls * 2 + 2,
        });
        for await (const current of stream) {
          state = projectInvestigationProgress(current);
          // Observers cannot mutate the recovery view retained by this invocation.
          observe(structuredClone(state));
        }
        return state;
      },
    );
  }
}
