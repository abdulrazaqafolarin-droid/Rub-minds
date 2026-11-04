import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownToLine, Check, ChevronDown, CircleAlert, Copy,
  LockKeyhole, Monitor, RefreshCw, ShieldCheck, Smartphone, SquareTerminal, X,
} from 'lucide-react';
import { listCloudRooms, type CloudRoom } from './cloudRooms';
import { supabase } from './supabase';
import {
  approveBackroomDevice, createBackroomDevicePairing, listBackroomDeviceEvents,
  listBackroomDevices, revokeBackroomDevice, type BackroomDevice, type BackroomDeviceEvent,
} from './backroomCloudDevices';
import BackroomAndroidControl from './BackroomAndroidControl';
import BackroomDesktopControl from './BackroomDesktopControl';
import './backroom-cloud.css';

type NativeTargetProof = {
  proofId: string;
  expiresAt: string;
  deviceId: string;
  roomId: string;
  screenSessionId: string;
  appPackageName: string;
  targetId: string;
};
type NativeProofHost = { hostId: string; expiresAt: string };
type NativeProofSession = {
  participantId: string;
  displayName: string;
  sessionDigest: string;
  expiresAt: string;
  credentialExpiresAt: string;
};

type Surface = 'phone' | 'desktop' | 'terminal';
const surfaceLabels: Record<Surface, string> = {
  phone: 'Phone apps', desktop: 'Desktop apps', terminal: 'Terminal',
};

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}
function eventLabel(event: BackroomDeviceEvent, devices: BackroomDevice[]) {
  const sourceDevice = event.actor_type === 'device' ? devices.find(device => device.device_id === event.actor_id) : undefined;
  const sourceApp = event.package_name
    ? devices.flatMap(device => device.apps).find(app => app.package_name === event.package_name)
    : undefined;
  const app = event.package_name ? ' · ' + (sourceApp?.app_label ?? event.package_name) : '';
  const actor = event.actor_type === 'owner' ? 'Group owner'
    : event.actor_type === 'ai' ? 'AI participant'
    : event.actor_type === 'device' ? sourceDevice?.device_label ?? 'Android device' : 'System';
  const action = event.event_type.replaceAll('_', ' ');
  return { actor, action, app, actorId: event.actor_id };
}

export default function BackroomApp() {
  const [rooms, setRooms] = useState<CloudRoom[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get('room') ?? '');
  const [devices, setDevices] = useState<BackroomDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [events, setEvents] = useState<BackroomDeviceEvent[]>([]);
  const [surface, setSurface] = useState<Surface>('phone');
  const [pairCode, setPairCode] = useState('');
  const [pairExpires, setPairExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [nativeTargetProof, setNativeTargetProof] = useState<NativeTargetProof | null>(null);
  const [nativeProofHosts, setNativeProofHosts] = useState<NativeProofHost[]>([]);
  const [nativeProofSessions, setNativeProofSessions] = useState<NativeProofSession[]>([]);
  const [selectedNativeHostId, setSelectedNativeHostId] = useState('');
  const [selectedNativeSessionDigest, setSelectedNativeSessionDigest] = useState('');
  const [nativeBindingBusy, setNativeBindingBusy] = useState(false);
  const [nativeBindingStatus, setNativeBindingStatus] = useState('');
  const [nativeTargetProofConsumed, setNativeTargetProofConsumed] = useState(false);


  const handleNativeTargetProof = useCallback(async (proof: NativeTargetProof | null) => {
    setNativeTargetProof(proof);
    setNativeTargetProofConsumed(false);
    setNativeProofHosts([]);
    setNativeProofSessions([]);
    setSelectedNativeHostId('');
    setSelectedNativeSessionDigest('');
    setNativeBindingStatus('');
    if (!proof || !supabase) return;
    try {
      const [hostResult, sessionResult] = await Promise.all([
        supabase.functions.invoke('backroom-config/hosts', { body: { roomId: proof.roomId } }),
        supabase.functions.invoke('backroom-config/sessions', { body: { roomId: proof.roomId } }),
      ]);
      if (hostResult.error) throw hostResult.error;
      if (sessionResult.error) throw sessionResult.error;
      const hosts = Array.isArray(hostResult.data?.hosts)
        ? hostResult.data.hosts.filter((row: any) =>
            row && typeof row.hostId === 'string' && /^[a-f0-9-]{36}$/i.test(row.hostId) &&
            typeof row.expiresAt === 'string')
        : [];
      const sessions = Array.isArray(sessionResult.data?.sessions)
        ? sessionResult.data.sessions.filter((row: any) =>
            row && typeof row.participantId === 'string' && /^[a-f0-9-]{36}$/i.test(row.participantId) &&
            typeof row.displayName === 'string' && typeof row.sessionDigest === 'string' &&
            /^[a-f0-9]{64}$/.test(row.sessionDigest) &&
            typeof row.expiresAt === 'string' && typeof row.credentialExpiresAt === 'string')
        : [];
      setNativeProofHosts(hosts);
      setNativeProofSessions(sessions);
      setSelectedNativeHostId(hosts[0]?.hostId ?? '');
      setSelectedNativeSessionDigest(sessions[0]?.sessionDigest ?? '');
      if (!hosts.length) setNativeBindingStatus('No active Backroom host is registered for this owner. Register a host on the desktop before binding this phone target.');
      else if (!sessions.length) setNativeBindingStatus('No active joined AI/MCP sessions are available in this group.');
      else setNativeBindingStatus('Choose the original AI session and the trusted Backroom host that should own this phone target.');
    } catch (e) {
      setNativeBindingStatus(e instanceof Error ? e.message : 'Could not load active hosts and AI sessions.');
    }
  }, []);

  const registerNativeTargetBinding = useCallback(async () => {
    const proof = nativeTargetProof;
    const proofRoom = proof ? rooms.find(room => room.id === proof.roomId) : undefined;
    if (!supabase || !proof || !proofRoom || !userId || proofRoom.owner_id !== userId || nativeBindingBusy ||
        !selectedNativeHostId || !selectedNativeSessionDigest) return;
    if (Date.parse(proof.expiresAt) <= Date.now()) {
      setNativeBindingStatus('The phone proof has expired. Recheck and prepare a new conversation proof.');
      setNativeTargetProof(null);
      return;
    }
    const selectedSession = nativeProofSessions.find(row => row.sessionDigest === selectedNativeSessionDigest);
    if (!selectedSession) {
      setNativeBindingStatus('The selected AI session is no longer available. Refresh the proof and session list.');
      return;
    }
    setNativeBindingBusy(true);
    setNativeBindingStatus('Consuming the phone proof and registering the inactive AI-to-phone binding…');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('backroom-config/binding', {
        body: {
          roomId: proof.roomId,
          participantId: selectedSession.participantId,
          hostId: selectedNativeHostId,
          sessionDigest: selectedSession.sessionDigest,
          spaceId: 'android-' + proof.deviceId,
          nativeTargetProofId: proof.proofId,
          participationMode: 'mentions',
          maxWakesPerMinute: 6,
        },
      });
      if (invokeError) throw invokeError;
      if (data?.ok !== true || typeof data.bindingId !== 'string') {
        throw new Error(typeof data?.reason === 'string' ? data.reason.replaceAll('_', ' ') : 'Android binding was not created.');
      }
      setNativeBindingStatus('Phone target registered for ' + selectedSession.displayName +
        '. Binding is inactive; a separate on-phone native wake consent and the trusted host forwarder are still required.');
      setNativeTargetProofConsumed(true);
      setNativeTargetProof(null);
      setNativeProofHosts([]);
      setNativeProofSessions([]);
      setSelectedNativeHostId('');
      setSelectedNativeSessionDigest('');
    } catch (e) {
      setNativeBindingStatus(e instanceof Error ? e.message : 'Could not register the native phone target.');
    } finally {
      setNativeBindingBusy(false);
    }
  }, [nativeBindingBusy, nativeProofSessions, nativeTargetProof, rooms, userId,
      selectedNativeHostId, selectedNativeSessionDigest]);

  const loadRooms = useCallback(async () => {
    if (!supabase) return;
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    setUserId(authData.user?.id ?? null);
    const next = await listCloudRooms();
    setRooms(next);
    setRoomId(current => current && next.some(room => room.id === current) ? current : next[0]?.id ?? '');
  }, []);

  const refresh = useCallback(async (targetRoom = roomId) => {
    if (!targetRoom) { setDevices([]); setEvents([]); return; }
    const [nextDevices, nextEvents] = await Promise.all([
      listBackroomDevices(targetRoom), listBackroomDeviceEvents(targetRoom),
    ]);
    setDevices(nextDevices);
    setEvents(nextEvents);
  }, [roomId]);

  useEffect(() => { void loadRooms().catch(e => setError(e.message)); }, [loadRooms]);
  useEffect(() => {
    setNativeTargetProof(null);
    setNativeTargetProofConsumed(false);
    setNativeProofHosts([]);
    setNativeProofSessions([]);
    setSelectedNativeHostId('');
    setSelectedNativeSessionDigest('');
    setNativeBindingStatus('');
    if (!roomId) return;
    setPairCode('');
    void refresh(roomId).catch(e => setError(e.message));
    const params = new URLSearchParams(location.search);
    params.set('backroom', '1');
    params.set('room', roomId);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  }, [roomId, refresh]);

  const selectedRoom = rooms.find(room => room.id === roomId);
  const activeDevices = useMemo(() => devices.filter(device => device.status === 'active'), [devices]);
  const activeDevice = activeDevices.find(device => device.device_id === selectedDeviceId) ?? activeDevices[0];
  const addedApps = useMemo(() => activeDevice
    ? activeDevice.apps.map(app => ({ ...app, deviceId: activeDevice.device_id, deviceLabel: activeDevice.device_label, status: activeDevice.status }))
    : [], [activeDevice]);
  const phoneReady = Boolean(activeDevice);
  const canManageDevices = Boolean(selectedRoom && userId && selectedRoom.owner_id === userId);

  useEffect(() => {
    if (!activeDevices.some(device => device.device_id === selectedDeviceId)) {
      setSelectedDeviceId(activeDevices[0]?.device_id ?? '');
    }
  }, [activeDevices, selectedDeviceId]);

  async function createPairing() {
    if (!roomId || !canManageDevices || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await createBackroomDevicePairing(roomId);
      setPairCode(result.pairingCode);
      setPairExpires(result.expiresAt);
      setNotice('Pairing code created. It expires in five minutes and can be used once.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create pairing code.'); }
    finally { setBusy(false); }
  }

  async function copyPairCode() {
    try { await navigator.clipboard.writeText(pairCode); setNotice('Pairing code copied.'); }
    catch { window.prompt('Copy this one-use pairing code to the Android companion:', pairCode); }
  }

  async function approve(deviceId: string) {
    if (!canManageDevices) return;
    setBusy(true); setError(''); setNotice('');
    try { await approveBackroomDevice(deviceId, roomId); await refresh(); setNotice('Device approved. It can now sync the apps you selected on the phone.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Device approval failed.'); }
    finally { setBusy(false); }
  }

  async function revoke(deviceId: string) {
    if (!canManageDevices) return;
    if (!window.confirm('Revoke this phone? It will lose access to this Rub Minds group.')) return;
    setBusy(true); setError(''); setNotice('');
    try { await revokeBackroomDevice(deviceId, roomId); await refresh(); setNotice('Device revoked.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Device revocation failed.'); }
    finally { setBusy(false); }
  }

  return <main className="br-cloud-shell">
    <header className="br-cloud-header">
      <div className="br-cloud-brand"><div className="br-cloud-mark"><Smartphone size={21}/></div><div><b>Backroom</b><small>Unified device frame</small></div></div>
      <div className="br-cloud-room">
        <label htmlFor="br-cloud-room-select">Group</label>
        <select id="br-cloud-room-select" value={roomId} onChange={event => setRoomId(event.target.value)}>
          {rooms.length ? rooms.map(room => <option key={room.id} value={room.id}>{room.title}</option>) : <option value="">No groups yet</option>}
        </select>
      </div>
      <button className="br-cloud-quiet" onClick={() => void refresh().catch(e => setError(e.message))} disabled={!roomId || busy}><RefreshCw size={16}/> Refresh</button>
    </header>

    {!supabase ? <section className="br-cloud-notice"><CircleAlert/> Supabase cloud is not configured for this deployment.</section> : null}
    {notice ? <section className="br-cloud-notice success"><Check size={17}/>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></section> : null}
    {error ? <section className="br-cloud-notice error"><CircleAlert size={17}/>{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></section> : null}

    <section className="br-cloud-intro">
      <div><span className="br-cloud-eyebrow">RUB MINDS · DEVICE RUNTIMES</span><h1>One space. Every surface.</h1><p>Connect native runtimes directly to Rub Minds over outbound HTTPS. No localhost server or phone port bridge.</p></div>
      <div className="br-cloud-security"><ShieldCheck size={19}/><span>Owner approval required<br/><small>Pairing codes are one-use and expire in 5 minutes.</small></span></div>
    </section>

    {!selectedRoom ? <section className="br-cloud-empty"><Smartphone size={32}/><h2>Create or join a group first</h2><p>Backroom devices are scoped to a Rub Minds group.</p><a className="br-cloud-primary" href="/">Open Rub Minds groups</a></section> : <>
      <section className="br-cloud-layout">
        <div className="br-cloud-sidebar">
          <div className="br-cloud-panel-head"><div><span className="br-cloud-eyebrow">DEVICES</span><h2>Connected runtimes</h2></div><span className="br-cloud-count">{devices.length}</span></div>
          {canManageDevices
            ? <button className="br-cloud-primary" disabled={busy} onClick={() => void createPairing()}><Smartphone size={17}/> Pair Android phone</button>
            : <p className="br-cloud-help">Only the group owner can pair, approve or revoke devices. All group members can view selected app inventory and the activity history.</p>}
          {pairCode ? <div className="br-cloud-pair-card">
            <b>One-use pairing code</b>
            <code>{pairCode}</code>
            <button onClick={() => void copyPairCode()}><Copy size={15}/> Copy code</button>
            <small>Enter this code in Rub Minds Companion on the phone. Expires {formatTime(pairExpires)}.</small>
          </div> : null}
          {devices.length ? devices.map(device => <article className="br-cloud-device" key={device.device_id}>
            <div className="br-cloud-device-icon"><Smartphone size={19}/></div>
            <div className="br-cloud-device-copy"><b>{device.device_label}</b><small>{device.platform} · Android {device.os_version || 'version unknown'}</small><span className={'br-cloud-status ' + device.status}>{device.status}</span></div>
            <div className="br-cloud-device-actions">
              {canManageDevices && device.status === 'pending' ? <button disabled={busy} onClick={() => void approve(device.device_id)}>Approve</button> : null}
              {canManageDevices && device.status !== 'revoked' ? <button className="danger" disabled={busy} onClick={() => void revoke(device.device_id)}>Revoke</button> : null}
            </div>
          </article>) : <div className="br-cloud-empty-mini"><Smartphone size={24}/><b>No devices paired</b><span>Ask the group owner to pair an Android companion and approve its selected app inventory.</span></div>}
          <button className="br-cloud-link" onClick={() => setShowHelp(value => !value)}><LockKeyhole size={15}/> {showHelp ? 'Hide connection details' : 'How device pairing works'} <ChevronDown size={14}/></button>
          {showHelp ? <p className="br-cloud-help">The phone creates a private device credential locally and sends only its digest to the cloud. The pairing code is single-use. A device remains pending until you approve it here. Revoke stops future device API access.</p> : null}
        </div>

        <div className="br-cloud-stage-panel">
          <div className="br-cloud-surface-tabs">
            {(['phone','desktop','terminal'] as Surface[]).map(id => <button key={id} className={surface === id ? 'active' : ''} onClick={() => setSurface(id)}>
              {id === 'phone' ? <Smartphone size={16}/> : id === 'desktop' ? <Monitor size={16}/> : <SquareTerminal size={16}/>} {surfaceLabels[id]}
            </button>)}
            {surface === 'phone' && activeDevices.length > 1 ? <label className="br-cloud-device-picker">
              <span>Phone</span>
              <select aria-label="Select Android phone" value={activeDevice?.device_id ?? ''} onChange={event => setSelectedDeviceId(event.target.value)}>
                {activeDevices.map(device => <option key={device.device_id} value={device.device_id}>{device.device_label}</option>)}
              </select>
            </label> : null}
          </div>
          <div className={'br-cloud-device-frame ' + surface}>
            {surface === 'phone' ? <div className="br-cloud-phone">
              <div className="br-cloud-phone-notch"/>
              {phoneReady ? <div className="br-cloud-phone-screen">
                <div className="br-cloud-phone-bar"><span>Selected apps</span><small>{addedApps.length} added</small></div>
                {addedApps.length ? addedApps.map(app => <div className="br-cloud-app-row" key={app.deviceId + app.package_name}>
                  <div className="br-cloud-app-icon"><Smartphone size={18}/></div><div><b>{app.app_label}</b><small>{app.package_name}</small></div><span className={app.status}>{app.status}</span>
                </div>) : <div className="br-cloud-phone-empty"><ArrowDownToLine size={27}/><b>No apps added yet</b><span>Choose apps in the Android companion. Only selected app metadata is synced.</span></div>}
                <div className="br-cloud-frame-foot"><Check size={14}/> App inventory synced from {activeDevice?.device_label ?? 'Android device'}</div>
                {activeDevice?.platform === 'android'
                  ? <>
                      <BackroomAndroidControl device={activeDevice} roomId={roomId} onNativeTargetProof={handleNativeTargetProof} nativeTargetProofConsumed={nativeTargetProofConsumed}/>
                      {nativeTargetProof && nativeTargetProof.deviceId === activeDevice.device_id ? <div className="br-cloud-native-proof">
                        <b>Bind this phone conversation to an AI session</b>
                        <small>Device proof expires {formatTime(nativeTargetProof.expiresAt)}. The provider conversation digest and native target identifiers remain on the phone/server; this panel sees only a one-use proof ID.</small>
                        <label>
                          <span>Trusted Backroom host</span>
                          <select value={selectedNativeHostId} onChange={event => setSelectedNativeHostId(event.target.value)} disabled={!canManageDevices || nativeBindingBusy}>
                            <option value="">Select active host</option>
                            {nativeProofHosts.map(host => <option key={host.hostId} value={host.hostId}>{host.hostId.slice(0, 8)} · expires {formatTime(host.expiresAt)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>Original AI conversation in this group</span>
                          <select value={selectedNativeSessionDigest} onChange={event => setSelectedNativeSessionDigest(event.target.value)} disabled={!canManageDevices || nativeBindingBusy}>
                            <option value="">Select AI session</option>
                            {nativeProofSessions.map(session => <option key={session.sessionDigest} value={session.sessionDigest}>{session.displayName} · {formatTime(session.expiresAt)}</option>)}
                          </select>
                        </label>
                        <button type="button" disabled={!canManageDevices || nativeBindingBusy || !selectedNativeHostId || !selectedNativeSessionDigest}
                          onClick={() => void registerNativeTargetBinding()}>
                          {nativeBindingBusy ? 'Registering…' : 'Register inactive AI binding'}
                        </button>
                        {nativeBindingStatus ? <p role="status">{nativeBindingStatus}</p> : null}
                      </div> : nativeBindingStatus ? <p className="br-cloud-native-proof-status" role="status">{nativeBindingStatus}</p> : null}
                    </>
                  : <div className="br-cloud-phone-runtime-note">This connected device has no Android app-stream driver. Its app entries remain inventory only.</div>}
              </div> : <div className="br-cloud-phone-screen disconnected">
                <div className="br-cloud-phone-bar"><span>Backroom</span><small>Not connected</small></div>
                <Smartphone size={32}/><b>Connect your Android runtime</b><p>Pair the phone, approve it, then select apps inside Rub Minds Companion.</p>
              </div>}
              <div className="br-cloud-phone-home"/>
            </div> : <BackroomDesktopControl roomId={roomId}/>}
          </div>

          {surface === 'phone' && <div className="br-cloud-capabilities">
            <div><b>Android app capabilities</b><span>Reported separately from desktop and terminal runtime status</span></div>
            <div className="br-cloud-capability-row"><span>Launcher-visible app discovery</span><b className="ready">Available</b></div>
            <div className="br-cloud-capability-row"><span>Virtualized app running inside phone frame</span><b>Not available</b></div>
            <div className="br-cloud-capability-row"><span>Separate app data / virtualization</span><b>Not available</b></div>
            <div className="br-cloud-capability-row"><span>Live original app stream and touch</span><b>Implementation ready · device verification pending</b></div>
            <div className="br-cloud-capability-row"><span>Accessibility-backed composer identification</span><b>Implemented · Android CI pending</b></div>
            <div className="br-cloud-capability-row"><span>Drag-select exact composer</span><b>Implemented · device verification pending</b></div>
            <div className="br-cloud-capability-row"><span>Send-control discovery and recheck</span><b>Implemented · device verification pending</b></div>
            <div className="br-cloud-capability-row"><span>AI-directed sending / native Off · On · Auto</span><b>Not available · provider adapters + group forwarding missing</b></div>
          </div>}
        </div>
      </section>

      <section className="br-cloud-activity">
        <div className="br-cloud-panel-head"><div><span className="br-cloud-eyebrow">GROUP ACTIVITY</span><h2>Device history</h2></div><span className="br-cloud-count">{events.length}</span></div>
        {events.length ? events.map(event => {
          const meta = eventLabel(event, devices);
          return <div className="br-cloud-event" key={event.id}><Activity size={16}/><div><b>{meta.actor}</b><span>{meta.action}{meta.app}</span><small className="br-cloud-actor-id">Actor ID · {meta.actorId}</small></div><time>{formatTime(event.created_at)}</time></div>;
        }) : <p className="br-cloud-no-events">Pairing, approval and selected-app activity will appear here. Remote AI actions are not yet enabled.</p>}
      </section>
    </>}
    <footer className="br-cloud-footer"><LockKeyhole size={14}/> Private device credentials · Outbound HTTPS only · No local port listener · No automatic access to private app data</footer>
  </main>;
}
