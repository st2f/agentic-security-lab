import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ActionModel } from "./investigation/ActionModel.ts";
import { configSchema } from "./investigation/contracts.ts";
import { ExplorationRunner } from "./investigation/ExplorationRunner.ts";
import { ExplorationOperations } from "./investigation/ExplorationOperations.ts";
import { initialExplorationState } from "./investigation/state.ts";
import { OpenAIActionModel } from "./infrastructure/ai/OpenAIActionModel.ts";
import { ExplorationWorkflow } from "./workflows/ExplorationWorkflow.ts";
import { RepositoryInspector } from "./infrastructure/repository/RepositoryInspector.ts";
import type { Snapshot } from "./infrastructure/repository/snapshot.ts";

/** Assemble a production investigation with a fresh model conversation. */
export function createExploration(
  snapshot: Snapshot,
  configuration: unknown,
  modelOptions: { apiKey: string; fetch?: typeof globalThis.fetch },
): ExplorationRunner {
  const client = new OpenAI({ ...modelOptions, maxRetries: 0 });
  const model = new OpenAIActionModel(client);
  return createExplorationWithModel(snapshot, configuration, model);
}

/** Assemble one run; deterministic evaluations supply a scripted model here. */
export function createExplorationWithModel(
  snapshot: Snapshot,
  configuration: unknown,
  model: ActionModel,
): ExplorationRunner {
  const config = configSchema.parse(configuration);
  const inspector = new RepositoryInspector(
    snapshot,
    config.limits.toolResponseBytes,
  );
  const operations = new ExplorationOperations();
  const workflow = new ExplorationWorkflow(operations);
  const state = initialExplorationState({
    runId: randomUUID(),
    snapshotId: snapshot.snapshotId,
  });
  return new ExplorationRunner(state, workflow, {
    snapshot,
    config,
    model,
    inspector,
  });
}
