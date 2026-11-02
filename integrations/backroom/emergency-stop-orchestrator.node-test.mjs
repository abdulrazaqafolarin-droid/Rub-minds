import assert from 'node:assert/strict';
import test from 'node:test';
import {stopLocalExecutionBeforePeerCleanup} from './emergency-stop-orchestrator.mjs';

test('native emergency stop is invoked before peer cleanup starts', async () => {
  const order = [];
  let finishNative;
  const native = new Promise(resolve => { finishNative = resolve; });

  const resultPromise = stopLocalExecutionBeforePeerCleanup({
    stopLocalExecution() {
      order.push('native-stop');
      return native;
    },
    cleanupPeerSessions() {
      order.push('peer-cleanup');
      return Promise.resolve();
    },
  });

  assert.deepEqual(order, ['native-stop', 'peer-cleanup']);
  finishNative();
  assert.deepEqual(await resultPromise, {localError: null, peerError: null});
});

test('peer cleanup failure cannot prevent or cancel native emergency stop', async () => {
  const error = new Error('peer channel unavailable');
  let nativeCompleted = false;
  const result = await stopLocalExecutionBeforePeerCleanup({
    stopLocalExecution() {
      nativeCompleted = true;
      return Promise.resolve();
    },
    cleanupPeerSessions() {
      throw error;
    },
  });

  assert.equal(nativeCompleted, true);
  assert.equal(result.localError, null);
  assert.equal(result.peerError, error);
});

test('native stop failure is surfaced while peer cleanup still runs', async () => {
  const error = new Error('native bridge unavailable');
  let peersCompleted = false;
  const result = await stopLocalExecutionBeforePeerCleanup({
    stopLocalExecution() {
      return Promise.reject(error);
    },
    cleanupPeerSessions() {
      peersCompleted = true;
      return Promise.resolve();
    },
  });

  assert.equal(result.localError, error);
  assert.equal(result.peerError, null);
  assert.equal(peersCompleted, true);
});
