import test from "node:test";
import assert from "node:assert/strict";
import { createRubMindsTools } from "./rub-minds-tools.mjs";

const credential = "a".repeat(64);
const document = {
  schema: "rub-minds.session-memory",
  version: 1,
  source: { platform: "test", session_label: "Test session" },
  summary: "Context summary",
  current_goal: "Test goal",
  known_decisions: [],
  open_questions: [],
  relevant_context: [],
  working_preferences: [],
  checkpoint: { last_processed_room_message_id: null },
  sharing: { raw_history_visibility: "private" },
};

test("rejects unsupported session document versions before network access", async () => {
  const tools = createRubMindsTools({ credential });
  assert.throws(() => tools.importSessionDocument({ ...document, version: 2 }), /Unsupported/);
});

test("imports session document through the fixed Rub Minds memory endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ imported: true }), {
      status: 201, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = createRubMindsTools({ credential });
    const result = await tools.importSessionDocument(document);
    assert.deepEqual(result, { imported: true });
    assert.equal(captured.url, "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/session-memory");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Authorization, "Bearer " + credential);
    assert.deepEqual(JSON.parse(captured.options.body), { operation: "import", document });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads a private conversation transcript without posting it to the group-message endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  const transcriptDocument = {
    ...document,
    transcript_text: "User: Can you help me?\\nAssistant: Yes.",
    transcript_complete: true,
  };
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ imported: true, visibility: "private" }), {
      status: 201, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = createRubMindsTools({ credential });
    const result = await tools.importSessionDocument(transcriptDocument);
    assert.deepEqual(result, { imported: true, visibility: "private" });
    assert.equal(captured.url, "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/session-memory");
    const payload = JSON.parse(captured.options.body);
    assert.equal(payload.operation, "import");
    assert.equal(payload.document.transcript_text, transcriptDocument.transcript_text);
    assert.equal(payload.document.transcript_complete, true);
    assert.equal(payload.document.sharing.raw_history_visibility, "private");
    assert.equal(captured.options.headers.Authorization, "Bearer " + credential);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads session memory using the same scoped credential and fixed endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ imports: [], group_memory: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = createRubMindsTools({ credential });
    assert.deepEqual(await tools.readSessionMemory(), { imports: [], group_memory: [] });
    assert.equal(captured.url, "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/session-memory");
    assert.equal(captured.options.headers.Authorization, "Bearer " + credential);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires explicit visibility and idempotency for memory writes", () => {
  const tools = createRubMindsTools({ credential });
  assert.throws(() => tools.rememberGroupMemory({
    entryType: "insight", content: "Useful insight", idempotencyKey: "insight-key-0001",
  }), /visibility/);
});

test("writes a selected group memory entry with provenance and idempotency", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ remembered: true }), {
      status: 201, headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const tools = createRubMindsTools({ credential });
    await tools.rememberGroupMemory({
      entryType: "decision",
      content: "Use a staged rollout",
      visibility: "group",
      idempotencyKey: "decision-rollout-0001",
      sourceMessageIds: ["123e4567-e89b-12d3-a456-426614174000"],
    });
    const payload = JSON.parse(captured.options.body);
    assert.equal(payload.operation, "remember");
    assert.equal(payload.visibility, "group");
    assert.equal(payload.entry_type, "decision");
    assert.equal(payload.content, "Use a staged rollout");
    assert.equal(payload.idempotency_key, "decision-rollout-0001");
    assert.deepEqual(payload.source_message_ids, ["123e4567-e89b-12d3-a456-426614174000"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
