import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackroomManagedSessions, BACKROOM_PROVIDER_ORIGINS } from './session-manager.mjs';
import { WindowsPlaywrightDriver } from './windows-playwright-driver.mjs';

const GROUP_A = '10000000-0000-4000-8000-000000000001';
const GROUP_B = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-10-27T10:00:00.000Z';
const inviteUrl = 'https://chatgpt.com/?invite=' + 'a'.repeat(64);

class FakePage {
  constructor(initialUrl = 'about:blank') {
    this.currentUrl = initialUrl;
    this.closed = false;
    this.routes = [];
    this.events = new Map();
    this.closeCalls = 0;
    this.timeoutMs = null;
  }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  mainFrame() { return this; }
  on(event, listener) {
    const listeners = this.events.get(event) || [];
    listeners.push(listener);
    this.events.set(event, listeners);
  }
  async triggerPopup(popup) {
    for (const listener of this.events.get('popup') || []) listener(popup);
    await new Promise(resolve => setImmediate(resolve));
  }
  setDefaultNavigationTimeout(ms) { this.timeoutMs = ms; }
  async route(pattern, handler) { this.routes.push({ pattern, handler }); }
  async goto(url) {
    if (this.closed) throw new Error('page closed');
    const route = this.routes.at(-1);
    if (route) {
      const outcome = await invokeRoute(route.handler, this, url);
      if (outcome !== 'continued') throw new Error('navigation blocked');
    }
    this.currentUrl = url;
  }
  async close() { this.closeCalls++; this.closed = true; }
  async triggerRoute(url) {
    const route = this.routes.at(-1);
    if (!route) throw new Error('no route guard installed');
    return invokeRoute(route.handler, this, url);
  }
}
async function invokeRoute(handler, page, url) {
  const route = {
    request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => page }),
    continued: false,
    aborted: false,
    async continue() { this.continued = true; },
    async abort() { this.aborted = true; },
  };
  await handler(route);
  return route.aborted ? 'aborted' : route.continued ? 'continued' : 'unknown';
}

function fakeDriver() {
  const calls = [];
  const pages = new Map();
  const pageGroups = new Map();
  return {
    calls, pages, pageGroups,
    async openManaged(input) {
      calls.push(['openManaged', input]);
      const page = new FakePage(input.url);
      const handle = { sessionId: input.sessionId, groupId: input.groupId, mode: 'managed', page };
      pages.set(input.sessionId, page);
      pageGroups.set(input.sessionId, input.groupId);
      return handle;
    },
    async attachExisting(input) {
      calls.push(['attachExisting', input]);
      const handle = { sessionId: input.sessionId, groupId: input.groupId, mode: 'attach_existing', page: input.page };
      pages.set(input.sessionId, input.page);
      pageGroups.set(input.sessionId, input.groupId);
      return handle;
    },
    async inspect(handle) {
      return { isClosed: handle.page.isClosed(), url: handle.page.url() };
    },
    async closeSession(handle, options) {
      calls.push(['closeSession', handle.sessionId, options]);
      if (options?.connectionMode !== 'attach_existing' && !handle.page.isClosed()) await handle.page.close();
      pages.delete(handle.sessionId);
      pageGroups.delete(handle.sessionId);
    },
    async closeGroup(groupId, handles) {
      calls.push(['closeGroup', groupId, handles.length]);
      for (const [sessionId, page] of pages) {
        if (pageGroups.get(sessionId) !== groupId) continue;
        if (!page.isClosed() && !handles.some(h => h.handle.sessionId === sessionId && h.connectionMode === 'attach_existing')) await page.close();
        pages.delete(sessionId);
        pageGroups.delete(sessionId);
      }
    },
  };
}
function manager(driver = fakeDriver(), platform = 'windows') {
  return new BackroomManagedSessions({ driver, platform, deviceId: 'device-01', now: () => NOW });
}
function approvedInput(overrides = {}) {
  return {
    groupId: GROUP_A, sessionId: 'session-01', provider: 'chatgpt', label: 'Primary ChatGPT',
    url: inviteUrl, approvedOrigins: ['https://chatgpt.com'], userApproved: true, approvedBy: 'human-01',
    ...overrides,
  };
}
function fakeChromium({ beforeGoto } = {}) {
  const launches = [];
  const contexts = [];
  const chromium = {
    async launchPersistentContext(userDataDir, options) {
      launches.push({ userDataDir, options });
      const context = {
        pagesList: [],
        closeCalls: 0,
        async newPage() {
          const page = new FakePage();
          if (beforeGoto) {
            const originalGoto = page.goto.bind(page);
            page.goto = async (...args) => { await beforeGoto(page, ...args); return originalGoto(...args); };
          }
          this.pagesList.push(page);
          return page;
        },
        async pages() { return this.pagesList; },
        async close() { this.closeCalls++; for (const page of this.pagesList) page.closed = true; },
      };
      contexts.push(context);
      return context;
    },
  };
  return { chromium, launches, contexts };
}

test('managed mode opens the real selected provider URL only after explicit approval', async () => {
  const driver = fakeDriver();
  const sessions = manager(driver);
  const result = await sessions.openManaged(approvedInput());
  assert.equal(result.connectionMode, 'managed');
  assert.equal(result.status, 'connected');
  assert.deepEqual(result.capabilities, ['session.inspect']);
  assert.equal(result.origin, 'https://chatgpt.com');
  assert.equal(JSON.stringify(result).includes('invite='), false);
  assert.equal(JSON.stringify(result).includes('a'.repeat(64)), false);
  assert.equal(driver.calls[0][0], 'openManaged');
});

test('existing-session attach requires an explicitly selected page and never changes its URL', async () => {
  const driver = fakeDriver();
  const sessions = manager(driver);
  const page = new FakePage('https://claude.ai/chat/abc-private');
  const result = await sessions.attachExisting(approvedInput({
    sessionId: 'session-claude', provider: 'claude', label: 'Claude session',
    url: 'https://claude.ai/chat/abc-private', approvedOrigins: ['https://claude.ai'], page,
  }));
  assert.equal(result.connectionMode, 'attach_existing');
  assert.equal(result.origin, 'https://claude.ai');
  assert.equal(page.url(), 'https://claude.ai/chat/abc-private');
  assert.equal(JSON.stringify(result).includes('/chat/abc-private'), false);
  await sessions.closeSession('session-claude');
  assert.equal(page.isClosed(), false);
});

test('does not open anything without consent, exact origins and a valid group scope', async () => {
  const driver = fakeDriver();
  const sessions = manager(driver);
  await assert.rejects(sessions.openManaged(approvedInput({ userApproved: false })), /Explicit local user approval/);
  await assert.rejects(sessions.openManaged(approvedInput({ approvedOrigins: ['https://evil.example'] })), /initial URL origin/);
  await assert.rejects(sessions.openManaged(approvedInput({ url: 'http://chatgpt.com' })), /Only HTTPS/);
  await assert.rejects(sessions.openManaged(approvedInput({ url: 'https://user:pass@chatgpt.com' })), /embedded credentials/);
  await assert.rejects(sessions.openManaged(approvedInput({ groupId: '../other-group' })), /groupId must be a UUID/);
  assert.equal(driver.calls.length, 0);
});

test('provider identifiers cannot be used to open unrelated websites', async () => {
  const sessions = manager(fakeDriver());
  await assert.rejects(sessions.openManaged(approvedInput({
    provider: 'chatgpt', url: 'https://evil.example/', approvedOrigins: ['https://evil.example'],
  })), /outside the built-in chatgpt allowlist/);
  await assert.rejects(sessions.openManaged(approvedInput({
    provider: 'unknown-ai', url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
  })), /Unsupported provider/);
});

test('generic websites require an exact origin that the user explicitly approves', async () => {
  const sessions = manager(fakeDriver());
  const result = await sessions.openManaged(approvedInput({
    provider: 'website', label: 'Documentation',
    url: 'https://docs.example.dev/guide?topic=private',
    approvedOrigins: ['https://docs.example.dev'],
  }));
  assert.equal(result.origin, 'https://docs.example.dev');
  assert.equal(JSON.stringify(result).includes('/guide'), false);
  assert.equal(JSON.stringify(result).includes('topic=private'), false);
});

test('the manager exposes inspect only and rejects requests for more powerful capabilities', async () => {
  const sessions = manager(fakeDriver());
  await assert.rejects(sessions.openManaged(approvedInput({
    capabilities: ['session.inspect', 'conversation.send'],
  })), /supports session.inspect only/);
});

test('duplicate session IDs and unknown handles are rejected', async () => {
  const sessions = manager(fakeDriver());
  await sessions.openManaged(approvedInput());
  await assert.rejects(sessions.openManaged(approvedInput()), /already registered or opening/);
  await assert.rejects(sessions.inspectSession('unknown'), /Unknown Backroom session/);
});

test('inspection marks closed sessions disconnected and fails closed if a page leaves its allowlist', async () => {
  const driver = fakeDriver();
  const sessions = manager(driver);
  await sessions.openManaged(approvedInput());
  const page = driver.pages.get('session-01');
  page.currentUrl = 'https://evil.example/';
  await assert.rejects(sessions.inspectSession('session-01'), /outside its approved origins/);
  assert.equal(sessions.getSession('session-01').status, 'failed');

  const disconnected = manager(fakeDriver());
  await disconnected.openManaged(approvedInput());
  const disconnectionPage = disconnected.driver.pages.get('session-01');
  disconnectionPage.closed = true;
  assert.equal((await disconnected.inspectSession('session-01')).status, 'disconnected');
});

test('sessions remain isolated by group and closeGroup clears only the selected group', async () => {
  const driver = fakeDriver();
  const sessions = manager(driver);
  await sessions.openManaged(approvedInput());
  await sessions.openManaged(approvedInput({ groupId: GROUP_B, sessionId: 'session-02', label: 'Another group' }));
  assert.equal(sessions.listSessions({ groupId: GROUP_A }).length, 1);
  assert.equal(sessions.listSessions({ groupId: GROUP_B }).length, 1);
  assert.equal(await sessions.closeGroup(GROUP_A), 1);
  assert.equal(sessions.getSession('session-01'), null);
  assert.equal(sessions.getSession('session-02').status, 'connected');
});

test('provider origin map is explicit and contains no wildcard hosts', () => {
  for (const origins of Object.values(BACKROOM_PROVIDER_ORIGINS)) {
    for (const origin of origins) {
      assert.match(origin, /^https:\/\/[^/*]+$/);
    }
  }
});

test('Windows Playwright driver creates group-isolated persistent browser profiles', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium, launches, contexts } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const first = await driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-a', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
    });
    const second = await driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-b', provider: 'chatgpt',
      url: 'https://chatgpt.com/c/another-thread', approvedOrigins: ['https://chatgpt.com'],
    });
    const otherGroup = await driver.openManaged({
      groupId: GROUP_B, sessionId: 'w-session-c', provider: 'claude',
      url: 'https://claude.ai/new', approvedOrigins: ['https://claude.ai'],
    });
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0].userDataDir, launches[1].userDataDir);
    assert.equal(launches[0].options.headless, false);
    assert.equal(launches[0].options.acceptDownloads, false);
    assert.ok(launches[0].userDataDir.startsWith(path.join(root, 'profiles')));
    assert.equal(await driver.inspect(first).then(x => x.origin), 'https://chatgpt.com');
    await driver.closeSession(first);
    assert.equal(contexts[0].closeCalls, 0, 'a remaining group tab must keep the group context open');
    await driver.closeSession(second);
    assert.equal(contexts[0].closeCalls, 1, 'the last managed tab closes its context');
    await driver.closeSession(otherGroup);
    assert.equal(contexts[1].closeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows driver blocks top-level navigation outside exact approved origins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const handle = await driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-nav', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
    });
    assert.equal(await handle.page.triggerRoute('https://chatgpt.com/settings'), 'continued');
    assert.equal(await handle.page.triggerRoute('https://evil.example/'), 'aborted');
    assert.equal(await handle.page.triggerRoute('http://127.0.0.1/'), 'aborted');
    assert.equal(await handle.page.triggerRoute('https://user:pass@chatgpt.com/'), 'aborted');
    await driver.closeSession(handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed managed navigation closes its page and does not retain a false session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium, contexts } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const original = FakePage.prototype.goto;
    try {
      FakePage.prototype.goto = async function () { throw new Error('simulated navigation failure'); };
      await assert.rejects(driver.openManaged({
        groupId: GROUP_A, sessionId: 'w-session-fail', provider: 'chatgpt',
        url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
      }), /simulated navigation failure/);
      assert.equal(driver.sessions.has('w-session-fail'), false);
      assert.equal(contexts[0].closeCalls, 1);
    } finally {
      FakePage.prototype.goto = original;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attaching to an existing Windows page unregisters without closing the user page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const page = new FakePage('https://claude.ai/chat/existing-thread');
    const handle = await driver.attachExisting({
      groupId: GROUP_A, sessionId: 'w-session-existing', provider: 'claude',
      page, approvedOrigins: ['https://claude.ai'],
    });
    await driver.closeSession(handle);
    assert.equal(page.isClosed(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows managed session closes unregistered popups instead of leaking new tabs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const handle = await driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-popup', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
    });
    const popup = new FakePage('https://evil.example/');
    await handle.page.triggerPopup(popup);
    assert.equal(popup.isClosed(), true);
    await driver.closeSession(handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows closeGroup closes only its managed group and preserves attached pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  const { chromium, contexts } = fakeChromium();
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const managedA = await driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-group-a', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
    });
    const managedB = await driver.openManaged({
      groupId: GROUP_B, sessionId: 'w-session-group-b', provider: 'claude',
      url: 'https://claude.ai/new', approvedOrigins: ['https://claude.ai'],
    });
    const attachedPage = new FakePage('https://claude.ai/chat/existing');
    const attached = await driver.attachExisting({
      groupId: GROUP_A, sessionId: 'w-session-attached', provider: 'claude',
      page: attachedPage, approvedOrigins: ['https://claude.ai'],
    });
    await driver.closeGroup(GROUP_A, [managedA, attached]);
    assert.equal(contexts[0].closeCalls, 1);
    assert.equal(contexts[1].closeCalls, 0);
    assert.equal(managedB.page.isClosed(), false);
    assert.equal(attachedPage.isClosed(), false);
    assert.equal(await driver.inspect(managedB).then(x => x.origin), 'https://claude.ai');
    await driver.closeSession(managedB);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manager closeGroup waits for pending opens and rejects late registrations', async () => {
  const driver = fakeDriver();
  const originalOpen = driver.openManaged.bind(driver);
  let announceOpen;
  let releaseOpen;
  const opened = new Promise(resolve => { announceOpen = resolve; });
  const gate = new Promise(resolve => { releaseOpen = resolve; });
  driver.openManaged = async input => {
    const handle = await originalOpen(input);
    announceOpen();
    await gate;
    return handle;
  };
  const sessions = manager(driver);
  const opening = sessions.openManaged(approvedInput());
  await opened;
  const closing = sessions.closeGroup(GROUP_A);
  await assert.rejects(
    sessions.openManaged(approvedInput({ sessionId: 'session-late' })),
    /group is closing/,
  );
  releaseOpen();
  await assert.rejects(opening, /group began closing/);
  assert.equal(await closing, 0);
  assert.equal(sessions.listSessions({ groupId: GROUP_A }).length, 0);
  assert.equal(driver.pages.has('session-01'), false);
  assert.equal(driver.pages.get('session-01'), undefined);
});


test('Windows driver closeGroup waits for pending navigation and leaves no orphan context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rub-minds-backroom-'));
  let announceGoto;
  let releaseGoto;
  const gotoStarted = new Promise(resolve => { announceGoto = resolve; });
  const gotoGate = new Promise(resolve => { releaseGoto = resolve; });
  const { chromium } = fakeChromium({ beforeGoto: async () => { announceGoto(); await gotoGate; } });
  try {
    const driver = new WindowsPlaywrightDriver({ chromium, profileRoot: path.join(root, 'profiles') });
    const opening = driver.openManaged({
      groupId: GROUP_A, sessionId: 'w-session-pending-close', provider: 'chatgpt',
      url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
    });
    await gotoStarted;
    const closing = driver.closeGroup(GROUP_A);
    await assert.rejects(
      driver.openManaged({
        groupId: GROUP_A, sessionId: 'w-session-late', provider: 'chatgpt',
        url: 'https://chatgpt.com/', approvedOrigins: ['https://chatgpt.com'],
      }),
      /group is closing/,
    );
    releaseGoto();
    await assert.rejects(opening, /group began closing/);
    await closing;
    assert.equal(driver.sessions.size, 0);
    assert.equal(driver.contexts.has(GROUP_A), false);
    assert.equal([...driver.pendingSessions].length, 0);
    assert.equal([...driver.pendingSessionGroups.values()].length, 0);
  } finally {
    releaseGoto();
    await rm(root, { recursive: true, force: true });
  }
});

