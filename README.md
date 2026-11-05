# Agentic Security Investigation Lab

A small TypeScript application for learning agentic orchestration through security investigation of source repositories. One model chooses what to inspect, follows evidence, revises hypotheses, and decides when to finish. LangGraph coordinates execution; application code enforces access, budgets, and evidence rules.

The current application performs read-only source exploration and produces prioritized security hypotheses with source references and uncertainty. The [project brief](./docs/project-brief.md) defines the learning goals, intended investigation process and six development milestones.

## How an investigation works

1. The CLI copies permitted files from a Git commit into an isolated source snapshot.
2. The model requests a file listing, literal search, or line-range read, with a short rationale.
3. The application validates the request, performs bounded inspection, and returns the observation. The model uses it to choose another action or revise its candidates.
4. When the model submits its assessment, the application checks the evidence and saves a trace, usage totals, and a Markdown report. Interrupted runs preserve available progress.

The sequence of searches and reads comes from model decisions. The [architecture](./docs/architecture.md) explains how components, graph state, and execution policy make this work. The [inventory experiment](./docs/experiments/milestone-1.md) shows recorded decisions, an initial failure, and the resulting fix.

## Run locally

Use Node.js 24 or higher and npm:

```sh
npm ci
npm run typecheck
npm test
npm run format:check
```

Tests use local fixtures, scripted models, and mocked HTTP; they require no API credentials. `npm run format` applies Prettier.

For a live investigation, supply `OPENAI_API_KEY` through the environment or a local `.env`; existing environment values take precedence. Live runs use the configured API account.

```sh
npm run investigate -- \
  --repo . \
  --commit <full-40-character-commit-id> \
  --subtree fixtures/inventory-api \
  --question 'Can authenticated users read inventory belonging to another tenant?'
```

Choose a commit containing the fixture. The snapshot uses committed blobs, so local edits and untracked files are excluded. For this lab, expose only `fixtures/inventory-api/`; the rest of the repository includes evaluator answers and experiment results.

Omit `--question` for open exploration. Other options are:

| Option                          | Default                                   |
| ------------------------------- | ----------------------------------------- |
| `--model`, `--reasoning`        | `gpt-6-luna`, `medium`                    |
| `--max-candidates`              | 3 final hypotheses; accepted range 1–10   |
| `--model-calls`, `--tool-calls` | 12 model attempts, 40 inspection attempts |
| `--elapsed-ms`                  | 180,000 milliseconds                      |
| `--output`                      | `priv/runs`                               |

Tool-response limits default to 16 KiB per envelope and 256 KiB cumulatively. These are configurable through programmatic `limits`; the CLI exposes the options above.

Unset `LANGSMITH_TRACING`, `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING`, `LANGCHAIN_TRACING_V2`, and `LANGCHAIN_VERBOSE`, or set them to `false`. A value of `true` stops the investigation before dispatch to prevent raw framework diagnostics from exposing internal conversation.

## Read or regenerate a report

Each run creates a directory containing `source/`, `manifest.json`, `run.json`, and, after successful validation, `report.md`. The trace contains inspected source and model prose; choose its storage accordingly.

Regenerate a saved report without credentials or model calls:

```sh
npm run report -- --run <saved-run-directory>/run.json
```

Keep the matching manifest and source snapshot beside the JSON. SIGINT requests cancellation; an incomplete run or report-generation failure exits with status 1. JSON is saved before report rendering, so a report failure preserves the investigation result.

A completed empty assessment differs from an incomplete run with provisional candidates. Neither establishes that the repository is secure, and valid source references do not by themselves establish exploitability.
