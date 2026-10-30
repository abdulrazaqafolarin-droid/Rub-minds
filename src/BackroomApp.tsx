import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownToLine, Check, ChevronDown, CircleAlert, Clock3, Copy, Laptop,
  LockKeyhole, Monitor, RefreshCw, ShieldCheck, Smartphone, SquareTerminal, X,
} from 'lucide-react';
import { listCloudRooms, type CloudRoom } from './cloudRooms';
import { supabase } from './supabase';
import {
  approveBackroomDevice, createBackroomDevicePairing, listBackroomDeviceEvents,
  listBackroomDevices, revokeBackroomDevice, type BackroomDevice, type BackroomDeviceEvent,
} from './backroomCloudDevices';
import './backroom-cloud.css';

type Surface = 'phone' | 'desktop' | 'terminal';
const surfaceLabels: Record<Surface, string> = {
  phone: 'Phone apps', desktop: 'Desktop apps', terminal: 'Terminal',
};

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}
function eventLabel(event: BackroomDeviceEvent) {
  const app = event.package_name ? ' · ' + event.package_name : '';
  const actor = event.actor_type === 'owner' ? 'Group owner' : event.actor_type === 'ai' ? 'AI participant' : event.actor_type === 'device' ? 'Android device' : 'System';
  const action = event.event_type.replaceAll('_', ' ');
  return { actor, action, app };
}

export default function BackroomApp() {
  const [rooms, setRooms] = useState<CloudRoom[]>([]);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get('room') ?? '');
  const [devices, setDevices] = useState<BackroomDevice[]>([]);
  const [events, setEvents] = useState<BackroomDeviceEvent[]>([]);
  const [surface, setSurface] = useState<Surface>('phone');
  const [pairCode, setPairCode] = useState('');
  const [pairExpires, setPairExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  const loadRooms = useCallback(async () => {
    if (!supabase) return;
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
    if (!roomId) return;
    setPairCode('');
    void refresh(roomId).catch(e => setError(e.message));
    const params = new URLSearchParams(location.search);
    params.set('backroom', '1');
    params.set('room', roomId);
    history.replaceState(null, '', location.pathname + '?' + params.toString());
  }, [roomId, refresh]);

  const selectedRoom = rooms.find(room => room.id === roomId);
  const addedApps = useMemo(() => devices.filter(device => device.status === 'active').flatMap(device =>
    device.apps.map(app => ({ ...app, deviceId: device.device_id, deviceLabel: device.device_label, status: device.status }))
  ), [devices]);
  const activeDevice = devices.find(device => device.status === 'active');
  const phoneReady = Boolean(activeDevice);
  const unsupported = surface !== 'phone';

  async function createPairing() {
    if (!roomId || busy) return;
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
    setBusy(true); setError(''); setNotice('');
    try { await approveBackroomDevice(deviceId, roomId); await refresh(); setNotice('Device approved. It can now sync the apps you selected on the phone.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Device approval failed.'); }
    finally { setBusy(false); }
  }

  async function revoke(deviceId: string) {
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

    {!selectedRoom ? <section className="br-cloud-empty"><Smartphone size={32}/><h2>Create or join a group first</h2><p>Backroom devices are scoped to a Rub Minds group.</p></section> : <>
      <section className="br-cloud-layout">
        <div className="br-cloud-sidebar">
          <div className="br-cloud-panel-head"><div><span className="br-cloud-eyebrow">DEVICES</span><h2>Connected runtimes</h2></div><span className="br-cloud-count">{devices.length}</span></div>
          <button className="br-cloud-primary" disabled={busy} onClick={() => void createPairing()}><Smartphone size={17}/> Pair Android phone</button>
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
              {device.status === 'pending' ? <button disabled={busy} onClick={() => void approve(device.device_id)}>Approve</button> : null}
              {device.status !== 'revoked' ? <button className="danger" disabled={busy} onClick={() => void revoke(device.device_id)}>Revoke</button> : null}
            </div>
          </article>) : <div className="br-cloud-empty-mini"><Smartphone size={24}/><b>No devices paired</b><span>Pair an Android companion to add selected apps.</span></div>}
          <button className="br-cloud-link" onClick={() => setShowHelp(value => !value)}><LockKeyhole size={15}/> {showHelp ? 'Hide connection details' : 'How device pairing works'} <ChevronDown size={14}/></button>
          {showHelp ? <p className="br-cloud-help">The phone creates a private device credential locally and sends only its digest to the cloud. The pairing code is single-use. A device remains pending until you approve it here. Revoke stops future device API access.</p> : null}
        </div>

        <div className="br-cloud-stage-panel">
          <div className="br-cloud-surface-tabs">
            {(['phone','desktop','terminal'] as Surface[]).map(id => <button key={id} className={surface === id ? 'active' : ''} onClick={() => setSurface(id)}>
              {id === 'phone' ? <Smartphone size={16}/> : id === 'desktop' ? <Monitor size={16}/> : <SquareTerminal size={16}/>} {surfaceLabels[id]}
            </button>)}
          </div>
          <div className={'br-cloud-device-frame ' + surface}>
            {surface === 'phone' ? <div className="br-cloud-phone">
              <div className="br-cloud-phone-notch"/>
              {phoneReady ? <div className="br-cloud-phone-screen">
                <div className="br-cloud-phone-bar"><span>Selected apps</span><small>{addedApps.length} added</small></div>
                {addedApps.length ? addedApps.map(app => <div className="br-cloud-app-row" key={app.deviceId + app.package_name}>
                  <div className="br-cloud-app-icon"><Smartphone size={18}/></div><div><b>{app.app_label}</b><small>{app.package_name}</small></div><span className={app.status}>{app.status}</span>
                </div>) : <div className="br-cloud-phone-empty"><ArrowDownToLine size={27}/><b>No apps added yet</b><span>Choose apps in the Android companion. Only selected app metadata is synced.</span></div>}
                <div className="br-cloud-frame-foot"><Check size={14}/> Inventory synced from {activeDevice.device_label}</div>
              </div> : <div className="br-cloud-phone-screen disconnected">
                <div className="br-cloud-phone-bar"><span>Backroom</span><small>Not connected</small></div>
                <Smartphone size={32}/><b>Connect your Android runtime</b><p>Pair the phone, approve it, then select apps inside Rub Minds Companion.</p>
              </div>}
              <div className="br-cloud-phone-home"/>
            </div> : <div className="br-cloud-unavailable">
              {surface === 'desktop' ? <Laptop size={35}/> : <SquareTerminal size={35}/>}
              <b>{surface === 'desktop' ? 'Desktop runtime not connected' : 'Terminal runtime not connected'}</b>
              <p>{surface === 'desktop' ? 'The desktop Device Frame will use the same cloud device contract. A Windows/macOS runtime and native window driver are not shipped in this slice.' : 'The terminal surface will use an isolated session runtime. No raw phone shell or localhost command bridge is enabled.'}</p>
            </div>}
          </div>

          <div className="br-cloud-capabilities">
            <div><b>Current phone capabilities</b><span>Available in the current companion build</span></div>
            <div className="br-cloud-capability-row"><span>Launcher-visible app discovery</span><b className="ready">Available</b></div>
            <div className="br-cloud-capability-row"><span>Separate app data / virtualization</span><b>Not available</b></div>
            <div className="br-cloud-capability-row"><span>Live screen and touch control</span><b>Not available</b></div>
            <div className="br-cloud-capability-row"><span>AI-directed device actions</span><b>Not available</b></div>
          </div>
        </div>
      </section>

      <section className="br-cloud-activity">
        <div className="br-cloud-panel-head"><div><span className="br-cloud-eyebrow">GROUP ACTIVITY</span><h2>Device history</h2></div><span className="br-cloud-count">{events.length}</span></div>
        {events.length ? events.map(event => {
          const meta = eventLabel(event);
          return <div className="br-cloud-event" key={event.id}><Activity size={16}/><div><b>{meta.actor}</b><span>{meta.action}{meta.app}</span></div><time>{formatTime(event.created_at)}</time></div>;
        }) : <p className="br-cloud-no-events">Pairing, approval and selected-app activity will appear here. Remote AI actions are not yet enabled.</p>}
      </section>
    </>}
    <footer className="br-cloud-footer"><LockKeyhole size={14}/> Private device credentials · Outbound HTTPS only · No local port listener · No automatic access to private app data</footer>
  </main>;
}
