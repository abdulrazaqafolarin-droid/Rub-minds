export async function stopLocalExecutionBeforePeerCleanup({
  stopLocalExecution,
  cleanupPeerSessions,
}) {
  if (typeof stopLocalExecution !== 'function' || typeof cleanupPeerSessions !== 'function') {
    throw new TypeError('Both local-stop and peer-cleanup callbacks are required.');
  }

  // Invoke native cleanup first. Observe both promises immediately so a fast
  // rejection cannot become unhandled while peer/media cleanup is still running.
  let localResult;
  try {
    localResult = Promise.resolve(stopLocalExecution()).then(
      () => ({ error: null }),
      error => ({ error }),
    );
  } catch (error) {
    localResult = Promise.resolve({ error });
  }

  let peerResult;
  try {
    peerResult = Promise.resolve(cleanupPeerSessions()).then(
      () => ({ error: null }),
      error => ({ error }),
    );
  } catch (error) {
    peerResult = Promise.resolve({ error });
  }

  const [local, peers] = await Promise.all([localResult, peerResult]);
  return { localError: local.error, peerError: peers.error };
}
