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
