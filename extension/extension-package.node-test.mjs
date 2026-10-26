import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const packaged = await readFile(new URL('./content/rub-minds-continuation.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../integrations/browser-loop/rub-minds-continuation.user.js', import.meta.url), 'utf8');
const popup = await readFile(new URL('./popup.html', import.meta.url), 'utf8');
const popupJs = await readFile(new URL('./popup.js', import.meta.url), 'utf8');

test('uses Manifest V3 and injects only on supported HTTPS provider pages', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://claude.ai/*',
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
});

test('uses only temporary activeTab permission and no broad host grants or background worker', () => {
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_security_policy, undefined);
});

test('packaged content script stays byte-for-byte synchronized with tested userscript', () => {
  assert.equal(packaged, source);
});

test('popup has external script only, provider launch links and safe manual controls', () => {
  assert.match(popup, /<script src="popup\.js" defer><\/script>/);
  assert.doesNotMatch(popup, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(popup, /https:\/\/chatgpt\.com\//);
  assert.match(popup, /https:\/\/claude\.ai\//);
  for (const id of ['start', 'pause', 'resume', 'stop']) {
    assert.match(popup, new RegExp('id="' + id + '"'));
  }
  assert.match(popup, /MCP must already be connected/i);
  assert.match(popup, /Starting is always a manual action/i);
});

test('popup controls the current tab only through a small allowlisted message protocol', () => {
  assert.match(popupJs, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
  assert.match(popupJs, /chrome\.tabs\.sendMessage/);
  assert.match(popupJs, /supportedHosts/);
  assert.match(packaged, /RUB_MINDS_EXTENSION_CONTROL/);
  assert.match(packaged, /!\['start', 'pause', 'resume', 'stop'\]\.includes\(action\)/);
  assert.match(packaged, /sender\?\.id && sender\.id !== chrome\.runtime\.id/);
});

test('extension package contains no network request primitives or remote script loading', () => {
  assert.doesNotMatch(packaged, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
  assert.doesNotMatch(popupJs, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
  assert.doesNotMatch(popup, /<script[^>]+src=["']https?:/i);
});

async function runPopupHarness({ url = 'https://chatgpt.com/c/test-thread', replies = true } = {}) {
  const listeners = new Map();
  const elements = new Map();
  const sentMessages = [];
  const initialState = { provider: 'ChatGPT', running: false, paused: false, status: 'Idle — review the prompt and start manually.' };
  const state = { ...initialState };
  for (const id of ['provider-status', 'loop-status', 'start', 'pause', 'resume', 'stop']) {
    elements.set(id, {
      id,
      disabled: true,
      textContent: '',
      addEventListener: (event, callback) => {
        if (!listeners.has(id)) listeners.set(id, new Map());
        listeners.get(id).set(event, callback);
      },
    });
  }
  const chrome = {
    tabs: {
      query: async () => [{ id: 42, url }],
      sendMessage: async (tabId, message) => {
        sentMessages.push({ tabId, ...message });
        if (!replies) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (message.action === 'status') return { ok: true, state: { ...state } };
        if (message.action === 'start') {
          state.running = true; state.paused = false; state.status = 'Cycle 1/1: sending continuation prompt…';
        } else if (message.action === 'pause') {
          state.paused = true; state.status = 'Paused.';
        } else if (message.action === 'resume') {
          state.paused = false; state.status = 'Resuming…';
        } else if (message.action === 'stop') {
          state.running = false; state.paused = false; state.status = 'Stopped manually.';
        }
        return { ok: true, state: { ...state } };
      },
    },
  };
  runInNewContext(popupJs, {
    document: { getElementById: id => elements.get(id) },
    chrome,
    URL,
    Set,
    Error,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { elements, listeners, sentMessages, state };
}

test('popup enables controls on a supported tab and wires Start, Pause, Resume and Stop', async () => {
  const h = await runPopupHarness();
  assert.equal(h.sentMessages[0].action, 'status');
  assert.equal(h.elements.get('start').disabled, false);
  assert.equal(h.elements.get('pause').disabled, true);

  for (const action of ['start', 'pause', 'resume', 'stop']) {
    h.listeners.get(action).get('click')();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(h.sentMessages.map(x => x.action), ['status', 'start', 'pause', 'resume', 'stop']);
  assert.equal(h.sentMessages.every(x => x.tabId === 42 && x.type === 'RUB_MINDS_EXTENSION_CONTROL'), true);
});

test('popup refuses unsupported tabs and leaves controls disabled', async () => {
  const h = await runPopupHarness({ url: 'https://example.com/' });
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.elements.get('start').disabled, true);
  assert.match(h.elements.get('provider-status').textContent, /ChatGPT or Claude/i);
});

test('popup fails closed when the extension content script is unavailable', async () => {
  const h = await runPopupHarness({ replies: false });
  assert.equal(h.elements.get('start').disabled, true);
  assert.match(h.elements.get('provider-status').textContent, /Could not establish connection/i);
});
