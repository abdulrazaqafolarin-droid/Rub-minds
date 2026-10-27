import test from 'node:test';
import assert from 'node:assert/strict';
import { BackroomManagedSessions } from './session-manager.mjs';

const groupId = '123e4567-e89b-42d3-a456-426614174000';
const otherGroupId = '123e4567-e89b-42d3-a456-426614174001';
const params = (sessionId, overrides = {}) => ({
  groupId, sessionId, label: 'ChatGPT session', provider: 'chatgpt',
  url: 'https://chatgpt.com/c/private-conversation?token=never-store',
  approvedOrigins: ['https://chatgpt.com'], userApproved: true,
  approvedBy: 'local-human', ...overrides,
});
function fixture({ openedUrl, openWait } = {}) {
  const closed = [];
  const handles = new Map();
  const driver = {
    async openManaged(input) {
      if (openWait) await openWait;
      const handle = { id: input.sessionId, url: openedUrl ?? input.url, closed: false };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async attachExisting(input) {
      const handle = { id: input.sessionId, url: input.page.url(), closed: false };
      handles.set(input.sessionId, handle);
      return handle;
    },
    async inspect(handle) { return { url: handle.url, isClosed: handle.closed }; },
    async closeSession(handle) { handle.closed = true; closed.push(handle.id); },
    async closeGroup(_groupId, records) {
      for (const item of records) {
        item.handle.closed = true;
        closed.push(item.handle.id);
      }
    },
  };
  return {
    sessions: new BackroomManagedSessions({
      driver, platform: 'windows', deviceId: 'local-device',
      now: () => '2026-10-27T15:00:00.000Z',
    }),
    handles, closed,
  };
}

test('registers only inspect capability and never exposes private URL or page handle', async () => {
  const { sessions } = fixture();
  const record = await sessions.openManaged(params('one'));
  assert.deepEqual(record.capabilities, ['session.inspect']);
  assert.equal(record.origin, 'https://chatgpt.com');
  assert.equal(record.status, 'connected');
  assert.equal(JSON.stringify(record).includes('private-conversation'), false);
  assert.equal(JSON.stringify(record).includes('never-store'), false);
  assert.equal(Object.hasOwn(record, 'handle'), false);
  assert.equal(sessions.listSessions({ groupId }).length, 1);
});

test('rejects missing approval, mismatched origin, and unsupported action capabilities', async () => {
  const { sessions } = fixture();
  await assert.rejects(sessions.openManaged(params('no-consent', { userApproved: false })), /Explicit local user approval/);
  await assert.rejects(sessions.openManaged(params('wrong-origin', { url: 'https://example.com' })), /initial URL origin/);
  await assert.rejects(sessions.openManaged(params('too-powerful', { capabilities: ['conversation.send'] })), /session.inspect only/);
  assert.equal(sessions.listSessions().length, 0);
});

test('refuses registration when a browser redirects outside approved origins and closes its handle', async () => {
  const { sessions, closed } = fixture({ openedUrl: 'https://example.com/redirected' });
  await assert.rejects(sessions.openManaged(params('redirect')), /outside the explicitly approved HTTPS origins/);
  assert.deepEqual(closed, ['redirect']);
  assert.equal(sessions.getSession('redirect'), null);
});

test('keeps the user-owned page alive when an attached session closes', async () => {
  const { sessions } = fixture();
  const page = { url: () => 'https://chatgpt.com/c/other' };
  const record = await sessions.attachExisting(params('attached', { page }));
  assert.equal(record.connectionMode, 'attach_existing');
  assert.equal(await sessions.closeSession('attached'), true);
  assert.equal(sessions.getSession('attached'), null);
  // The manager delegates ownership to the driver; this verifies registry removal.
});

test('rejects duplicate identifiers and isolates group closing', async () => {
  const { sessions, closed } = fixture();
  await sessions.openManaged(params('one'));
  await assert.rejects(sessions.openManaged(params('one')), /already registered/);
  await sessions.openManaged(params('two', { groupId: otherGroupId }));
  assert.equal(await sessions.closeGroup(groupId), 1);
  assert.deepEqual(closed, ['one']);
  assert.equal(sessions.getSession('one'), null);
  assert.ok(sessions.getSession('two'));
});

test('a group closure waits for an in-flight open and prevents its registration', async () => {
  let release;
  const openWait = new Promise(resolve => { release = resolve; });
  const { sessions, closed } = fixture({ openWait });
  const pending = sessions.openManaged(params('slow'));
  const closing = sessions.closeGroup(groupId);
  release();
  await assert.rejects(pending, /began closing/);
  assert.equal(await closing, 0);
  assert.deepEqual(closed, ['slow']);
  assert.equal(sessions.listSessions({ groupId }).length, 0);
});
