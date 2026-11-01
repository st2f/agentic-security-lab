import assert from "node:assert/strict";
import test from "node:test";
import {
  configSchema,
  ModelRequestError,
} from "../src/investigation/contract.ts";
import { createOpenAIModel } from "../src/models/openai.ts";
import {
  bindModelAction,
  modelActionSchemas,
} from "../src/investigation/contract.ts";

test("OpenAI adapter preserves reasoning and function output correlation across requests", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = createOpenAIModel({
    apiKey: "test-key-not-a-secret",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text());
      bodies.push(body);
      const name = bodies.length === 1 ? "list_files" : "finish";
      const args =
        name === "list_files"
          ? {
              directory: ".",
              offset: 0,
              limit: 50,
              rationale: "Find files.",
              basedOnToolCallIds: [],
              checkpoint: null,
            }
          : {
              candidates: [],
              scopeAndLimitations: [],
              rationale: "Stop.",
              basedOnToolCallIds: ["tool-1"],
            };
      return new Response(
        JSON.stringify({
          id: `response-${bodies.length}`,
          object: "response",
          created_at: 1,
          model: "configured-model-version",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: `reasoning-${bodies.length}`,
              summary: [],
              encrypted_content: "opaque-test-content",
            },
            {
              type: "function_call",
              id: `function-${bodies.length}`,
              call_id: `provider-call-${bodies.length}`,
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const config = configSchema.parse({});
  const first = await model(
    { snapshotId: "snapshot", config, observation: null },
    new AbortController().signal,
  );
  assert.equal((first.action as { name: string }).name, "list_files");
  assert.equal(first.actualModel, "configured-model-version");
  assert.deepEqual(first.usage, { inputTokens: 100, outputTokens: 20 });
  await model(
    {
      snapshotId: "snapshot",
      config,
      observation: { toolCallId: "tool-1", result: { files: ["query.ts"] } },
    },
    new AbortController().signal,
  );
  const secondInput = bodies[1]!.input as {
    type?: string;
    call_id?: string;
    encrypted_content?: string;
    output?: string;
  }[];
  assert.ok(
    secondInput.some(
      (item) =>
        item.type === "reasoning" &&
        item.encrypted_content === "opaque-test-content",
    ),
  );
  const observation = secondInput.find(
    (item) => item.type === "function_call_output",
  );
  assert.equal(observation?.call_id, "provider-call-1");
  assert.equal(JSON.parse(observation!.output!).toolCallId, "tool-1");
  assert.equal(bodies[0]!.model, "gpt-6-luna");
  assert.equal(bodies[0]!.store, false);
  assert.equal(bodies[0]!.parallel_tool_calls, false);
});

test("provider failures are not retried and diagnostics omit provider payloads", async () => {
  let calls = 0;
  const model = createOpenAIModel({
    apiKey: "test-key-not-a-secret",
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            message: "sensitive request details",
            type: "rate_limit_error",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  await assert.rejects(
    model(
      {
        snapshotId: "snapshot",
        config: configSchema.parse({}),
        observation: null,
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof ModelRequestError &&
      error.message === "Model provider returned HTTP 429",
  );
  assert.equal(calls, 1);
});

test("snapshot identity is supplied from run context for final and checkpoint references", () => {
  const reference = {
    path: "query.ts",
    startLine: 1,
    endLine: 2,
    toolCallId: "tool-1",
  };
  const candidate = {
    id: "candidate-1",
    claim: "A lookup may lack tenant scoping.",
    rationale: "Only the ID is supplied.",
    supportingEvidence: [reference],
    contradictoryEvidence: [
      { reference, explanation: "The callee might enforce it." },
    ],
    uncertainties: ["Callee not inspected."],
    priorityReason: "Possible cross-tenant disclosure.",
    nextChecks: ["Read callee."],
  };
  const snapshotId =
    "8107b80d6ea834ab142df53f56ec7157ce4149e7b12544cc4d2b8508e008d8d0";
  const finish = {
    name: "finish",
    rationale: "Report hypothesis.",
    basedOnToolCallIds: ["tool-1"],
    candidates: [candidate],
    scopeAndLimitations: [],
  };
  const final = bindModelAction(finish, snapshotId);
  assert.equal(final?.name, "finish");
  if (final?.name !== "finish") return;
  assert.equal(
    final.candidates[0]!.supportingEvidence[0]!.snapshotId,
    snapshotId,
  );
  assert.equal(
    final.candidates[0]!.contradictoryEvidence[0]!.reference.snapshotId,
    snapshotId,
  );
  const update = bindModelAction(
    {
      name: "read_lines",
      path: "query.ts",
      startLine: 1,
      endLine: 2,
      rationale: "Follow evidence.",
      basedOnToolCallIds: ["tool-1"],
      checkpoint: [candidate],
    },
    snapshotId,
  );
  if (update?.name !== "read_lines")
    assert.fail("Expected an inspection checkpoint");
  assert.equal(
    update.checkpoint?.[0]?.supportingEvidence[0]?.snapshotId,
    snapshotId,
  );
  const typo = {
    ...candidate,
    supportingEvidence: [{ ...reference, snapshotId: snapshotId.slice(0, 60) }],
  };
  const { name: _name, ...finishArguments } = finish;
  assert.equal(
    modelActionSchemas.finish.safeParse(finishArguments).success,
    true,
  );
  assert.equal(
    modelActionSchemas.finish.safeParse({
      ...finishArguments,
      candidates: [typo],
    }).success,
    false,
  );
  assert.equal(
    bindModelAction({ ...finish, candidates: [typo] }, snapshotId),
    null,
  );
});
