import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  assert.doesNotMatch(popup, /<script\s*[^>]*>/i);
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
