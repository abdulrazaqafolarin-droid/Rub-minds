import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeCanonicalWakeAdapter } from './native-canonical-wake-adapter.mjs';
import { LocalExecutionGuard } from './host-runtime.mjs';
import { buildCanonicalWakePrompt } from './coordination-core.mjs';

const target = Object.freeze({
  id: 'native-target-1', roomId: 'room-1', hostId: 'host-1', spaceId: 'space-1',
  sessionId: 'session-1', appId: 'com.example.chat',
  identityFingerprint: 'foreground-app-fingerprint',
  providerConversationIdentityDigest: 'e'.repeat(64),
  surface: 'android_app', locatorKind: 'accessibility',
  locatorValue: 'native-composer-opaque', revision: 3,
});
const command = Object.freeze({
  id: 'wake_job_123', eventId: 'message_123',
  roomId: target.roomId, hostId: target.hostId, spaceId: target.spaceId,
  sessionId: target.sessionId, identityFingerprint: target.identityFingerprint,
  providerConversationIdentityDigest: target.providerConversationIdentityDigest,
  targetId: target.id, targetRevision: target.revision, operation: 'wake',
  text: buildCanonicalWakePrompt('message_123'),
});

function readyState() {
  return {
    connected: true, focused: true, composerEmpty: true,
    composerIdentityVerified: true, sendControlUnique: true,
    sendControlEnabled: true, sendControlVisible: true,
    sendControlIdentityVerified: true, providerConversationIdentityVerified: true, targetId: target.id,
    targetRevision: target.revision, locatorKind: 'accessibility',
    composerIdentityDigest: 'a'.repeat(64), sendControlIdentityDigest: 'b'.repeat(64),
    providerConversationIdentityDigest: target.providerConversationIdentityDigest,
    surface: target.surface,
    appId: target.appId, sessionId: target.sessionId,
    identityFingerprint: target.identityFingerprint,
  };
}

function submittedOutcome(input, overrides = {}) {
  return {
    state: 'submitted', eventId: input.eventId,
    targetId: input.target.targetId, targetRevision: input.target.targetRevision,
    composerIdentityDigest: 'a'.repeat(64), sendControlIdentityDigest: 'b'.repeat(64),
    providerConversationIdentityRevalidated: true,
    providerConversationIdentityDigest: target.providerConversationIdentityDigest,
    promptInserted: true, promptReadbackVerified: true,
    composerIdentityRevalidated: true, sendControlIdentityRevalidated: true,
    sendInvoked: true, composerCleared: true, ...overrides,
  };
}

function fixture({ inspect = readyState, submit, surface = target.surface } = {}) {
  const calls = [];
  const driver = {
    async inspectWakeTarget(input) {
      calls.push(['inspect', input]);
      return inspect();
    },
    async submitCanonicalWake(input) {
      calls.push(['submit', input]);
      return submit ? submit(input) : submittedOutcome(input);
    },
  };
  const adapter = new NativeCanonicalWakeAdapter({
    driver, targetId: target.id, roomId: target.roomId, hostId: target.hostId,
    spaceId: target.spaceId, surface, appId: target.appId,
    sessionId: target.sessionId, identityFingerprint: target.identityFingerprint,
    providerConversationIdentityDigest: target.providerConversationIdentityDigest,
    locatorValue: target.locatorValue, targetRevision: target.revision,
  });
  const guard = new LocalExecutionGuard({
    host: { hostId: target.hostId, deviceLabel: 'trusted native companion',
      surfaces: [surface], operations: ['wake'] },
    adapter, permission: async () => true, isConnected: async () => true,
  });
  return { adapter, guard, calls };
}

test('probe requires a foreground empty composer and the same unique verified Send control', async () => {
  const valid = fixture();
  const ready = await valid.adapter.probe({ target, operation: 'wake' });
  assert.equal(ready.nativeWakeReady, true);
  for (const mutate of [
    state => { state.connected = false; },
    state => { state.focused = false; },
    state => { state.composerEmpty = false; },
    state => { state.composerIdentityVerified = false; },
    state => { state.sendControlUnique = false; },
    state => { state.sendControlEnabled = false; },
    state => { state.sendControlVisible = false; },
    state => { state.sendControlIdentityVerified = false; },
    state => { state.composerIdentityDigest = 'not-a-digest'; },
    state => { state.sendControlIdentityDigest = 'not-a-digest'; },
    state => { state.providerConversationIdentityVerified = false; },
    state => { state.providerConversationIdentityDigest = 'not-a-digest'; },

    state => { state.targetId = 'another-target'; },
    state => { state.targetRevision = target.revision + 1; },
    state => { state.identityFingerprint = 'other-app'; },
  ]) {
    const state = readyState(); mutate(state);
    const failed = fixture({ inspect: () => state });
    assert.equal((await failed.adapter.probe({ target, operation: 'wake' })).connected, false);
  }
});

test('native wake target mismatch, non-native surfaces and wrong operation fail closed', async () => {
  const f = fixture();
  assert.equal((await f.adapter.probe({
    target: { ...target, revision: 4 }, operation: 'wake',
  })).connected, false);
  assert.equal((await f.adapter.probe({
    target: { ...target, roomId: 'another-room' }, operation: 'wake',
  })).connected, false);
  assert.equal((await f.adapter.probe({ target, operation: 'draft' })).connected, false);
  assert.throws(() => new NativeCanonicalWakeAdapter({
    driver: { inspectWakeTarget() {}, submitCanonicalWake() {} },
    targetId: target.id, roomId: target.roomId, hostId: target.hostId,
    spaceId: target.spaceId, surface: 'terminal', appId: target.appId,
    sessionId: target.sessionId, identityFingerprint: target.identityFingerprint,
    locatorValue: target.locatorValue, targetRevision: target.revision,
  }), /surface/);
});

test('driver receives only the fixed canonical prompt and the native target scope', async () => {
  const f = fixture();
  const outcome = await f.guard.execute({
    command, target, beforeEffect: async () => true,
  });
  assert.equal(outcome.state, 'completed');
  const request = f.calls.find(([kind]) => kind === 'submit')[1];
  const preflight = f.calls.find(([kind]) => kind === 'inspect')[1];
  assert.equal(request.prompt, buildCanonicalWakePrompt(command.eventId));
  assert.equal(request.eventId, command.eventId);
  assert.equal(request.target.targetId, target.id);
  assert.equal(request.target.targetRevision, target.revision);
  assert.equal(request.automaticRetry, false);
  assert.equal(request.requireSendControlIdentityRecheck, true);
  assert.equal(request.requireProviderConversationIdentityRecheck, true);
  assert.equal(request.providerConversationIdentityDigest, target.providerConversationIdentityDigest);
  assert.equal(preflight.target.targetRevision, target.revision);
  assert.equal('text' in request, false);
});

test('arbitrary provider text and mismatched event prompts never reach the platform driver', async () => {
  const f = fixture();
  await assert.rejects(
    f.guard.execute({ command: { ...command, text: 'hello' }, target }),
    /canonical event-bound/,
  );
  await assert.rejects(
    f.guard.execute({
      command: { ...command, text: buildCanonicalWakePrompt('another_event') }, target,
    }),
    /canonical event-bound/,
  );
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('durable execution seal runs after native preflight and before Send', async () => {
  const f = fixture(); const order = [];
  const guard = new LocalExecutionGuard({
    host: { hostId: target.hostId, deviceLabel: 'trusted native companion',
      surfaces: [target.surface], operations: ['wake'] },
    adapter: {
      probe: async args => { order.push('probe'); return f.adapter.probe(args); },
      execute: async args => { order.push('submit'); return f.adapter.execute(args); },
    },
    permission: async () => { order.push('permission'); return true; },
    isConnected: async () => { order.push('connected'); return true; },
  });
  const result = await guard.execute({
    command, target, beforeEffect: async () => { order.push('seal'); return true; },
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(order, ['connected', 'permission', 'probe', 'seal', 'submit']);
});

test('failed final preflight does not reserve execution seal or invoke Send', async () => {
  const state = readyState(); state.sendControlIdentityVerified = false;
  const f = fixture({ inspect: () => state }); let sealed = false;
  await assert.rejects(
    f.guard.execute({ command, target, beforeEffect: async () => { sealed = true; return true; } }),
    /identity\/focus mismatch/,
  );
  assert.equal(sealed, false);
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('native wake refuses to run without a durable execution seal', async () => {
  const f = fixture();
  await assert.rejects(f.guard.execute({ command, target }), /durable execution seal/);
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('seal denial blocks the native Send operation', async () => {
  const f = fixture();
  await assert.rejects(
    f.guard.execute({ command, target, beforeEffect: async () => false }),
    /seal/,
  );
  assert.equal(f.calls.some(([kind]) => kind === 'submit'), false);
});

test('composer-clear confirmation is required; an ambiguous Send becomes needs_review', async () => {
  const f = fixture({ submit: async input =>
    submittedOutcome(input, { composerCleared: false }) });
  const result = await f.guard.execute({
    command, target, beforeEffect: async () => true,
  });
  assert.equal(result.state, 'needs_review');
  assert.equal(result.result, null);
});

test('the durable one-time seal prevents a second attempt after an uncertain native Send', async () => {
  const f = fixture({ submit: async input =>
    submittedOutcome(input, { composerCleared: false }) });
  let reservations = 0;
  const reserve = async () => { reservations += 1; return reservations === 1; };
  const first = await f.guard.execute({ command, target, beforeEffect: reserve });
  assert.equal(first.state, 'needs_review');
  await assert.rejects(f.guard.execute({ command, target, beforeEffect: reserve }), /seal/);
  assert.equal(f.calls.filter(([kind]) => kind === 'submit').length, 1);
  assert.equal(f.adapter.hasAttempted(command.id), true);
});

test('a device exception after the seal is converted into needs_review, never a retry signal', async () => {
  const f = fixture({ submit: async () => { throw new Error('native IPC disconnected after click'); } });
  const result = await f.guard.execute({
    command, target, beforeEffect: async () => true,
  });
  assert.equal(result.state, 'needs_review');
  assert.equal(result.result, null);
  assert.equal(f.adapter.hasAttempted(command.id), true);
});
test('identity fingerprints must remain exactly the same after the durable seal', async () => {
  const f = fixture({
    submit: async input => submittedOutcome(input, {
      composerIdentityDigest: 'c'.repeat(64),
    }),
  });
  const result = await f.guard.execute({
    command, target, beforeEffect: async () => true,
  });
  assert.equal(result.state, 'needs_review');
  assert.equal(result.result, null);
  assert.equal(f.calls.filter(([kind]) => kind === 'submit').length, 1);
});



test('provider conversation switch or missing final conversation proof becomes needs_review', async () => {
  for (const overrides of [
    { providerConversationIdentityRevalidated: false },
    { providerConversationIdentityDigest: 'f'.repeat(64) },
  ]) {
    const f = fixture({ submit: async input => submittedOutcome(input, overrides) });
    const result = await f.guard.execute({
      command, target, beforeEffect: async () => true,
    });
    assert.equal(result.state, 'needs_review');
    assert.equal(f.adapter.hasAttempted(command.id), true);
  }
});
