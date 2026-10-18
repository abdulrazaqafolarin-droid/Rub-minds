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
