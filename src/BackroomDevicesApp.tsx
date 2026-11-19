import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Check, ChevronDown, CircleAlert, Copy,
  LockKeyhole, Monitor, RefreshCw, ShieldCheck, Smartphone, X,
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

type Surface = 'phone' | 'desktop';
const surfaceLabels: Record<Surface, string> = {
  phone: 'Android phone', desktop: 'Computer',
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
  const activePhones = useMemo(() => activeDevices.filter(device => device.platform === 'android'), [activeDevices]);
  const activeDevice = activePhones.find(device => device.device_id === selectedDeviceId) ?? activePhones[0];
  const canManageDevices = Boolean(selectedRoom && userId && selectedRoom.owner_id === userId);

  useEffect(() => {
    if (!activePhones.some(device => device.device_id === selectedDeviceId)) {
      setSelectedDeviceId(activePhones[0]?.device_id ?? '');
    }
  }, [activePhones, selectedDeviceId]);

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
    if (!window.confirm('Revoke this device? It will lose access to this Rub Minds group.')) return;
    setBusy(true); setError(''); setNotice('');
    try { await revokeBackroomDevice(deviceId, roomId); await refresh(); setNotice('Device revoked.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Device revocation failed.'); }
    finally { setBusy(false); }
  }

  return <main className="br-cloud-shell">
    <header className="br-cloud-header">
      <div className="br-cloud-brand"><div className="br-cloud-mark"><Smartphone size={21}/></div><div><b>Backroom</b><small>Device frames</small></div></div>
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
      <div><span className="br-cloud-eyebrow">RUB MINDS · LIVE DEVICES</span><h1>Your devices, live.</h1><p>Open the real screen of a paired phone or computer. Choose an app, request the control you need, and keep every action tied to this group.</p></div>
      <div className="br-cloud-security"><ShieldCheck size={19}/><span>Owner approval required<br/><small>Pairing codes are one-use and expire in 5 minutes.</small></span></div>
    </section>

    {!selectedRoom ? <section className="br-cloud-empty"><Smartphone size={32}/><h2>Create or join a group first</h2><p>Backroom devices are scoped to a Rub Minds group.</p><a className="br-cloud-primary" href="/">Open Rub Minds groups</a></section> : <>
      <section className="br-cloud-layout">
        <div className="br-cloud-sidebar">
          <div className="br-cloud-panel-head"><div><span className="br-cloud-eyebrow">YOUR DEVICES</span><h2>Device connections</h2></div><span className="br-cloud-count">{devices.length}</span></div>
          {canManageDevices
            ? <button className="br-cloud-primary" disabled={busy} onClick={() => void createPairing()}><Smartphone size={17}/> Pair Android phone</button>
            : <p className="br-cloud-help">Only the group owner can pair, approve or revoke devices. Group members can view the device frames and activity history.</p>}
          {pairCode ? <div className="br-cloud-pair-card">
            <b>One-use pairing code</b>
            <code>{pairCode}</code>
            <button onClick={() => void copyPairCode()}><Copy size={15}/> Copy code</button>
            <small>Enter this code in Rub Minds Companion on the phone. Expires {formatTime(pairExpires)}.</small>
          </div> : null}
          {devices.length ? devices.map(device => <article className="br-cloud-device" key={device.device_id}>
            <div className="br-cloud-device-icon">{device.platform === 'android' ? <Smartphone size={19}/> : <Monitor size={19}/>}</div>
            <div className="br-cloud-device-copy"><b>{device.device_label}</b><small>{device.platform === 'android' ? 'Android phone' : device.platform + ' computer'} · {device.os_version || 'version unknown'}</small><span className={'br-cloud-status ' + device.status}>{device.status}</span></div>
            <div className="br-cloud-device-actions">
              {canManageDevices && device.status === 'pending' ? <button disabled={busy} onClick={() => void approve(device.device_id)}>Approve</button> : null}
              {canManageDevices && device.status !== 'revoked' ? <button className="danger" disabled={busy} onClick={() => void revoke(device.device_id)}>Revoke</button> : null}
            </div>
          </article>) : <div className="br-cloud-empty-mini"><Smartphone size={24}/><b>No devices paired</b><span>Ask the group owner to pair a device and approve its connection.</span></div>}
          <button className="br-cloud-link" onClick={() => setShowHelp(value => !value)}><LockKeyhole size={15}/> {showHelp ? 'Hide connection details' : 'How device pairing works'} <ChevronDown size={14}/></button>
          {showHelp ? <p className="br-cloud-help">The phone creates a private device credential locally and sends only its digest to the cloud. The pairing code is single-use. A device remains pending until you approve it here. Revoke stops future device API access.</p> : null}
        </div>

        <div className="br-cloud-stage-panel">
          <div className="br-cloud-surface-tabs">
            {(['phone','desktop'] as Surface[]).map(id => <button key={id} className={surface === id ? 'active' : ''} aria-pressed={surface === id} onClick={() => setSurface(id)}>
              {id === 'phone' ? <Smartphone size={16}/> : <Monitor size={16}/>} {surfaceLabels[id]}
            </button>)}
            {surface === 'phone' && activePhones.length > 1 ? <label className="br-cloud-device-picker">
              <span>Phone</span>
              <select aria-label="Select Android phone" value={activeDevice?.device_id ?? ''} onChange={event => setSelectedDeviceId(event.target.value)}>
                {activePhones.map(device => <option key={device.device_id} value={device.device_id}>{device.device_label}</option>)}
              </select>
            </label> : null}
            <span className="br-cloud-stage-hint">{surface === 'phone' ? 'Original Android app screen' : 'Original computer screen and terminal'}</span>
          </div>
          <div className={'br-cloud-device-frame ' + surface}>
            {surface === 'phone' ? activeDevice
              ? <BackroomAndroidControl device={activeDevice} roomId={roomId}/>
              : <div className="br-cloud-frame-empty">
                  <Smartphone size={34}/><b>No approved Android phone</b>
                  <p>Pair an Android phone, approve it, then open the selected app from the phone frame.</p>
                  {canManageDevices ? <button className="br-cloud-primary" disabled={busy} onClick={() => void createPairing()}>Pair Android phone</button> : null}
                </div>
              : <BackroomDesktopControl roomId={roomId}/>}
          </div>
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
    <footer className="br-cloud-footer"><LockKeyhole size={14}/> Device-scoped access · Separate control approval · Drafts stay unsent until explicitly submitted</footer>
  </main>;
}
