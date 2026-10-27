import test from 'node:test';
import assert from 'node:assert/strict';
import { BackroomManagedSessions } from './session-manager.mjs';
import { executeBackroomCommand } from './local-executor.mjs';
import { BACKROOM_PROTOCOL, BACKROOM_PROTOCOL_VERSION, validateBackroomResult } from './protocol.mjs';

const GROUP_A = '10000000-0000-4000-8000-000000000001';
const GROUP_B = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-10-27T10:00:00.000Z';
const PRIVATE_URL = 'https://chatgpt.com/c/private-conversation?invite=' + 'b'.repeat(64);

function driver() {
  const pages = new Map();
  return {
    pages,
    async openManaged({ groupId, sessionId, url }) {
      const page = { url, isClosed: false };
      pages.set(sessionId, page);
      return { groupId, sessionId, mode: 'managed', page };
    },
    async attachExisting({ groupId, sessionId, page }) {
      pages.set(sessionId, page);
      return { groupId, sessionId, mode: 'attach_existing', page };
    },
    async inspect(handle) {
      return { isClosed: handle.page.isClosed, url: handle.page.url };
    },
    async closeSession(handle) { pages.delete(handle.sessionId); },
    async closeGroup(groupId, handles) {
      for (const handle of handles) pages.delete(handle.handle.sessionId);
    },
  };
}

async function setup({ groupId = GROUP_A, sessionId = 'session-01', url = PRIVATE_URL } = {}) {
  const platformDriver = driver();
  const manager = new BackroomManagedSessions({
    driver: platformDriver, platform: 'windows', deviceId: 'device-01', now: () => NOW,
  });
  await manager.openManaged({
    groupId, sessionId, provider: 'chatgpt', label: 'ChatGPT',
    url, approvedOrigins: ['https://chatgpt.com'], userApproved: true, approvedBy: 'human-01',
  });
  return { platformDriver, manager };
}

function inspectCommand({ groupId = GROUP_A, sessionId = 'session-01', action = 'session.inspect', params = {} } = {}) {
  return {
    protocol: BACKROOM_PROTOCOL,
    version: BACKROOM_PROTOCOL_VERSION,
    requestId: 'request-01',
    idempotencyKey: 'idempotency-01',
    groupId,
    sessionId,
    action,
    params,
    requestedBy: { kind: 'human', id: 'human-01' },
  };
}

test('executes a valid scoped inspection and returns only sanitized session metadata', async () => {
  const { manager } = await setup();
  const command = inspectCommand();
  const result = await executeBackroomCommand({ command, sessionManager: manager, now: () => NOW });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.status, 'connected');
  assert.equal(result.output.provider, 'chatgpt');
  assert.equal(result.output.origin, 'https://chatgpt.com');
  assert.equal(result.output.capabilities.includes('session.inspect'), true);
  assert.equal(JSON.stringify(result).includes('/c/private-conversation'), false);
  assert.equal(JSON.stringify(result).includes('invite='), false);
  assert.equal(JSON.stringify(result).includes('b'.repeat(64)), false);
  assert.equal(validateBackroomResult(result, command).valid, true);
});

test('rejects unknown sessions and group/session crossing before asking a driver', async () => {
  const { manager } = await setup();
  await assert.rejects(
    executeBackroomCommand({ command: inspectCommand({ sessionId: 'missing' }), sessionManager: manager, now: () => NOW }),
    /not registered/,
  );
  await assert.rejects(
    executeBackroomCommand({ command: inspectCommand({ groupId: GROUP_B }), sessionManager: manager, now: () => NOW }),
    /different group/,
  );
});

test('rejects message send and other operations because the registered capability is inspect-only', async () => {
  const { manager } = await setup();
  await assert.rejects(
    executeBackroomCommand({
      command: inspectCommand({ action: 'conversation.send', params: { text: 'Send this to the AI' } }),
      sessionManager: manager,
      now: () => NOW,
    }),
    /command rejected|supports session.inspect only/,
  );
  assert.equal(manager.getSession('session-01').status, 'connected');
});

test('reports the real disconnected state when a managed tab is closed', async () => {
  const { manager, platformDriver } = await setup();
  platformDriver.pages.get('session-01').isClosed = true;
  const result = await executeBackroomCommand({
    command: inspectCommand(), sessionManager: manager, now: () => NOW,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.status, 'disconnected');
});

test('turns a failed live inspection into a correlated failed result without leaking the URL', async () => {
  const { manager, platformDriver } = await setup();
  platformDriver.pages.get('session-01').url = 'https://evil.example/private?secret=1';
  const command = inspectCommand();
  const result = await executeBackroomCommand({ command, sessionManager: manager, now: () => NOW });
  assert.equal(result.status, 'failed');
  assert.equal(result.requestId, command.requestId);
  assert.equal(result.groupId, command.groupId);
  assert.equal(result.error.includes('evil.example'), false);
  assert.equal(result.error.includes('secret=1'), false);
  assert.equal(validateBackroomResult(result, command).valid, true);
});

test('rejects invalid clocks and incomplete executor dependencies', async () => {
  const { manager } = await setup();
  await assert.rejects(
    executeBackroomCommand({ command: inspectCommand(), sessionManager: manager, now: () => 'not-a-date' }),
    /valid ISO date-time/,
  );
  await assert.rejects(
    executeBackroomCommand({ command: inspectCommand(), sessionManager: {}, now: () => NOW }),
    /sessionManager must implement/,
  );
});
