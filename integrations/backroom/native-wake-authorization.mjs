/**
 * Separate process-local authorization for native canonical @RMconnects wakes.
 *
 * This authority is intentionally independent from browser wake grants,
 * remote touch and draft-typing approvals. Construct and call it only inside a
 * trusted native host/companion process. A local OS confirmation flow must be
 * the only caller allowed to create grants; a boolean supplied by a WebView or
 * remote device message is not local confirmation.
 *
 * Grants disappear on process restart. Each event command is consumed once,
 * and a grant has its own bounded wake rate limit.
 */
import {randomUUID} from 'node:crypto';
import {isCanonicalWakePrompt, validId} from './coordination-core.mjs';

const NATIVE_SURFACES = new Set(['desktop_app', 'windows_app', 'android_app']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

function requiredId(value, name) {
  if (!validId(value)) throw new TypeError('Invalid ' + name);
  return value;
}
function nonempty(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError('Invalid ' + name);
  }
  return value;
}
function validRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function targetScope(target) {
  return !!target && target.locatorKind === 'accessibility' &&
    target.surface && NATIVE_SURFACES.has(target.surface) &&
    HEX.test(target.providerConversationIdentityDigest ?? '');
}

export class NativeWakeAuthorizationAuthority {
  #grants = new Map();
  #now;
  constructor({now = () => Date.now(), maxPerMinute = 6, maxGrantMs = MAX_TTL_MS} = {}) {
    if (typeof now !== 'function') throw new TypeError('Clock function required');
    if (!Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 6) {
      throw new RangeError('Native wake maxPerMinute must be 1-6');
    }
    if (!Number.isSafeInteger(maxGrantMs) || maxGrantMs < MIN_TTL_MS || maxGrantMs > MAX_TTL_MS) {
      throw new RangeError('Native wake grant lifetime must be 1 minute to 24 hours');
    }
    this.#now = now;
    this.maxPerMinute = maxPerMinute;
    this.maxGrantMs = maxGrantMs;
  }

  createGrant(input = {}) {
    if (input.localConfirmation !== true) {
      throw new Error('Explicit on-device confirmation is required for native wake');
    }
    const scope = {
      hostId: requiredId(input.hostId, 'hostId'),
      groupId: requiredId(input.groupId, 'groupId'),
      participantId: requiredId(input.participantId, 'participantId'),
      sessionId: requiredId(input.sessionId, 'sessionId'),
      spaceId: nonempty(input.spaceId, 'spaceId', 128),
      bindingId: requiredId(input.bindingId, 'bindingId'),
      targetId: requiredId(input.targetId, 'targetId'),
      surface: input.surface,
      appId: nonempty(input.appId, 'appId', 256),
      identityFingerprint: nonempty(input.identityFingerprint, 'identityFingerprint'),
      providerConversationIdentityDigest: input.providerConversationIdentityDigest,
      targetRevision: input.targetRevision,
    };
    if (!NATIVE_SURFACES.has(scope.surface) || !validRevision(scope.targetRevision) ||
        !HEX.test(scope.providerConversationIdentityDigest ?? '')) {
      throw new TypeError('Invalid native wake target surface or revision');
    }
    const ttlMs = input.ttlMs === undefined ? this.maxGrantMs : input.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > this.maxGrantMs) {
      throw new RangeError('Invalid native wake grant lifetime');
    }
    const maxPerMinute = input.maxPerMinute === undefined ? this.maxPerMinute : input.maxPerMinute;
    if (!Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > this.maxPerMinute) {
      throw new RangeError('Invalid native wake rate limit');
    }
    const grantId = randomUUID();
    const now = this.#now();
    this.#grants.set(grantId, {
      ...scope, grantId, createdAt: now, expiresAt: now + ttlMs,
      maxPerMinute, usedCommands: new Set(), uses: [],
    });
    return Object.freeze({
      grantId, createdAt: now, expiresAt: now + ttlMs, maxPerMinute,
      scope: Object.freeze({...scope}),
    });
  }

  verify(grantId, {command, target} = {}, {consume = false} = {}) {
    if (typeof grantId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grantId) ||
        !command || typeof command !== 'object' || !target || typeof target !== 'object') {
      return false;
    }
    const grant = this.#grants.get(grantId);
    const now = this.#now();
    if (!grant || now >= grant.expiresAt ||
        command.operation !== 'wake' ||
        !validId(command.id) || !validId(command.eventId) ||
        !isCanonicalWakePrompt(command.text, command.eventId) ||
        !targetScope(target) ||
        target.surface !== grant.surface ||
        target.appId !== grant.appId ||
        target.identityFingerprint !== grant.identityFingerprint ||
        target.providerConversationIdentityDigest !== grant.providerConversationIdentityDigest ||
        target.revision !== grant.targetRevision ||
        target.locatorKind !== 'accessibility' ||
        target.id !== grant.targetId ||
        target.roomId !== grant.groupId ||
        target.hostId !== grant.hostId ||
        target.spaceId !== grant.spaceId ||
        target.sessionId !== grant.sessionId ||
        command.hostId !== grant.hostId ||
        command.roomId !== grant.groupId ||
        command.participantId !== grant.participantId ||
        command.bindingId !== grant.bindingId ||
        command.sessionId !== grant.sessionId ||
        command.spaceId !== grant.spaceId ||
        command.targetId !== grant.targetId ||
        command.targetRevision !== grant.targetRevision ||
        command.identityFingerprint !== grant.identityFingerprint ||
        command.providerConversationIdentityDigest !== grant.providerConversationIdentityDigest ||
        grant.usedCommands.has(command.id)) {
      return false;
    }
    const recent = grant.uses.filter(at => now - at < 60_000);
    if (recent.length >= grant.maxPerMinute) return false;
    if (consume) {
      grant.usedCommands.add(command.id);
      grant.uses = [...recent, now];
    }
    return true;
  }

  revoke(grantId) {
    return this.#grants.delete(grantId);
  }

  revokeForTarget(targetId) {
    let count = 0;
    for (const [id, grant] of this.#grants) {
      if (grant.targetId === targetId) {
        this.#grants.delete(id);
        count++;
      }
    }
    return count;
  }

  revokeAll() {
    const count = this.#grants.size;
    this.#grants.clear();
    return count;
  }

  status(grantId) {
    const grant = this.#grants.get(grantId);
    if (!grant) return Object.freeze({active: false, reason: 'missing-or-revoked'});
    const now = this.#now();
    if (now >= grant.expiresAt) {
      this.#grants.delete(grantId);
      return Object.freeze({active: false, reason: 'expired'});
    }
    const recent = grant.uses.filter(at => now - at < 60_000);
    return Object.freeze({
      active: true,
      expiresAt: grant.expiresAt,
      usedCommands: grant.usedCommands.size,
      remainingThisMinute: Math.max(0, grant.maxPerMinute - recent.length),
      scope: Object.freeze({
        hostId: grant.hostId, groupId: grant.groupId, participantId: grant.participantId,
        sessionId: grant.sessionId, spaceId: grant.spaceId, bindingId: grant.bindingId,
        targetId: grant.targetId, surface: grant.surface, appId: grant.appId,
        identityFingerprint: grant.identityFingerprint,
        providerConversationIdentityDigest: grant.providerConversationIdentityDigest,
        targetRevision: grant.targetRevision,
      }),
    });
  }
}

/**
 * The trusted device worker calls this from LocalExecutionGuard.beforeEffect.
 * It persists the one-time seal first, then consumes this exact native grant.
 * If either step fails, no native UI action is permitted.
 */
export async function reserveNativeWakeExecution({
  authority, grantId, journal, journalRecord, command, target,
} = {}) {
  if (!authority || typeof authority.verify !== 'function' ||
      !journal || typeof journal.reserve !== 'function') {
    throw new TypeError('Native wake authority and durable execution journal are required');
  }
  if (!journalRecord || !HEX.test(journalRecord.jobKey ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(journalRecord.jobId ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(journalRecord.hostId ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(journalRecord.bindingId ?? '') ||
      !HEX.test(journalRecord.sessionDigest ?? '') || !ID.test(journalRecord.targetId ?? '')) {
      !HEX.test(journalRecord.providerConversationIdentityDigest ?? '') ||
    throw new TypeError('Invalid native wake journal scope');
  }
  if (!command || command.operation !== 'wake' ||
      command.id !== 'wake_' + journalRecord.jobId.replaceAll('-', '') ||
      command.hostId !== journalRecord.hostId ||
      command.bindingId !== journalRecord.bindingId ||
      command.targetId !== journalRecord.targetId ||
      command.providerConversationIdentityDigest !== journalRecord.providerConversationIdentityDigest ||
      target?.id !== journalRecord.targetId ||
      target?.providerConversationIdentityDigest !== journalRecord.providerConversationIdentityDigest) {
    throw new Error('Native wake job does not match its durable journal scope');
  }

  const reserved = await journal.reserve(Object.freeze({...journalRecord}));
  if (reserved !== true) return false;
  // A failed consume after reservation deliberately leaves a permanent seal.
  // Reconciliation must use a fresh event rather than reusing this job.
  return authority.verify(grantId, {command, target}, {consume: true}) === true;
}
