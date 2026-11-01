export function invalidateTargetSelection(peer) {
  if (!peer || typeof peer !== 'object') return;
  peer.latestTargetRequestId = null;
  peer.targetSelectionId = null;
  peer.targetVerified = false;
}

export function beginTargetSelection(peer, requestId) {
  if (!peer || typeof peer !== 'object' || typeof requestId !== 'string' || requestId.length === 0) {
    return false;
  }
  peer.latestTargetRequestId = requestId;
  peer.targetSelectionId = null;
  peer.targetVerified = false;
  return true;
}

export function confirmTargetSelection(peer, requestId, summary) {
  if (!peer || typeof peer !== 'object' || peer.latestTargetRequestId !== requestId) return false;
  if (!summary || typeof summary !== 'object' ||
      typeof summary.message !== 'string' || summary.message.length === 0 ||
      typeof summary.selectionId !== 'string' || summary.selectionId.length === 0) {
    peer.targetSelectionId = null;
    peer.targetVerified = false;
    return false;
  }
  // A successful native acknowledgement is single-use. A duplicated or replayed
  // reply must not replace the active verified target with another selection ID.
  peer.latestTargetRequestId = null;
  peer.targetSelectionId = summary.selectionId;
  peer.targetVerified = true;
  return true;
}

export function rejectTargetSelection(peer, requestId) {
  if (!peer || typeof peer !== 'object' || peer.latestTargetRequestId !== requestId) return false;
  peer.latestTargetRequestId = null;
  peer.targetSelectionId = null;
  peer.targetVerified = false;
  return true;
}

export function canStageDraftForCurrentSelection(peer) {
  return Boolean(
    peer &&
    peer.targetVerified === true &&
    typeof peer.targetSelectionId === 'string' &&
    peer.targetSelectionId.length > 0 &&
    !peer.targetClearPromise
  );
}

export function isPendingDraftForCurrentSelection(peer, draft) {
  return Boolean(
    canStageDraftForCurrentSelection(peer) &&
    draft &&
    typeof draft.selectionId === 'string' &&
    draft.selectionId.length > 0 &&
    peer.targetSelectionId === draft.selectionId
  );
}

export function enqueuePeerOperation(peer, operation) {
  if (!peer || typeof peer !== 'object' || typeof operation !== 'function') {
    return Promise.reject(new TypeError('A peer and operation function are required.'));
  }
  const previous = peer.targetQueue || Promise.resolve();
  peer.targetOperationsPending = (peer.targetOperationsPending || 0) + 1;
  const task = Promise.resolve(previous).catch(() => {}).then(operation);
  const tracked = task.finally(() => {
    peer.targetOperationsPending = Math.max(0, (peer.targetOperationsPending || 1) - 1);
  });
  // The caller receives the real failure. The shared queue always recovers so
  // one failed revoke/input operation cannot block future target safety work.
  peer.targetQueue = tracked.catch(() => {});
  return tracked;
}
