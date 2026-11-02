import assert from 'node:assert/strict';
import test from 'node:test';
import {stopLocalExecutionBeforePeerCleanup} from './emergency-stop-orchestrator.mjs';

test('native Emergency Stop completes before peer cleanup starts', async () => {
  const order = [];
  let finishNative;
  const native = new Promise(resolve => { finishNative = resolve; });

  const resultPromise = stopLocalExecutionBeforePeerCleanup({
    stopLocalExecution() {
      order.push('native-start');
      return native.then(() => order.push('native-complete'));
    },
    cleanupPeerSessions() {
      order.push('peer-cleanup');
      return Promise.resolve();
    },
  });

  assert.deepEqual(order, ['native-start']);
  finishNative();
  assert.deepEqual(await resultPromise, {localError: null, peerError: null});
  assert.deepEqual(order, ['native-start', 'native-complete', 'peer-cleanup']);
});

test('peer cleanup failure cannot prevent or cancel completed native Emergency Stop', async () => {
  const error = new Error('peer channel unavailable');
  const order = [];
  const result = await stopLocalExecutionBeforePeerCleanup({
    async stopLocalExecution() {
      order.push('native-complete');
    },
    cleanupPeerSessions() {
      order.push('peer-cleanup');
      throw error;
    },
  });

  assert.deepEqual(order, ['native-complete', 'peer-cleanup']);
  assert.equal(result.localError, null);
  assert.equal(result.peerError, error);
});

test('native stop failure is surfaced while peer cleanup still runs afterward', async () => {
  const error = new Error('native bridge unavailable');
  const order = [];
  const result = await stopLocalExecutionBeforePeerCleanup({
    stopLocalExecution() {
      order.push('native-failed');
      return Promise.reject(error);
    },
    cleanupPeerSessions() {
      order.push('peer-cleanup');
      return Promise.resolve();
    },
  });

  assert.deepEqual(order, ['native-failed', 'peer-cleanup']);
  assert.equal(result.localError, error);
  assert.equal(result.peerError, null);
});

test('requires both cleanup callbacks', async () => {
  await assert.rejects(
    stopLocalExecutionBeforePeerCleanup({stopLocalExecution() {}}),
    /Both local-stop and peer-cleanup callbacks are required/,
  );
});
