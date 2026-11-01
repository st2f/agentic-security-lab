import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { decodeText, digest, excludedPath, snapshotPolicy, validRelativePath } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

export class SnapshotChangedError extends Error {
  constructor() { super("Snapshot content or filesystem boundary changed"); }
}

export class OutputBudgetError extends Error {
  constructor() { super("No complete result fits the tool response allowance"); }
}

class InputError extends Error {}

type SourceLine = { line: number; text: string };
type Match = SourceLine & { path: string };
type Result =
  | { kind: "list_files"; snapshotId: string; files: string[]; truncated: boolean; nextOffset: number | null }
  | { kind: "search_text"; snapshotId: string; matches: Match[]; truncated: boolean; nextOffset: number | null }
  | { kind: "read_lines"; snapshotId: string; path: string; lines: SourceLine[]; truncated: boolean; nextStartLine: number | null }
  | { kind: "error"; code: "invalid_request"; message: string };

export function serializedBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InputError("Integer argument outside its permitted range");
  }
  return value;
}

function relative(value: unknown, allowRoot = false): string {
  if (allowRoot && (value === undefined || value === ".")) return ".";
  if (typeof value !== "string" || !validRelativePath(value) || excludedPath(value)) {
    throw new InputError("Path is not permitted");
  }
  return value;
}

function argumentsFor(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new InputError("Expected an object containing only supported arguments");
  }
  return value as Record<string, unknown>;
}

function lines(text: string): SourceLine[] {
  if (!text.length) return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split.map((text, index) => ({ line: index + 1, text: text.replace(/\r$/, "") }));
}

/** One instance is scoped to one prepared snapshot; caller owns run-wide accounting. */
export function createRepositoryInspector(snapshot: Snapshot, maxResponseBytes = 16_384) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > 16_384) {
    throw new Error("Response allowance must be between 256 and 16384 bytes");
  }
  // Copy the trusted manifest so later caller mutations cannot broaden access.
  const manifest = new Map(snapshot.files.map((file) => [file.path, file.sha256]));
  const paths = [...manifest.keys()].filter((file) => validRelativePath(file) && !excludedPath(file)).sort();
  const root = path.resolve(snapshot.root);

  async function readVerified(file: string): Promise<SourceLine[]> {
    if (!paths.includes(file)) throw new InputError("File is not in the accessible manifest");
    try {
      const rootInfo = await lstat(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new SnapshotChangedError();
      let current = root;
      const segments = file.split("/");
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < segments.length - 1
          ? !info.isDirectory() : !info.isFile() || info.size > snapshotPolicy.maxFileBytes)) {
          throw new SnapshotChangedError();
        }
      }
      const canonicalRoot = await realpath(root);
      const canonicalFile = await realpath(current);
      if (!canonicalFile.startsWith(canonicalRoot + path.sep)) throw new SnapshotChangedError();
      const content = await readFile(canonicalFile);
      if (digest(content) !== manifest.get(file)) throw new SnapshotChangedError();
      return lines(decodeText(content));
    } catch (error) {
      if (error instanceof SnapshotChangedError) throw error;
      throw new SnapshotChangedError();
    }
  }

  function page<T>(items: T[], limit: number, bytes: number, render: (selected: T[], more: boolean) => Result): Result {
    const selected: T[] = [];
    for (const item of items.slice(0, limit)) {
      const candidate = [...selected, item];
      if (serializedBytes(render(candidate, candidate.length < items.length)) > bytes) break;
      selected.push(item);
    }
    const result = render(selected, selected.length < items.length);
    if ((items.length && !selected.length) || serializedBytes(result) > bytes) throw new OutputBudgetError();
    return result;
  }

  async function execute(name: string, input: unknown, remainingBytes = maxResponseBytes): Promise<Result> {
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 256) throw new OutputBudgetError();
    const bytes = Math.min(remainingBytes, maxResponseBytes);
    try {
      if (name === "list_files" || name === "search_text") {
        const args = argumentsFor(input, name === "list_files"
          ? ["directory", "offset", "limit"] : ["directory", "offset", "limit", "query"]);
        const directory = relative(args.directory, true);
        if (directory !== "." && !paths.some((file) => file.startsWith(directory + "/"))) {
          throw new InputError("Directory is not in the accessible manifest");
        }
        const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = integer(args.limit, 50, 1, 100);
        const files = paths.filter((file) => directory === "." || file.startsWith(directory + "/"));
        if (name === "list_files") {
          return page(files.slice(offset), limit, bytes, (selected, more) => ({
            kind: "list_files", snapshotId: snapshot.snapshotId, files: selected,
            truncated: more, nextOffset: more ? offset + selected.length : null,
          }));
        }
        if (typeof args.query !== "string" || !args.query.length || args.query.length > 256 || /[\r\n\0]/.test(args.query)) {
          throw new InputError("Query must be 1–256 characters of literal single-line text");
        }
        const matches: Match[] = [];
        let skippedMatches = 0;
        search: for (const file of files) {
          for (const line of await readVerified(file)) {
            if (!line.text.includes(args.query)) continue;
            if (skippedMatches < offset) { skippedMatches++; continue; }
            matches.push({ path: file, ...line });
            // One look-ahead establishes truncation without retaining every repository match.
            if (matches.length > limit) break search;
          }
        }
        return page(matches, limit, bytes, (selected, more) => ({
          kind: "search_text", snapshotId: snapshot.snapshotId, matches: selected,
          truncated: more, nextOffset: more ? offset + selected.length : null,
        }));
      }
      if (name === "read_lines") {
        const args = argumentsFor(input, ["path", "startLine", "endLine"]);
        const file = relative(args.path);
        const start = integer(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
        const end = integer(args.endLine, start + 99, start, Number.MAX_SAFE_INTEGER);
        if (end - start >= 200) throw new InputError("Read at most 200 lines per request");
        const content = await readVerified(file);
        if (start > content.length && !(start === 1 && !content.length)) throw new InputError("Start line is past the end of the file");
        return page(content.slice(start - 1, end), 200, bytes, (selected, more) => ({
          kind: "read_lines", snapshotId: snapshot.snapshotId, path: file, lines: selected,
          truncated: more, nextStartLine: more ? start + selected.length : null,
        }));
      }
      throw new InputError("Unknown inspection tool");
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      const result: Result = { kind: "error", code: "invalid_request", message: error.message };
      if (serializedBytes(result) > bytes) throw new OutputBudgetError();
      return result;
    }
  }

  return { execute };
}
