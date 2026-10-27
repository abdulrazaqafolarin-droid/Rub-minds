import { describe, expect, it } from 'vitest';
import {
  BACKROOM_PROTOCOL_VERSION,
  MAX_ACTION_TTL_MS,
  approveBackroomAction,
  cancelBackroomAction,
  claimBackroomAction,
  createBackroomAction,
  expireBackroomAction,
  finishBackroomAction,
  type BackroomActionKind,
  type BackroomActionPayloads,
  type BackroomSessionRecord,
} from './protocol';

const start = '2026-10-27T10:00:00.000Z';
const beforeExpiry = '2026-10-27T10:01:00.000Z';
const expiry = '2026-10-27T10:15:00.000Z';

function session(overrides: Partial<BackroomSessionRecord> = {}): BackroomSessionRecord {
  return {
    protocolVersion: BACKROOM_PROTOCOL_VERSION,
    id: 'session-1',
    groupId: 'group-1',
    deviceId: 'device-1',
    platform: 'windows',
    connectionMode: 'managed_session',
    targetKind: 'ai_conversation',
    label: 'ChatGPT',
    status: 'connected',
    capabilities: ['open_url', 'read_page', 'capture_screenshot', 'send_message', 'terminal_execute'],
    openedAt: start,
    lastSeenAt: start,
    ...overrides,
  };
}

function action<K extends BackroomActionKind>(
  kind: K,
  payload: BackroomActionPayloads[K],
  overrides: Partial<{
    id: string;
    groupId: string;
    sessionId: string;
    requestedBy: string;
    idempotencyKey: string;
    requestedAt: string;
    expiresAt: string;
  }> = {},
) {
  return createBackroomAction({
    id: 'action-1',
    groupId: 'group-1',
    sessionId: 'session-1',
    requestedBy: 'human-1',
    idempotencyKey: 'request-unique-0001',
    kind,
    payload,
    requestedAt: start,
    expiresAt: expiry,
    ...overrides,
  });
}

describe('Backroom v1 platform-neutral action contract', () => {
  it('creates a minimal read action without inventing a remote runtime', () => {
    const created = action('read_page', {});
    expect(created.protocolVersion).toBe(1);
    expect(created.status).toBe('queued');
    expect(created.requiresApproval).toBe(false);
    expect(created.approvedBy).toBeNull();
    expect(created).not.toHaveProperty('credential');
    expect(claimBackroomAction(created, session(), beforeExpiry).status).toBe('running');
  });

  it.each([
    ['open_url', { url: 'https://example.com' }],
    ['capture_screenshot', {}],
    ['send_message', { text: 'Please review this implementation.' }],
    ['run_terminal_command', { executable: 'npm', args: ['test'], workingDirectory: 'C:/projects/rub-minds' }],
  ] as const)('%s requires an explicit approval before execution', (kind, payload) => {
    const created = action(kind, payload as BackroomActionPayloads[typeof kind]);
    expect(created.requiresApproval).toBe(true);
    expect(created.status).toBe('awaiting_approval');
    expect(() => claimBackroomAction(created, session(), beforeExpiry)).toThrow(/queued actions/);

    const approved = approveBackroomAction(created, 'owner-1', beforeExpiry);
    expect(approved.status).toBe('queued');
    expect(approved.approvedBy).toBe('owner-1');
    expect(claimBackroomAction(approved, session(), beforeExpiry).status).toBe('running');
  });

  it('requires the target capability even after approval', () => {
    const created = action('run_terminal_command', { executable: 'echo', args: ['safe'], workingDirectory: 'C:/workspace' });
    const approved = approveBackroomAction(created, 'owner-1', beforeExpiry);
    expect(() => claimBackroomAction(
      approved,
      session({ capabilities: ['read_page'] }),
      beforeExpiry,
    )).toThrow(/lacks required capability: terminal_execute/);
  });

  it('fails closed when session/group identity does not match', () => {
    const approved = approveBackroomAction(
      action('send_message', { text: 'Hello group' }),
      'owner-1',
      beforeExpiry,
    );
    expect(() => claimBackroomAction(approved, session({ groupId: 'another-group' }), beforeExpiry))
      .toThrow(/scope do not match/);
    expect(() => claimBackroomAction(approved, session({ id: 'another-session' }), beforeExpiry))
      .toThrow(/scope do not match/);
    expect(() => claimBackroomAction(approved, session({ status: 'disconnected' }), beforeExpiry))
      .toThrow(/not connected/);
  });

  it('rejects non-HTTPS URLs, embedded credentials and malformed URLs', () => {
    expect(() => action('open_url', { url: 'http://example.com' })).toThrow(/HTTPS/);
    expect(() => action('open_url', { url: 'javascript:alert(1)' })).toThrow(/HTTPS/);
    expect(() => action('open_url', { url: 'https://user:pass@example.com/' })).toThrow(/credential-free/);
    expect(() => action('open_url', { url: 'not a URL' })).toThrow(/absolute HTTPS/);
  });

  it('bounds action lifetime to 24 hours and rejects already-expired requests', () => {
    const tooLong = new Date(Date.parse(start) + MAX_ACTION_TTL_MS + 1).toISOString();
    expect(() => action('read_page', {}, { expiresAt: tooLong })).toThrow(/within 24 hours/);
    expect(() => action('read_page', {}, { expiresAt: start })).toThrow(/after requestedAt/);
    expect(() => claimBackroomAction(action('read_page', {}), session(), expiry))
      .toThrow(/Expired actions cannot be executed/);
  });

  it('expires queued or awaiting-approval work without running it', () => {
    const queued = action('read_page', {});
    expect(expireBackroomAction(queued, beforeExpiry).status).toBe('queued');
    expect(expireBackroomAction(queued, expiry).status).toBe('expired');

    const pending = action('send_message', { text: 'Needs approval' });
    expect(expireBackroomAction(pending, expiry).status).toBe('expired');
    expect(() => approveBackroomAction(pending, 'owner-1', expiry)).toThrow(/Expired actions/);
  });

  it('enforces terminal state transitions and keeps the result bounded', () => {
    const approved = approveBackroomAction(
      action('run_terminal_command', { executable: 'npm', args: ['test'], workingDirectory: 'C:/projects/rub-minds' }),
      'owner-1',
      beforeExpiry,
    );
    const running = claimBackroomAction(approved, session(), '2026-10-27T10:01:30.000Z');
    const finished = finishBackroomAction(running, 'succeeded', '2026-10-27T10:02:00.000Z', 'Tests passed');
    expect(finished.status).toBe('succeeded');
    expect(finished.resultSummary).toBe('Tests passed');
    expect(() => finishBackroomAction(approved, 'succeeded', expiry)).toThrow(/running actions/);
    expect(() => cancelBackroomAction(finished, expiry)).toThrow(/Terminal actions/);
    expect(cancelBackroomAction(queuedAction(), beforeExpiry).status).toBe('cancelled');
  });

  it('requires stable, non-empty identifiers and bounded payloads', () => {
    expect(() => action('read_page', {}, { idempotencyKey: '' })).toThrow(/idempotencyKey/);
    expect(() => action('send_message', { text: '   ' })).toThrow(/text/);
    expect(() => action('run_terminal_command', { executable: 'echo', args: ['x'.repeat(2_001)], workingDirectory: 'C:/workspace' })).toThrow(/argument/);
  });
});

function queuedAction() {
  return action('read_page', {});
}
