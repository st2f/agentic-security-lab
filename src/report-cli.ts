import { parseArgs } from "node:util";
import { writeSavedReport } from "./reporting/saved-report.ts";
import { ReportValidationError } from "./reporting/ReportValidator.ts";

try {
  const { values } = parseArgs({ options: { run: { type: "string" } } });
  if (!values.run) {
    console.error(
      "Usage: npm run report -- --run <saved-run-directory>/run.json",
    );
    process.exitCode = 1;
  } else {
    console.log(await writeSavedReport(values.run));
  }
} catch (error) {
  console.error(
    error instanceof ReportValidationError
      ? error.message
      : "Could not render report. Check the run JSON, manifest, source snapshot, and output directory.",
  );
  process.exitCode = 1;
}
