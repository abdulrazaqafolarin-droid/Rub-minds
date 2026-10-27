/**
 * Platform-neutral Backroom v1 contract.
 *
 * This module validates intent and state transitions only. It does not control
 * Windows/Android applications, persist offline work, grant capabilities, or
 * execute commands. Those belong to the platform-specific local runner.
 */
export const BACKROOM_PROTOCOL_VERSION = 1 as const;
export const MAX_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_TERMINAL_ARGUMENT_LENGTH = 2_000;
const MAX_TERMINAL_ARGUMENTS = 64;

export type BackroomPlatform = 'windows' | 'android';
export type BackroomConnectionMode = 'existing_session' | 'managed_session';
export type BackroomTargetKind = 'ai_conversation' | 'website' | 'desktop_app' | 'terminal';
export type BackroomSessionStatus = 'connected' | 'waiting_for_user' | 'disconnected' | 'failed';

export type BackroomCapability =
  | 'open_url'
  | 'read_page'
  | 'capture_screenshot'
  | 'send_message'
  | 'terminal_execute';

export interface BackroomSessionRecord {
  protocolVersion: typeof BACKROOM_PROTOCOL_VERSION;
  id: string;
  groupId: string;
  deviceId: string;
  platform: BackroomPlatform;
  connectionMode: BackroomConnectionMode;
  targetKind: BackroomTargetKind;
  label: string;
  status: BackroomSessionStatus;
  capabilities: readonly BackroomCapability[];
  openedAt: string;
  lastSeenAt: string | null;
}

export interface BackroomActionPayloads {
  open_url: { url: string };
  read_page: Record<string, never>;
  capture_screenshot: Record<string, never>;
  send_message: { text: string };
  run_terminal_command: { executable: string; args: string[]; workingDirectory: string };
}

export type BackroomActionKind = keyof BackroomActionPayloads;
export type BackroomActionStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface BackroomAction<K extends BackroomActionKind = BackroomActionKind> {
  protocolVersion: typeof BACKROOM_PROTOCOL_VERSION;
  id: string;
  groupId: string;
  sessionId: string;
  requestedBy: string;
  idempotencyKey: string;
  kind: K;
  payload: BackroomActionPayloads[K];
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  status: BackroomActionStatus;
  requestedAt: string;
  expiresAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: string | null;
}

export interface CreateBackroomActionInput<K extends BackroomActionKind> {
  id: string;
  groupId: string;
  sessionId: string;
  requestedBy: string;
  idempotencyKey: string;
  kind: K;
  payload: BackroomActionPayloads[K];
  requestedAt: string;
  expiresAt: string;
}

const REQUIRED_APPROVAL = new Set<BackroomActionKind>([
  'open_url',
  'capture_screenshot',
  'send_message',
  'run_terminal_command',
]);

const REQUIRED_CAPABILITY: Record<BackroomActionKind, BackroomCapability> = {
  open_url: 'open_url',
  read_page: 'read_page',
  capture_screenshot: 'capture_screenshot',
  send_message: 'send_message',
  run_terminal_command: 'terminal_execute',
};

function requireText(value: unknown, name: string, maxLength = MAX_LABEL_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must contain 1-${maxLength} characters`);
  }
}

function timestampMs(value: unknown, name: string): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid ISO date-time`);
  }
  return Date.parse(value);
}

function validatePayload<K extends BackroomActionKind>(
  kind: K,
  payload: BackroomActionPayloads[K],
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Action payload must be an object');
  }

  switch (kind) {
    case 'open_url': {
      const value = payload as BackroomActionPayloads['open_url'];
      requireText(value.url, 'url', 2_048);
      let url: URL;
      try {
        url = new URL(value.url);
      } catch {
        throw new TypeError('url must be an absolute HTTPS URL');
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new TypeError('Only credential-free HTTPS URLs are allowed');
      }
      return;
    }
    case 'read_page':
    case 'capture_screenshot':
      if (Object.keys(payload).length !== 0) {
        throw new TypeError(`${kind} does not accept a payload`);
      }
      return;
    case 'send_message':
      requireText((payload as BackroomActionPayloads['send_message']).text, 'text', MAX_MESSAGE_LENGTH);
      return;
    case 'run_terminal_command': {
      const value = payload as BackroomActionPayloads['run_terminal_command'];
      requireText(value.executable, 'executable', 256);
      requireText(value.workingDirectory, 'workingDirectory', 2_048);
      if (!Array.isArray(value.args) || value.args.length > MAX_TERMINAL_ARGUMENTS) {
        throw new TypeError(`args must contain 0-${MAX_TERMINAL_ARGUMENTS} strings`);
      }
      for (const arg of value.args) requireText(arg, 'argument', MAX_TERMINAL_ARGUMENT_LENGTH);
      return;
    }
  }
}

export function createBackroomAction<K extends BackroomActionKind>(
  input: CreateBackroomActionInput<K>,
): BackroomAction<K> {
  requireText(input.id, 'id', 200);
  requireText(input.groupId, 'groupId', 200);
  requireText(input.sessionId, 'sessionId', 200);
  requireText(input.requestedBy, 'requestedBy', 200);
  requireText(input.idempotencyKey, 'idempotencyKey', 200);

  const requestedAt = timestampMs(input.requestedAt, 'requestedAt');
  const expiresAt = timestampMs(input.expiresAt, 'expiresAt');
  if (expiresAt <= requestedAt) throw new RangeError('expiresAt must be after requestedAt');
  if (expiresAt - requestedAt > MAX_ACTION_TTL_MS) {
    throw new RangeError('Action expiry must be within 24 hours');
  }

  validatePayload(input.kind, input.payload);
  const requiresApproval = REQUIRED_APPROVAL.has(input.kind);

  return {
    protocolVersion: BACKROOM_PROTOCOL_VERSION,
    ...input,
    requiresApproval,
    approvedBy: null,
    approvedAt: null,
    status: requiresApproval ? 'awaiting_approval' : 'queued',
    startedAt: null,
    finishedAt: null,
    resultSummary: null,
  };
}

export function approveBackroomAction<K extends BackroomActionKind>(
  action: BackroomAction<K>,
  approvedBy: string,
  approvedAt: string,
): BackroomAction<K> {
  requireText(approvedBy, 'approvedBy', 200);
  const approved = timestampMs(approvedAt, 'approvedAt');
  if (action.status !== 'awaiting_approval') {
    throw new Error('Only actions awaiting approval can be approved');
  }
  if (!action.requiresApproval) throw new Error('This action does not require approval');
  if (approved < Date.parse(action.requestedAt)) {
    throw new Error('Actions cannot be approved before they are requested');
  }
  if (approved >= Date.parse(action.expiresAt)) {
    throw new Error('Expired actions cannot be approved');
  }
  return { ...action, approvedBy, approvedAt, status: 'queued' };
}

export function claimBackroomAction<K extends BackroomActionKind>(
  action: BackroomAction<K>,
  session: BackroomSessionRecord,
  startedAt: string,
): BackroomAction<K> {
  const started = timestampMs(startedAt, 'startedAt');
  if (action.status !== 'queued') throw new Error('Only queued actions can be claimed');
  if (started >= Date.parse(action.expiresAt)) throw new Error('Expired actions cannot be executed');
  if (action.requiresApproval && (!action.approvedBy || !action.approvedAt)) {
    throw new Error('Explicit human approval is required');
  }
  if (action.approvedAt && Date.parse(action.approvedAt) > started) {
    throw new Error('Action cannot start before its approval');
  }
  if (session.protocolVersion !== BACKROOM_PROTOCOL_VERSION) {
    throw new Error('Unsupported Backroom protocol version');
  }
  if (session.status !== 'connected') throw new Error('Backroom session is not connected');
  if (session.groupId !== action.groupId || session.id !== action.sessionId) {
    throw new Error('Action and session scope do not match');
  }
  const capability = REQUIRED_CAPABILITY[action.kind];
  if (!session.capabilities.includes(capability)) {
    throw new Error(`Session lacks required capability: ${capability}`);
  }
  return { ...action, status: 'running', startedAt };
}

export function finishBackroomAction<K extends BackroomActionKind>(
  action: BackroomAction<K>,
  outcome: 'succeeded' | 'failed',
  finishedAt: string,
  resultSummary: string | null = null,
): BackroomAction<K> {
  timestampMs(finishedAt, 'finishedAt');
  if (action.status !== 'running') throw new Error('Only running actions can finish');
  if (resultSummary !== null) requireText(resultSummary, 'resultSummary', 500);
  return {
    ...action,
    status: outcome,
    finishedAt,
    resultSummary,
  };
}

export function cancelBackroomAction<K extends BackroomActionKind>(
  action: BackroomAction<K>,
  cancelledAt: string,
): BackroomAction<K> {
  timestampMs(cancelledAt, 'cancelledAt');
  if (['succeeded', 'failed', 'cancelled', 'expired'].includes(action.status)) {
    throw new Error('Terminal actions cannot be cancelled');
  }
  return { ...action, status: 'cancelled', finishedAt: cancelledAt };
}

export function expireBackroomAction<K extends BackroomActionKind>(
  action: BackroomAction<K>,
  now: string,
): BackroomAction<K> {
  const currentTime = timestampMs(now, 'now');
  if (['succeeded', 'failed', 'cancelled', 'expired'].includes(action.status)) return action;
  if (currentTime < Date.parse(action.expiresAt)) return action;
  return { ...action, status: 'expired', finishedAt: now };
}
