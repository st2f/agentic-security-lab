# Repository inspection

Milestone 1 uses a prepared source snapshot and three read-only operations. No
model SDK or LangGraph code is required for this part. The future orchestration
adapter calls `createRepositoryInspector(snapshot).execute(name, arguments,
remainingBytes)` and records the returned result and actual serialized bytes.

## Prepare the source

`prepareSnapshot` in `src/repository/snapshot.ts` accepts a local repository, a
full 40-character Git commit ID, an optional repository-relative subtree, and an
output parent directory. It creates a uniquely named directory containing:

- `source/`: the only directory exposed to inspection.
- `manifest.json`: hashes, snapshot ID, source commit, selected subtree, exclusion
  policy, and skipped paths. This metadata stays outside the accessible root.

The snapshot ID hashes the sorted list of included relative paths and content
hashes. The same included content produces the same identity even at different
source commits; provenance is recorded separately. Source files are copied from
committed Git blobs, so local edits and untracked files are not included.

For the inventory fixture, select the `fixtures/inventory-api` subtree. Do not
expose the entire lab: its evaluation directory contains the answer key.

Only regular UTF-8 text files are copied. The policy excludes dependency and
build directories, private configuration directories, `.env` and `.env.*`, common
key/certificate files, and credential filenames. Symlinks, submodules, binary or
invalid UTF-8 content, and files larger than 1 MiB are skipped with reasons. A
tree with over 10,000 entries or included content over 32 MiB is rejected. See
`snapshotPolicy` and `excludedPath` for the exact policy. Filename exclusions do
not detect secrets embedded in ordinary source; select an appropriate target.

The exporter runs fixed Git subcommands with argument arrays, without a shell.
It never runs the target's scripts, installs its dependencies, or opens its
working-tree source files. Snapshot preparation is application setup, not a
model-callable tool.

## Tool arguments

| Operation | Arguments | Behavior |
| --- | --- | --- |
| `list_files` | Optional `directory` (default `.`), `offset` (default 0), `limit` (default 50, maximum 100) | Recursively lists included files in path order |
| `search_text` | Required `query`; optional `directory`, `offset`, `limit` as above | Case-sensitive literal substring search; complete matching lines in file/line order |
| `read_lines` | Required `path`; optional `startLine` (default 1), `endLine` (default start + 99) | Reads an inclusive one-based range, at most 200 lines |

Paths use forward slashes and are relative to the exposed source root. Absolute
paths, traversal, backslashes, excluded paths, unknown arguments, and unknown
files or directories return bounded `invalid_request` results. Queries are 1–256
characters with no newline or NUL; regexes and shell syntax have no special meaning.
An empty file returns no lines. CRLF line endings are normalized for display,
and a final newline does not invent an additional empty source line.

Results identify the snapshot and operation. Listings return `files`; searches
return `matches` with path, line, and text; reads return `lines` with line and
text. Content and model instructions found in source remain untrusted data.

## Bounds and integrity

The serialized JSON result is at most 16 KiB, including metadata. Callers can
lower that allowance to the remaining run-wide tool-output budget. Pages retain
whole entries and complete source lines, and report `truncated` with `nextOffset`
or `nextStartLine`. Read truncation refers to the requested range, not to lines
outside that range. Pagination beyond the last search/list result is empty.

`OutputBudgetError` means no complete next item fits, or too little response
allowance remains; no partial line is returned. A long source line can therefore
exhaust the usable response allowance. The future application loop must record
and terminate this condition as budget exhaustion.

Before returning file content, the inspector checks path components for symlinks,
checks the canonical boundary and file size, and verifies the bytes against the
manifest hash. Missing, replaced, unreadable, or modified files raise
`SnapshotChangedError`. The application must stop the run and preserve its trace.
Final evidence acceptance must recheck the cited content in the reporting step.
Listings use the manifest; they are navigation aids rather than source evidence.

This is a local immutable-snapshot boundary, not an OS sandbox against concurrent
hostile filesystem modification. The application owns the prepared directory.
Run-wide call counters, deadlines, cancellation, and cumulative response-byte
accounting belong to the application loop in Step 4; this module enforces its
per-invocation input, access, and output rules.

Run `npm run typecheck` and `npm test` for source checking and deterministic
coverage of export provenance, exclusions, boundaries, mutation detection,
line references, literal search, UTF-8 response bytes, and pagination.
