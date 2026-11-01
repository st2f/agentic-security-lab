# Investigation reports

Step 5 renders a saved investigation into Markdown without a model call, API key, or security-tool execution. The investigator saves its structured result first, then attempts to generate `report.md` alongside it.

To render or refresh an existing run:

```sh
npm run report -- --run <saved-run-directory>/run.json
```

The directory must contain the corresponding `manifest.json` and `source/` snapshot. Reports link to those local artifacts and exact snapshot-relative source ranges. The result is deterministic for unchanged validated inputs.

## Contents

- Run completion, termination reason, exhausted limit, and available diagnostics.
- Investigation question, source commit and subtree, content identity, configured and observed model identifiers, and reasoning setting.
- Prioritized hypotheses with rationale, supporting source excerpts, contradictory evidence or protective controls, uncertainties, and suggested checks.
- Scope exclusions and limitations, with a link to the full manifest.
- Every inspection call in order, with its arguments, outcome, returned entry count, truncation indicator, and duration.
- The model's recorded action rationales and references to earlier calls.
- Model/tool counts, tool-response bytes, elapsed time, configured limits, and provider-reported tokens with complete or partial usage labelling.

Source excerpts include at most 20 lines per reference; longer cited ranges are explicitly labelled, with a link to the full range. All cited lines are checked, including those omitted from the displayed excerpt.

Reports describe model-generated security hypotheses supported by source, not runtime-verified vulnerabilities. Reference integrity does not establish the security interpretation or exploitability. Runtime verification was not performed by the investigating agent in milestone 1.

## Validation before rendering

`src/reporting/validation.ts` treats saved JSON as untrusted data. It checks:

1. Result and manifest structure, required configuration, and completion semantics.
2. Sorted, unique, permitted manifest paths; the content-manifest identity; source commit, subtree, and exclusion consistency with the saved run.
3. Unique trace IDs, causal references to earlier calls, and correspondence between requested inspection actions, tool arguments, and result kinds.
4. Trace call counts and serialized response bytes against recorded usage and limits.
5. Final candidates against the recorded finish action, or provisional candidates against the latest successful checkpoint.
6. Each candidate's supporting and contradictory evidence against complete lines actually present in its cited tool response.
7. Cited files against manifest hashes, filesystem boundaries, and the recorded source text at those exact line numbers.

These checks establish structural and source consistency. Artifacts are not digitally signed; coordinated edits to a run, source, and manifest are not proof of an authentic historical investigation. Token usage is provider-reported data, not independently reconstructed from the trace. Only cited evidence is rechecked against source files; this is not a fresh whole-repository investigation.

Model prose is rendered as escaped text. It cannot create arbitrary Markdown links, HTML, or headings. Source snippets use code fences, and source links use encoded path segments within the local snapshot. Generated files use restricted permissions, and report writes do not follow a pre-existing output symlink.

## Empty, incomplete, and changed-source results

A completed run with no candidates explicitly says this does not establish that the repository is secure. It is different from an incomplete run, where there is no final assessment and any retained candidates are labelled provisional.

Provider interruption and budget exhaustion preserve available usage and trace; unavailable token usage is labelled partial. No additional model call is needed to explain those failures.

If a completed run's cited source is missing, changed, or inconsistent with its trace, report generation fails. The saved result is preserved and a previous report, if any, is not overwritten; that older report describes its earlier generation, not the modified snapshot.

An incomplete run can have a changed snapshot. Valid historical checkpoint references remain visible, but unavailable evidence is labelled **not revalidated** and its source excerpts and current-source links are omitted. The original text remains available in `run.json`. Malformed references, unread-line citations, and inconsistent accounting are rejected even for incomplete runs.

The report loader accepts regular JSON artifacts up to 32 MiB for a run and 4 MiB for its manifest. Report regeneration needs the saved source artifacts, not access to the original working repository or model provider.

Run `npm run typecheck`, `npm run format:check`, and `npm test` to check the renderer and its validation paths. Reporting tests use deterministic investigations and temporary local snapshots; they do not make API calls.
