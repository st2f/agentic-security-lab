import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type SnapshotFile = { path: string; sha256: string };
export type Snapshot = {
  root: string;
  snapshotId: string;
  commit: string;
  subtree: string;
  files: readonly SnapshotFile[];
  skipped: readonly { path: string; reason: string }[];
};

export const snapshotPolicy = {
  version: 1,
  maxFiles: 10_000,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 33_554_432,
  excludedDirectories: [
    ".git", "node_modules", "dist", "build", "coverage", ".next",
    "priv", "private", ".aws", ".ssh", ".codex", ".agents",
  ],
};

export function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validRelativePath(value: string): boolean {
  return value.length > 0 && !value.includes("\\") && !/[\x00-\x1f\x7f]/.test(value)
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function excludedPath(value: string): boolean {
  const parts = value.split("/");
  return parts.some((part) => snapshotPolicy.excludedDirectories.includes(part))
    || parts.some((part) => /^\.env(?:\.|$)/i.test(part)
      || /\.(pem|key|p12|pfx)$/i.test(part)
      || /^(?:\.npmrc|\.netrc|credentials|id_rsa|id_ed25519)$/i.test(part));
}

export function decodeText(content: Uint8Array): string {
  if (content.includes(0)) throw new Error("Binary content");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
}

/** Export only committed blobs; never execute repository scripts or read its working tree. */
export async function prepareSnapshot(input: {
  repository: string;
  commit: string;
  subtree?: string;
  outputParent: string;
}): Promise<Snapshot> {
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new Error("A full Git commit ID is required");
  const subtree = input.subtree ?? "";
  if (subtree && !validRelativePath(subtree)) throw new Error("Invalid source subtree");
  const git = async (args: string[]) => (await run("git", ["-C", input.repository, ...args], {
    encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  const resolved = (await git(["rev-parse", "--verify", `${input.commit}^{commit}`])).toString().trim();
  if (resolved !== input.commit) throw new Error("Commit identity mismatch");
  const tree = new TextDecoder("utf-8", { fatal: true }).decode(await git(["ls-tree", "-r", "-z", input.commit]));
  const entries = tree.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    return { mode, type, oid, sourcePath: entry.slice(tab + 1) };
  }).filter((entry) => !subtree || entry.sourcePath.startsWith(`${subtree}/`));
  if (entries.length === 0) throw new Error("Source tree is empty or does not exist");
  if (entries.length > snapshotPolicy.maxFiles) throw new Error("Snapshot file limit exceeded");

  await mkdir(input.outputParent, { recursive: true });
  const directory = await mkdtemp(path.join(input.outputParent, "snapshot-"));
  const root = path.join(directory, "source");
  const files: SnapshotFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let totalBytes = 0;
  try {
    await mkdir(root);
    for (const entry of entries.sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0)) {
      const relative = subtree ? entry.sourcePath.slice(subtree.length + 1) : entry.sourcePath;
      let reason: string | undefined;
      if (!validRelativePath(relative)) reason = "unsupported_path";
      else if (excludedPath(entry.sourcePath)) reason = "excluded_path";
      else if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode!)) reason = "not_regular_file";
      if (reason) { skipped.push({ path: relative, reason }); continue; }
      const size = Number((await git(["cat-file", "-s", entry.oid!])).toString().trim());
      if (size > snapshotPolicy.maxFileBytes) {
        skipped.push({ path: relative, reason: "file_size_limit" }); continue;
      }
      if (totalBytes + size > snapshotPolicy.maxTotalBytes) throw new Error("Snapshot byte limit exceeded");
      const content = await git(["cat-file", "blob", entry.oid!]);
      try { decodeText(content); } catch {
        skipped.push({ path: relative, reason: "not_utf8_text" }); continue;
      }
      const destination = path.join(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx", mode: 0o400 });
      totalBytes += content.byteLength;
      files.push({ path: relative, sha256: digest(content) });
    }
    if (!files.length) throw new Error("No inspectable files in source tree");
    const snapshotId = digest(JSON.stringify(files));
    const snapshot: Snapshot = { root, snapshotId, commit: input.commit, subtree, files, skipped };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      snapshotId, commit: input.commit, subtree, policy: snapshotPolicy, files, skipped,
    }, null, 2) + "\n");
    return snapshot;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
