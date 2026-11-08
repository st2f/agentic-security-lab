import type { ActionModel } from "./ActionModel.ts";
import type { RunConfig } from "./contracts.ts";
import type { ExecutionControl } from "./ExecutionScope.ts";
import type { RepositoryInspector } from "../infrastructure/repository/RepositoryInspector.ts";
import type { Snapshot } from "../infrastructure/repository/snapshot.ts";

/** Trusted dependencies and execution capability, separate from evolving state. */
export type ExplorationContext = {
  config: RunConfig;
  snapshot: Snapshot;
  model: ActionModel;
  inspector: Pick<RepositoryInspector, "execute">;
  execution: ExecutionControl;
};

export type ExplorationDependencies = Omit<ExplorationContext, "execution">;
