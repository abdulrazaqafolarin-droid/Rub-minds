const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_CONTROL = /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/u;
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
      TERMINAL_CONTROL.test(message.data)) {
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
