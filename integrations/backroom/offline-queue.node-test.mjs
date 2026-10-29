import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKROOM_PROTOCOL, BACKROOM_PROTOCOL_VERSION } from './protocol.mjs';
import { BackroomOfflineQueue } from './offline-queue.mjs';

const baseNow = Date.parse('2026-10-27T10:00:00.000Z');
const registration = (extra = {}) => ({
  protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION, deviceId: 'device-01', platform: 'windows',
  groupId: '10000000-0000-4000-8000-000000000001', sessionId: 'session-01', provider: 'chatgpt',
  label: 'ChatGPT tab', connectionMode: 'attach_existing', capabilities: ['session.inspect','conversation.read','conversation.send','browser.navigate'],
  consent: { granted: true, approvedBy: 'human-01', approvedAt: '2026-10-27T09:55:00.000Z' }, ...extra,
});
const command = (extra = {}) => ({
  protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION, requestId: 'request-01', idempotencyKey: 'idem-01',
  groupId: '10000000-0000-4000-8000-000000000001', sessionId: 'session-01', action: 'conversation.send',
  params: { text: 'Test message' }, requestedBy: { kind: 'human', id: 'human-01' }, ...extra,
});
const approval = (request, extra = {}) => ({ approvalId: 'approval-' + request.requestId, approvedBy: 'human-01', requestId: request.requestId,
  idempotencyKey: request.idempotencyKey, action: request.action, groupId: request.groupId, sessionId: request.sessionId,
  params: request.params, requestedBy: request.requestedBy, approvedAt: '2026-10-27T09:59:00.000Z',
  expiresAt: '2026-10-27T10:15:00.000Z', ...extra });
function fixture({ now = baseNow, limits = {} } = {}) {
  let clock = now;
  const map = new Map();
  const storage = {
    async list() { return [...map.values()].map(x => structuredClone(x)); },
    async put(record) { map.set(record.requestId, structuredClone(record)); },
    async delete(requestId) { map.delete(requestId); },
  };
  const queue = new BackroomOfflineQueue({ storage, now: () => clock, ...limits });
  return { queue, storage, setNow: v => { clock = v; } };
}
function trustedFor(request) { return approval(request); }
function successfulResult(request) { return { protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION,
  requestId: request.requestId, groupId: request.groupId, sessionId: request.sessionId, status: 'succeeded',
  completedAt: '2026-10-27T10:01:00.000Z', output: { accepted: true } }; }

test('queues an approved message without persisting the approval or provider secrets', async () => {
  const { queue, storage } = fixture();
  const req = command(); const item = await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  assert.equal(item.status, 'queued');
  assert.equal(item.approvalId, 'approval-request-01');
  assert.equal(JSON.stringify(await storage.list()).includes('approvedBy'), false);
  assert.equal(JSON.stringify(await storage.list()).includes('bearer'), false);
});

test('requires a trusted approval before queuing external message sends', async () => {
  const { queue } = fixture();
  await assert.rejects(queue.enqueue(command(), registration()), /trusted approval/);
});

test('deduplicates concurrent identical requests and rejects conflicting reuse of a request id', async () => {
  const { queue } = fixture(); const req = command();
  const [first, duplicate] = await Promise.all([
    queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) }),
    queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) }),
  ]);
  assert.equal(duplicate.requestId, first.requestId);
  const changed = command({ params: { text: 'Different payload' } });
  await assert.rejects(queue.enqueue(changed, registration(), { trustedApproval: approval(changed) }), /already exists/);
});

test('only allows explicitly queueable actions', async () => {
  const { queue } = fixture();
  await assert.rejects(queue.enqueue(command({ action: 'conversation.read', params: {} }), registration()), /not eligible/);
  await assert.rejects(queue.enqueue(command({ action: 'terminal.execute', params: { executable: 'rm', args: ['-rf', '/'], workingDirectory: '/' } }), registration()), /not eligible/);
});

test('enforces maximum queued items and payload sizes', async () => {
  const a = fixture({ limits: { maxItems: 1 } }); const req = command();
  await a.queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  const second = command({ requestId: 'request-02', idempotencyKey: 'idem-02' });
  await assert.rejects(a.queue.enqueue(second, registration(), { trustedApproval: approval(second) }), /queue is full/);
  const b = fixture({ limits: { maxEntryBytes: 256 } });
  const large = command({ params: { text: 'x'.repeat(1000) } });
  await assert.rejects(b.queue.enqueue(large, registration(), { trustedApproval: approval(large) }), /size limit/);
});

test('does not execute while offline', async () => {
  const { queue } = fixture(); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  let executions = 0;
  const result = await queue.drain({ online: false, execute: async () => { executions++; } });
  assert.equal(result.status, 'offline'); assert.equal(executions, 0);
});

test('revalidates fresh approval before replay and passes idempotency key to adapter', async () => {
  const { queue } = fixture(); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  let seenKey = '';
  const result = await queue.drain({ online: true, getRegistration: async () => registration(),
    getTrustedApproval: async id => { assert.equal(id, 'approval-request-01'); return trustedFor(req); },
    execute: async (request, options) => { seenKey = options.idempotencyKey; return successfulResult(request); } });
  assert.equal(result.processed, 1); assert.equal(seenKey, 'idem-01');
  assert.equal((await queue.list())[0].status, 'succeeded');
});

test('rejects actions when approval expired during offline time', async () => {
  const { queue, setNow } = fixture(); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  setNow(Date.parse('2026-10-27T10:16:00.000Z'));
  let executions = 0;
  await queue.drain({ online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req),
    execute: async () => { executions++; } });
  assert.equal(executions, 0); assert.equal((await queue.list())[0].status, 'rejected');
});

test('expires aged queue records before trying to read registration or execute', async () => {
  const { queue, setNow } = fixture({ limits: { maxAgeMs: 2000 } }); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) }); setNow(baseNow + 2000);
  let checks = 0;
  await queue.drain({ online: true, getRegistration: async () => { checks++; return registration(); }, getTrustedApproval: async () => trustedFor(req), execute: async () => { checks++; } });
  assert.equal(checks, 0); assert.equal((await queue.list())[0].status, 'expired');
});

test('rejects mismatched group/session and revoked capabilities before execution', async () => {
  for (const reg of [registration({ groupId: '20000000-0000-0000-0000-000000000002' }), registration({ sessionId: 'different-session' }), registration({ capabilities: ['session.inspect'] })]) {
    const { queue } = fixture(); const req = command(); await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
    let executions = 0;
    await queue.drain({ online: true, getRegistration: async () => reg, getTrustedApproval: async () => trustedFor(req), execute: async () => { executions++; } });
    assert.equal(executions, 0); assert.equal((await queue.list())[0].status, 'rejected');
  }
});

test('cancels pending actions and refuses cancellation after execution begins', async () => {
  const { queue } = fixture(); const req = command(); await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  assert.equal(await queue.cancel(req.requestId), true); assert.equal(await queue.cancel(req.requestId), false);
  assert.equal((await queue.list())[0].status, 'cancelled');
});

test('retries transient adapter failures and stops after retry budget', async () => {
  const { queue } = fixture({ limits: { maxRetries: 1 } }); const req = command(); await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  const callbacks = { online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req), execute: async () => { throw new Error('temporary adapter failure'); } };
  await queue.drain(callbacks); assert.equal((await queue.list())[0].status, 'queued');
  await queue.drain(callbacks); assert.equal((await queue.list())[0].status, 'failed');
});

test('recovers interrupted executions as queued and records at-least-once warning', async () => {
  const { queue, storage } = fixture(); const req = command(); await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  const item = (await queue.list())[0]; item.status = 'executing'; await storage.put(item);
  assert.equal(await queue.recoverInterrupted(), 1);
  const recovered = (await queue.list())[0]; assert.equal(recovered.status, 'queued'); assert.match(recovered.lastError, /idempotency/);
});

test('rejects malformed executor results and never marks them succeeded', async () => {
  const { queue } = fixture(); const req = command(); await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  await queue.drain({ online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req),
    execute: async request => ({ ...successfulResult(request), sessionId: 'other' }) });
  const item = (await queue.list())[0]; assert.equal(item.status, 'queued'); assert.match(item.lastError, /invalid result/);
});

test('respects batch limit and preserves FIFO order', async () => {
  const { queue } = fixture();
  for (let i = 1; i <= 3; i++) { const req = command({ requestId: 'request-0' + i, idempotencyKey: 'idem-0' + i, params: { text: 'Message ' + i } }); await queue.enqueue(req, registration(), { trustedApproval: approval(req) }); }
  const order = [];
  const deps = { online: true, maxBatch: 2, getRegistration: async () => registration(), getTrustedApproval: async id => {
    const item = (await queue.list()).find(x => x.approvalId === id); return approval(item.command);
  }, execute: async request => { order.push(request.requestId); return successfulResult(request); } };
  const result = await queue.drain(deps);
  assert.deepEqual(order, ['request-01', 'request-02']); assert.equal(result.remaining, 1);
});

test('does not retry an explicit failed result as if it were a transport failure', async () => {
  const { queue } = fixture({ limits: { maxRetries: 3 } }); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  await queue.drain({ online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req),
    execute: async request => ({ ...successfulResult(request), status: 'failed', error: 'Provider rejected the action' }) });
  const item = (await queue.list())[0]; assert.equal(item.status, 'failed'); assert.equal(item.retryCount, 0);
});

test('does not persist private approval payloads when retrying failed adapter calls', async () => {
  const { queue, storage } = fixture(); const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  await queue.drain({ online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req),
    execute: async () => { throw new Error('temporary failure'); } });
  const serialized = JSON.stringify(await storage.list());
  assert.equal(serialized.includes('approvedBy'), false); assert.equal(serialized.includes('2026-10-27T10:15'), false);
});

test('prunes oldest terminal history at the configured record bound, never pending work', async () => {
  const { queue } = fixture({ limits: { maxItems: 2, maxRecords: 2 } });
  const first = command(); await queue.enqueue(first, registration(), { trustedApproval: trustedFor(first) });
  await queue.cancel(first.requestId);
  const second = command({ requestId: 'request-02', idempotencyKey: 'idem-02' });
  await queue.enqueue(second, registration(), { trustedApproval: approval(second) });
  const third = command({ requestId: 'request-03', idempotencyKey: 'idem-03' });
  await queue.enqueue(third, registration(), { trustedApproval: approval(third) });
  const records = await queue.list();
  assert.deepEqual(records.map(record => record.requestId), ['request-02', 'request-03']);
  assert.ok(records.every(record => record.status === 'queued'));
});

test('refuses queue history overflow when every retained item is still pending', async () => {
  const { queue } = fixture({ limits: { maxItems: 2, maxRecords: 2 } });
  const first = command(); await queue.enqueue(first, registration(), { trustedApproval: trustedFor(first) });
  const second = command({ requestId: 'request-02', idempotencyKey: 'idem-02' });
  await queue.enqueue(second, registration(), { trustedApproval: approval(second) });
  const third = command({ requestId: 'request-03', idempotencyKey: 'idem-03' });
  await assert.rejects(queue.enqueue(third, registration(), { trustedApproval: approval(third) }), /queue is full/);
});

test('rejects replay when a locally stored approval has been revoked', async () => {
  const { queue } = fixture();
  const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  let executions = 0;
  await queue.drain({
    online: true,
    getRegistration: async () => registration(),
    getTrustedApproval: async () => null,
    execute: async () => { executions += 1; return successfulResult(req); },
  });
  assert.equal(executions, 0);
  assert.equal((await queue.list())[0].status, 'rejected');
});

test('does not mark an action successful when the executor returns a result for another request', async () => {
  const { queue } = fixture();
  const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  await queue.drain({
    online: true,
    getRegistration: async () => registration(),
    getTrustedApproval: async () => trustedFor(req),
    execute: async request => ({ ...successfulResult(request), requestId: 'different-request' }),
  });
  const item = (await queue.list())[0];
  assert.notEqual(item.status, 'succeeded');
});

test('cancellation during asynchronous revalidation prevents the queued action from executing', async () => {
  const { queue } = fixture();
  const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  let markLookupStarted;
  let releaseLookup;
  const lookupStarted = new Promise(resolve => { markLookupStarted = resolve; });
  const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
  let executions = 0;
  const draining = queue.drain({
    online: true,
    getRegistration: async () => { markLookupStarted(); await lookupGate; return registration(); },
    getTrustedApproval: async () => trustedFor(req),
    execute: async () => { executions += 1; return successfulResult(req); },
  });
  await lookupStarted;
  assert.equal(await queue.cancel(req.requestId), true);
  releaseLookup();
  await draining;
  assert.equal(executions, 0);
  assert.equal((await queue.list())[0].status, 'cancelled');
});

test('a concurrent drain on the same queue instance is reported busy', async () => {
  const { queue } = fixture();
  const req = command();
  await queue.enqueue(req, registration(), { trustedApproval: trustedFor(req) });
  let markExecutionStarted;
  let releaseExecution;
  const executionStarted = new Promise(resolve => { markExecutionStarted = resolve; });
  const executionGate = new Promise(resolve => { releaseExecution = resolve; });
  const firstDrain = queue.drain({
    online: true,
    getRegistration: async () => registration(),
    getTrustedApproval: async () => trustedFor(req),
    execute: async request => { markExecutionStarted(); await executionGate; return successfulResult(request); },
  });
  await executionStarted;
  const secondDrain = await queue.drain({ online: true, getRegistration: async () => registration(), getTrustedApproval: async () => trustedFor(req), execute: async request => successfulResult(request) });
  assert.equal(secondDrain.status, 'busy');
  await assert.rejects(queue.recoverInterrupted(), /while this queue is draining/);
  releaseExecution();
  await firstDrain;
  assert.equal((await queue.list())[0].status, 'succeeded');
});
