import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_GROUP_WORKSPACE_LIMITS,
  listDesktopWorkspaceRooms,
  loadDesktopGroupWorkspace,
  sendDesktopGroupMessage,
  subscribeDesktopGroupWorkspace,
} from "./group-workspace.mjs";

const ROOM = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT = "33333333-3333-4333-8333-333333333333";

function result(data, error = null) { return { data, error }; }

function createClient(fixtures = {}) {
  const calls = [];
  const channels = [];
  const client = {
    auth: { async getUser() { calls.push(["auth.getUser"]); return result({ user: { id: USER } }); } },
    from(table) {
      const state = { table, action: "select", filters: [], orders: [], limit: null, payload: null, selection: null };
      const query = {
        select(columns) { state.selection = columns; calls.push([table, "select", columns]); return query; },
        eq(column, value) { state.filters.push([column, value]); calls.push([table, "eq", column, value]); return query; },
        order(column, options) { state.orders.push([column, options]); return query; },
        limit(value) { state.limit = value; return query; },
        insert(payload) { state.action = "insert"; state.payload = payload; calls.push([table, "insert", payload]); return query; },
        single() { return Promise.resolve(resolve(state, true)); },
        maybeSingle() { return Promise.resolve(resolve(state, false)); },
        then(resolvePromise, rejectPromise) { return Promise.resolve(resolve(state, false)).then(resolvePromise, rejectPromise); },
      };
      function resolve(current, one) {
        if (current.action === "insert") {
          if (fixtures.insertError) return result(null, fixtures.insertError);
          return result({ ...current.payload, created_at: "2026-11-08T10:00:00.000Z" });
        }
        const configured = fixtures[current.table] ?? [];
        const error = fixtures.errors?.[current.table] ?? null;
        if (error) return result(null, error);
        if (one) return result(Array.isArray(configured) ? configured[0] ?? null : configured);
        return result(Array.isArray(configured) ? configured : configured ? [configured] : []);
      }
      return query;
    },
    channel(name) {
      const entry = { name, handlers: [], on(event, filter, callback) { entry.handlers.push({ event, filter }); return entry; }, subscribe() { return entry; } };
      channels.push(entry); return entry;
    },
    async removeChannel(channel) { calls.push(["removeChannel", channel.name]); },
  };
  return { client, calls, channels };
}

test("lists only rooms returned by the authenticated RLS-filtered Supabase client", async () => {
  const rooms = [{ id: ROOM, owner_id: USER, title: "Research", objective: "Build together" }];
  const f = createClient({ rooms });
  assert.deepEqual(await listDesktopWorkspaceRooms(f.client), rooms);
  assert.equal(f.calls.some(call => call[0] === "rooms" && call[1] === "eq" && call[2] === "owner_id"), false);
});

test("loads a bounded shared collaboration snapshot and never requests private imports", async () => {
  const messages = [
    { id: "m2", room_id: ROOM, sender_id: PARTICIPANT, body: "Second", created_at: "2026-11-08T10:02:00Z" },
    { id: "m1", room_id: ROOM, sender_id: PARTICIPANT, body: "First", created_at: "2026-11-08T10:01:00Z" },
  ];
  const f = createClient({
    rooms: [{ id: ROOM, owner_id: USER, title: "Research", objective: "Build together" }],
    messages,
    participants: [{ id: PARTICIPANT, display_name: "Human", kind: "human", status: "active" }],
    room_memory_entries: [{ id: "mem1", entry_type: "decision", content: "Keep it lean" }],
    room_tasks: [{ id: "task1", title: "Review", status: "assigned", priority: 2 }],
  });
  const snapshot = await loadDesktopGroupWorkspace(f.client, ROOM);
  assert.deepEqual(snapshot.messages.map(item => item.id), ["m1", "m2"]);
  assert.equal(snapshot.memories[0].content, "Keep it lean");
  assert.equal(snapshot.tasks[0].title, "Review");
  assert.equal(f.calls.some(call => call[0] === "room_memory_entries" && call[1] === "eq" && call[2] === "visibility" && call[3] === "group"), true);
  assert.equal(f.calls.some(call => call[0] === "room_session_imports"), false);
  assert.equal(f.calls.some(call => call[0] === "messages" && call[1] === "limit" && call[2] === DESKTOP_GROUP_WORKSPACE_LIMITS.messages), true);
});

test("group tasks remain an optional capability when staging migrations are not present", async () => {
  const f = createClient({
    rooms: [{ id: ROOM, title: "Research" }],
    messages: [], participants: [], room_memory_entries: [],
    errors: { room_tasks: { code: "PGRST205", message: "Could not find the table room_tasks in the schema cache" } },
  });
  const snapshot = await loadDesktopGroupWorkspace(f.client, ROOM);
  assert.equal(snapshot.tasksAvailable, false);
  assert.deepEqual(snapshot.tasks, []);
});

test("does not suppress task permission or other query errors", async () => {
  const f = createClient({
    rooms: [{ id: ROOM, title: "Research" }], messages: [], participants: [], room_memory_entries: [],
    errors: { room_tasks: { code: "42501", message: "permission denied" } },
  });
  await assert.rejects(() => loadDesktopGroupWorkspace(f.client, ROOM), /permission denied/);
});

test("sending requires an active human participant and writes a single bounded message", async () => {
  const f = createClient({ participants: [{ id: PARTICIPANT }] });
  const message = await sendDesktopGroupMessage(f.client, ROOM, "  Hello group  ");
  assert.equal(message.body, "Hello group");
  const write = f.calls.find(call => call[0] === "messages" && call[1] === "insert");
  assert.equal(write[2].room_id, ROOM);
  assert.equal(write[2].sender_id, PARTICIPANT);
  assert.equal(write[2].body, "Hello group");
  assert.match(write[2].id, /^[0-9a-f-]{36}$/i);
  assert.ok(f.calls.some(call => call[0] === "participants" && call[1] === "eq" && call[2] === "kind" && call[3] === "human"));
  assert.ok(f.calls.some(call => call[0] === "participants" && call[1] === "eq" && call[2] === "status" && call[3] === "active"));
});

test("sending refuses empty, oversized, unauthenticated and non-member messages", async () => {
  const empty = createClient();
  await assert.rejects(() => sendDesktopGroupMessage(empty.client, ROOM, "   "), /1-10,000/);
  await assert.rejects(() => sendDesktopGroupMessage(empty.client, ROOM, "x".repeat(10_001)), /1-10,000/);
  const unauthenticated = createClient();
  unauthenticated.client.auth.getUser = async () => result({ user: null });
  await assert.rejects(() => sendDesktopGroupMessage(unauthenticated.client, ROOM, "Hi"), /Sign in/);
  const notMember = createClient({ participants: [] });
  await assert.rejects(() => sendDesktopGroupMessage(notMember.client, ROOM, "Hi"), /active human member/);
});

test("realtime subscriptions are room-filtered and safely removable", async () => {
  const f = createClient();
  const refresh = () => {};
  const unsubscribe = subscribeDesktopGroupWorkspace(f.client, ROOM, refresh);
  assert.equal(f.channels.length, 1);
  assert.equal(f.channels[0].handlers.length, 2);
  assert.ok(f.channels[0].handlers.every(handler => handler.filter.filter === "room_id=eq." + ROOM));
  unsubscribe();
  assert.deepEqual(f.calls[0], ["removeChannel", f.channels[0].name]);
});
