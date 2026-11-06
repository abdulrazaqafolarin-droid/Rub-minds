/**
 * Native accessibility adapter for the event-bound Backroom wake operation.
 *
 * This is separate from NativeAccessibilityDraftAdapter and must be constructed
 * only inside a trusted native host/companion runtime. It must sit behind
 * LocalExecutionGuard and the durable wake execution seal. The platform driver
 * owns the full composer and Send-control identities; they never cross this
 * adapter boundary or get serialized to a WebView.
 *
 * inspectWakeTarget() must verify the exact selected, empty composer and one
 * enabled, visible, nearby Send control in the expected foreground app.
 * submitCanonicalWake() must repeat those checks, insert only the canonical
 * event prompt, verify its readback, re-identify the same Send control, invoke
 * it, and wait for the same composer to clear.
 *
 * Any partial or ambiguous outcome is needs_review, never an automatic retry.
 */
import {
  buildCanonicalWakePrompt,
  isCanonicalWakePrompt,
  validId,
} from './coordination-core.mjs';

const NATIVE_SURFACES = new Set(['desktop_app', 'windows_app', 'android_app']);
const MAX_RETAINED_ATTEMPTS = 4096;

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const IDENTITY_DIGEST = /^[a-f0-9]{64}$/;

function probeIsReady(result, expected) {
  return !!result && typeof result === 'object' && !Array.isArray(result) &&
    result.connected === true && result.focused === true &&
    result.composerEmpty === true &&
    result.composerIdentityVerified === true &&
    result.sendControlUnique === true &&
    result.sendControlEnabled === true &&
    result.sendControlVisible === true &&
    result.sendControlIdentityVerified === true &&
    result.providerConversationIdentityVerified === true &&
    result.targetId === expected.targetId &&
    result.targetRevision === expected.targetRevision &&
    result.locatorKind === 'accessibility' &&
    IDENTITY_DIGEST.test(result.composerIdentityDigest || '') &&
    IDENTITY_DIGEST.test(result.sendControlIdentityDigest || '') &&
    result.providerConversationIdentityDigest === expected.providerConversationIdentityDigest &&
    IDENTITY_DIGEST.test(result.providerConversationIdentityDigest || '') &&
    result.surface === expected.surface &&
    result.appId === expected.appId &&
    result.sessionId === expected.sessionId &&
    result.identityFingerprint === expected.identityFingerprint;
}

function scopeFor(target) {
  return Object.freeze({
    targetId: target.id,
    roomId: target.roomId,
    hostId: target.hostId,
    spaceId: target.spaceId,
    sessionId: target.sessionId,
    appId: target.appId,
    surface: target.surface,
    identityFingerprint: target.identityFingerprint,
    providerConversationIdentityDigest: target.providerConversationIdentityDigest,
    locatorKind: target.locatorKind,
    locatorValue: target.locatorValue,
    targetRevision: target.revision,
  });
}

export class NativeCanonicalWakeAdapter {
  #driver;
  #targetId;
  #roomId;
  #hostId;
  #spaceId;
  #surface;
  #appId;
  #sessionId;
  #identityFingerprint;
  #locatorValue;
  #targetRevision;
  #providerConversationIdentityDigest;
  #attemptedJobs = new Map();
  #inFlightJobs = new Set();

  constructor({
    driver, targetId, roomId, hostId, spaceId, surface, appId,
    sessionId, identityFingerprint, locatorValue, targetRevision, providerConversationIdentityDigest,
  } = {}) {
    if (!NATIVE_SURFACES.has(surface)) {
      throw new TypeError('Native wake surface is not supported');
    }
    if ([
      targetId, roomId, hostId, spaceId, appId, sessionId,
      identityFingerprint, locatorValue,
    ] .some(value => !text(value)) || !validRevision(targetRevision) ||
        !IDENTITY_DIGEST.test(providerConversationIdentityDigest || '')) {
      throw new TypeError('Native wake target identity is incomplete');
    }
    if (!driver || typeof driver.inspectWakeTarget !== 'function' ||
        typeof driver.submitCanonicalWake !== 'function') {
      throw new TypeError('Native wake driver must implement inspectWakeTarget and submitCanonicalWake');
    }
    this.#driver = driver;
    this.#targetId = targetId;
    this.#roomId = roomId;
    this.#hostId = hostId;
    this.#spaceId = spaceId;
    this.#surface = surface;
    this.#appId = appId;
    this.#sessionId = sessionId;
    this.#identityFingerprint = identityFingerprint;
    this.#locatorValue = locatorValue;
    this.#targetRevision = targetRevision;
    this.#providerConversationIdentityDigest = providerConversationIdentityDigest;
  }

  #targetMatches(target) {
    return !!target && target.id === this.#targetId &&
      target.roomId === this.#roomId && target.hostId === this.#hostId &&
      target.spaceId === this.#spaceId && target.surface === this.#surface &&
      target.appId === this.#appId && target.sessionId === this.#sessionId &&
      target.identityFingerprint === this.#identityFingerprint &&
      target.providerConversationIdentityDigest === this.#providerConversationIdentityDigest &&
      target.locatorKind === 'accessibility' &&
      target.locatorValue === this.#locatorValue &&
      target.revision === this.#targetRevision &&
      validRevision(target.revision);
  }

  async probe({ target, operation } = {}) {
    if (operation !== 'wake' || !this.#targetMatches(target)) {
      return Object.freeze({
        connected: false, focused: false, reason: 'native_wake_target_mismatch',
      });
    }
    try {
      const state = await this.#driver.inspectWakeTarget({ target: scopeFor(target) });
      if (!probeIsReady(state, {
        targetId: this.#targetId,
        targetRevision: this.#targetRevision,
        surface: this.#surface,
        appId: this.#appId,
        sessionId: this.#sessionId,
        identityFingerprint: this.#identityFingerprint,
        providerConversationIdentityDigest: this.#providerConversationIdentityDigest,
      })) {
        return Object.freeze({
          connected: false,
          focused: false,
          reason: 'native_composer_or_send_control_unavailable',
        });
      }
      return Object.freeze({
        connected: true,
        focused: true,
        targetId: this.#targetId,
        targetRevision: this.#targetRevision,
        locatorKind: 'accessibility',
        composerIdentityDigest: state.composerIdentityDigest,
        sendControlIdentityDigest: state.sendControlIdentityDigest,
        surface: this.#surface,
        appId: this.#appId,
        sessionId: this.#sessionId,
        identityFingerprint: this.#identityFingerprint,
        providerConversationIdentityVerified: state.providerConversationIdentityVerified,
        providerConversationIdentityDigest: this.#providerConversationIdentityDigest,
        locatorKinds: Object.freeze(['accessibility']),
        nativeWakeReady: true,
      });
    } catch {
      return Object.freeze({
        connected: false, focused: false, reason: 'native_wake_inspection_failed',
      });
    }
  }

  async execute({ command, target, verifiedProbe, executionSealReserved } = {}) {
    if (!this.#targetMatches(target) || command?.operation !== 'wake' ||
        command.targetId !== target.id || command.targetRevision !== target.revision ||
        command.roomId !== target.roomId || command.hostId !== target.hostId ||
        command.spaceId !== target.spaceId || command.sessionId !== target.sessionId ||
        command.identityFingerprint !== target.identityFingerprint ||
        command.providerConversationIdentityDigest !== this.#providerConversationIdentityDigest ||
        !validId(command.eventId) || !validId(command.id) ||
        !isCanonicalWakePrompt(command.text, command.eventId)) {
      throw new Error(
        'Native accessibility wake accepts only the exact event-bound canonical trigger for its selected target',
      );
    }
    if (executionSealReserved !== true) {
      throw new Error(
        'Native wake requires a reserved durable execution seal and consumed one-shot grant',
      );
    }
    if (!verifiedProbe || verifiedProbe.nativeWakeReady !== true ||
        verifiedProbe.connected !== true || verifiedProbe.focused !== true ||
        verifiedProbe.surface !== this.#surface ||
        verifiedProbe.appId !== this.#appId ||
        verifiedProbe.sessionId !== this.#sessionId ||
        verifiedProbe.identityFingerprint !== this.#identityFingerprint ||
        verifiedProbe.providerConversationIdentityVerified !== true ||
        verifiedProbe.providerConversationIdentityDigest !== this.#providerConversationIdentityDigest ||
        verifiedProbe.targetId !== this.#targetId ||
        verifiedProbe.targetRevision !== this.#targetRevision ||
        verifiedProbe.locatorKind !== 'accessibility' ||
        !IDENTITY_DIGEST.test(verifiedProbe.composerIdentityDigest || '') ||
        !IDENTITY_DIGEST.test(verifiedProbe.sendControlIdentityDigest || '') ||
        !IDENTITY_DIGEST.test(verifiedProbe.providerConversationIdentityDigest || '') ||
        !Array.isArray(verifiedProbe.locatorKinds) ||
        !verifiedProbe.locatorKinds.includes('accessibility')) {
      throw new Error('Native wake execution requires a successful LocalExecutionGuard preflight');
    }

    // command.id is the stable durable job identity. LocalExecutionGuard must
    // reserve the persistent seal before execute() is entered. The bounded
    // in-memory cache adds same-process protection; the persistent journal is
    // still the authority across crashes and restarts.
    if (this.#attemptedJobs.has(command.id) || this.#inFlightJobs.has(command.id)) {
      return Object.freeze({
        state: 'needs_review',
        verified: false,
        result: Object.freeze({
          submitted: null, reason: 'native_wake_job_already_attempted',
        }),
      });
    }
    this.#attemptedJobs.set(command.id, true);
    if (this.#attemptedJobs.size > MAX_RETAINED_ATTEMPTS) {
      const oldest = this.#attemptedJobs.keys().next().value;
      if (oldest) this.#attemptedJobs.delete(oldest);
    }
    this.#inFlightJobs.add(command.id);

    try {
      const prompt = buildCanonicalWakePrompt(command.eventId);
      const outcome = await this.#driver.submitCanonicalWake({
        target: scopeFor(target),
        eventId: command.eventId,
        jobId: command.id,
        prompt,
        requireComposerIdentityRecheck: true,
        requireSendControlIdentityRecheck: true,
        requireProviderConversationIdentityRecheck: true,
        providerConversationIdentityDigest: this.#providerConversationIdentityDigest,
        requireEmptyComposerBeforeInsert: true,
        requireExactPromptReadback: true,
        requireComposerClearAfterSend: true,
        automaticRetry: false,
      });

      const confirmed = !!outcome && typeof outcome === 'object' &&
        !Array.isArray(outcome) &&
        outcome.state === 'submitted' &&
        outcome.eventId === command.eventId &&
        outcome.targetId === this.#targetId &&
        outcome.targetRevision === this.#targetRevision &&
        outcome.composerIdentityDigest === verifiedProbe.composerIdentityDigest &&
        outcome.sendControlIdentityDigest === verifiedProbe.sendControlIdentityDigest &&
        outcome.providerConversationIdentityRevalidated === true &&
        outcome.providerConversationIdentityDigest === this.#providerConversationIdentityDigest &&
        outcome.promptInserted === true &&
        outcome.promptReadbackVerified === true &&
        outcome.composerIdentityRevalidated === true &&
        outcome.sendControlIdentityRevalidated === true &&
        outcome.sendInvoked === true &&
        outcome.composerCleared === true;

      if (!confirmed) {
        return Object.freeze({
          state: 'needs_review',
          verified: false,
          result: Object.freeze({
            submitted: outcome?.sendInvoked === true,
            reason: 'native_wake_outcome_unconfirmed',
            eventId: command.eventId,
          }),
        });
      }
      return Object.freeze({
        state: 'completed',
        verified: true,
        result: Object.freeze({
          triggerSubmitted: true,
          confirmation: 'composer_cleared',
          providerConversationIdentityRevalidated: true,
          providerConversationIdentityDigest: this.#providerConversationIdentityDigest,
          eventId: command.eventId,
        }),
      });
    } catch {
      // The prompt may have been inserted or sent before a device IPC failure.
      // Never convert an unknown post-seal outcome into an automatic retry.
      return Object.freeze({
        state: 'needs_review',
        verified: false,
        result: Object.freeze({
          submitted: null,
          reason: 'native_wake_outcome_unknown',
          eventId: command.eventId,
        }),
      });
    } finally {
      this.#inFlightJobs.delete(command.id);
    }
  }

  hasAttempted(jobId) {
    return validId(jobId) && this.#attemptedJobs.has(jobId);
  }
}
