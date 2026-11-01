import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { createRepositoryInspector, OutputBudgetError, serializedBytes, SnapshotChangedError } from "../src/repository/inspection.ts";
import { digest, prepareSnapshot, snapshotPolicy } from "../src/repository/snapshot.ts";
import type { Snapshot } from "../src/repository/snapshot.ts";

const run = promisify(execFile);

async function temporary(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "repository-inspection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function sample(t: TestContext, entries: Record<string, string | Buffer>) {
  const root = await temporary(t);
  const files = [];
  for (const [file, content] of Object.entries(entries).sort()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
    files.push({ path: file, sha256: digest(content) });
  }
  const snapshot: Snapshot = {
    root, snapshotId: digest(JSON.stringify(files)), commit: "a".repeat(40), subtree: "", files, skipped: [],
  };
  return { root, snapshot, inspector: createRepositoryInspector(snapshot) };
}

test("snapshot exports committed subtree files and records exclusions without answer-key leakage", async (t) => {
  const directory = await temporary(t);
  const repository = path.join(directory, "repository");
  await mkdir(path.join(repository, "target/src"), { recursive: true });
  const git = async (...args: string[]) => (await run("git", ["-C", repository, ...args])).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Fixture evaluator");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repository, "target/src/item.ts"), "export const quantity = 12;\n");
  await writeFile(path.join(repository, "target/.env"), "EXAMPLE=fake\n");
  await writeFile(path.join(repository, "target/server.pem"), "fake certificate\n");
  await writeFile(path.join(repository, "target/binary.dat"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(repository, "target/invalid.dat"), Buffer.from([0xff]));
  await mkdir(path.join(repository, "target/node_modules"));
  await writeFile(path.join(repository, "target/node_modules/dependency.js"), "ignored\n");
  await writeFile(path.join(repository, "target/large.txt"), "x".repeat(snapshotPolicy.maxFileBytes + 1));
  await writeFile(path.join(repository, "answer-key.md"), "evaluator only\n");
  await symlink("../../answer-key.md", path.join(repository, "target/src/link.ts"));
  await git("add", ".");
  await git("commit", "--quiet", "-m", "test: seed repository");
  const commit = await git("rev-parse", "HEAD");
  await git("update-index", "--add", "--cacheinfo", `160000,${commit},target/vendor`);
  await git("commit", "--quiet", "-m", "test: add submodule entry");
  const selectedCommit = await git("rev-parse", "HEAD");
  await writeFile(path.join(repository, "target/src/item.ts"), "working tree change\n");
  await writeFile(path.join(repository, "target/untracked.ts"), "untracked\n");
  const request = { repository, commit: selectedCommit, subtree: "target", outputParent: path.join(directory, "runs") };
  const first = await prepareSnapshot(request);
  const second = await prepareSnapshot(request);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.deepEqual(first.files.map((file) => file.path), ["src/item.ts"]);
  assert.equal(await readFile(path.join(first.root, "src/item.ts"), "utf8"), "export const quantity = 12;\n");
  assert.equal(first.skipped.find((file) => file.path === ".env")?.reason, "excluded_path");
  assert.equal(first.skipped.find((file) => file.path === "server.pem")?.reason, "excluded_path");
  assert.equal(first.skipped.find((file) => file.path === "src/link.ts")?.reason, "not_regular_file");
  assert.equal(first.skipped.find((file) => file.path === "vendor")?.reason, "not_regular_file");
  assert.equal(first.skipped.find((file) => file.path === "binary.dat")?.reason, "not_utf8_text");
  assert.equal(first.skipped.find((file) => file.path === "invalid.dat")?.reason, "not_utf8_text");
  assert.equal(first.skipped.find((file) => file.path === "large.txt")?.reason, "file_size_limit");
  const manifest = JSON.parse(await readFile(path.join(first.root, "../manifest.json"), "utf8"));
  assert.equal(manifest.commit, selectedCommit);
  assert.equal(manifest.subtree, "target");
  await assert.rejects(prepareSnapshot({ ...request, commit: "HEAD" }));
  await assert.rejects(prepareSnapshot({ ...request, subtree: "../target" }));
});

test("listing and search paginate in stable order; source lines preserve CRLF numbering", async (t) => {
  const { inspector } = await sample(t, {
    "src/a.ts": "tenant one\r\nsecond\r\ntenant two\r\n",
    "src/b.ts": "tenant three\n",
    "empty.ts": "",
  });
  const listed = await inspector.execute("list_files", { directory: "src", limit: 1 });
  assert.equal(listed.kind, "list_files");
  if (listed.kind !== "list_files") return;
  assert.deepEqual(listed.files, ["src/a.ts"]);
  assert.equal(listed.truncated, true);
  assert.equal(listed.nextOffset, 1);
  const next = await inspector.execute("list_files", { directory: "src", offset: listed.nextOffset });
  assert.equal(next.kind, "list_files");
  if (next.kind === "list_files") assert.deepEqual(next.files, ["src/b.ts"]);
  const found = await inspector.execute("search_text", { query: "tenant", limit: 1, offset: 1 });
  assert.equal(found.kind, "search_text");
  if (found.kind === "search_text") {
    assert.deepEqual(found.matches, [{ path: "src/a.ts", line: 3, text: "tenant two" }]);
    assert.equal(found.nextOffset, 2);
  }
  const read = await inspector.execute("read_lines", { path: "src/a.ts", startLine: 2, endLine: 10 });
  assert.equal(read.kind, "read_lines");
  if (read.kind === "read_lines") {
    assert.deepEqual(read.lines, [{ line: 2, text: "second" }, { line: 3, text: "tenant two" }]);
    assert.equal(read.truncated, false);
  }
  const empty = await inspector.execute("read_lines", { path: "empty.ts" });
  if (empty.kind === "read_lines") assert.deepEqual(empty.lines, []);
  else assert.fail("Empty file should be readable");
  const absent = await inspector.execute("search_text", { query: ".*" });
  if (absent.kind === "search_text") assert.deepEqual(absent.matches, []);
  else assert.fail("Search should treat regex metacharacters as literal text");
});

test("tool boundary rejects traversal, absolute paths, excluded paths, unknown files, and malformed arguments", async (t) => {
  const { inspector } = await sample(t, { "src/item.ts": "hello\n" });
  for (const file of ["../answer-key.md", "/etc/passwd", "src/../../outside", "src\\item.ts", "C:/secret", ".env", "priv/info.md", "unknown.ts", "src//item.ts", "src/./item.ts", "src/item.ts\0"]) {
    assert.equal((await inspector.execute("read_lines", { path: file })).kind, "error", file);
  }
  for (const input of [null, [], { path: "src/item.ts", startLine: 0 }, { path: "src/item.ts", startLine: 1.5 }, { path: "src/item.ts", endLine: 201 }, { path: "src/item.ts", startLine: 2 }, { path: "src/item.ts", command: "anything" }]) {
    assert.equal((await inspector.execute("read_lines", input)).kind, "error");
  }
  assert.equal((await inspector.execute("search_text", { query: "" })).kind, "error");
  assert.equal((await inspector.execute("list_files", { directory: "../evaluation" })).kind, "error");
  assert.equal((await inspector.execute("shell", { command: "anything" })).kind, "error");
});

test("read and search response byte limits preserve whole UTF-8 lines and resumable positions", async (t) => {
  const text = Array.from({ length: 12 }, (_, i) => `tenant ${i} ${"é".repeat(30)}`).join("\n");
  const { inspector } = await sample(t, { "item.ts": text });
  for (const [name, args] of [
    ["read_lines", { path: "item.ts", startLine: 1, endLine: 12 }],
    ["search_text", { query: "tenant" }],
  ] as const) {
    const result = await inspector.execute(name, args, 400);
    assert.ok(serializedBytes(result) <= 400);
    assert.ok(result.kind === "read_lines" || result.kind === "search_text");
    assert.equal(result.truncated, true);
    const returned = result.kind === "read_lines" ? result.lines : result.matches;
    assert.ok(returned.length > 0);
    assert.equal(returned[0].text, `tenant 0 ${"é".repeat(30)}`);
    if (result.kind === "read_lines") assert.equal(result.nextStartLine, returned.length + 1);
    else assert.equal(result.nextOffset, returned.length);
  }
  await assert.rejects(inspector.execute("read_lines", { path: "item.ts" }, 100), OutputBudgetError);
  const { inspector: longLine } = await sample(t, { "item.ts": "x".repeat(20_000) });
  await assert.rejects(longLine.execute("read_lines", { path: "item.ts" }), OutputBudgetError);
});

test("listing obeys response bytes and search resumes without skipping or repeating matches", async (t) => {
  const entries = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [
    `src/${String(i).padStart(2, "0")}-${"name".repeat(5)}.ts`, "tenant\ntenant\n",
  ]));
  const { inspector } = await sample(t, entries);
  const listing = await inspector.execute("list_files", {}, 300);
  assert.equal(listing.kind, "list_files");
  assert.ok(serializedBytes(listing) <= 300);
  if (listing.kind === "list_files") {
    assert.equal(listing.truncated, true);
    assert.equal(listing.nextOffset, listing.files.length);
  }
  const matches = [];
  let offset = 0;
  for (;;) {
    const result = await inspector.execute("search_text", { query: "tenant", limit: 3, offset }, 400);
    assert.equal(result.kind, "search_text");
    if (result.kind !== "search_text") return;
    assert.ok(serializedBytes(result) <= 400);
    matches.push(...result.matches.map((match) => `${match.path}:${match.line}`));
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  }
  assert.equal(matches.length, 30);
  assert.equal(new Set(matches).size, 30);
});

test("modified, deleted, or symlink-replaced snapshot files fail closed before returning evidence", async (t) => {
  for (const mode of ["modify", "delete", "file_link", "directory_link", "oversize"]) {
    const { root, inspector } = await sample(t, { "src/item.ts": "original\n" });
    const file = path.join(root, "src/item.ts");
    if (mode === "modify") await writeFile(file, "changed\n");
    if (mode === "oversize") await writeFile(file, "x".repeat(snapshotPolicy.maxFileBytes + 1));
    if (mode === "delete") await unlink(file);
    if (mode === "file_link") {
      const outside = await temporary(t);
      await writeFile(path.join(outside, "secret.ts"), "outside\n");
      await unlink(file);
      await symlink(path.join(outside, "secret.ts"), file);
    }
    if (mode === "directory_link") {
      const outside = await temporary(t);
      await writeFile(path.join(outside, "item.ts"), "outside\n");
      await rm(path.join(root, "src"), { recursive: true });
      await symlink(outside, path.join(root, "src"));
    }
    await assert.rejects(inspector.execute("read_lines", { path: "src/item.ts" }), SnapshotChangedError, mode);
    await assert.rejects(inspector.execute("search_text", { query: "original" }), SnapshotChangedError, mode);
  }
});

