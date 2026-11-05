import type { Candidate, Evidence } from "../investigation/contracts.ts";
import { evidenceKey } from "../investigation/evidence.ts";
import type { ValidatedReport } from "./ReportValidator.ts";

/** All model prose is plain text; it cannot introduce HTML, links, or headings. */
function prose(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#!|~]/g, "\\$&");
}
function bullets(values: string[], empty: string): string {
  return values.length
    ? values.map((value) => `- ${prose(value)}`).join("\n")
    : empty;
}
function segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class ReportRenderer {
  render(checked: ValidatedReport): string {
    const { run, snapshot, evidence, warnings } = checked;
    const completed = run.completion === "completed";
    const candidates = run.finalCandidates ?? run.provisionalCandidates;
    const output: string[] = [
      "# Security investigation report",
      `Run: ${prose(run.runId)}. Status: **${run.completion}**.`,
      "## Outcome",
      completed
        ? candidates.length
          ? `${candidates.length} prioritized source-supported ${candidates.length === 1 ? "hypothesis" : "hypotheses"}. These are model interpretations of source evidence.`
          : "No credible candidates were returned within this run's scope and budget. This does not establish that the repository is secure."
        : "The investigation is incomplete. No final assessment is available. Any candidates below are provisional checkpoints, not final findings.",
      `Termination: ${prose(run.termination.reason)}${run.termination.limit ? `; limit: ${prose(run.termination.limit)}` : ""}.`,
      ...(run.termination.detail ? [prose(run.termination.detail)] : []),
      "Runtime verification was not performed. Source evidence and valid references do not by themselves establish exploitability or deployment behavior.",
      "## Scope and configuration",
      `- Run started (recorded UTC): ${prose(run.trace[0]?.startedAt ?? "Not recorded")}`,
      `- Focus: ${prose(run.request.question ?? "Open exploration")}`,
      `- Target commit: ${run.request.commit}`,
      `- Source subtree: ${prose(run.request.subtree || "Repository root")}`,
      `- Snapshot: ${run.snapshotId}`,
      `- Provider/model: ${prose(run.request.provider)} / ${prose(run.request.model)}; reasoning: ${prose(run.request.reasoning)}`,
      `- Observed model identifiers: ${prose([...new Set(run.trace.flatMap((event) => (event.actualModel ? [event.actualModel] : [])))].join(", ") || "Not recorded")}`,
      `- Included files: ${snapshot.files.length}; excluded entries: ${snapshot.skipped.length}. See [snapshot manifest](./manifest.json).`,
      `- Maximum final candidates: ${run.request.maxCandidates}; this is an upper limit, not a quota.`,
      "The scope is limited to source exposed by inspection tools. No application tests, scanner, or external target was executed during this investigation.",
      "## Evidence integrity",
      ...(warnings.length
        ? [
            "Some provisional evidence could not be revalidated. Those references are labelled historical and have no current-source excerpts.",
          ]
        : []),
      evidence.size
        ? "Cited ranges were checked against the recorded tool results and the saved snapshot while generating this report. This validates reference integrity, not the security interpretation."
        : "There are no candidate evidence references to validate.",
      ...(warnings.length ? [bullets(warnings, "")] : []),
      "## Scope limitations and unperformed checks",
      bullets(
        run.scopeAndLimitations,
        "No additional scope limitations were recorded.",
      ),
      `## ${completed ? "Prioritized hypotheses" : "Provisional candidates"}`,
    ];

    function source(reference: Evidence): string {
      const checkedEvidence = evidence.get(evidenceKey(reference))!;
      const label = `${reference.path}:${reference.startLine}–${reference.endLine}`;
      if (!checkedEvidence.verified) {
        return `${prose(label)} (${prose(reference.toolCallId)}): **not revalidated**. Historical tool content is retained in [the run trace](./run.json); no current-source excerpt is presented.`;
      }
      const link = `./source/${reference.path.split("/").map(segment).join("/")}#L${reference.startLine}-L${reference.endLine}`;
      const shown = checkedEvidence.lines.slice(0, 20);
      const snippet = shown
        .map((line) => `${line.line} | ${line.text}`)
        .join("\n");
      const longest = Math.max(
        0,
        ...(snippet.match(/`+/g) ?? []).map((match) => match.length),
      );
      const fence = "`".repeat(Math.max(3, longest + 1));
      return (
        `[${prose(label)}](${link}) (${prose(reference.toolCallId)}).\n\n${fence}text\n${snippet}\n${fence}` +
        (shown.length < checkedEvidence.lines.length
          ? `\n\nExcerpt shows the first ${shown.length} of ${checkedEvidence.lines.length} cited lines; follow the source link for the complete range.`
          : "")
      );
    }
    function candidate(item: Candidate, index: number) {
      output.push(
        `### ${index + 1}. ${prose(item.claim)}`,
        `Candidate ID: ${prose(item.id)}.`,
        `Rationale: ${prose(item.rationale)}`,
        `Priority: ${prose(item.priorityReason)}`,
        "#### Supporting evidence",
        ...item.supportingEvidence.map(source),
        "#### Contradictory evidence and protective controls",
        ...(item.contradictoryEvidence.length
          ? item.contradictoryEvidence.map(
              (entry) =>
                `${source(entry.reference)}\n\n${prose(entry.explanation)}`,
            )
          : ["No contradictory source evidence was recorded."]),
        "#### Uncertainties",
        bullets(
          item.uncertainties,
          "No additional uncertainties were recorded; this does not establish completeness.",
        ),
        "#### Suggested next checks",
        bullets(item.nextChecks, "No additional checks were recorded."),
      );
    }
    candidates.forEach(candidate);
    if (!candidates.length)
      output.push(
        completed
          ? "No hypotheses to list."
          : "No validated provisional checkpoint was available when execution stopped.",
      );

    output.push(
      "## Tool calls",
      "Full arguments and returned source are retained in [run.json](./run.json).",
    );
    const toolTable = [
      "| ID | Tool and arguments | Outcome | Result | Duration (ms) |",
      "| --- | --- | --- | --- | ---: |",
    ];
    const tools = run.trace.filter((event) => event.type === "tool");
    for (const event of tools) {
      const result = event.result as
        | {
            kind?: string;
            files?: unknown[];
            lines?: unknown[];
            matches?: unknown[];
            truncated?: boolean;
          }
        | undefined;
      const summary = result
        ? `${result.kind}; ${result.files?.length ?? result.lines?.length ?? result.matches?.length ?? 0} entries${result.truncated ? "; truncated" : ""}`
        : "No returned result";
      toolTable.push(
        `| ${prose(event.toolCallId!)} | ${prose(JSON.stringify(event.arguments) ?? "Not recorded")} | ${event.outcome} | ${prose(summary)} | ${event.durationMs.toFixed(2)} |`,
      );
    }
    if (!tools.length)
      toolTable.push("| — | No inspection calls | — | — | — |");
    output.push(toolTable.join("\n"));
    output.push(
      "## Investigation decisions",
      "These are recorded model action rationales, not hidden reasoning or independent verification.",
    );
    for (const event of run.trace.filter((entry) => entry.type === "model")) {
      output.push(
        `- ${prose(event.id)}: ${event.action ? `${prose(event.action.name)} — ${prose(event.action.rationale)} Based on: ${prose(event.action.basedOnToolCallIds.join(", ") || "initial investigation context")}.` : "No valid action was recorded."} Outcome: ${event.outcome}; ${event.durationMs.toFixed(2)} ms.`,
      );
    }
    output.push(
      "## Resource usage and limits",
      [
        "| Resource | Recorded usage | Configured limit |",
        "| --- | ---: | ---: |",
        `| Model calls | ${run.usage.modelCalls} | ${run.request.limits.modelCalls} |`,
        `| Inspection calls | ${run.usage.toolCalls} | ${run.request.limits.toolCalls} |`,
        `| Tool-response bytes | ${run.usage.toolResponseBytes} | ${run.request.limits.totalToolResponseBytes} |`,
        `| Elapsed milliseconds | ${run.usage.elapsedMs.toFixed(2)} | ${run.request.limits.elapsedMs} |`,
      ].join("\n"),
      `Per-response tool limit: ${run.request.limits.toolResponseBytes} bytes.`,
      `Provider-reported tokens: ${run.usage.inputTokens} input, ${run.usage.outputTokens} output. Usage is **${run.usage.tokenUsageComplete ? "complete" : "partial; unavailable request usage is not included"}**. No exact monetary budget was enforced.`,
    );
    return output.join("\n\n") + "\n";
  }
}
