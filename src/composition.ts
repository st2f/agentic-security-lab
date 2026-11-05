import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ActionModel } from "./investigation/ActionModel.ts";
import { configSchema } from "./investigation/contracts.ts";
import { InvestigationRunner } from "./investigation/InvestigationRunner.ts";
import { InvestigationOperations } from "./investigation/InvestigationOperations.ts";
import { initialInvestigationState } from "./investigation/state.ts";
import { OpenAIActionModel } from "./infrastructure/ai/OpenAIActionModel.ts";
import { ExplorationWorkflow } from "./workflows/ExplorationWorkflow.ts";
import { RepositoryInspector } from "./infrastructure/repository/RepositoryInspector.ts";
import type { Snapshot } from "./infrastructure/repository/snapshot.ts";

/** Assemble a production investigation with a fresh model conversation. */
export function createInvestigation(
  snapshot: Snapshot,
  configuration: unknown,
  modelOptions: { apiKey: string; fetch?: typeof globalThis.fetch },
): InvestigationRunner {
  const client = new OpenAI({ ...modelOptions, maxRetries: 0 });
  const model = new OpenAIActionModel(client);
  return createInvestigationWithModel(snapshot, configuration, model);
}

/** Assemble one run; deterministic evaluations supply a scripted model here. */
export function createInvestigationWithModel(
  snapshot: Snapshot,
  configuration: unknown,
  model: ActionModel,
): InvestigationRunner {
  const config = configSchema.parse(configuration);
  const inspector = new RepositoryInspector(
    snapshot,
    config.limits.toolResponseBytes,
  );
  const operations = new InvestigationOperations();
  const workflow = new ExplorationWorkflow(operations);
  const state = initialInvestigationState({
    runId: randomUUID(),
    snapshotId: snapshot.snapshotId,
  });
  return new InvestigationRunner(state, workflow, {
    snapshot,
    config,
    model,
    inspector,
  });
}
