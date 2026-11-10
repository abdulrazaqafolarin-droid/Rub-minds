import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clipboard, Link2, RefreshCw, Shield, Unlink } from 'lucide-react';
import {
  createBackroomFrameBindingChallenge,
  getBackroomFrameBindingStatus,
  listBackroomFrameAICandidates,
  revokeBackroomFrameBinding,
  type BackroomFrameAICandidate,
  type BackroomFrameBinding,
  type BackroomFrameBindingChallenge,
  type BackroomFrameSurface,
} from './backroomCloudDevices';
import './backroomFrameAIConnector.css';

type Props = {
  roomId: string;
  deviceId: string;
  runtimeSessionId: string;
  surface: BackroomFrameSurface;
  ready: boolean;
  unavailableReason?: string;
};

export default function BackroomFrameAIConnector({
  roomId, deviceId, runtimeSessionId, surface, ready, unavailableReason,
}: Props) {
  const [candidates, setCandidates] = useState<BackroomFrameAICandidate[]>([]);
  const [participantId, setParticipantId] = useState('');
  const [binding, setBinding] = useState<BackroomFrameBinding | null>(null);
  const [challenge, setChallenge] = useState<BackroomFrameBindingChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const operationEpoch = useRef(0);

  // A frame can change while an API request is in flight. Clear the old
  // frame's UI before paint and invalidate every pending response so it can
  // never overwrite the new frame's state.
  useLayoutEffect(() => {
    operationEpoch.current += 1;
    setCandidates([]);
    setParticipantId('');
    setBinding(null);
    setChallenge(null);
    setBusy(false);
    setError('');
    setNotice('');
    setCopied(false);
    return () => {
      operationEpoch.current += 1;
    };
  }, [deviceId, ready, roomId, runtimeSessionId, surface]);

  const selectedCandidate = useMemo(
    () => candidates.find(candidate => candidate.participantId === participantId) ?? null,
    [candidates, participantId],
  );
  const toolCall = useMemo(() => challenge ? [
    'Use the Rub Minds MCP tool bind_device_frame in this exact AI conversation.',
    'This AI must already have joined the selected Rub Minds group.',
    JSON.stringify({
      challenge_id: challenge.challengeId,
      nonce: challenge.nonce,
      confirm_bind: true,
    }, null, 2),
    'This links the existing AI participant to this device frame. It does not enable app control, native Send or automatic wake.',
  ].join('\n\n') : '', [challenge]);

  const refresh = useCallback(async () => {
    if (!roomId || !deviceId || !runtimeSessionId || !ready) return;
    const requestEpoch = ++operationEpoch.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const [people, activeBinding] = await Promise.all([
        listBackroomFrameAICandidates(roomId),
        getBackroomFrameBindingStatus({ deviceId, roomId, runtimeSessionId }),
      ]);
      if (requestEpoch !== operationEpoch.current) return;
      setCandidates(people);
      setBinding(activeBinding);
      setParticipantId(current => activeBinding?.participant_id || (people.some(p => p.participantId === current) ? current : people[0]?.participantId || ''));
      if (activeBinding) setChallenge(null);
    } catch (cause) {
      if (requestEpoch === operationEpoch.current) {
        setError(cause instanceof Error ? cause.message : 'Could not refresh the group AI connection.');
      }
    } finally {
      if (requestEpoch === operationEpoch.current) setBusy(false);
    }
  }, [deviceId, roomId, runtimeSessionId, ready]);

  useEffect(() => {
    if (ready) void refresh();
    else {
      setBinding(null);
      setChallenge(null);
      setError('');
      setNotice('');
    }
  }, [refresh, ready]);

  const createChallenge = async () => {
    if (!selectedCandidate || !ready || busy || binding) return;
    const requestEpoch = ++operationEpoch.current;
    setBusy(true); setError(''); setNotice(''); setCopied(false);
    try {
      const result = await createBackroomFrameBindingChallenge({
        deviceId, roomId, runtimeSessionId, participantId: selectedCandidate.participantId, surface,
      });
      if (requestEpoch !== operationEpoch.current) return;
      const expiresAtMs = Date.parse(result.expiresAt);
      const validUuid = typeof result.challengeId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.challengeId);
      const validNonce = typeof result.nonce === 'string' && /^[a-f0-9]{64}$/i.test(result.nonce);
      if (result.participantId !== selectedCandidate.participantId || result.surface !== surface ||
          !validUuid || !validNonce || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw new Error('The server returned an invalid or expired frame challenge. Refresh the frame and try again.');
      }
      setChallenge(result);
      setNotice('One-time challenge created. Give the tool call below to this exact AI conversation before it expires.');
    } catch (cause) {
      if (requestEpoch === operationEpoch.current) {
        setError(cause instanceof Error ? cause.message : 'Could not create the one-time device-frame challenge.');
      }
    } finally {
      if (requestEpoch === operationEpoch.current) setBusy(false);
    }
  };

  const copyToolCall = async () => {
    if (!toolCall) return;
    const requestEpoch = operationEpoch.current;
    try {
      await navigator.clipboard.writeText(toolCall);
      if (requestEpoch !== operationEpoch.current) return;
      setCopied(true);
      setNotice('One-time tool call copied. Paste it into the selected AI conversation.');
    } catch {
      if (requestEpoch !== operationEpoch.current) return;
      setCopied(false);
      setNotice('Clipboard access is unavailable. Select and copy the one-time tool call shown below.');
    }
  };

  const revoke = async () => {
    if (!binding || busy) return;
    const requestEpoch = ++operationEpoch.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await revokeBackroomFrameBinding({
        deviceId, roomId, runtimeSessionId, bindingId: binding.id,
      });
      if (requestEpoch !== operationEpoch.current) return;
      if (!result.revoked) throw new Error('The device-frame association was already changed or revoked.');
      setBinding(null); setChallenge(null);
      setNotice('AI-to-frame association revoked. The AI remains a member of the group until it leaves separately.');
    } catch (cause) {
      if (requestEpoch === operationEpoch.current) {
        setError(cause instanceof Error ? cause.message : 'Could not revoke the device-frame association.');
      }
    } finally {
      if (requestEpoch === operationEpoch.current) setBusy(false);
    }
  };

  const linkedName = binding
    ? candidates.find(candidate => candidate.participantId === binding.participant_id)?.displayName || 'Selected group AI'
    : '';
  const expires = challenge ? new Date(challenge.expiresAt).toLocaleTimeString() : '';

  return <section className="br-frame-ai" aria-label="AI group frame connection">
    <div className="br-frame-ai-head">
      <div><b><Link2 size={14}/> Group AI connection</b><small>Attach the existing AI session to this live device frame</small></div>
      <button type="button" onClick={() => void refresh()} disabled={!ready || busy} aria-label="Refresh AI frame connection">
        <RefreshCw size={13}/> Refresh
      </button>
    </div>
    {!ready ? <p className="br-frame-ai-note">{unavailableReason || 'Start and approve the selected app or terminal frame first.'}</p> :
      binding ? <div className="br-frame-ai-linked">
        <span><CheckCircle2 size={15}/> Linked to <strong>{linkedName}</strong></span>
        <small>Group identity stays with this AI MCP session. Link expires {new Date(binding.expires_at).toLocaleString()}.</small>
        <button type="button" onClick={() => void revoke()} disabled={busy}><Unlink size={13}/> Revoke frame link</button>
      </div> : <>
        <label htmlFor="br-frame-ai-candidate">AI participant already in this group</label>
        <select id="br-frame-ai-candidate" value={participantId} onChange={event => { setParticipantId(event.target.value); setChallenge(null); }}
          disabled={busy || candidates.length === 0}>
          <option value="">Choose the AI conversation running in this frame</option>
          {candidates.map(candidate => <option key={candidate.participantId} value={candidate.participantId}>{candidate.displayName} · {candidate.kind.replaceAll('_',' ')}</option>)}
        </select>
        {candidates.length === 0 ? <p className="br-frame-ai-note">No active AI MCP session is joined to this group yet. Connect the AI to the group first, then refresh this list.</p> :
          <button type="button" className="br-frame-ai-primary" onClick={() => void createChallenge()} disabled={!selectedCandidate || busy}>
            <Shield size={13}/> Create one-time frame link
          </button>}
        {challenge && <div className="br-frame-ai-challenge">
          <div><b>One-time AI tool call</b><small>Expires at {expires}. Use only in {selectedCandidate?.displayName || 'the selected AI'}'s own joined conversation.</small></div>
          <pre>{toolCall}</pre>
          <button type="button" onClick={() => void copyToolCall()}><Clipboard size={13}/>{copied ? 'Copied' : 'Copy tool call'}</button>
        </div>}
      </>}
    {error ? <p className="br-frame-ai-error" role="alert">{error}</p> : null}
    {notice ? <p className="br-frame-ai-status" role="status">{notice}</p> : null}
    <p className="br-frame-ai-foot">This link enables group collaboration through the same AI participant. It does not grant app control, typing, Send or background wake.</p>
  </section>;
}
