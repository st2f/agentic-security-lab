# Agentic Security Investigation Lab

A TypeScript learning lab for bounded, model-directed security investigation of source repositories. The model chooses what to inspect and which hypotheses to pursue; application code controls access, budgets, evidence integrity, and termination. LangGraph coordinates the exploration loop.

Milestone 1 supports targeted questions and open exploration using one model and read-only file listing, literal text search, and line-range reading. Each run retains a source snapshot, action trace, prioritized hypotheses, usage, and a Markdown report. Security conclusions remain bounded by the inspected source and recorded uncertainties; runtime verification is deferred.

## Start locally

Use Node.js 24 or higher and npm. The recorded demonstration used Node.js 24.7.0 and npm 11.19.1.

```sh
npm ci
npm run typecheck
npm test
npm run format:check
```

For a live investigation, supply `OPENAI_API_KEY` through the environment or a local `.env`. Run the controlled fixture using a full commit ID that contains it:

```sh
npm run investigate -- \
  --repo . \
  --commit <full-commit-id> \
  --subtree fixtures/inventory-api \
  --question 'Can authenticated users read inventory belonging to another tenant?'
```

Omit `--question` for open exploration. The initial model is `gpt-6-luna` with medium reasoning. The CLI writes local artifacts under the ignored `priv/runs/` directory. Live investigations use the configured API account; deterministic tests and saved-report rendering do not make model requests.

The fixture experiment exposes only `fixtures/inventory-api/`. Its evaluator expectations remain outside that source boundary.

## Read the experiment

The [milestone 1 experiment](./docs/experiments/milestone-1.md) records the protocol, outcomes, hypotheses, traces, limits, and lessons from targeted and open fixture exploration. Retained reports can be regenerated locally without API credentials.

## Design and development

- [Project brief](./specs/project-brief.md)
- [Milestone 1 scope and steps](./specs/milestone-1.md)
- [Repository snapshots and inspection tools](./docs/repository-inspection.md)
- [Exploration loop and CLI configuration](./docs/exploration-loop.md)
- [Report validation and rendering](./docs/reporting.md)

Run `npm run format` to apply Prettier. Use the Prettier VS Code extension with format on save for the same local formatting rules.
