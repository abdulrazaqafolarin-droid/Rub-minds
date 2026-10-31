import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateTerminalDraftMessage,
  validateTerminalSubmitMessage,
  createTerminalActionRequestGuard,
  validateTerminalExitedMessage,
} from './terminal-pty-protocol.mjs';

const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '123e4567-e89b-42d3-a456-426614174001';

test('terminal draft accepts plain text only for the exact active PTY session', () => {
  const message = { kind: 'terminal_draft', requestId, sessionId, data: 'Review this task' };
  assert.deepEqual(validateTerminalDraftMessage(message, sessionId), {
    requestId, sessionId, data: 'Review this task',
  });
  assert.equal(Object.isFrozen(validateTerminalDraftMessage(message, sessionId)), true);
});

test('terminal draft rejects missing, malformed, stale or mismatched session identity', () => {
  const message = { kind: 'terminal_draft', requestId, sessionId, data: 'draft' };
  for (const invalid of [
    null,
    {},
    { ...message, kind: 'terminal_submit' },
    { ...message, requestId: 'not-a-uuid' },
    { ...message, sessionId: '123e4567-e89b-42d3-a456-426614174099' },
    { ...message, sessionId: undefined },
  ]) {
    assert.equal(validateTerminalDraftMessage(invalid, sessionId), null);
  }
  assert.equal(validateTerminalDraftMessage(message, 'not-a-uuid'), null);
});

test('terminal draft rejects empty, oversized, multiline and control-sequence payloads', () => {
  for (const data of [
    '',
    '   ',
    'first\nsecond',
    'first\rsecond',
    'tab\tcharacter',
    'escape\u001b[31m',
    'nul\u0000',
    'delete\u007f',
    'c1\u0085',
    'unicode\u2028line',
    'unicode\u2029line',
    'x'.repeat(4001),
  ]) {
    assert.equal(
      validateTerminalDraftMessage({ kind: 'terminal_draft', requestId, sessionId, data }, sessionId),
      null,
      `accepted unsafe draft ${JSON.stringify(data.slice(0, 50))}`,
    );
  }
  assert.equal(
    validateTerminalDraftMessage({ kind: 'terminal_draft', requestId, sessionId, data: 'x'.repeat(4000) }, sessionId)?.data.length,
    4000,
  );
});

test('terminal Enter is separate, exact-session, and carries no text payload', () => {
  const message = { kind: 'terminal_submit', requestId, sessionId };
  assert.deepEqual(validateTerminalSubmitMessage(message, sessionId), { requestId, sessionId });
  assert.equal(validateTerminalSubmitMessage({ ...message, data: '\r' }, sessionId), null);
  assert.equal(validateTerminalSubmitMessage({ ...message, text: 'command' }, sessionId), null);
  assert.equal(validateTerminalSubmitMessage({ ...message, sessionId: 'wrong' }, sessionId), null);
  assert.equal(validateTerminalSubmitMessage({ ...message, requestId: 'invalid' }, sessionId), null);
  assert.equal(validateTerminalSubmitMessage({ ...message, kind: 'terminal_draft' }, sessionId), null);
});


test('terminal action request IDs are one-use across drafts and Enter and fail closed at capacity', () => {
  const guard = createTerminalActionRequestGuard(2);
  assert.equal(guard(requestId), 'accepted');
  assert.equal(guard(requestId), 'duplicate');
  const second = '123e4567-e89b-42d3-a456-426614174002';
  assert.equal(guard(second), 'accepted');
  const third = '123e4567-e89b-42d3-a456-426614174003';
  assert.equal(guard(third), 'limit');
  assert.equal(guard('not-a-uuid'), 'invalid');
});

test('terminal action replay guard rejects invalid limits', () => {
  assert.throws(() => createTerminalActionRequestGuard(0), /between 1 and 4096/);
  assert.throws(() => createTerminalActionRequestGuard(1.5), /between 1 and 4096/);
});

test('terminal exit notice is exact-session scoped and cannot carry injected content', () => {
  const notice = { kind: 'terminal_exited', sessionId };
  assert.deepEqual(validateTerminalExitedMessage(notice, sessionId), notice);
  assert.equal(Object.isFrozen(validateTerminalExitedMessage(notice, sessionId)), true);
  for (const invalid of [
    null,
    [],
    { ...notice, kind: 'terminal_output' },
    { ...notice, sessionId: '123e4567-e89b-42d3-a456-426614174099' },
    { ...notice, text: 'execute this' },
    { ...notice, output: [1, 2, 3] },
  ]) {
    assert.equal(validateTerminalExitedMessage(invalid, sessionId), null);
  }
  assert.equal(validateTerminalExitedMessage(notice, 'not-a-uuid'), null);
});

test('native PTY exit reaches the exact Backroom peer and retires its session', async () => {
  const host = await readFile(new URL('../../desktop-companion/src/main.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../../src/BackroomDesktopControl.tsx', import.meta.url), 'utf8');
  assert.match(host, /listen\('backroom-terminal-exited'/);
  assert.match(host, /kind:'terminal_exited',sessionId:terminalId/);
  assert.match(host, /const wasTracked=state\.terminals\.has\(terminalId\)/);
  assert.match(host, /state\.exitedTerminals\.add\(terminalId\)/);
  assert.match(host, /state\.exitedTerminals\.has\(term\.sessionId\)/);
  assert.ok(host.indexOf('state.exitedTerminals.add(terminalId)') < host.indexOf('if(!wasTracked&&!peers.length)return'));
  assert.match(host, /state\.terminals\.delete\(peer\.terminalId\);\s*try\{await invoke\('stop_terminal'/);
  assert.match(host, /state\.terminals\.delete\(peer\.terminalId\);\s*try\{await invoke\('stop_terminal'/);
  assert.match(host, /stopPeer\(peerSessionId\)/);
  assert.match(browser, /validateTerminalExitedMessage\(message,terminalPeerRef\.current\)/);
  assert.match(browser, /void stopActivePeer\(\)/);
});
