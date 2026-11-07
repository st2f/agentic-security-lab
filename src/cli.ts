import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { z } from "zod";
import { configSchema, defaultLimits } from "./investigation/contracts.ts";
import { createInvestigation } from "./composition.ts";
import { prepareSnapshot } from "./infrastructure/repository/snapshot.ts";
import { writeSavedReport } from "./reporting/saved-report.ts";
import { ReportValidationError } from "./reporting/ReportValidator.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      commit: { type: "string" },
      subtree: { type: "string" },
      question: { type: "string" },
      output: { type: "string", default: "priv/runs" },
      model: { type: "string", default: "gpt-6-luna" },
      reasoning: { type: "string", default: "medium" },
      "max-candidates": { type: "string", default: "3" },
      "model-calls": { type: "string" },
      "tool-calls": { type: "string" },
      "elapsed-ms": { type: "string" },
    },
  });
  if (!values.repo || !values.commit)
    throw new Error(
      "Required: --repo <local path> --commit <full commit ID>; optional: --subtree, --question, --output, --model, --reasoning, --max-candidates, --model-calls, --tool-calls, --elapsed-ms",
    );
  const config = configSchema.parse({
    question: values.question,
    model: values.model,
    reasoning: values.reasoning,
    maxCandidates: Number(values["max-candidates"]),
    limits: {
      ...defaultLimits,
      ...(values["model-calls"] === undefined
        ? {}
        : { modelCalls: Number(values["model-calls"]) }),
      ...(values["tool-calls"] === undefined
        ? {}
        : { toolCalls: Number(values["tool-calls"]) }),
      ...(values["elapsed-ms"] === undefined
        ? {}
        : { elapsedMs: Number(values["elapsed-ms"]) }),
    },
  });
  // Existing environment values take precedence over local .env values.
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const snapshot = await prepareSnapshot({
    repository: path.resolve(values.repo),
    commit: values.commit,
    subtree: values.subtree,
    outputParent: path.resolve(values.output!),
  });
  const controller = new AbortController();
  const investigation = createInvestigation(snapshot, config, { apiKey });
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  let result;
  try {
    result = await investigation.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
  const output = path.join(snapshot.root, "..", "run.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  let report: string | undefined;
  try {
    report = await writeSavedReport(output);
  } catch (error) {
    console.error(
      error instanceof ReportValidationError
        ? error.message
        : `Run JSON was saved, but its Markdown report could not be written: ${describe(error)}`,
    );
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify(
      {
        output,
        report,
        completion: result.completion,
        termination: result.termination,
        usage: result.usage,
      },
      null,
      2,
    ),
  );
  if (result.completion === "incomplete") process.exitCode = 1;
}

/** Show the application's own messages; SDK errors may carry request details. */
function describe(error: unknown): string {
  if (error instanceof z.ZodError)
    return `Invalid options:\n${z.prettifyError(error)}`;
  if (error instanceof OpenAI.OpenAIError || !(error instanceof Error))
    return "Model client error; check OPENAI_API_KEY and network access.";
  return error.message;
}

main().catch((error: unknown) => {
  console.error(`Investigation failed: ${describe(error)}`);
  process.exitCode = 1;
});
