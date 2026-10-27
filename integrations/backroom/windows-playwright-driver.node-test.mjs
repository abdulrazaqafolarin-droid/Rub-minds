import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WindowsPlaywrightDriver } from './windows-playwright-driver.mjs';

const groupId = '123e4567-e89b-42d3-a456-426614174000';
const allowed = ['https://chatgpt.com'];

test('a new open cannot reuse a managed context during last-session shutdown', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rub-backroom-close-'));
  let allowClose;
  let closingStarted;
  const closeStarted = new Promise(resolve => { closingStarted = resolve; });
  const closeGate = new Promise(resolve => { allowClose = resolve; });
  let launchCount = 0;
  const chromium = {
    async launchPersistentContext() {
      launchCount += 1;
      return {
        async route() {},
        async newPage() {
          let closed = false;
          let url = 'about:blank';
          return {
            async route() {},
            mainFrame() { return {}; },
            on() {},
            setDefaultNavigationTimeout() {},
            async goto(target) { url = target; },
            url() { return url; },
            isClosed() { return closed; },
            async close() { closed = true; },
          };
        },
        async close() {
          closingStarted();
          await closeGate;
        },
      };
    },
  };
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: root });
    const first = await driver.openManaged({
      groupId, sessionId: 'session-a', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: allowed,
    });
    const closing = driver.closeSession(first);
    await closeStarted;
    await assert.rejects(
      driver.openManaged({
        groupId, sessionId: 'session-b', provider: 'chatgpt',
        url: 'https://chatgpt.com/', approvedOrigins: allowed,
      }),
      /context is being cleaned up/,
    );
    assert.equal(launchCount, 1);
    allowClose();
    await closing;
    const second = await driver.openManaged({
      groupId, sessionId: 'session-c', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: allowed,
    });
    assert.equal(launchCount, 2);
    await driver.closeGroup(groupId);
    assert.equal(second.sessionId, 'session-c');
  } finally {
    allowClose?.();
    await rm(root, { recursive: true, force: true });
  }
});
