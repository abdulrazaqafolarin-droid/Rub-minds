import { validateBackroomCommand, validateBackroomResult } from './protocol.mjs';

export const BACKROOM_QUEUEABLE_ACTIONS = Object.freeze(['conversation.send', 'browser.navigate']);
const ACTIVE = new Set(['queued', 'executing']);
const TERMINAL = new Set(['succeeded', 'rejected', 'expired', 'cancelled', 'failed']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function errorText(value) {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown local execution error');
  return text.slice(0, 500) || 'Unknown local execution error';
}

function cloneJson(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new TypeError('Queue data must be JSON-serializable');
  return JSON.parse(encoded);
}

/**
 * Storage-agnostic, single-host offline queue engine. Storage must durably
 * persist records on the device. This engine validates and schedules actions;
 * it is not an OS automation driver, transport, or security boundary.
 */
export class BackroomOfflineQueue {
  constructor({ storage, now = Date.now, maxItems = 200, maxAgeMs = 24 * 60 * 60 * 1000, maxEntryBytes = 32 * 1024, maxRetries = 3, maxRecords = 500 } = {}) {
    if (!storage || typeof storage.list !== 'function' || typeof storage.put !== 'function' || typeof storage.delete !== 'function') {
      throw new TypeError('storage must implement async list(), put(record), and delete(requestId) methods');
    }
    if (typeof now !== 'function' || !Number.isSafeInteger(maxItems) || maxItems < 1 ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 ||
        !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 256 ||
        !Number.isSafeInteger(maxRecords) || maxRecords < maxItems ||
        !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new TypeError('Invalid offline queue limits or clock');
    }
    this.storage = storage;
    this.now = now;
    this.maxItems = maxItems;
    this.maxAgeMs = maxAgeMs;
    this.maxEntryBytes = maxEntryBytes;
    this.maxRetries = maxRetries;
    this.maxRecords = maxRecords;
    this.draining = false;
  }

  async list() {
    const records = await this.storage.list();
    if (!Array.isArray(records)) throw new TypeError('storage.list() must return an array');
    return records.map(cloneJson).sort((a, b) => a.queuedAt - b.queuedAt || a.requestId.localeCompare(b.requestId));
  }

  async enqueue(command, registration, { trustedApproval = null } = {}) {
    const now = this.now();
    if (!Number.isFinite(now)) throw new TypeError('Queue clock must return a finite timestamp');
    if (!isRecord(command)) throw new TypeError('command must be an object');
    if (!BACKROOM_QUEUEABLE_ACTIONS.includes(command.action)) {
      throw new Error('This action is not eligible for offline queueing: ' + String(command.action));
    }
    const validation = validateBackroomCommand(command, registration, { now, trustedApproval });
    if (!validation.valid) throw new Error('Backroom command rejected: ' + validation.errors.join('; '));

    const storedCommand = cloneJson(command);
    const encoded = JSON.stringify(storedCommand);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > this.maxEntryBytes) throw new Error('Command exceeds the local offline queue size limit');

    const records = await this.list();
    const existing = records.find(record => record.requestId === command.requestId);
    if (existing) {
      if (existing.idempotencyKey === command.idempotencyKey && JSON.stringify(existing.command) === encoded) return existing;
      throw new Error('requestId already exists with different queued content');
    }
    if (records.filter(record => ACTIVE.has(record.status)).length >= this.maxItems) {
      throw new Error('Local offline queue is full; clear completed actions or reconnect the device');
    }
    while (records.length >= this.maxRecords) {
      const oldestTerminal = records.find(record => TERMINAL.has(record.status));
      if (!oldestTerminal) throw new Error('Local offline queue history is full; finish or cancel pending actions first');
      await this.storage.delete(oldestTerminal.requestId);
      records.splice(records.findIndex(record => record.requestId === oldestTerminal.requestId), 1);
    }

    const item = {
      requestId: command.requestId,
      idempotencyKey: command.idempotencyKey,
      groupId: command.groupId,
      sessionId: command.sessionId,
      action: command.action,
      command: storedCommand,
      // Store only the opaque reference; approval contents/tokens are never persisted here.
      approvalId: trustedApproval?.approvalId ?? null,
      queuedAt: now,
      expiresAt: now + this.maxAgeMs,
      status: 'queued',
      retryCount: 0,
      lastError: null,
    };
    await this.storage.put(item);
    return cloneJson(item);
  }

  async cancel(requestId) {
    const records = await this.list();
    const item = records.find(record => record.requestId === requestId);
    if (!item || item.status !== 'queued') return false;
    item.status = 'cancelled';
    item.lastError = null;
    await this.storage.put(item);
    return true;
  }

  /** Call once on host startup. Retrying an interrupted action is at-least-once;
   * the adapter must enforce idempotencyKey to avoid duplicate side effects. */
  async recoverInterrupted() {
    const records = await this.list();
    let recovered = 0;
    for (const item of records) {
      if (item.status !== 'executing') continue;
      item.status = 'queued';
      item.retryCount += 1;
      item.lastError = 'Recovered an interrupted execution; adapter idempotency is required';
      await this.storage.put(item);
      recovered += 1;
    }
    return recovered;
  }

  async drain({ online, getRegistration, getTrustedApproval, execute, maxBatch = 20 } = {}) {
    if (online !== true) return { status: 'offline', processed: 0, remaining: (await this.list()).filter(item => item.status === 'queued').length };
    if (this.draining) return { status: 'busy', processed: 0, remaining: (await this.list()).filter(item => item.status === 'queued').length };
    if (typeof getRegistration !== 'function' || typeof getTrustedApproval !== 'function' || typeof execute !== 'function') {
      throw new TypeError('Online draining requires registration, approval, and executor callbacks');
    }
    if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) throw new TypeError('maxBatch must be an integer from 1 to 100');
    this.draining = true;
    let processed = 0;
    try {
      const records = await this.list();
      for (const item of records) {
        if (processed >= maxBatch) break;
        if (item.status !== 'queued') continue;
        const now = this.now();
        if (!Number.isFinite(now)) throw new TypeError('Queue clock must return a finite timestamp');
        if (now >= item.expiresAt) {
          item.status = 'expired'; item.lastError = 'Queued action expired before execution';
          await this.storage.put(item); processed += 1; continue;
        }

        let registration, trustedApproval;
        try {
          registration = await getRegistration(item);
          trustedApproval = item.approvalId ? await getTrustedApproval(item.approvalId, item) : null;
        } catch {
          item.status = 'rejected'; item.lastError = 'Could not revalidate the local session and approval';
          await this.storage.put(item); processed += 1; continue;
        }
        const validation = validateBackroomCommand(item.command, registration, { now, trustedApproval });
        if (!validation.valid) {
          item.status = 'rejected'; item.lastError = ('Revalidation failed: ' + validation.errors.join('; ')).slice(0, 500);
          await this.storage.put(item); processed += 1; continue;
        }

        item.status = 'executing'; item.lastError = null;
        await this.storage.put(item);
        processed += 1;
        try {
          const result = await execute(cloneJson(item.command), { idempotencyKey: item.idempotencyKey });
          const resultValidation = validateBackroomResult(result, item.command);
          if (!resultValidation.valid) throw new Error('Executor returned an invalid result');
          if (result.status === 'succeeded') item.status = 'succeeded';
          else if (result.status === 'cancelled') item.status = 'cancelled';
          else if (result.status === 'rejected') item.status = 'rejected';
          else if (result.status === 'failed') item.status = 'failed';
          else item.status = 'rejected';
          item.lastError = item.status === 'succeeded' ? null : errorText(result.error || result.status);
          await this.storage.put(item);
        } catch (error) {
          item.retryCount += 1;
          item.lastError = errorText(error);
          item.status = item.retryCount > this.maxRetries ? 'failed' : 'queued';
          await this.storage.put(item);
        }
      }
      const final = await this.list();
      return { status: 'drained', processed, remaining: final.filter(item => item.status === 'queued').length };
    } finally {
      this.draining = false;
    }
  }
}

export const BACKROOM_QUEUE_TERMINAL_STATUSES = Object.freeze([...TERMINAL]);
