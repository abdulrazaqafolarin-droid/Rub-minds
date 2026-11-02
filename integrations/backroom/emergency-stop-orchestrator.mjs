export async function stopLocalExecutionBeforePeerCleanup({
  stopLocalExecution,
  cleanupPeerSessions,
}) {
  if (typeof stopLocalExecution !== 'function' || typeof cleanupPeerSessions !== 'function') {
    throw new TypeError('Both local-stop and peer-cleanup callbacks are required.');
  }

  // Await local shutdown before starting any network/media teardown. Peer
  // cleanup is still attempted if the native command fails.
  let localError = null;
  try {
    await stopLocalExecution();
  } catch (error) {
    localError = error;
  }

  let peerError = null;
  try {
    await cleanupPeerSessions();
  } catch (error) {
    peerError = error;
  }

  return { localError, peerError };
}
