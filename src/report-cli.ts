import { parseArgs } from "node:util";
import { writeSavedReport } from "./reporting/saved-report.ts";

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
    error instanceof Error
      ? `Could not render report: ${error.message}`
      : "Could not render report.",
  );
  process.exitCode = 1;
}
