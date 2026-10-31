const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function hasTerminalControl(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}
const MAX_TERMINAL_DRAFT_CHARS = 4_000;

function validSession(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Validate the untrusted WebRTC message before native IPC. The Rust Tauri
 * command repeats the text policy and remains the authoritative permission gate.
 */
export function validateTerminalDraftMessage(message, expectedSessionId) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.kind !== 'terminal_draft' ||
      !validSession(expectedSessionId) ||
      message.sessionId !== expectedSessionId ||
      !validSession(message.requestId) ||
      typeof message.data !== 'string' ||
      !message.data.trim() ||
      [...message.data].length > MAX_TERMINAL_DRAFT_CHARS ||
      hasTerminalControl(message.data)) {
    return null;
  }
  return Object.freeze({
    requestId: message.requestId,
    sessionId: expectedSessionId,
    data: message.data,
  });
}

/** Enter is a distinct, one-use action and carries no caller-supplied text. */
export function validateTerminalSubmitMessage(message, expectedSessionId) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.kind !== 'terminal_submit' ||
      !validSession(expectedSessionId) ||
      message.sessionId !== expectedSessionId ||
      !validSession(message.requestId) ||
      Object.hasOwn(message, 'data') || Object.hasOwn(message, 'text')) {
    return null;
  }
  return Object.freeze({
    requestId: message.requestId,
    sessionId: expectedSessionId,
  });
}

/**
 * Creates a per-PTY-peer replay guard. Request IDs are retained for the life
 * of that peer; once the bounded set fills, new actions fail closed until the
 * peer is restarted. Draft and Enter actions share the same namespace.
 */
export function createTerminalActionRequestGuard(maxRequests = 256) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 4096) {
    throw new TypeError('Terminal action request limit must be between 1 and 4096');
  }
  const seen = new Set();
  return requestId => {
    if (!validSession(requestId)) return 'invalid';
    if (seen.has(requestId)) return 'duplicate';
    if (seen.size >= maxRequests) return 'limit';
    seen.add(requestId);
    return 'accepted';
  };
}

/** A terminal-exited notice is scoped to the exact PTY peer and carries no output or command text. */
export function validateTerminalExitedMessage(message, expectedSessionId) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).some(key => !['kind', 'sessionId'].includes(key)) ||
      message.kind !== 'terminal_exited' ||
      !validSession(expectedSessionId) ||
      message.sessionId !== expectedSessionId) {
    return null;
  }
  return Object.freeze({ kind: 'terminal_exited', sessionId: expectedSessionId });
}
