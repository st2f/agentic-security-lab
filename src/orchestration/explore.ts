import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type {
  Action,
  RequestAction,
  RunResult,
} from "../investigation/contract.ts";
import { createInvestigationSession } from "../investigation/session.ts";
import type { Snapshot } from "../repository/snapshot.ts";

export async function explore(
  snapshot: Snapshot,
  config: unknown,
  model: RequestAction,
  signal?: AbortSignal,
): Promise<RunResult> {
  const session = createInvestigationSession(snapshot, config, model, signal);
  try {
    const state = new StateSchema({
      run: z.custom<RunResult>(),
      action: z.custom<Action | null>(),
    });
    const graph = new StateGraph(state)
      .addNode("choose_action", async () => ({
        run: session.result,
        action: await session.ask(),
      }))
      .addNode("execute_action", async (current) => {
        await session.act(current.action);
        return { run: session.result, action: null };
      })
      .addEdge(START, "choose_action")
      .addConditionalEdges(
        "choose_action",
        () => (session.stopped() ? END : "execute_action"),
        [END, "execute_action"],
      )
      .addConditionalEdges(
        "execute_action",
        () => (session.stopped() ? END : "choose_action"),
        [END, "choose_action"],
      )
      .compile();
    await graph.invoke(
      { run: session.result, action: null },
      {
        recursionLimit: session.result.request.limits.modelCalls * 2 + 4,
      },
    );
  } catch {
    session.fail();
  } finally {
    session.close();
  }
  return session.result;
}
