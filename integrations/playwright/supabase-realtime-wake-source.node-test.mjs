import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseRealtimeWakeSource } from "./supabase-realtime-wake-source.mjs";

function fakeClient() {
  let callback;
  let config;
  const channel = {
    on: (event, options, handler) => { config = { event, options }; callback = handler; return channel; },
    subscribe: handler => { queueMicrotask(() => handler("SUBSCRIBED")); return channel; },
  };
  return {
    channel: name => { channel.name = name; return channel; },
    removeChannel: async value => { assert.equal(value, channel); },
    emit: payload => callback(payload),
    getConfig: () => ({ name: channel.name, ...config }),
  };
}

test("subscribes only to inserts for the specified room and wakes on its message", async () => {
  const client = fakeClient();
  const source = new SupabaseRealtimeWakeSource({ client, roomId: "room-123" });
  await source.start();
  assert.deepEqual(client.getConfig(), {
    name: "rub-minds-wake-room-123",
    event: "postgres_changes",
    options: { event: "INSERT", schema: "public", table: "messages", filter: "room_id=eq.room-123" },
  });
  const waiting = source.waitForWake({ timeoutMs: 1000 });
  client.emit({ new: { room_id: "other-room" } });
  client.emit({ new: { room_id: "room-123", body: "hello" } });
  assert.deepEqual(await waiting, { status: "wake" });
  await source.close();
});

test("queues a bounded wake if no waiter is waiting", async () => {
  const client = fakeClient();
  const source = new SupabaseRealtimeWakeSource({ client, roomId: "r", maxQueuedWakes: 1 });
  await source.start();
  client.emit({ new: { room_id: "r" } });
  client.emit({ new: { room_id: "r" } });
  assert.deepEqual(await source.waitForWake({ timeoutMs: 1000 }), { status: "wake" });
  assert.deepEqual(await source.waitForWake({ timeoutMs: 5 }), { status: "timeout" });
  await source.close();
});

test("supports timeout, cancellation, and close without leaking waiters", async () => {
  const client = fakeClient();
  const source = new SupabaseRealtimeWakeSource({ client, roomId: "r" });
  await source.start();
  assert.deepEqual(await source.waitForWake({ timeoutMs: 5 }), { status: "timeout" });
  const controller = new AbortController();
  const pending = source.waitForWake({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  assert.deepEqual(await pending, { status: "closed" });
  const pendingClose = source.waitForWake({ timeoutMs: 1000 });
  await source.close();
  assert.deepEqual(await pendingClose, { status: "closed" });
  assert.deepEqual(await source.waitForWake(), { status: "closed" });
});


test("removes the channel when subscription fails", async () => {
  let removed = 0;
  const channel = {
    on: () => channel,
    subscribe: handler => { queueMicrotask(() => handler("CHANNEL_ERROR")); return channel; },
  };
  const client = {
    channel: () => channel,
    removeChannel: async value => { assert.equal(value, channel); removed++; },
  };
  const source = new SupabaseRealtimeWakeSource({ client, roomId: "r" });
  await assert.rejects(() => source.start(), /subscription failed: CHANNEL_ERROR/);
  assert.equal(removed, 1);
  assert.equal(source.channel, null);
});

test("bounds a subscription handshake that never reports a status", async () => {
  let removed = 0;
  const channel = { on: () => channel, subscribe: () => channel };
  const client = {
    channel: () => channel,
    removeChannel: async value => { assert.equal(value, channel); removed++; },
  };
  const source = new SupabaseRealtimeWakeSource({ client, roomId: "r", subscriptionTimeoutMs: 100 });
  await assert.rejects(() => source.start(), /local handshake timeout/);
  assert.equal(removed, 1);
  assert.equal(source.channel, null);
});

