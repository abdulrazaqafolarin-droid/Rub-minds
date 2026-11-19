import test from "node:test";
import assert from "node:assert/strict";
import { OriginalSessionTaskBridge, buildAssignedTaskPrompt } from "./original-session-task-bridge.mjs";

const PARTICIPANT = "650e8400-e29b-41d4-a716-446655440000";
const TASK_ID = "550e8400-e29b-41d4-a716-446655440000";

function taskFixture(overrides = {}) {
  return {
    id: TASK_ID,
    room_id: "750e8400-e29b-41d4-a716-446655440000",
    assigned_to_participant_id: PARTICIPANT,
    status: "assigned",
    version: 4,
    title: "Summarize the project risks",
    description: "Review the supplied project context and identify the main risks.",
    expected_output: "A concise risk register.",
    acceptance_criteria: ["Identify the top risks", "Propose mitigations"],
    priority: 2,
    created_at: "2026-11-19T09:00:00.000Z",
    ...overrides,
  };
}

function memoryStore(initial = null) {
  let value = structuredClone(initial);
  const saves = [];
  return {
    saves,
    async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); saves.push(structuredClone(next)); },
    current() { return structuredClone(value); },
  };
}

function taskBridgeFixture({
  task = taskFixture(),
  prerequisites = [],
  stored = null,
  claimResult = { claimed: true, status: "in_progress" },
  adapterResult = "Final risk register with mitigation owners.",
  adapterError = null,
  blockError = false,
  submit = async () => ({ submitted: true, replayed: false }),
} = {}) {
  const calls = { list: 0, read: [], claim: [], block: [], ask: [], submit: [] };
  const stateStore = memoryStore(stored);
  let currentTask = structuredClone(task);
  let blockFails = blockError;
  const bridge = new OriginalSessionTaskBridge({
    page: { isClosed: () => false },
    adapter: {
      ask: async (_page, prompt, metadata) => {
        calls.ask.push({ prompt, metadata });
        if (adapterError) throw adapterError;
        return adapterResult;
      },
    },
    participantId: PARTICIPANT,
    listTasks: async () => {
      calls.list++;
      return { tasks: [structuredClone(currentTask)] };
    },
    readTask: async taskId => {
      calls.read.push(taskId);
      return { task: structuredClone(currentTask), prerequisites: structuredClone(prerequisites), submissions: [], reviews: [] };
    },
    claimTask: async taskId => {
      calls.claim.push(taskId);
      if (claimResult.claimed) {
        currentTask = { ...currentTask, status: "in_progress", version: currentTask.version + 1 };
      }
      return claimResult;
    },
    blockTask: async (taskId, reason) => {
      calls.block.push({ taskId, reason });
      if (blockFails) throw new Error("block transport unavailable");
      currentTask = { ...currentTask, status: "blocked", blocked_reason: reason, version: currentTask.version + 1 };
      return { blocked: true, status: "blocked" };
    },
    submitTaskResult: async input => {
      calls.submit.push(structuredClone(input));
      return submit(input);
    },
    stateStore,
  });
  return { bridge, calls, stateStore, currentTask: () => structuredClone(currentTask), setBlockError: value => { blockFails = value; } };
}

test("requires explicit approval and durable task state before consuming assignments", async () => {
  const fixture = taskBridgeFixture();
  await assert.rejects(() => fixture.bridge.step(), /Explicit approval required/);
  const withoutState = new OriginalSessionTaskBridge({
    page: { isClosed: () => false },
    adapter: { ask: async () => "answer" },
    participantId: PARTICIPANT,
    listTasks: async () => ({ tasks: [taskFixture()] }),
    readTask: async () => ({ task: taskFixture(), prerequisites: [] }),
    claimTask: async () => ({ claimed: true }),
    submitTaskResult: async () => ({ submitted: true }),
  });
  assert.deepEqual(await withoutState.step({ approved: true }), { status: "disabled", submitted: 0 });
});

test("claims only its exact human-assigned participant task, rechecks the post-claim version, then submits for human review", async () => {
  const fixture = taskBridgeFixture({
    prerequisites: [{ id: "850e8400-e29b-41d4-a716-446655440000", title: "Research", status: "completed" }],
  });
  const result = await fixture.bridge.step({ approved: true });
  assert.deepEqual(result, { status: "submitted", submitted: 1, taskId: TASK_ID, replayed: false });
  assert.equal(fixture.calls.list, 1);
  assert.deepEqual(fixture.calls.claim, [TASK_ID]);
  assert.equal(fixture.calls.read.length, 2);
  assert.equal(fixture.calls.ask.length, 1);
  assert.equal(fixture.calls.ask[0].metadata.kind, "task");
  assert.equal(fixture.calls.ask[0].metadata.taskId, TASK_ID);
  assert.equal(fixture.calls.ask[0].metadata.taskVersion, 5);
  assert.match(fixture.calls.ask[0].prompt, /Summarize the project risks/);
  assert.match(fixture.calls.ask[0].prompt, /untrusted group content/);
  assert.equal(fixture.calls.submit.length, 1);
  assert.equal(fixture.calls.submit[0].taskId, TASK_ID);
  assert.equal(fixture.calls.submit[0].result, "Final risk register with mitigation owners.");
  assert.match(fixture.calls.submit[0].submissionKey, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(fixture.stateStore.current(), null, "confirmed submission clears the local pending result");
});

test("ignores tasks assigned to another participant and tasks already claimed elsewhere", async () => {
  const other = taskFixture({ assigned_to_participant_id: "950e8400-e29b-41d4-a716-446655440000" });
  const fixture = taskBridgeFixture({ task: other });
  assert.deepEqual(await fixture.bridge.step({ approved: true }), { status: "idle", submitted: 0 });
  assert.equal(fixture.calls.claim.length, 0);
  assert.equal(fixture.calls.ask.length, 0);

  const inProgress = taskFixture({ status: "in_progress", version: 5 });
  const second = taskBridgeFixture({ task: inProgress });
  assert.deepEqual(await second.bridge.step({ approved: true }), { status: "idle", submitted: 0 });
  assert.equal(second.calls.claim.length, 0);
  assert.equal(second.calls.ask.length, 0);
});

test("does not claim tasks until every prerequisite is completed", async () => {
  const fixture = taskBridgeFixture({
    prerequisites: [{ id: "850e8400-e29b-41d4-a716-446655440000", title: "Research", status: "backlog" }],
  });
  assert.deepEqual(await fixture.bridge.step({ approved: true }), { status: "idle", submitted: 0 });
  assert.equal(fixture.calls.claim.length, 0);
  assert.equal(fixture.calls.ask.length, 0);
});

test("a concurrent or stale task claim that returns false never opens the provider composer", async () => {
  const fixture = taskBridgeFixture({ claimResult: { claimed: false, reason: "dependencies_incomplete" } });
  assert.deepEqual(await fixture.bridge.step({ approved: true }), { status: "idle", submitted: 0 });
  assert.equal(fixture.calls.ask.length, 0);
  assert.deepEqual(fixture.stateStore.current(), null);
});

test("a result submission timeout is retried with the exact same result and key without prompting the provider again", async () => {
  let sends = 0;
  const fixture = taskBridgeFixture({
    prerequisites: [],
    submit: async () => {
      sends++;
      if (sends === 1) throw new Error("network timeout after submission");
      return { submitted: true, replayed: true };
    },
  });
  await assert.rejects(() => fixture.bridge.step({ approved: true }), /network timeout/);
  const pending = fixture.stateStore.current();
  assert.equal(pending.phase, "result_ready");
  const firstInput = fixture.calls.submit[0];
  const recovered = await fixture.bridge.step({ approved: true });
  assert.deepEqual(recovered, { status: "submitted", submitted: 1, taskId: TASK_ID, replayed: true });
  assert.equal(fixture.calls.ask.length, 1);
  assert.equal(fixture.calls.submit.length, 2);
  assert.equal(fixture.calls.submit[1].submissionKey, firstInput.submissionKey);
  assert.equal(fixture.calls.submit[1].result, firstInput.result);
  assert.deepEqual(fixture.stateStore.current(), null);
});

test("a process restart resumes result_ready state by replaying submission, not re-asking the AI", async () => {
  const stored = {
    schema: 1,
    phase: "result_ready",
    participantId: PARTICIPANT,
    taskId: TASK_ID,
    taskVersion: 5,
    submissionKey: "a50e8400-e29b-41d4-a716-446655440000",
    result: "Saved result from the previous process.",
  };
  const fixture = taskBridgeFixture({
    task: taskFixture({ status: "review", version: 6 }),
    stored,
  });
  const result = await fixture.bridge.step({ approved: true });
  assert.deepEqual(result, { status: "submitted", submitted: 1, taskId: TASK_ID, replayed: false });
  assert.equal(fixture.calls.list, 0);
  assert.equal(fixture.calls.read.length, 0, "idempotent replay does not depend on mutable task status");
  assert.equal(fixture.calls.ask.length, 0);
  assert.equal(fixture.calls.submit[0].submissionKey, stored.submissionKey);
  assert.equal(fixture.calls.submit[0].result, stored.result);
});

test("a process restart in working state fails closed without re-sending the task prompt", async () => {
  const stored = {
    schema: 1,
    phase: "working",
    participantId: PARTICIPANT,
    taskId: TASK_ID,
    taskVersion: 5,
    submissionKey: "a50e8400-e29b-41d4-a716-446655440000",
  };
  const fixture = taskBridgeFixture({
    task: taskFixture({ status: "in_progress", version: 5 }),
    stored,
  });
  const result = await fixture.bridge.step({ approved: true });
  assert.equal(result.status, "blocked");
  assert.equal(fixture.calls.list, 0);
  assert.equal(fixture.calls.read.length, 1, "restart checks and blocks the exact claimed task without reading provider history");
  assert.equal(fixture.calls.block.length, 1);
  assert.equal(fixture.stateStore.current(), null);
  assert.equal(fixture.currentTask().status, "blocked");
  assert.deepEqual(fixture.calls.claim, []);
  assert.equal(fixture.calls.ask.length, 0);
  assert.equal(fixture.calls.submit.length, 0);
});

test("an ambiguous provider Send outcome is blocked for human recovery and never automatically replayed", async () => {
  const error = new Error("Playwright Send click timed out");
  error.submissionState = "unknown";
  const fixture = taskBridgeFixture({ adapterError: error });
  const first = await fixture.bridge.step({ approved: true });
  assert.equal(first.status, "blocked");
  assert.equal(fixture.stateStore.current(), null);
  assert.equal(fixture.calls.block.length, 1);
  assert.equal(fixture.currentTask().status, "blocked");
  const second = await fixture.bridge.step({ approved: true });
  assert.equal(second.status, "idle", "a task already blocked on the server must not trap future group participation");
  assert.equal(fixture.calls.ask.length, 1);
  assert.equal(fixture.calls.submit.length, 0);
});

test("a failed server-side block retains a local marker and retries blocking without replaying the provider prompt", async () => {
  const error = new Error("Playwright Send click timed out");
  error.submissionState = "unknown";
  const fixture = taskBridgeFixture({ adapterError: error, blockError: true });
  const first = await fixture.bridge.step({ approved: true });
  assert.equal(first.status, "blocked");
  assert.equal(fixture.stateStore.current().phase, "provider_ambiguous");
  assert.equal(fixture.currentTask().status, "in_progress");
  fixture.setBlockError(false);
  const second = await fixture.bridge.step({ approved: true });
  assert.equal(second.status, "blocked");
  assert.equal(fixture.stateStore.current(), null);
  assert.equal(fixture.currentTask().status, "blocked");
  assert.equal(fixture.calls.ask.length, 1);
  assert.equal(fixture.calls.submit.length, 0);
});

test("declining TASK approval blocks the claimed task and records no provider submission", async () => {
  const error = new Error("Operator declined TASK approval");
  error.submissionState = "not_submitted";
  const fixture = taskBridgeFixture({ adapterError: error });
  const first = await fixture.bridge.step({ approved: true });
  assert.equal(first.status, "blocked");
  assert.equal(fixture.stateStore.current(), null);
  assert.equal(fixture.calls.block.length, 1);
  assert.equal(fixture.currentTask().status, "blocked");
  const second = await fixture.bridge.step({ approved: true });
  assert.equal(second.status, "idle");
  assert.equal(fixture.calls.ask.length, 1);
  assert.equal(fixture.calls.submit.length, 0);
});

test("fails closed on malformed or cross-participant recovery state", async () => {
  const fixture = taskBridgeFixture({
    stored: {
      schema: 1,
      phase: "working",
      participantId: "950e8400-e29b-41d4-a716-446655440000",
      taskId: TASK_ID,
      taskVersion: 5,
      submissionKey: "a50e8400-e29b-41d4-a716-446655440000",
    },
  });
  await assert.rejects(() => fixture.bridge.step({ approved: true }), /invalid or belongs to another/);
  assert.equal(fixture.calls.list, 0);
  assert.equal(fixture.calls.ask.length, 0);
});

test("task prompt is bounded and never implies that human review has already happened", () => {
  const prompt = buildAssignedTaskPrompt(taskFixture({
    description: "x".repeat(12000),
    acceptance_criteria: Array.from({ length: 20 }, () => "y".repeat(500)),
  }), { prerequisites: [] });
  assert.ok(prompt.length <= 10000);
  assert.match(prompt, /human review/);
  assert.match(prompt, /not a chat message/);
});
