import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { configSchema, defaultLimits } from "./investigation/contract.ts";
import { createOpenAIModel } from "./models/openai.ts";
import { explore } from "./orchestration/explore.ts";
import { prepareSnapshot } from "./repository/snapshot.ts";
import { writeSavedReport } from "./reporting/report.ts";
import { ReportValidationError } from "./reporting/validation.ts";

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
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  let result;
  try {
    result = await explore(
      snapshot,
      config,
      createOpenAIModel({ apiKey }),
      controller.signal,
    );
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
        : "Run JSON was saved, but its Markdown report could not be written.",
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

main().catch(() => {
  // SDK/network errors may contain request details; do not dump them or credentials.
  console.error(
    "Investigation could not start or save its result. Check CLI arguments, local repository, output path, and OPENAI_API_KEY.",
  );
  process.exitCode = 1;
});
