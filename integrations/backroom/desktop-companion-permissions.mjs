/**
 * Companion-side authorization policy for REAL desktop and PTY sessions.
 * This module does not create an OS permission, launch a process, or trust
 * approval claims from the web page. Only the companion's trusted UI can call
 * confirm(). The transport must authenticate a device separately.
 */
import { randomUUID } from 'node:crypto';

const SURFACES = new Set(['desktop_app', 'windows_app', 'terminal']);
const OPERATIONS = new Set(['launch', 'view', 'control', 'draft']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/;
function identifier(value) { return typeof value === 'string' && ID.test(value); }
function validScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('Invalid scope');
  const { roomId, spaceId, appId, surface, identityFingerprint } = scope;
  if (![roomId, spaceId, appId, identityFingerprint].every(identifier) || !SURFACES.has(surface))
    throw new TypeError('Verified desktop app or terminal identity required');
  return Object.freeze({ roomId, spaceId, appId, surface, identityFingerprint });
}
function key(scope, operation) {
  if (!OPERATIONS.has(operation)) throw new TypeError('Unsupported capability');
  return JSON.stringify([scope.roomId, scope.spaceId, scope.appId, scope.surface, scope.identityFingerprint, operation]);
}
export function createCompanionPermissionBroker({ now = () => Date.now(), ttlMs = 60_000 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000)
    throw new TypeError('Invalid permission broker configuration');
  const pending = new Map();
  const approved = new Map();
  let stopped = false;
  function expire() {
    for (const [id, request] of pending) if (now() >= request.expiresAt) pending.delete(id);
    for (const [id, grant] of approved) if (now() >= grant.expiresAt) approved.delete(id);
  }
  return Object.freeze({
    request({ scope, operation } = {}) {
      if (stopped) throw new Error('Companion control stopped');
      const normalized = validScope(scope);
      const capability = key(normalized, operation);
      expire();
      // Every launch gets its own request; no implicit permission inheritance.
      const id = randomUUID();
      const challenge = Object.freeze({
        id, scope: normalized, operation, createdAt: now(),
        expiresAt: now() + ttlMs,
        description: operation === 'launch' ? 'Launch this program on your computer?' :
          operation === 'view' ? 'Show this application screen in Rub Minds?' :
          operation === 'control' ? 'Allow Rub Minds to control this application?' :
          'Allow typing into the selected target?',
      });
      pending.set(id, { ...challenge, capability });
      return challenge;
    },
    // Must be called by a trusted native permission window, never by a remote RPC.
    confirm({ requestId, trustedLocalDecision, approved: granted } = {}) {
      if (stopped || trustedLocalDecision !== true) throw new Error('Local device confirmation required');
      expire();
      const request = pending.get(requestId);
      if (!request) throw new Error('Approval request expired or missing');
      pending.delete(requestId);
      if (granted !== true) return Object.freeze({ allowed: false, requestId });
      const grantId = randomUUID();
      const grant = Object.freeze({
        grantId, scope: request.scope, operation: request.operation,
        capability: request.capability, expiresAt: now() + ttlMs,
      });
      approved.set(grantId, grant);
      return Object.freeze({ allowed: true, grantId, expiresAt: grant.expiresAt });
    },
    consume({ grantId, scope, operation } = {}) {
      if (stopped) return false;
      expire();
      const grant = approved.get(grantId);
      if (!grant || grant.operation !== operation) return false;
      let candidate;
      try { candidate = key(validScope(scope), operation); } catch { return false; }
      if (candidate !== grant.capability) return false;
      approved.delete(grantId);
      return true;
    },
    revokeScope(scope) {
      const normalized = validScope(scope);
      const prefix = JSON.stringify([normalized.roomId, normalized.spaceId, normalized.appId, normalized.surface, normalized.identityFingerprint]).slice(0, -1) + ',';
      for (const [id, request] of pending) if (request.capability.startsWith(prefix)) pending.delete(id);
      for (const [id, grant] of approved) if (grant.capability.startsWith(prefix)) approved.delete(id);
    },
    stop() { stopped = true; pending.clear(); approved.clear(); },
    get status() { expire(); return Object.freeze({ stopped, pending: pending.size, approved: approved.size }); },
  });
}
