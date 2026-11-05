import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { ReportValidationError, ReportValidator } from "./ReportValidator.ts";
import { ReportRenderer } from "./ReportRenderer.ts";

async function readJson(file: string, maximum: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum)
      throw new ReportValidationError(
        "Saved artifact is not a bounded regular file",
      );
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Re-render a saved run without loading credentials or making a model request. */
export async function writeSavedReport(runFile: string): Promise<string> {
  const directory = path.dirname(path.resolve(runFile));
  const [run, manifest] = await Promise.all([
    readJson(runFile, 32 * 1024 * 1024),
    readJson(path.join(directory, "manifest.json"), 4 * 1024 * 1024),
  ]);
  const validator = new ReportValidator();
  const renderer = new ReportRenderer();
  const checked = await validator.validate(
    run,
    manifest,
    path.join(directory, "source"),
  );
  const output = path.join(directory, "report.md");
  const handle = await open(
    output,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(renderer.render(checked));
  } finally {
    await handle.close();
  }
  return output;
}
