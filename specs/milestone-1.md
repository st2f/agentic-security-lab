# Milestone 1 | Iterative, model-directed repository exploration → prioritized risk hypotheses → report

|  | Minimum scope |
| --- | --- |
| Inputs | Local repository snapshot, optional investigation question, explicit investigation budget |
| Behavior | One model chooses read-only search and file-reading actions, follows evidence, revises hypotheses, then stops |
| Outputs | Prioritized hypotheses, precise source references, reasoning and uncertainty, action trace, budget usage |
| Acceptance | Demonstrates a follow-up action driven by earlier evidence; references resolve against the inspected snapshot; a controlled fixture includes vulnerable and secure cases; limits and repository boundaries are enforced |

## Learning objective

Demonstrate that a model can follow repository evidence to choose useful next actions and produce defensible risk hypotheses within application-enforced limits. The action trace must make this behavior inspectable.

## Scope and architectural choices

Start with a local CLI, one model configuration, and read-only inspection of a stable local repository snapshot. Both targeted investigation and open exploration use the same loop; the optional question changes the investigation focus.

LangGraph controls the loop and routing. Application code enforces access, budgets, validates results, and determines whether execution may continue. The model chooses searches, files to read, candidate priorities, and when it has enough evidence to finish. Keep investigation data independent of framework and provider types without introducing a general provider abstraction.

Defer runtime verification, scanners, arbitrary command execution, multiple models or agents, persistence, and detailed verification statuses.

## Step 1: Define the run contract

Define the input and output shapes before integrating the model:

- Inputs: repository snapshot, optional question, maximum candidate count, and explicit execution limits.
- Hypotheses: claim, rationale, priority justification, evidence references, contradictory evidence where available, uncertainties, and suggested next checks.
- Run result: hypotheses, scope and limitations, action trace, usage, and termination reason.

Choose how to identify and preserve the inspected snapshot so references remain meaningful. Specify limits for model calls, tool calls, elapsed time, and tool output size; record provider-reported token usage when available. Define behavior for exhaustion and failures, including an incomplete result when a final model response is unavailable.

Completion check: the contract represents a normal result, zero credible candidates, and an interrupted or budget-exhausted run without implying that the repository is secure.

## Step 2: Create a controlled investigation target

Build a small TypeScript fixture with an authorization or tenant-isolation concern spanning an entry point and supporting code. Include a secure counterpart so the investigation must consider protective checks as well as suspicious code.

Keep the evaluator's answer key outside the accessible target. Avoid filenames or comments that reveal which case is vulnerable. The fixture need not run as an application for this milestone.

Completion check: a reviewer can explain the seeded issue and secure counterpart from the code, and investigating the relationship requires following evidence across files.

## Step 3: Implement bounded repository inspection

Provide only the tools needed to list files, search text, and read line-numbered file ranges. Bound results and report truncation explicitly. Enforce the repository boundary, including traversal and symlink handling, and define exclusions for metadata, dependencies, generated files, and sensitive local files.

Treat file contents as untrusted data. The model receives no general shell or write capability.

Completion check: focused deterministic tests cover boundary enforcement, result limits, and accurate file and line references.

## Step 4: Build the model-directed exploration loop

Connect one model to the inspection tools through a minimal LangGraph loop. After each tool result, the model can choose another permitted action or submit its current hypotheses. Allow candidates to be added, reprioritized, merged, or discarded as evidence changes.

Keep conversation history separate from structured results and execution accounting. Record tool requests, outcomes, and concise evidence-based reasons for follow-up actions; do not require hidden model reasoning. Check execution limits before dispatching further work.

Completion check: the fixture produces an inspectable sequence where a discovery leads to a relevant follow-up action that was not predetermined by application code. Deterministic control-flow tests also show that limits and termination work independently of model cooperation.

## Step 5: Produce the report

Validate the submitted result and render a Markdown report from structured data. Check that cited paths and line ranges resolve against the snapshot and refer to evidence actually returned during inspection. These checks establish reference validity, not whether the evidence proves the claim.

Include the prioritized hypotheses, supporting and contradictory evidence, uncertainties, suggested checks, investigation limits, usage, and termination reason. Treat the candidate count as a maximum. Explicitly state that runtime verification was not performed and avoid claims of demonstrated exploitability without sufficient evidence.

Completion check: reports handle ordinary results, zero candidates, and incomplete runs without inventing evidence or concealing execution limits.

## Step 6: Evaluate and document the demonstration

Run targeted and open exploration against the controlled fixture. Review whether the seeded concern is identified, the secure counterpart is treated appropriately, the references support the claims, and the trace demonstrates an evidence-driven follow-up. Record misses and false positives rather than adjusting the answer key to fit the output.

Separate deterministic implementation checks from live-model evaluation: model wording and action order may vary. Record the model configuration, snapshot identity, limits, usage, and observed results so the experiment can be repeated and compared.

Completion check: retain a demonstration report and trace, document known limitations, and explain what LangGraph contributed versus application logic. A missed seeded issue or unsupported accusation against the secure case remains an evaluation failure to investigate before declaring the demonstration successful.

## Decisions to settle during implementation

- Model provider and model, after checking current tool-calling and structured-output support.
- Node.js version, package manager, and compatible LangGraph.js APIs.
- Snapshot mechanism and initial numeric limits, informed by the small fixture.

These choices do not require expanding the milestone's scope.
