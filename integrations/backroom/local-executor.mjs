import {
  BACKROOM_PROTOCOL,
  BACKROOM_PROTOCOL_VERSION,
  validateBackroomCommand,
  validateBackroomResult,
} from './protocol.mjs';

const PROTOCOL_REGISTRATION_FIELDS = Object.freeze([
  'protocol', 'version', 'deviceId', 'platform', 'groupId', 'sessionId',
  'provider', 'label', 'connectionMode', 'capabilities', 'consent',
]);

function registrationFor(record) {
  const registration = {};
  for (const field of PROTOCOL_REGISTRATION_FIELDS) registration[field] = record[field];
  return registration;
}

function resultFor(command, status, completedAt, { output, error } = {}) {
  const result = {
    protocol: BACKROOM_PROTOCOL,
    version: BACKROOM_PROTOCOL_VERSION,
    requestId: command.requestId,
    groupId: command.groupId,
    sessionId: command.sessionId,
    status,
    completedAt,
  };
  if (output !== undefined) result.output = output;
  if (error !== undefined) result.error = String(error).slice(0, 1000);
  const validation = validateBackroomResult(result, command);
  if (!validation.valid) throw new Error('Backroom result failed validation: ' + validation.errors.join('; '));
  return Object.freeze(result);
}

/**
 * Executes only the non-mutating session.inspect operation against the local
 * session registry. No page text, full URL, conversation contents, cookies,
 * credentials, screenshots, or provider actions leave the adapter.
 *
 * Remote authentication/transport and trustedApproval storage are intentionally
 * outside this function. The caller must supply trustedApproval from a local
 * approval store; request payloads are never an approval source.
 */
export async function executeBackroomCommand({
  command,
  sessionManager,
  trustedApproval = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!sessionManager || typeof sessionManager.getSession !== 'function' ||
      typeof sessionManager.inspectSession !== 'function') {
    throw new TypeError('sessionManager must implement getSession and inspectSession');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const completedAt = now();
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) {
    throw new TypeError('clock must return a valid ISO date-time');
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('command must be an object');
  }

  const record = sessionManager.getSession(command.sessionId);
  if (!record) throw new Error('Backroom session is not registered');
  if (record.groupId !== command.groupId) throw new Error('Backroom session belongs to a different group');
  if (record.status !== 'connected' && record.status !== 'disconnected') {
    throw new Error('Backroom session is not available for inspection');
  }

  const registration = registrationFor(record);
  const validation = validateBackroomCommand(command, registration, {
    now: Date.parse(completedAt),
    trustedApproval,
  });
  if (!validation.valid) {
    throw new Error('Backroom command rejected: ' + validation.errors.join('; '));
  }
  if (command.action !== 'session.inspect') {
    throw new Error('Backroom v1 local executor supports session.inspect only');
  }

  try {
    const inspected = await sessionManager.inspectSession(command.sessionId);
    if (inspected.groupId !== command.groupId || inspected.sessionId !== command.sessionId) {
      throw new Error('Inspected session identity changed during execution');
    }
    // Never expose the provider conversation path or query string in group output.
    const output = Object.freeze({
      status: inspected.status,
      provider: inspected.provider,
      label: inspected.label,
      origin: inspected.origin,
      connectionMode: inspected.connectionMode,
      capabilities: Object.freeze([...inspected.capabilities]),
      lastSeenAt: inspected.lastSeenAt,
    });
    return resultFor(command, 'succeeded', completedAt, { output });
  } catch (error) {
    return resultFor(command, 'failed', completedAt, {
      error: error instanceof Error ? error.message : 'Local session inspection failed',
    });
  }
}
