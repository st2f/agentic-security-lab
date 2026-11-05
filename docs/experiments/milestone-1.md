# Inventory investigation: what the model did

Can one model follow source evidence, choose useful repository actions, and produce a reviewable security hypothesis within enforced limits? This experiment compared targeted investigation with open exploration on a small inventory fixture. Three runs delivered accepted final hypotheses; an initial targeted run found the seeded issue but failed final-reference validation.

## Setup and review criteria

The fixture contains one cross-tenant quantity disclosure and one protected read path, both behind a trusted authenticated principal. The [evaluator key](./inventory-fixture.md) describes the expected behavior. Only `fixtures/inventory-api` was exposed to the model; requests supplied no answer key, expected endpoint name or prescribed file order.

The protocol was a targeted run followed by an open run, each with a fresh conversation. After the targeted run's reference failure, a focused application fix was followed by another fresh pair. The fixture, security instructions, question and review criteria were unchanged.

| Recorded setting | Value |
| --- | --- |
| Target source commit; initial investigator revision | `76cdccf307e7a020dc91be21ae53b6c8a1cace2a` |
| Investigator revision after the fix | `412e2e6ec8d2ae7f7d751b38d5dc34641fceca62` |
| Model / reasoning | OpenAI `gpt-6-luna` / `medium` |
| Candidate / model-call / inspection-call maximum | 3 / 12 / 40 |
| Deadline; per-response / cumulative tool bytes | 180 seconds; 16,384 / 262,144 |
| Runtime / package manager | Node.js 24.7.0 / npm 11.19.1 |

All four runs occurred on November 1, 2026 (UTC), using five included files, no exclusions, and snapshot identity `8107b80d6ea834ab142df53f56ec7157ce4149e7b12544cc4d2b8508e008d8d0`. Investigator revisions identify the application code; the source commit identifies the investigated target. Dependencies are pinned in each revision's lockfile.

The exact targeted question was:

> Investigate whether authenticated users can read inventory belonging to another tenant. Follow relevant code relationships and consider protective controls.

Open exploration omitted the question and used the generic exploration request. Both modes could finish with zero to three hypotheses. Review required the seeded disclosure, evidence tracing handler → query → repository, appropriate treatment of the protected path, an evidence-driven follow-up, and explicit uncertainty about untested runtime behavior. A missed issue or unsupported accusation against the protected case would fail the demonstration; additional hypotheses required individual review.

## Results

Run names link to reports; trace links contain the full structured results and rejected submissions where applicable.

| Run | Outcome | Model / inspection calls | Input / output tokens | Tool bytes | Seconds |
| --- | --- | --- | --- | --: | --: |
| [Initial targeted](./runs/milestone-1/baseline-targeted/report.md) · [trace](./runs/milestone-1/baseline-targeted/run.json) | Incomplete: invalid final reference | 9 / 8 | 37,244 / 2,491 | 7,129 | 36.10 |
| [Initial open](./runs/milestone-1/baseline-open/report.md) · [trace](./runs/milestone-1/baseline-open/run.json) | Completed | 7 / 6 | 28,066 / 1,786 | 6,699 | 27.01 |
| [Targeted after fix](./runs/milestone-1/targeted/report.md) · [trace](./runs/milestone-1/targeted/run.json) | Completed | 9 / 8 | 35,708 / 1,417 | 7,264 | 19.55 |
| [Open after fix](./runs/milestone-1/open/report.md) · [trace](./runs/milestone-1/open/run.json) | Completed | 8 / 7 | 32,110 / 1,624 | 7,080 | 20.66 |

Each completed run accepted one final hypothesis. The initial targeted run retained one valid provisional candidate and no accepted final assessment. Token accounting was complete in every run. No configured limit was exhausted; the largest tool-response envelope was 2,072 bytes.

The implementation assistant reviewed source and traces against the evaluator key. This was neither independent human review nor automated semantic grading. All four analyses identified the availability lookup's missing tenant constraint and the resulting quantity disclosure for a known foreign item ID. They recognized the scoped detail path as protective and acknowledged that runtime verification had not been performed. No additional vulnerability hypotheses were submitted.

There were reporting limitations: the repeated targeted run supplied a protective-control reference, while the open run described the contrast in prose with empty `contradictoryEvidence`. A secure sibling path does not itself refute the vulnerable path. The open claim also mentioned returning the caller-supplied item ID; quantity was the meaningful new disclosure. Model phrases such as “high-confidence” were uncalibrated judgments.

## Lessons from the trace

The initial targeted submission shortened the snapshot ID on its final `src/model.ts:1–10` citation at `event-17`. Validation rejected the submission and preserved the earlier valid checkpoint. The source had not changed.

The fix in `412e2e6` removed `snapshotId` from model-facing references. The model still chooses a previously observed tool-call ID, path and line range; application code attaches trusted snapshot identity. Supporting evidence, contradictory evidence and provisional checkpoints retain the same validation. No fixture change, vulnerability-specific hint, weaker check or automatic retry was introduced. The second pair was a new experiment, not a repair of the original conversation.

The traces also show actual model direction. In the repeated targeted run, `tool-4` reads the query; `event-9` then requests the repository implementation to check whether its lookup enforces ownership. Later, `event-15` searches for `getAvailability` call sites. The repeated open run starts differently: listing → README → handlers → query → repository → model → call-site search. Its query observation likewise prompts the repository follow-up.

Targeted runs searched for case-sensitive `inventory` and received no matches; the initial run then repeated a listing. These are observable inefficiencies. The few runs and uncontrolled context/cache/provider conditions do not establish that either mode or the fix is faster.

The main orchestration lesson is to leave investigative choices to the model while supplying opaque application facts from code. A plain loop could support this small experiment; LangGraph was chosen to learn explicit workflow orchestration. Persistence, parallel agents, provider routing and scanners were not exercised.

## Reproducing the setup and inspecting artifacts

Use the recorded investigator revision and lockfile, the source commit and limits above, and the exact question for a targeted run; omit it for open exploration. General commands are in the [README](../../README.md#run-locally). This reproduces the setup, not identical model output.

Each linked run directory retains its original JSON, report, manifest and source snapshot. Archived source hashes and report regeneration have been checked; these files are excluded from formatting. They contain the controlled source and nonsecret metadata, without the evaluator key, credentials, local absolute paths or SDK reasoning payloads. The README's report command can regenerate them without a model request.

Deterministic tests validate known fixture behavior and application controls using scripted models and mocked HTTP. They do not establish live investigation quality. The recorded live evaluation supports this demonstration on one tiny fixture with one seeded issue and one protected counterpart. One post-fix run per mode gives no statistical detection rate, calibrated confidence, typical cost/latency, prompt-injection resistance or general repository coverage. Both repeated runs met the criteria; the baseline failure remains part of that result.

## Earlier pilot and cache observation

An [earlier pilot report](./runs/milestone-1/pilot/report.md) and [trace](./runs/milestone-1/pilot/run.json) used source commit `31b46e715e2d414f0b79fe2c12f208db914950db` and the then-uncommitted exploration implementation preceding `a9c91e0`. With the same model and limits, it completed in 28.85 seconds: 9 model calls, 8 inspections, 35,360 input tokens and 1,611 output tokens. Its report was rendered later. The subsequent source includes Markdown formatting changes; this pilot is separate from the four evaluation runs.

A [dashboard capture](./assets/milestone-1-input-token-composition.png), taken on November 1, 2026 after the pilot and before the evaluation runs, shows 28,792 cache-read tokens, 5,434 30-minute cache-write tokens, zero 12-hour writes and 1,134 uncached tokens, totaling 35,360. No other API activity was reported in that period. Cache reads were about 81.4% of input, or 5.3 times writes by token volume.

This account-level observation supports the pilot's aggregate usage; it is not per-call telemetry or a cache-performance benchmark for the later runs. The implementation records aggregate tokens without the response cache breakdown.
