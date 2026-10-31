import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginTargetSelection,
  confirmTargetSelection,
  invalidateTargetSelection,
  rejectTargetSelection,
  canStageDraftForCurrentSelection,
  isPendingDraftForCurrentSelection,
  enqueuePeerOperation,
} from './desktop-target-selection.mjs';

function peer() {
  return { latestTargetRequestId: null, targetSelectionId: null, targetVerified: false };
}

test('a fresh drag immediately invalidates the previous selection ID', () => {
  const value = peer();
  assert.equal(beginTargetSelection(value, 'drag-1'), true);
  assert.equal(confirmTargetSelection(value, 'drag-1', {
    message: 'Verified an empty field',
    selectionId: 'native-selection-1',
  }), true);
  assert.equal(canStageDraftForCurrentSelection(value), true);

  assert.equal(beginTargetSelection(value, 'drag-2'), true);
  assert.equal(value.targetSelectionId, null);
  assert.equal(value.targetVerified, false);
  assert.equal(canStageDraftForCurrentSelection(value), false);
});

test('a delayed result for an older drag cannot confirm a newer drag', () => {
  const value = peer();
  beginTargetSelection(value, 'drag-older');
  beginTargetSelection(value, 'drag-newer');

  assert.equal(confirmTargetSelection(value, 'drag-older', {
    message: 'Old field',
    selectionId: 'native-old',
  }), false);
  assert.equal(value.targetSelectionId, null);
  assert.equal(value.targetVerified, false);

  assert.equal(confirmTargetSelection(value, 'drag-newer', {
    message: 'New field',
    selectionId: 'native-new',
  }), true);
  assert.equal(value.targetSelectionId, 'native-new');
  assert.equal(canStageDraftForCurrentSelection(value), true);
});

test('malformed acknowledgements and failed current checks never enable draft staging', () => {
  const value = peer();
  beginTargetSelection(value, 'drag-1');
  assert.equal(confirmTargetSelection(value, 'drag-1', null), false);
  assert.equal(value.targetVerified, false);
  assert.equal(canStageDraftForCurrentSelection(value), false);

  beginTargetSelection(value, 'drag-2');
  assert.equal(rejectTargetSelection(value, 'drag-2'), true);
  assert.equal(value.latestTargetRequestId, null);
  assert.equal(canStageDraftForCurrentSelection(value), false);
});

test('clearing a target or starting a clear operation blocks draft staging', () => {
  const value = peer();
  beginTargetSelection(value, 'drag-1');
  confirmTargetSelection(value, 'drag-1', { message: 'ok', selectionId: 'selection-1' });
  value.targetClearPromise = Promise.resolve();
  assert.equal(canStageDraftForCurrentSelection(value), false);

  delete value.targetClearPromise;
  invalidateTargetSelection(value);
  assert.equal(value.latestTargetRequestId, null);
  assert.equal(value.targetSelectionId, null);
  assert.equal(value.targetVerified, false);
  assert.equal(canStageDraftForCurrentSelection(value), false);
});

test('pending approval list entries must match the exact active native selection ID', () => {
  const value = peer();
  beginTargetSelection(value, 'drag-1');
  confirmTargetSelection(value, 'drag-1', { message: 'ok', selectionId: 'selection-current' });

  assert.equal(isPendingDraftForCurrentSelection(value, {
    requestId: 'draft-1',
    selectionId: 'selection-current',
  }), true);
  assert.equal(isPendingDraftForCurrentSelection(value, {
    requestId: 'draft-old',
    selectionId: 'selection-old',
  }), false);
  assert.equal(isPendingDraftForCurrentSelection(value, {
    requestId: 'draft-missing-version',
  }), false);
});

test('native target, clear, manual input and the next drag stay in arrival order', async () => {
  const value = peer();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const firstTarget = enqueuePeerOperation(value, async () => {
    events.push('target-start');
    await firstGate;
    events.push('target-finish');
  });
  const clear = enqueuePeerOperation(value, async () => { events.push('clear'); });
  const manualInput = enqueuePeerOperation(value, async () => { events.push('manual-input'); });
  const nextTarget = enqueuePeerOperation(value, async () => { events.push('next-target'); });

  assert.deepEqual(events, ['target-start']);
  assert.equal(value.targetOperationsPending, 4);
  releaseFirst();
  await Promise.all([firstTarget, clear, manualInput, nextTarget]);

  assert.deepEqual(events, [
    'target-start',
    'target-finish',
    'clear',
    'manual-input',
    'next-target',
  ]);
  assert.equal(value.targetOperationsPending, 0);
});

test('a rejected native operation does not poison the per-peer queue', async () => {
  const value = peer();
  const events = [];
  const failure = enqueuePeerOperation(value, async () => {
    events.push('clear-failed');
    throw new Error('native clear unavailable');
  });
  const followingDrag = enqueuePeerOperation(value, async () => {
    events.push('next-drag');
    return 'verified';
  });

  await assert.rejects(failure, /native clear unavailable/);
  assert.equal(await followingDrag, 'verified');
  assert.deepEqual(events, ['clear-failed', 'next-drag']);
  assert.equal(value.targetOperationsPending, 0);
});

test('invalid queue arguments reject without mutating peer queue state', async () => {
  const value = peer();
  await assert.rejects(enqueuePeerOperation(null, async () => {}), TypeError);
  await assert.rejects(enqueuePeerOperation(value, null), TypeError);
  assert.equal(value.targetOperationsPending, undefined);
  assert.equal(value.targetQueue, undefined);
});
