import type { ActionModel } from "../src/investigation/ActionModel.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import type {
  Action,
  Candidate,
  RunResult,
} from "../src/investigation/contracts.ts";
import { defaultLimits } from "../src/investigation/contracts.ts";
import { createExplorationWithModel } from "../src/composition.ts";
import {
  initialExplorationState,
  projectRunResult,
} from "../src/investigation/state.ts";
import type { ExplorationTraceEvent } from "../src/investigation/state.ts";
import {
  digest,
  snapshotPolicy,
} from "../src/infrastructure/repository/snapshot.ts";
import type { Snapshot } from "../src/infrastructure/repository/snapshot.ts";
import { ReportRenderer } from "../src/reporting/ReportRenderer.ts";
import { writeSavedReport } from "../src/reporting/saved-report.ts";
import {
  ReportValidationError,
  ReportValidator,
} from "../src/reporting/ReportValidator.ts";

const validator = new ReportValidator();
const renderer = new ReportRenderer();

async function fixture(
  t: TestContext,
  filename = "query.ts",
  content = "const item = repository.findById(id);\nreturn item.quantity;\n",
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reporting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(root);
  await writeFile(path.join(root, filename), content);
  const files = [{ path: filename, sha256: digest(content) }];
  const manifest = {
    snapshotId: digest(JSON.stringify(files)),
    commit: "a".repeat(40),
    subtree: "target",
    policy: snapshotPolicy,
    files,
    skipped: [],
  };
  const snapshot: Snapshot = { ...manifest, root };
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
  );
  const read: Action = {
    name: "read_lines",
    path: filename,
    startLine: 1,
    endLine: 2,
    rationale: "Inspect the lookup.",
    basedOnToolCallIds: [],
    checkpoint: null,
  };
  const candidate: Candidate = {
    id: "candidate-1",
    claim: "The lookup may expose another tenant's quantity.",
    rationale: "Only an ID is passed to the lookup.",
    priorityReason: "Potential tenant-boundary violation.",
    supportingEvidence: [
      {
        snapshotId: snapshot.snapshotId,
        path: filename,
        startLine: 1,
        endLine: 2,
        toolCallId: "tool-1",
      },
    ],
    contradictoryEvidence: [
      {
        reference: {
          snapshotId: snapshot.snapshotId,
          path: filename,
          startLine: 1,
          endLine: 1,
          toolCallId: "tool-1",
        },
        explanation: "The repository may enforce ownership internally.",
      },
    ],
    uncertainties: ["The repository implementation is not included."],
    nextChecks: ["Inspect the repository's tenant filtering."],
  };
  const finish: Action = {
    name: "finish",
    rationale: "Report the bounded hypothesis.",
    basedOnToolCallIds: ["tool-1"],
    candidates: [candidate],
    scopeAndLimitations: ["Repository internals were not investigated."],
  };
  async function save(run: RunResult) {
    const file = path.join(directory, "run.json");
    await writeFile(file, JSON.stringify(run));
    return file;
  }
  return { directory, root, snapshot, manifest, read, candidate, finish, save };
}
function replies(actions: Action[]): ActionModel {
  let index = 0;
  return {
    requestAction: async (input) => ({
      action: actions[index++],
      conversation: input.conversation,
      actualModel: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };
}

test("retained completed and incomplete experiments preserve their JSON contract and report bytes", async () => {
  const parent = new URL(
    "../docs/experiments/runs/milestone-1/",
    import.meta.url,
  );
  for (const name of [
    "pilot",
    "baseline-targeted",
    "baseline-open",
    "targeted",
    "open",
  ]) {
    const directory = new URL(`${name}/`, parent);
    const run: RunResult = JSON.parse(
      await readFile(new URL("run.json", directory), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(new URL("manifest.json", directory), "utf8"),
    );
    const { elapsedMs, ...usage } = run.usage;
    const projected = projectRunResult(
      {
        ...initialExplorationState(run),
        finalCandidates: run.finalCandidates,
        provisionalCandidates: run.provisionalCandidates,
        termination: run.termination,
        scopeAndLimitations: run.scopeAndLimitations,
        trace: run.trace as ExplorationTraceEvent[],
        usage,
      },
      run,
      elapsedMs,
    );
    // Compare the persisted representation: JSON omits optional undefined fields.
    assert.deepEqual(JSON.parse(JSON.stringify(projected)), run, name);
    const checked = await validator.validate(
      projected,
      manifest,
      fileURLToPath(new URL("source/", directory)),
    );
    const retained = await readFile(new URL("report.md", directory), "utf8");
    assert.equal(renderer.render(checked), retained, name);
    assert.equal(
      renderer.render(checked),
      retained,
      `${name}: repeated render`,
    );
  }
});

test("saved report links exact snapshot ranges, includes protective evidence and tools, and is repeatable", async (t) => {
  const f = await fixture(t);
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([f.read, f.finish]),
  ).run();
  const input = await f.save(run);
  const output = await writeSavedReport(input);
  const markdown = await readFile(output, "utf8");
  assert.ok(markdown.includes("Status: **completed**"));
  assert.ok(markdown.includes("./source/query.ts#L1-L2"));
  assert.ok(markdown.includes("1 | const item = repository.findById(id);"));
  assert.ok(
    markdown.includes("#### Contradictory evidence and protective controls"),
  );
  assert.ok(
    markdown.includes("The repository may enforce ownership internally."),
  );
  assert.ok(markdown.includes("#### Uncertainties"));
  assert.ok(markdown.includes("tenant filtering"));
  assert.ok(markdown.includes("Runtime verification was not performed"));
  assert.ok(markdown.includes("tool-1"));
  assert.ok(markdown.includes("read\\_lines"));
  assert.ok(markdown.includes("| --- | --- | --- | --- | ---: |\n| tool-1"));
  assert.ok(
    markdown.includes("Provider-reported tokens: 20 input, 10 output."),
  );
  assert.equal(await readFile(await writeSavedReport(input), "utf8"), markdown);
});

test("zero candidates and no tool calls do not become a security assurance", async (t) => {
  const f = await fixture(t);
  const finish = { ...f.finish, candidates: [], basedOnToolCallIds: [] };
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([finish]),
  ).run();
  const report = renderer.render(
    await validator.validate(run, f.manifest, f.root),
  );
  assert.ok(report.includes("No credible candidates were returned"));
  assert.ok(
    report.includes("does not establish that the repository is secure"),
  );
  assert.ok(report.includes("No inspection calls"));
  assert.ok(report.includes("no candidate evidence references to validate"));
});

test("incomplete runs retain provisional candidates and partial usage without presenting final findings", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    {
      requestAction: async (input) => {
        calls++;
        if (calls === 3) throw new Error("provider interrupted");
        return {
          conversation: input.conversation,
          action:
            calls === 1
              ? f.read
              : {
                  ...f.read,
                  checkpoint: [f.candidate],
                  basedOnToolCallIds: ["tool-1"],
                },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    },
  ).run();
  const report = renderer.render(
    await validator.validate(run, f.manifest, f.root),
  );
  assert.ok(report.includes("Status: **incomplete**"));
  assert.ok(report.includes("No final assessment is available"));
  assert.ok(report.includes("## Provisional candidates"));
  assert.ok(report.includes(f.candidate.claim));
  assert.ok(
    report.includes("**partial; unavailable request usage is not included**"),
  );
  assert.ok(report.includes("model\\_error"));
});

test("incomplete changed snapshots label provisional evidence as historical and suppress current-source excerpts", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    {
      requestAction: async (input) => {
        calls++;
        if (calls === 3) throw new Error("provider interrupted");
        return {
          conversation: input.conversation,
          action:
            calls === 1
              ? f.read
              : {
                  ...f.read,
                  checkpoint: [f.candidate],
                  basedOnToolCallIds: ["tool-1"],
                },
        };
      },
    },
  ).run();
  assert.equal(run.completion, "incomplete");
  // The saved snapshot changes after the run, before the report is regenerated.
  await writeFile(path.join(f.root, "query.ts"), "changed\n");
  const report = renderer.render(
    await validator.validate(run, f.manifest, f.root),
  );
  assert.ok(report.includes("historical only"));
  assert.ok(report.includes("**not revalidated**"));
  assert.ok(!report.includes("1 | const item"));
  assert.ok(!report.includes("./source/query.ts#L"));
});

test("completed report generation refuses mutated snapshots without overwriting an earlier report", async (t) => {
  const f = await fixture(t);
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([f.read, f.finish]),
  ).run();
  const input = await f.save(run);
  const output = await writeSavedReport(input);
  const before = await readFile(output, "utf8");
  await writeFile(path.join(f.root, "query.ts"), "changed\n");
  await assert.rejects(writeSavedReport(input), ReportValidationError);
  assert.equal(await readFile(output, "utf8"), before);
});

test("saved evidence must match actual returned lines, snapshot provenance, and trace accounting", async (t) => {
  const f = await fixture(t);
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([f.read, f.finish]),
  ).run();
  const cases = [
    (value: RunResult) => {
      value.usage.toolCalls++;
    },
    (value: RunResult) => {
      value.usage.toolResponseBytes++;
    },
    (value: RunResult) => {
      value.request.commit = "b".repeat(40);
    },
    (value: RunResult) => {
      (value.trace[1]!.result as { lines: { text: string }[] }).lines[0]!.text =
        "fabricated code";
    },
    (value: RunResult) => {
      value.finalCandidates![0]!.supportingEvidence[0]!.endLine = 3;
      const finish = value.trace.at(-1)!.action;
      if (finish?.name === "finish") finish.candidates = value.finalCandidates!;
    },
    (value: RunResult) => {
      value.trace[1]!.arguments = {
        name: "read_lines",
        path: "../private",
        startLine: 1,
        endLine: 2,
      };
    },
  ];
  for (const mutate of cases) {
    const copy = structuredClone(run);
    mutate(copy);
    await assert.rejects(
      validator.validate(copy, f.manifest, f.root),
      ReportValidationError,
    );
  }
  await assert.rejects(
    validator.validate({ completion: "completed" }, f.manifest, f.root),
    ReportValidationError,
  );
  await assert.rejects(
    validator.validate(
      run,
      { ...f.manifest, snapshotId: "b".repeat(64) },
      f.root,
    ),
    ReportValidationError,
  );
});

test("model prose and source filenames cannot introduce active links or HTML into the report", async (t) => {
  const f = await fixture(
    t,
    "query[)]#.ts",
    "const example = 1;\n```<script>text</script>\n",
  );
  f.candidate.claim =
    "[click](javascript:alert(1)) <img src=x onerror=alert(1)>";
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([f.read, f.finish]),
  ).run();
  const report = renderer.render(
    await validator.validate(run, f.manifest, f.root),
  );
  assert.ok(report.includes("\\[click\\]\\(javascript:alert\\(1\\)\\)"));
  assert.ok(report.includes("&lt;img"));
  assert.ok(!report.includes("<img"));
  assert.ok(report.includes("./source/query%5B%29%5D%23.ts#L1-L2"));
  assert.ok(report.includes("````text\n"));
});

test("budget exhaustion before a checkpoint remains an incomplete report", async (t) => {
  const f = await fixture(t);
  const run = await createExplorationWithModel(
    f.snapshot,
    { limits: { ...defaultLimits, modelCalls: 1 } },
    replies([f.read]),
  ).run();
  const report = renderer.render(
    await validator.validate(run, f.manifest, f.root),
  );
  assert.ok(report.includes("budget\\_exhausted"));
  assert.ok(
    report.includes("No validated provisional checkpoint was available"),
  );
});

test("report output cannot follow a symlink to overwrite an unrelated file", async (t) => {
  const f = await fixture(t);
  const run = await createExplorationWithModel(
    f.snapshot,
    {},
    replies([f.read, f.finish]),
  ).run();
  const input = await f.save(run);
  const unrelated = path.join(f.directory, "unrelated.txt");
  await writeFile(unrelated, "keep this content");
  await symlink(unrelated, path.join(f.directory, "report.md"));
  await assert.rejects(writeSavedReport(input));
  assert.equal(await readFile(unrelated, "utf8"), "keep this content");
});
