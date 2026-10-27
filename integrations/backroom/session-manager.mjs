import {
  BACKROOM_CONNECTION_MODES,
  BACKROOM_PLATFORMS,
  BACKROOM_PROTOCOL,
  BACKROOM_PROTOCOL_VERSION,
  validateBackroomRegistration,
} from './protocol.mjs';

export const BACKROOM_PROVIDER_ORIGINS = Object.freeze({
  chatgpt: Object.freeze(['https://chatgpt.com', 'https://chat.openai.com', 'https://auth.openai.com']),
  claude: Object.freeze(['https://claude.ai', 'https://accounts.anthropic.com']),
});

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NON_EMPTY = (value, max = 128) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const ISO_TIMESTAMP = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /Z$|[+-]\d{2}:\d{2}$/.test(value);

function requireOrigin(value, label = 'approved origin') {
  if (typeof value !== 'string' || value.length > 512) throw new TypeError(label + ' must be an HTTPS origin');
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError(label + ' must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError(label + ' must be an exact HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function targetDetails({ provider, url, approvedOrigins, userApproved, approvedBy }) {
  if (userApproved !== true) throw new Error('Explicit local user approval is required before opening or attaching a session');
  if (!NON_EMPTY(approvedBy)) throw new TypeError('approvedBy must identify the approving user');
  if (!NON_EMPTY(provider, 64)) throw new TypeError('provider must be a non-empty string');
  if (typeof url !== 'string' || url.length > 2048) throw new TypeError('url must be a non-empty HTTPS URL of at most 2048 characters');

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new TypeError('url must be an absolute HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError('Only HTTPS URLs without embedded credentials are supported');
  }

  if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 10) {
    throw new TypeError('Select 1-10 exact HTTPS origins for this session');
  }
  const normalized = approvedOrigins.map(origin => requireOrigin(origin));
  if (new Set(normalized).size !== normalized.length) throw new TypeError('approvedOrigins must not contain duplicates');
  if (!normalized.includes(parsed.origin)) throw new Error('The initial URL origin must be explicitly approved');

  const knownProvider = BACKROOM_PROVIDER_ORIGINS[provider];
  if (provider !== 'website') {
    if (!knownProvider) throw new Error('Unsupported provider; use website only with an explicitly approved origin');
    for (const origin of normalized) {
      if (!knownProvider.includes(origin)) throw new Error('Origin is outside the built-in ' + provider + ' allowlist');
    }
    if (!knownProvider.includes(parsed.origin)) throw new Error('The URL origin is not approved for this AI provider');
  }
  return { url: parsed.href, origin: parsed.origin, approvedOrigins: Object.freeze(normalized) };
}

function sanitizedRecord(record) {
  return Object.freeze({
    protocol: record.protocol,
    version: record.version,
    deviceId: record.deviceId,
    platform: record.platform,
    groupId: record.groupId,
    sessionId: record.sessionId,
    provider: record.provider,
    label: record.label,
    connectionMode: record.connectionMode,
    capabilities: Object.freeze([...record.capabilities]),
    consent: Object.freeze({ ...record.consent }),
    status: record.status,
    origin: record.origin,
    openedAt: record.openedAt,
    lastSeenAt: record.lastSeenAt,
  });
}

/**
 * Shared session registry for Windows and Android local control layers.
 * The platform driver is injected. Records keep only the origin, not a private
 * conversation path, query string, invitation token, or page title.
 *
 * This is a local policy layer, not device authentication or a sandbox.
 * Remote callers must authenticate separately and never receive driver handles.
 */
export class BackroomManagedSessions {
  constructor({ driver, platform, deviceId, now = () => new Date().toISOString() } = {}) {
    if (!driver || typeof driver.openManaged !== 'function' ||
        typeof driver.attachExisting !== 'function' ||
        typeof driver.inspect !== 'function' ||
        typeof driver.closeSession !== 'function' ||
        typeof driver.closeGroup !== 'function') {
      throw new TypeError('driver must implement openManaged, attachExisting, inspect, closeSession and closeGroup');
    }
    if (!BACKROOM_PLATFORMS.includes(platform)) throw new TypeError('platform must be windows or android');
    if (!NON_EMPTY(deviceId)) throw new TypeError('deviceId must be a non-empty string');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.driver = driver;
    this.platform = platform;
    this.deviceId = deviceId;
    this.now = now;
    this.sessions = new Map();
    this.pending = new Set();
  }

  async openManaged(input) {
    return this.create('managed', input);
  }

  async attachExisting(input) {
    return this.create('attach_existing', input);
  }

  async create(connectionMode, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('session input must be an object');
    if (!BACKROOM_CONNECTION_MODES.includes(connectionMode)) throw new TypeError('unsupported connection mode');
    if (!GROUP_ID.test(input.groupId || '')) throw new TypeError('groupId must be a UUID');
    if (!NON_EMPTY(input.sessionId, 200)) throw new TypeError('sessionId must be a non-empty string');
    if (!NON_EMPTY(input.label, 120)) throw new TypeError('label must contain 1-120 characters');

    // Only inspect is exposed until a separately reviewed action executor exists.
    const capabilities = input.capabilities ?? ['session.inspect'];
    if (!Array.isArray(capabilities) || capabilities.length !== 1 || capabilities[0] !== 'session.inspect') {
      throw new Error('Backroom v1 session manager currently supports session.inspect only');
    }
    if (this.sessions.has(input.sessionId) || this.pending.has(input.sessionId)) {
      throw new Error('sessionId is already registered or opening');
    }

    const target = targetDetails(input);
    const openedAt = this.now();
    if (!ISO_TIMESTAMP(openedAt)) throw new TypeError('clock must return an ISO timestamp');
    this.pending.add(input.sessionId);
    let handle;
    try {
      if (connectionMode === 'managed') {
        handle = await this.driver.openManaged({
          groupId: input.groupId,
          sessionId: input.sessionId,
          url: target.url,
          approvedOrigins: target.approvedOrigins,
          provider: input.provider,
        });
      } else {
        if (!input.page) throw new TypeError('attach_existing requires an explicitly selected page handle');
        handle = await this.driver.attachExisting({
          groupId: input.groupId,
          sessionId: input.sessionId,
          page: input.page,
          approvedOrigins: target.approvedOrigins,
          provider: input.provider,
        });
      }

      const live = await this.driver.inspect(handle);
      if (!live || live.isClosed === true) throw new Error('The selected browser session closed before registration');
      let liveUrl;
      try { liveUrl = new URL(live.url); }
      catch { throw new Error('The adapter did not return a valid current page URL'); }
      if (liveUrl.protocol !== 'https:' || !target.approvedOrigins.includes(liveUrl.origin)) {
        throw new Error('The active page is outside the explicitly approved HTTPS origins');
      }

      const registration = {
        protocol: BACKROOM_PROTOCOL,
        version: BACKROOM_PROTOCOL_VERSION,
        deviceId: this.deviceId,
        platform: this.platform,
        groupId: input.groupId,
        sessionId: input.sessionId,
        provider: input.provider,
        label: input.label.trim(),
        connectionMode,
        capabilities: ['session.inspect'],
        consent: { granted: true, approvedBy: input.approvedBy.trim(), approvedAt: openedAt },
      };
      const checked = validateBackroomRegistration(registration);
      if (!checked.valid) throw new Error('Generated Backroom registration was invalid: ' + checked.errors.join('; '));

      const record = {
        ...registration,
        status: 'connected',
        origin: liveUrl.origin,
        openedAt,
        lastSeenAt: openedAt,
        approvedOrigins: target.approvedOrigins,
        handle,
      };
      this.sessions.set(input.sessionId, record);
      return sanitizedRecord(record);
    } catch (error) {
      if (handle !== undefined) {
        try { await this.driver.closeSession(handle, { connectionMode, failedRegistration: true }); }
        catch { /* Preserve the registration failure. */ }
      }
      throw error;
    } finally {
      this.pending.delete(input.sessionId);
    }
  }

  async inspectSession(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error('Unknown Backroom session');
    try {
      const live = await this.driver.inspect(record.handle);
      if (!live || live.isClosed === true) {
        record.status = 'disconnected';
        record.lastSeenAt = this.now();
        return sanitizedRecord(record);
      }
      let url;
      try { url = new URL(live.url); }
      catch { record.status = 'failed'; throw new Error('The local adapter returned an invalid page URL'); }
      if (url.protocol !== 'https:' || !record.approvedOrigins.includes(url.origin)) {
        record.status = 'failed';
        throw new Error('Session navigated outside its approved origins; local control has been disabled');
      }
      record.status = 'connected';
      record.origin = url.origin;
      record.lastSeenAt = this.now();
      return sanitizedRecord(record);
    } catch (error) {
      if (record.status !== 'failed' && record.status !== 'disconnected') record.status = 'failed';
      throw error;
    }
  }

  getSession(sessionId) {
    const record = this.sessions.get(sessionId);
    return record ? sanitizedRecord(record) : null;
  }

  listSessions({ groupId } = {}) {
    return [...this.sessions.values()]
      .filter(record => groupId === undefined || record.groupId === groupId)
      .map(sanitizedRecord);
  }

  async closeSession(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    await this.driver.closeSession(record.handle, { connectionMode: record.connectionMode });
    this.sessions.delete(sessionId);
    return true;
  }

  async closeGroup(groupId) {
    if (!GROUP_ID.test(groupId || '')) throw new TypeError('groupId must be a UUID');
    const records = [...this.sessions.values()].filter(record => record.groupId === groupId);
    await this.driver.closeGroup(groupId, records.map(record => ({
      handle: record.handle,
      connectionMode: record.connectionMode,
    })));
    for (const record of records) this.sessions.delete(record.sessionId);
    return records.length;
  }
}
