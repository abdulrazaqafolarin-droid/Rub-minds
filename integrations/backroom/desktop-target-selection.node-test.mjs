import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginTargetSelection,
  confirmTargetSelection,
  invalidateTargetSelection,
  rejectTargetSelection,
  canStageDraftForCurrentSelection,
  isPendingDraftForCurrentSelection,
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
