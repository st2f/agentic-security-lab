# Application architecture

This document follows one investigation from assembly to saved result. The implementation uses ordinary TypeScript classes and constructor injection. LangGraph owns progress and routing; application operations enforce investigation policy.

## Assembly and responsibilities

Start at [`src/composition.ts`](../src/composition.ts). `createInvestigation` constructs the SDK client and model adapter, then delegates to `createInvestigationWithModel`. That function validates configuration, builds the inspector, operations, graph and initial state, and returns a single-use runner. Tests use the same assembly with a scripted model. Construction starts no timer, cancellation listener, or model request.

| Component | Responsibility |
| --- | --- |
| [CLI](../src/cli.ts) | Prepare the snapshot, assemble and run the investigation, save JSON, then request a report |
| [InvestigationRunner](../src/investigation/InvestigationRunner.ts) | Start execution resources, retain committed progress for failure recovery, clean up and project the result |
| [ExplorationWorkflow](../src/workflows/ExplorationWorkflow.ts) | Compile nodes and conditional routes; supply invocation dependencies through runtime context |
| [InvestigationOperations](../src/investigation/InvestigationOperations.ts) | Read explicit state/context and return updates: validate actions, enforce limits, inspect source and accept completion |
| [OpenAIActionModel](../src/infrastructure/ai/OpenAIActionModel.ts) | Translate conversation data and tool schemas into provider requests; return action, continuation and usage |
| [RepositoryInspector](../src/infrastructure/repository/RepositoryInspector.ts) | Provide bounded listing, literal search and reading inside the prepared source boundary |
| [ReportValidator](../src/reporting/ReportValidator.ts), [ReportRenderer](../src/reporting/ReportRenderer.ts) and [saved-report I/O](../src/reporting/saved-report.ts) | Independently validate saved artifacts and evidence, render Markdown and write the report |

[Contracts](../src/investigation/contracts.ts) define actions, configuration, candidates and results. Zod validates untrusted data at runtime; TypeScript types alone cannot validate model output. A DI container or additional application framework would add machinery to this small constructor graph without replacing its investigation rules.

## One exploration round

The workflow is the standard two-node agent loop, `choose_action → execute_action → choose_action`, ending when `state.termination` is set:

1. `choose_action` checks interruption and the model-call limit, then requests an action. It validates the reply's structure, cited tool-call IDs and any candidate replacement, and returns updated conversation, usage and trace.
2. `execute_action` performs one bounded inspection, or accepts the final assessment after checking candidate counts and evidence.

For example, reading a function may lead the model to search for its callers or inspect a referenced implementation. The application supplies permitted operations and validates evidence; it does not choose that follow-up or prescribe a file order.

Every model request carries a `remainingBudget`: model calls after this one, inspections, response bytes and milliseconds. When no later model call could use another observation, because this is the last model call or no inspections remain, the budget is marked `finishOnly`. The adapter then forces the `finish` tool at the provider. If a model still requests an inspection on such a turn, the application keeps its validated checkpoint and ends the run as `budget_exhausted`. Each model call yields at most one inspection, so with the default limits the model-call limit is reached first.

A call is counted and traced when it is dispatched. Interruption observed before dispatch creates no event and no count. Each node returns its whole update at the end, so a node that fails unexpectedly leaves the last committed state, without an entry for its call.

## State, dependencies and lifecycle

[InvestigationState](../src/investigation/state.ts) contains identity, the chosen action, provisional/final candidates, termination, limitations, usage, trace and conversation continuation. The [LangGraph schema](../src/workflows/investigation-state.ts) uses replacement channels. Latest observations and tool-ID/path/line visibility derive from accepted trace results; operations retain no mutable progress fields.

[Runtime context](../src/investigation/context.ts) carries fixed references to validated configuration, snapshot, model, inspector and execution capability. SDK clients and credentials stay outside graph state. The adapter holds only its client: each request receives conversation history and provider-call correlation, then returns detached JSON continuation. Independent invocations can reuse stateless operations and a compiled graph with separate state and context.

`InvestigationRunner.run(signal?)` starts an [ExecutionScope](../src/investigation/ExecutionScope.ts) with a monotonic clock, deadline and cancellation signal. Bounded waiting returns on interruption even when external work ignores cancellation. Late replies cannot introduce accepted actions or evidence. Cleanup in `finally` seals the observer, clears timers/listeners, aborts remaining waits, blocks later dispatch and freezes elapsed time.

The runner retains an `InvestigationProgress` view of committed state for unexpected failures. This view excludes conversation, the chosen action and live dependencies. It is used to project an incomplete result, not to resume execution. An accepted termination is preserved; a model call without reported usage makes token totals partial. Recovery is in process, with no durable checkpointing, automatic retry or exactly-once provider guarantee.

## Inspection, evidence and budgets

[Snapshot preparation](../src/infrastructure/repository/snapshot.ts) exports committed Git blobs using fixed argument arrays, without a shell or target execution. Only regular UTF-8 text is copied. Dependency/build directories, private configuration, common credential filenames, symlinks, submodules, binary content and oversized files are excluded. Filename rules cannot detect secrets embedded in ordinary source. The policy caps files at 1 MiB, the tree at 10,000 entries and included content at 32 MiB.

The manifest records sorted relative paths, content hashes, exclusions, commit and subtree. Snapshot identity hashes the included path/hash list; equal content can have the same identity at different commits. The inspector copies manifest paths at construction and reads only those files. Manifest paths are validated relative paths, so they cannot escape the snapshot root. The prepared directory is application-owned and written read-only, so reads during a run do not re-verify hashes; this is not an OS sandbox against a hostile local user. Hashes are rechecked when a saved report is regenerated, because the snapshot can change between runs.

| Operation | Input and result |
| --- | --- |
| `list_files` | Optional directory, offset and limit; sorted included paths |
| `search_text` | Literal case-sensitive query plus optional directory, offset and limit; matching path/line/text entries |
| `read_lines` | Relative path and inclusive one-based range, at most 200 lines; line/text entries |

Listings and searches default to 50 entries and allow up to 100. Queries accept 1–256 characters without newline or NUL. Reads default to 100 lines; CRLF is normalized for display and a final newline adds no invented line. Absolute paths, traversal, backslashes, excluded paths, unsupported arguments and unknown files/directories return bounded `invalid_request` observations.

Responses preserve whole entries and complete lines, with `truncated` and a continuation offset or start line. `OutputBudgetError` terminates the run when no complete next item fits. The entire `{toolCallId, result}` envelope counts toward per-response and cumulative byte allowances. Call/time/byte limits remain application policy; the graph recursion bound, `2 * modelCalls + 2`, is a secondary safeguard. Provider output is capped at 8,192 tokens per request. Available token totals are accumulated; missing or malformed usage stays partial. SDK retries are disabled.

An inspection action's `checkpoint` is a provisional candidate replacement: `null` keeps it, `[]` clears it, and another array replaces it. This is separate from LangGraph persistence checkpoints. [Evidence rules](../src/investigation/evidence.ts) require unique candidate IDs, the current snapshot, an earlier application tool-call ID and every cited line actually returned by that call. Listings establish causal observations but supply no source evidence. The adapter attaches trusted snapshot identity to model-selected references.

At `finish`, operations validate final counts and references; this adds no inspection-call or response-byte totals. Invalid actions/evidence, provider errors, exhaustion and cancellation preserve available trace and valid provisional candidates. The first accepted termination wins. A run ends on its first invalid model output; the model is not asked to repair it.

## Results and output boundaries

`RunResult` is an explicit projection of graph progress and trusted metadata. Accepted completion uses a final array, including `[]`; incomplete execution uses `finalCandidates: null` and retains provisional candidates. The trace records event/tool IDs, action rationale, arguments, bounded observations, timing, outcomes, actual model identifiers and known usage.

Saved-report validation reconstructs observations independently and checks strict shapes, provenance, permitted manifest paths, causal/action relationships, counts, envelope bytes, candidate replacements and all cited lines against recorded results and current source hashes. Completed evidence that changed or disappeared prevents rendering without overwriting an existing report. Incomplete runs may retain historical references labelled **not revalidated**, without current-source excerpts or links. Malformed references and inconsistent accounting are always rejected.

Rendering escapes model prose and filenames, fences source and encodes local links. It shows at most 20 lines per reference while validating the whole range. Saved-report I/O accepts regular JSON files up to 32 MiB for a run and 4 MiB for a manifest, refuses output symlinks and creates files with restricted permissions. These checks establish source and structural consistency; unsigned artifacts cannot independently prove historical authenticity, provider dispatch or the security interpretation. Only cited source is rechecked.

Conversation, encrypted reasoning continuation, provider call IDs, clients and execution resources are excluded from saved results and recovery observers. The workflow filters `values` with `outputKeys`, validates allowed nested fields and supplies detached observer copies. API response storage is disabled. Source and model prose remain untrusted content; the application trace intentionally retains inspected source.

Stream filtering does not filter framework callbacks. The workflow isolates inherited framework async context and refuses environment-enabled raw tracing or verbose logging before dispatch, with an incomplete `execution_error`. The application trace is the diagnostic record; no external tracing service is configured. The [framework streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) and [tracing](https://docs.langchain.com/langsmith/trace-with-langgraph) mechanisms are separate output paths. Injected components remain trusted application code.

The [project brief](./project-brief.md) sets the development direction beyond exploration, including verification, tool integration and coordination between models. This document describes the current implementation; future increments will extend it as those capabilities are built.
