import OpenAI from "openai";
import assert from "node:assert/strict";
import test from "node:test";
import {
  configSchema,
  ModelRequestError,
} from "../src/investigation/contracts.ts";
import type { JsonObject, ModelInput } from "../src/investigation/contracts.ts";
import { OpenAIActionModel } from "../src/infrastructure/ai/OpenAIActionModel.ts";
import {
  bindModelAction,
  modelActionSchemas,
} from "../src/investigation/contracts.ts";

function deepFreeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}

function providerReply(name: "list_files" | "finish", callId: string) {
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
      id: `response-${callId}`,
      object: "response",
      created_at: 1,
      model: "configured-model-version",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: `reasoning-${callId}`,
          summary: [],
          encrypted_content: `opaque-${callId}`,
        },
        {
          type: "function_call",
          id: `function-${callId}`,
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
          status: "completed",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("OpenAI adapter preserves reasoning and function output correlation across requests", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new OpenAI({
    maxRetries: 0,
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
  const model = new OpenAIActionModel(client);
  const config = configSchema.parse({});
  const input: ModelInput = {
    snapshotId: "snapshot",
    config,
    observation: null,
    conversation: { history: [], pendingCallId: null },
  };
  const before = structuredClone(input);
  deepFreeze(input);
  const first = await model.requestAction(input, new AbortController().signal);
  assert.deepEqual(input, before);
  const firstConversation = structuredClone(first.conversation);
  deepFreeze(first.conversation);
  assert.equal((first.action as { name: string }).name, "list_files");
  assert.equal(first.actualModel, "configured-model-version");
  assert.deepEqual(first.usage, { inputTokens: 100, outputTokens: 20 });
  const second = await new OpenAIActionModel(client).requestAction(
    {
      snapshotId: "snapshot",
      config,
      observation: { toolCallId: "tool-1", result: { files: ["query.ts"] } },
      conversation: JSON.parse(JSON.stringify(first.conversation)),
    },
    new AbortController().signal,
  );
  assert.deepEqual(first.conversation, firstConversation);
  assert.equal(first.conversation.pendingCallId, "provider-call-1");
  assert.equal(second.conversation.pendingCallId, "provider-call-2");
  assert.deepEqual(
    second.conversation,
    JSON.parse(JSON.stringify(second.conversation)),
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
  assert.equal(bodies[0]!.tool_choice, "required");
  assert.equal(bodies[0]!.max_output_tokens, 8192);
  assert.deepEqual(bodies[0]!.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(bodies[0]!.reasoning, { effort: "medium" });
  assert.deepEqual(
    (bodies[0]!.tools as { name: string }[]).map((tool) => tool.name),
    ["list_files", "search_text", "read_lines", "finish"],
  );
});

test("provider failures are not retried and diagnostics omit provider payloads", async () => {
  let calls = 0;
  const model = new OpenAIActionModel(
    new OpenAI({
      maxRetries: 0,
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
    }),
  );
  await assert.rejects(
    model.requestAction(
      {
        snapshotId: "snapshot",
        config: configSchema.parse({}),
        observation: null,
        conversation: { history: [], pendingCallId: null },
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof ModelRequestError &&
      error.message === "Model provider returned HTTP 429",
  );
  assert.equal(calls, 1);
});

test("one adapter isolates interleaved conversations and replays identical continuation without hidden progress", async () => {
  const requests: { input: JsonObject[] }[] = [];
  const model = new OpenAIActionModel(
    new OpenAI({
      apiKey: "test-key-not-a-secret",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = JSON.parse(await request.text()) as {
          input: JsonObject[];
        };
        requests.push(body);
        const task = JSON.parse(body.input[0]!.content as string)
          .task as string;
        const output = body.input.find(
          (item) => item.type === "function_call_output",
        );
        if (output) assert.equal(output.call_id, `${task}-list`);
        return providerReply(
          output ? "finish" : "list_files",
          `${task}-${output ? "finish" : "list"}`,
        );
      },
    }),
  );
  const inputs: ModelInput[] = ["run-a", "run-b"].map((question) => ({
    snapshotId: question,
    config: configSchema.parse({ question }),
    observation: null,
    conversation: { history: [], pendingCallId: null },
  }));
  const signal = new AbortController().signal;
  const first = await Promise.all(
    inputs.map((input) => model.requestAction(input, signal)),
  );
  const followups = inputs.map((input, index) => ({
    ...input,
    observation: {
      toolCallId: "tool-1",
      result: { files: [`${input.snapshotId}.ts`] },
    },
    conversation: first[index]!.conversation,
  }));
  const before = structuredClone(followups);
  followups.forEach(deepFreeze);
  const second = await Promise.all(
    followups.map((input) => model.requestAction(input, signal)),
  );
  assert.deepEqual(followups, before);
  for (let index = 0; index < second.length; index++) {
    const history = second[index]!.conversation.history;
    assert.equal(
      second[index]!.conversation.pendingCallId,
      `${inputs[index]!.snapshotId}-finish`,
    );
    assert.equal(
      history.some(
        (item) => item.call_id === `${inputs[1 - index]!.snapshotId}-list`,
      ),
      false,
    );
    assert.ok(
      history.some(
        (item) =>
          item.encrypted_content === `opaque-${inputs[index]!.snapshotId}-list`,
      ),
    );
  }
  await model.requestAction(followups[0]!, signal);
  assert.deepEqual(requests.at(-1)!.input, requests[2]!.input);
  assert.deepEqual(followups, before);
});

test("provider and cancellation failures leave continuation unchanged for a caller-directed retry", async () => {
  for (const mode of ["provider", "cancel"] as const) {
    const controller = new AbortController();
    const requests: unknown[] = [];
    const model = new OpenAIActionModel(
      new OpenAI({
        apiKey: "test-key-not-a-secret",
        maxRetries: 0,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(JSON.parse(await request.text()));
          if (requests.length === 1) {
            if (mode === "cancel") {
              controller.abort();
              throw new DOMException("Aborted", "AbortError");
            }
            return new Response(
              JSON.stringify({ error: { message: "provider details" } }),
              { status: 429, headers: { "content-type": "application/json" } },
            );
          }
          return providerReply("list_files", "provider-call-1");
        },
      }),
    );
    const input: ModelInput = {
      snapshotId: "snapshot",
      config: configSchema.parse({}),
      observation: { toolCallId: "tool-1", result: { files: ["query.ts"] } },
      conversation: {
        history: [
          { role: "user", content: "Inspect source." },
          {
            type: "function_call",
            call_id: "prior-provider-call",
            name: "list_files",
            arguments: "{}",
          },
        ],
        pendingCallId: "prior-provider-call",
      },
    };
    const before = structuredClone(input);
    deepFreeze(input);
    await assert.rejects(
      model.requestAction(input, controller.signal),
      ModelRequestError,
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(input, before);
    const reply = await model.requestAction(
      input,
      new AbortController().signal,
    );
    assert.equal(reply.conversation.pendingCallId, "provider-call-1");
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(input, before);
  }
});

test("missing tool correlation fails before HTTP without modifying caller continuation", async () => {
  let calls = 0;
  const model = new OpenAIActionModel(
    new OpenAI({
      apiKey: "test-key-not-a-secret",
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return providerReply("finish", "unused");
      },
    }),
  );
  const input: ModelInput = {
    snapshotId: "snapshot",
    config: configSchema.parse({}),
    observation: { toolCallId: "tool-1", result: {} },
    conversation: {
      history: [{ role: "user", content: "existing conversation" }],
      pendingCallId: null,
    },
  };
  deepFreeze(input);
  const before = structuredClone(input);
  await assert.rejects(
    model.requestAction(input, new AbortController().signal),
    /Missing tool response/,
  );
  await assert.rejects(
    model.requestAction(
      {
        ...input,
        observation: null,
        conversation: {
          ...input.conversation,
          pendingCallId: "provider-call-1",
        },
      },
      new AbortController().signal,
    ),
    /Missing tool response/,
  );
  assert.deepEqual(input, before);
  assert.equal(calls, 0);
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
