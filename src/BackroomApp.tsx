import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, CircleHelp, Command, Cpu, ExternalLink, Laptop, Layers3, Monitor, MousePointer2, Plus, ShieldCheck, Smartphone, SquareTerminal, Trash2, WifiOff, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { listCloudMessages, listCloudRooms, subscribeToCloudMessages, type CloudMessage, type CloudRoom } from './cloudRooms';
import './backroom.css';

type Surface = 'browser_tab' | 'desktop_app' | 'windows_app' | 'terminal' | 'android_app';
type Space = { id: string; name: string; surface: Surface; app: string; createdAt: number };
type Rect = { x: number; y: number; width: number; height: number };
type HostStatus = { hostId: string; label: string; expiresAt: number; protocolVersion: string; connected: boolean; executionReady: boolean; capabilities: Record<string, boolean>; nextStep: string; browserPages?: number; enrollmentDigest?: string };
type BrowserPageRow = { pageId: string; title: string; site: string; canSelect: boolean };
type BrowserTargetRow = { id: string; pageId: string; roomId: string; title: string; site: string; surface: string; operations: string[]; wakeAvailable?: boolean; spaceId?: string; sessionId?: string; identityFingerprint?: string; revision?: number; locatorKind?: string; locatorValue?: string };
type HostedAiSession = { participantId: string; displayName: string; sessionDigest: string; expiresAt: string };
type HostedWakeBinding = { bindingId: string; roomId: string; participantId: string; sessionId: string; targetId: string; sessionDigest: string; wakeEnabled?: boolean; requiresRevoke?: boolean };
type PendingBrowserSelection = { pageId: string; roomId: string; generation: number; attemptId: string | null };
const surfaces: { id: Surface; name: string; detail: string }[] = [
  { id: 'browser_tab', name: 'Browser session', detail: 'ChatGPT, Claude and other browser conversations' },
  { id: 'desktop_app', name: 'Desktop AI app', detail: 'Native Claude, ChatGPT or other desktop applications' },
  { id: 'windows_app', name: 'Windows application', detail: 'Installed apps and desktop windows' },
  { id: 'terminal', name: 'Terminal', detail: 'Named shell or AI coding terminal session' },
  { id: 'android_app', name: 'Android phone app', detail: 'Native ChatGPT, Claude and other mobile apps' },
];
const iconFor = (s: Surface) => s === 'android_app' ? Smartphone : s === 'terminal' ? SquareTerminal : s === 'browser_tab' ? Monitor : s === 'windows_app' ? Laptop : Bot;
const randomId = () => crypto.randomUUID();
const clamp = (n: number) => Math.min(100, Math.max(0, n));
const hostCapabilityKeys = ['browserDraft', 'desktopAccessibility', 'androidAccessibility', 'terminal'] as const;
class HostStatusValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'HostStatusValidationError'; }
}
function parseHostStatus(value: unknown, expectedHostId?: string): HostStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostStatusValidationError('Local host returned an invalid status document.');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.hostId !== 'string' || !row.hostId ||
    (expectedHostId !== undefined && row.hostId !== expectedHostId)) {
    throw new HostStatusValidationError('Local host identity changed. Verify the host terminal and pair with the intended host again.');
  }
  if (row.protocolVersion !== '1') throw new HostStatusValidationError('Unsupported local host protocol. Restart/update the local host before pairing.');
  if (row.connected !== true || typeof row.label !== 'string' || !row.label ||
    typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) ||
    typeof row.executionReady !== 'boolean' || typeof row.nextStep !== 'string') {
    throw new HostStatusValidationError('Local host returned an incomplete or unauthenticated status.');
  }
  if (row.enrollmentDigest !== undefined &&
    (typeof row.enrollmentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.enrollmentDigest))) {
    throw new HostStatusValidationError('Local host supplied an invalid enrollment digest.');
  }
  if (row.browserPages !== undefined &&
    (typeof row.browserPages !== 'number' || !Number.isSafeInteger(row.browserPages) || row.browserPages < 0)) {
    throw new HostStatusValidationError('Local host returned an invalid browser-page count.');
  }
  if (!row.capabilities || typeof row.capabilities !== 'object' || Array.isArray(row.capabilities)) {
    throw new HostStatusValidationError('Local host returned invalid capabilities.');
  }
  const supplied = row.capabilities as Record<string, unknown>;
  const capabilities: Record<string, boolean> = {};
  for (const key of hostCapabilityKeys) {
    if (typeof supplied[key] !== 'boolean') throw new HostStatusValidationError('Local host returned an invalid capability flag.');
    capabilities[key] = supplied[key] as boolean;
  }
  if (row.executionReady !== Object.values(capabilities).some(Boolean)) {
    throw new HostStatusValidationError('Local host status conflicts with its declared capabilities.');
  }
  return {
    hostId: row.hostId,
    label: row.label,
    expiresAt: row.expiresAt,
    protocolVersion: '1',
    connected: true,
    executionReady: row.executionReady,
    capabilities,
    nextStep: row.nextStep,
    ...(typeof row.browserPages === 'number' ? { browserPages: row.browserPages } : {}),
    ...(typeof row.enrollmentDigest === 'string' ? { enrollmentDigest: row.enrollmentDigest } : {}),
  };
}

function Preview({ surface, onSelect, selected }: { surface: Surface; onSelect: (r: Rect) => void; selected: Rect | null }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  function coords(e: PointerEvent<HTMLDivElement>) {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: clamp((e.clientX - b.left) / b.width * 100), y: clamp((e.clientY - b.top) / b.height * 100) };
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (!start) return;
    const p = coords(e);
    setDrag({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
  }
  function end(e: PointerEvent<HTMLDivElement>) {
    if (!start) return;
    const p = coords(e);
    const next = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
    if (next.width >= 4 && next.height >= 3) onSelect(next);
    setStart(null); setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  const rect = drag ?? selected;
  return <div className="br-preview" aria-label="Interactive simulated app preview">
    <div className="br-preview-bar"><span className="br-preview-dots"><i/><i/><i/></span><span>{surface === 'android_app' ? 'Android device preview' : surface === 'terminal' ? 'Terminal preview' : 'Application window preview'}</span><span className="br-preview-demo">SIMULATED</span></div>
    <div className="br-preview-body">
      <div className="br-preview-icon"><Bot size={23}/></div>
      <strong>{surface === 'terminal' ? 'AI coding terminal' : 'Your AI workspace'}</strong>
      <p>{surface === 'terminal' ? 'A named terminal session will be connected here.' : 'Your connected application will appear here when a local host is installed.'}</p>
      <div className="br-fake-composer"><span>Type a message or command...</span><ArrowRight size={15}/></div>
    </div>
    <div className="br-drag-layer" onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setStart(coords(e)); setDrag(null); }} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { setStart(null); setDrag(null); }} role="img" aria-label="Drag across this simulated preview to test selection coordinates"/>
    {rect && <div className="br-selection" style={{ left: rect.x + '%', top: rect.y + '%', width: rect.width + '%', height: rect.height + '%' }} />}
  </div>;
}

export default function BackroomApp() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<CloudRoom[]>([]);
  const [groupMessages, setGroupMessages] = useState<CloudMessage[]>([]);
  const [selectedGroupMessageId, setSelectedGroupMessageId] = useState('');
  const [error, setError] = useState('');
  const [hostUrl, setHostUrl] = useState('http://127.0.0.1:43781');
  const [pairingCode, setPairingCode] = useState('');
  const [hostToken, setHostToken] = useState('');
  const [hostInfo, setHostInfo] = useState<HostStatus | null>(null);
  const [hostModal, setHostModal] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostMessage, setHostMessage] = useState('');
  const [hostStopped, setHostStopped] = useState(false);
  const [browserPages, setBrowserPages] = useState<BrowserPageRow[]>([]);
  const [browserTargets, setBrowserTargets] = useState<BrowserTargetRow[]>([]);
  const [selectedBrowserTarget, setSelectedBrowserTarget] = useState('');
  const [browserDraftText, setBrowserDraftText] = useState('@RMConnects: this is a local Backroom draft test. Please acknowledge without sending anything.');
  const [browserUrl, setBrowserUrl] = useState('https://chatgpt.com/');
  const [browserNotice, setBrowserNotice] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [hostedAiSessions,setHostedAiSessions] = useState<HostedAiSession[]>([]);
  const [selectedHostedSession,setSelectedHostedSession] = useState('');
  const [hostedWakeBinding,setHostedWakeBinding] = useState<HostedWakeBinding | null>(null);
  const [hostedWakeGrantId,setHostedWakeGrantId] = useState('');
  const selectionGeneration = useRef(0);
  const activeBrowserSelection = useRef<PendingBrowserSelection | null>(null);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get('room') || '');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [active, setActive] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [app, setApp] = useState('');
  const [surface, setSurface] = useState<Surface>('desktop_app');
  const [selection, setSelection] = useState<Rect | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!hostModal && !adding) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || hostBusy || browserBusy) return;
      if (hostModal) setHostModal(false);
      if (adding) setAdding(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [hostModal, adding, hostBusy, browserBusy]);

  useEffect(() => {
    if (!supabase) { setError('Cloud authentication is not configured.'); setLoading(false); return; }
    let alive = true;
    void supabase.auth.getUser().then(async ({ data, error: authError }) => {
      if (!alive) return;
      if (authError || !data.user) { setError('Sign in to Rub Minds before opening Backroom.'); return; }
      setUser(data.user);
      try {
        const stoppedKey = 'rub-backroom-host-stopped-v1:' + data.user.id;
        const emergencyStopped = sessionStorage.getItem(stoppedKey) === '1';
        setHostStopped(emergencyStopped);
        const savedRaw = sessionStorage.getItem('rub-backroom-host-session-v1:' + data.user.id);
        if (emergencyStopped && savedRaw) sessionStorage.removeItem('rub-backroom-host-session-v1:' + data.user.id);
        if (savedRaw && !emergencyStopped) {
          const saved = JSON.parse(savedRaw) as { origin?: string; sessionToken?: string; info?: HostStatus };
          if (saved.origin && typeof saved.sessionToken === 'string' && /^[a-f0-9]{64}$/i.test(saved.sessionToken) &&
            saved.info && typeof saved.info.hostId === 'string' && typeof saved.info.protocolVersion === 'string' &&
            typeof saved.info.capabilities === 'object' && saved.info.capabilities !== null) {
            const origin = localHostOrigin(saved.origin);
            setHostUrl(origin);
            setHostToken(saved.sessionToken);
            setHostInfo({ ...saved.info, connected: false, executionReady: false, browserPages: 0, capabilities: { ...saved.info.capabilities, browserDraft: false } });
            setHostMessage('Saved host session restored for this tab. Check connection before use.');
          } else sessionStorage.removeItem('rub-backroom-host-session-v1:' + data.user.id);
        }
      } catch { /* Session storage may be unavailable; pairing can still work until this tab reloads. */ }
      const list = await listCloudRooms();
      if (alive) setRooms(list);
    }).catch(() => { if (alive) setError('Could not verify your group access.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const room = rooms.find(r => r.id === roomId);
  useEffect(() => {
    // Never carry a selected source message or target across Rub Minds groups.
    setSelectedBrowserTarget('');
    setSelectedGroupMessageId('');
    setBrowserDraftText('@RMConnects: this is a local Backroom draft test. Please acknowledge without sending anything.');
    setBrowserNotice('');
    // Cancel a pending browser overlay server-side as well; otherwise a selection
    // begun for the previous group could finish after the user changes rooms.
    const pending = activeBrowserSelection.current;
    if (pending && (pending.roomId !== room?.id || !hostToken)) {
      activeBrowserSelection.current = null;
      selectionGeneration.current += 1;
      if (hostToken && pending.attemptId) {
        void hostApi('/v1/browser/select/cancel', {
          method: 'POST', body: { pageId: pending.pageId, roomId: pending.roomId, attemptId: pending.attemptId },
        }).catch(() => {});
      }
      setBrowserNotice('Input selection cancelled because the active group or host session changed.');
    }
  }, [room?.id, hostToken]);
  useEffect(() => {
    if (!room?.id) { setGroupMessages([]); setSelectedGroupMessageId(''); return; }
    let alive = true;
    const refreshMessages = async () => {
      try {
        const messages = await listCloudMessages(room.id);
        if (alive) setGroupMessages(messages.slice(-60).reverse());
      } catch {
        if (alive) { setGroupMessages([]); setBrowserNotice('Could not read group messages. You can still type a local draft manually.'); }
      }
    };
    void refreshMessages();
    const unsubscribe = subscribeToCloudMessages(room.id, () => { void refreshMessages(); });
    return () => { alive = false; unsubscribe(); };
  }, [room?.id]);
  const storageKey = user && room ? 'rub-backroom-spaces-v1:' + user.id + ':' + room.id : '';
  useEffect(() => {
    setActive(''); setSelection(null); setSpaces([]);
    if (!storageKey) return;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(value)) setSpaces(value.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string' && surfaces.some(t => t.id === s.surface)).slice(0, 30));
    } catch { setNotice('Local space layout could not be restored.'); }
  }, [storageKey]);
  function save(next: Space[]) {
    setSpaces(next);
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { setNotice('Browser storage unavailable. This layout will not persist.'); }
    }
  }
  const current = spaces.find(s => s.id === active);
  const roomBrowserTargets = browserTargets.filter(target => target.roomId === room?.id);
  function supportsLoopbackNetworkRequests() {
    // Feature-detect the browser API instead of assuming every embedded WebView
    // implements RequestInit.targetAddressSpace. Creating this Request does not
    // contact localhost or grant permission; the following fetch still prompts.
    try {
      const probe = new Request('http://127.0.0.1/', {
        mode: 'cors', targetAddressSpace: 'loopback',
      } as RequestInit & { targetAddressSpace: 'loopback' });
      return (probe as Request & { targetAddressSpace?: string }).targetAddressSpace === 'loopback';
    } catch { return false; }
  }
  function fetchLocalHost(url: string, init: RequestInit = {}) {
    // Local Network Access is permission-gated in supported Chromium builds.
    // Don't mislabel unsupported browsers as an offline host.
    if (!supportsLoopbackNetworkRequests()) {
      throw new Error('This browser does not support the loopback permission signal needed by Rub Minds. Use current desktop Chrome or Edge; Firefox, Safari and some embedded WebViews may block this connection.');
    }
    return fetch(url, { ...init, targetAddressSpace: 'loopback' } as RequestInit & { targetAddressSpace: 'loopback' });
  }
  function localHostOrigin(value: string) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !parsed.port || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) ||
      parsed.search || parsed.hash) throw new Error('Use the local host address, such as http://127.0.0.1:43781.');
    return parsed.origin;
  }
  async function pairLocalHost() {
    setHostBusy(true); setHostMessage('');
    try {
      const origin = localHostOrigin(hostUrl.trim());
      const healthResponse = await fetchLocalHost(origin + '/health', { cache: 'no-store' });
      const health = await healthResponse.json().catch(() => ({})) as { status?: string; protocolVersion?: string };
      if (health.status === 'stopped') throw new Error('Emergency stop is latched on this host. Stop and restart the local host process before pairing again.');
      if (!healthResponse.ok) throw new Error('Local host health check failed.');
      if (health.status !== 'ok' || health.protocolVersion !== '1') throw new Error('Unsupported local host protocol.');
      const pairResponse = await fetchLocalHost(origin + '/v1/pair', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: pairingCode.trim(), clientLabel: 'Rub Minds Backroom' }),
      });
      if (!pairResponse.ok) throw new Error(pairResponse.status === 403
        ? 'This web origin is not allowed by the local host. Check BACKROOM_ALLOWED_ORIGINS.'
        : 'Pairing failed. Check the one-time code and make sure the host has not already been paired.');
      const credentials = await pairResponse.json() as { sessionToken?: string; hostId?: string; expiresAt?: number; protocolVersion?: string };
      if (!credentials.sessionToken || !credentials.hostId || credentials.protocolVersion !== '1') throw new Error('Local host returned an incomplete pairing response.');
      const infoResponse = await fetchLocalHost(origin + '/v1/host', {
        headers: { Authorization: 'Bearer ' + credentials.sessionToken }, cache: 'no-store',
      });
      if (!infoResponse.ok) throw new Error('Host paired, but its status could not be verified. Restart host and pair again.');
      const info = parseHostStatus(await infoResponse.json(), credentials.hostId);
      if (hostInfo?.hostId !== info.hostId) {
        setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      }
      setHostUrl(origin); setHostToken(credentials.sessionToken); setHostInfo(info); setHostStopped(false);
      try { sessionStorage.removeItem('rub-backroom-host-stopped-v1:' + user?.id); } catch {}
      try {
        sessionStorage.setItem('rub-backroom-host-session-v1:' + user?.id, JSON.stringify({
          origin, sessionToken: credentials.sessionToken, info,
        }));
      } catch { /* Keep the token in memory; pairing remains active for this page. */ }
      setPairingCode(''); setHostMessage('Host paired. Launch the managed browser for the available draft-only path; native and terminal drivers are unavailable.');
    } catch (e) {
      const message = e instanceof TypeError
        ? 'The browser could not reach the local host. Start it on this same computer, allow local-network access if prompted, and retry in current Chrome or Edge if this embedded browser blocks loopback requests.'
        : e instanceof Error ? e.message : 'Pairing failed.';
      setHostMessage(message);
    } finally { setHostBusy(false); }
  }
  async function registerHostedWakeHost() {
    if (!supabase || !user || !hostInfo?.connected || !hostInfo.enrollmentDigest) {
      setHostMessage('Pair a current Backroom host that exposes a valid enrollment digest first.');
      return;
    }
    if (!window.confirm('Register this local Backroom host with your Rub Minds account? This does NOT enable AI wake or submit any prompts.')) return;
    setHostBusy(true);
    try {
      const {data,error:registrationError}=await supabase.functions.invoke('backroom-config/host',{
        body:{hostId:hostInfo.hostId,credentialDigest:hostInfo.enrollmentDigest,ttlSeconds:86400}
      });
      if(registrationError || data?.ok!==true)throw new Error(
        data?.reason==='registration_conflict'
          ? 'This host is already registered. Its existing registration remains unchanged.'
          : 'Hosted host registration failed. No wake automation was activated.'
      );
      setHostMessage(data.renewed===true
        ? 'Host registration renewed. Existing binding consent was not changed; any new binding still requires a separate explicit wake confirmation.'
        : 'Hosted Backroom host registered. New input bindings remain disabled until you explicitly confirm wake.');
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Hosted registration unavailable.');
    }finally{setHostBusy(false);}
  }

  async function revokeHostedWakeBinding() {
    const binding=hostedWakeBinding;
    if(!supabase||!user||!binding)return;
    if(!window.confirm('Permanently revoke this AI input binding? Its pending and leased wake events will be cancelled. The host remains registered, but this input must be selected and bound again before wake can be enabled.'))return;
    setHostBusy(true);
    try{
      // Stop the local worker first where reachable. Server-side binding revoke
      // remains authoritative if the computer is offline or the browser lost its grant ID.
      try{if(hostToken)await hostApi('/v1/browser/wake/bindings/revoke',{method:'POST',body:{bindingId:binding.bindingId}});}catch{}
      const {data,error:revokeError}=await supabase.functions.invoke('backroom-config/revoke-binding',{
        body:{bindingId:binding.bindingId}
      });
      if(revokeError||data?.ok!==true||data?.revoked!==true)
        throw new Error('Input binding was not revoked. Check ownership and retry.');
      setHostedWakeBinding(null);
      setHostedWakeGrantId('');
      setHostMessage('AI input binding revoked on the server; its pending wakes were cancelled. Select the intended composer and bind it again.');
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Input binding revocation failed.');
    }finally{setHostBusy(false);}
  }

  async function revokeHostedWakeHost() {
    if (!supabase || !user || !hostInfo?.hostId) return;
    if (!window.confirm('Permanently revoke this host on the Rub Minds server? All its input bindings and queued wakes will be disabled. This host identity cannot be reused.')) return;
    setHostBusy(true);
    try {
      const {data,error:revokeError}=await supabase.functions.invoke('backroom-config/revoke-host',{
        body:{hostId:hostInfo.hostId}
      });
      if(revokeError || data?.ok!==true || data?.revoked!==true)
        throw new Error('Remote host was not revoked. Verify that it was registered to this signed-in owner.');
      // Best-effort local unpair: remote revocation already makes all future claims fail
      // even if this device is offline, but a reachable host should stop polling now.
      try {
        if(hostToken) await fetchLocalHost(localHostOrigin(hostUrl)+'/v1/unpair',{
          method:'POST',headers:{Authorization:'Bearer '+hostToken},cache:'no-store'
        });
      } catch {}
      try {
        sessionStorage.removeItem('rub-backroom-host-session-v1:'+user.id);
        sessionStorage.removeItem('rub-backroom-host-stopped-v1:'+user.id);
      } catch {}
      setHostToken('');setHostInfo(null);
      setBrowserPages([]);setBrowserTargets([]);setSelectedBrowserTarget('');
      setHostedAiSessions([]);setSelectedHostedSession('');
      setHostedWakeBinding(null);setHostedWakeGrantId('');
      setHostMessage('Remote host, all input bindings and queued wakes have been revoked. To reuse this computer, stop the Backroom host with Ctrl+C, run `npm run backroom:rotate-host`, then restart and pair the new host ID.');
    } catch(error) {
      setHostMessage(error instanceof Error?error.message:'Remote host revocation failed.');
    } finally {setHostBusy(false);}
  }

  async function discoverHostedAiSessions() {
    if (!supabase || !room?.id || !user) return;
    setHostBusy(true);
    try {
      const {data,error:discoveryError}=await supabase.functions.invoke('backroom-config/sessions',{
        body:{roomId:room.id}
      });
      if(discoveryError || data?.ok!==true || !Array.isArray(data.sessions))
        throw new Error('Could not list authorized joined AI sessions for this group.');
      const sessions=data.sessions.filter((v:unknown)=>{
        if(!v||typeof v!=='object'||Array.isArray(v))return false;
        const x=v as Record<string,unknown>;
        return typeof x.participantId==='string'&&typeof x.displayName==='string'&&
          typeof x.sessionDigest==='string'&&/^[a-f0-9]{64}$/.test(x.sessionDigest);
      }) as HostedAiSession[];
      setHostedAiSessions(sessions);
      setSelectedHostedSession(sessions[0]?.sessionDigest??'');
      setHostMessage(sessions.length+' authorized live AI session(s) found. Select the intended original AI conversation.');
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'AI session discovery failed.');
    }finally{setHostBusy(false);}
  }
  async function bindHostedWakeInput() {
    if (!supabase || !room?.id || !hostInfo?.connected || !hostToken) return;
    const selectedSession=hostedAiSessions.find(s=>s.sessionDigest===selectedHostedSession);
    const target=browserTargets.find(t=>t.id===selectedBrowserTarget);
    if(!selectedSession||!target||target.roomId!==room.id||target.wakeAvailable!==true||
       !target.spaceId||!target.sessionId||!target.identityFingerprint||
       !target.revision||target.locatorKind!=='dom'||!target.locatorValue){
      setHostMessage('Select one live joined AI session and a wake-capable browser composer in the same group.');
      return;
    }
    setHostBusy(true);
    let pendingNewBindingId: string | null = null;
    try {
      // Ensure registration exists or renew the same owner/credential before
      // creating a binding; registration itself never enables wake.
      const {data:registration,error:registrationError}=await supabase.functions.invoke('backroom-config/host',{
        body:{hostId:hostInfo.hostId,credentialDigest:hostInfo.enrollmentDigest,ttlSeconds:86400}
      });
      if(registrationError || registration?.ok!==true)
        throw new Error('Could not renew this signed-in owner host registration.');
      const {data:rawBindingData,error:bindingError}=await supabase.functions.invoke('backroom-config/binding',{
        body:{
          roomId:room.id,participantId:selectedSession.participantId,
          hostId:hostInfo.hostId,sessionDigest:selectedSession.sessionDigest,
          spaceId:target.spaceId,sessionId:target.sessionId,
          targetId:target.id,targetIdentityFingerprint:target.identityFingerprint,
          targetRevision:target.revision,surface:'browser_tab',
          locatorKind:target.locatorKind,locatorValue:target.locatorValue,
          participationMode:'mentions',maxWakesPerMinute:6
        }
      });
      let data=rawBindingData as {ok?:boolean;bindingId?:string;reason?:string;wakeEnabled?:boolean;requiresHostRevoke?:boolean;existing?:boolean}|null;
      // Supabase's invoke helper exposes non-2xx JSON through FunctionsHttpError.context.
      // Read that response so an existing-binding conflict can offer its explicit revoke path.
      const responseContext=(bindingError as unknown as {context?:unknown}|null)?.context;
      if(bindingError && responseContext instanceof Response){
        const errorBody=await responseContext.clone().json().catch(()=>null);
        if(errorBody&&typeof errorBody==='object')data=errorBody as typeof data;
      }
      if(bindingError || data?.ok!==true || typeof data.bindingId!=='string'){
        if(typeof data?.bindingId==='string'&&
          (data.reason==='existing_binding_active_revoke_first'||data.reason==='existing_binding_requires_revoke')){
          setHostedWakeBinding({
            bindingId:data.bindingId,roomId:room.id,
            participantId:selectedSession.participantId,sessionId:target.sessionId,
            targetId:target.id,sessionDigest:selectedSession.sessionDigest,
            wakeEnabled:data.wakeEnabled===true,requiresRevoke:true
          });
          setHostedWakeGrantId('');
          setHostMessage('An existing hosted binding owns this AI session or composer. Revoke that binding explicitly before rebinding; the old queued wakes will be cancelled.');
          return;
        }
        if(data?.requiresHostRevoke===true)
          throw new Error('This host has conflicting active input bindings. Permanently revoke the host, rotate its identity, then register it again.');
        throw new Error('Secure hosted binding registration failed. No wake operation was enabled.');
      }
      if(data.existing!==true) pendingNewBindingId=data.bindingId;
      // The host's pinned Supabase destination is local configuration. Never let
      // this browser choose where the private host credential is sent.
      const publishableKey=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;
      if(typeof publishableKey!=='string'||publishableKey.length<20)
        throw new Error('Rub Minds public Supabase API key is missing from this web build.');
      await hostApi('/v1/backroom/configure',{method:'POST',body:{
        sessionDigest:selectedSession.sessionDigest,bindingId:data.bindingId,publishableKey
      }});
      pendingNewBindingId=null;
      setHostedWakeBinding({
        bindingId:data.bindingId,roomId:room.id,
        participantId:selectedSession.participantId,sessionId:target.sessionId,
        targetId:target.id,sessionDigest:selectedSession.sessionDigest,
        wakeEnabled:false,requiresRevoke:false
      });
      setHostedWakeGrantId('');
      setHostMessage('AI session bound to the exact selected composer. Wake remains OFF; activate only with your explicit confirmation.');
    }catch(error){
      let cleanupWarning='';
      if(pendingNewBindingId && supabase){
        try{
          const {data:cleanup,error:cleanupError}=await supabase.functions.invoke('backroom-config/revoke-binding',{body:{bindingId:pendingNewBindingId}});
          if(cleanupError || cleanup?.ok!==true || cleanup?.revoked!==true)
            cleanupWarning=' Server cleanup was not confirmed; revoke the orphaned input binding before retrying.';
        }catch{cleanupWarning=' Server cleanup failed; revoke the orphaned input binding before retrying.';}
      }
      setHostMessage((error instanceof Error?error.message:'Could not configure wake binding.')+cleanupWarning);
    }finally{setHostBusy(false);}
  }
  async function enableHostedWake() {
    const binding=hostedWakeBinding;
    if(!binding||binding.roomId!==room?.id||binding.targetId!==selectedBrowserTarget||!hostInfo?.connected)return;
    if(!window.confirm('Enable the selected original AI conversation to receive only canonical @RMconnects event triggers for up to 5 minutes? This may press Send in that selected AI chat.'))return;
    setHostBusy(true);
    try{
      const grant=await hostApi<{grantId:string}>('/v1/browser/wake/grants',{
        method:'POST',body:{
          targetId:binding.targetId,roomId:binding.roomId,
          participantId:binding.participantId,sessionId:binding.sessionId,
          bindingId:binding.bindingId,confirmed:true,ttlMs:300000,maxPerMinute:6
        }
      });
      if(typeof grant.grantId!=='string')throw new Error('Local wake grant was not confirmed.');
      setHostedWakeGrantId(grant.grantId);
      setHostMessage('Wake enabled for this one selected AI input. It expires automatically; use Revoke wake to stop earlier.');
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Wake activation failed and must be retried with consent.');
    }finally{setHostBusy(false);}
  }
  async function revokeHostedWake() {
    const binding=hostedWakeBinding;
    if(!binding||!hostedWakeGrantId)return;
    setHostBusy(true);
    try{
      const result=await hostApi<{
        revoked:boolean;localPollingStopped:boolean;
        remoteDeactivationConfirmed?:boolean;remoteDeactivationPending?:boolean
      }>('/v1/browser/wake/grants/revoke',{method:'POST',body:{
        grantId:hostedWakeGrantId,targetId:binding.targetId,roomId:binding.roomId,bindingId:binding.bindingId
      }});
      if(result.revoked!==true || result.localPollingStopped!==true)
        throw new Error('The local wake grant could not be confirmed revoked.');
      setHostedWakeGrantId('');
      setHostedWakeBinding(previous=>previous?{...previous,wakeEnabled:false}:previous);
      setHostMessage(result.remoteDeactivationConfirmed===true
        ? 'Wake grant revoked; local polling stopped and hosted consent deactivation confirmed.'
        : 'Wake grant revoked locally and polling stopped, but the server did not confirm remote deactivation. The old consent expires within 5 minutes. For immediate server-side cancellation, revoke this input binding.');

    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Could not confirm wake revocation. Use Emergency Stop.');
    }finally{setHostBusy(false);}
  }

  async function checkLocalHost() {
    if (!hostToken) return;
    setHostBusy(true); setHostMessage('');
    try {
      const response = await fetchLocalHost(localHostOrigin(hostUrl) + '/v1/host', {
        headers: { Authorization: 'Bearer ' + hostToken }, cache: 'no-store',
      });
      if (!response.ok) {
        try { sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id); } catch {}
        setHostToken(''); setHostInfo(null);
        setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
        setHostMessage('Host session expired or was revoked. Restart the local host to generate a fresh pairing code.');
        return;
      }
      const info = parseHostStatus(await response.json(), hostInfo?.hostId);
      setHostInfo(info);
      try { sessionStorage.setItem('rub-backroom-host-session-v1:' + user?.id, JSON.stringify({ origin: localHostOrigin(hostUrl), sessionToken: hostToken, info })); } catch {}
      setHostMessage(info.capabilities.browserDraft ? 'Host is reachable. Browser draft insertion is active; native and terminal drivers remain unavailable.' : 'Host is reachable. Launch the managed browser to enable draft-only browser input; native and terminal drivers remain unavailable.');
    } catch (e) {
      // A malformed status or host identity change is not a transient network
      // failure. Drop the cached bearer and require a fresh pairing rather than
      // continue sending a token to a different local process.
      if (e instanceof HostStatusValidationError) {
        try { sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id); } catch {}
        setHostToken(''); setHostInfo(null);
      } else {
        // A stale "browserDraft: true" must never leave an offline host looking
        // executable. Keep the token for an explicit retry, but clear all targets.
        setHostInfo(previous => previous ? {
          ...previous, connected: false, executionReady: false, browserPages: 0,
          capabilities: { ...previous.capabilities, browserDraft: false },
        } : previous);
      }
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      setHostMessage(e instanceof Error ? e.message : 'Host status check failed.');
    } finally { setHostBusy(false); }
  }
  async function emergencyStopLocalHost() {
    if (!hostToken || !hostInfo || hostBusy || browserBusy) return;
    if (!window.confirm(
      'EMERGENCY STOP: Close the managed browser, revoke every paired host session, and block new pairing until the local host process is restarted? Any open AI drafts will remain unsent.'
    )) return;
    setHostBusy(true); setHostMessage('');
    try {
      const response = await fetchLocalHost(localHostOrigin(hostUrl) + '/v1/host/stop', {
        method: 'POST', headers: { Authorization: 'Bearer ' + hostToken }, cache: 'no-store',
      });
      const result = await response.json().catch(() => ({})) as {
        stopped?: boolean; browserClosed?: boolean; sessionsRevoked?: boolean; restartRequired?: boolean; hint?: string; error?: string;
      };
      if (!response.ok || result.stopped !== true) {
        throw new Error(result.hint || 'Emergency stop could not be confirmed. Stop the local host process with Ctrl+C and close any remaining browser windows.');
      }
      try {
        sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id);
        sessionStorage.setItem('rub-backroom-host-stopped-v1:' + user?.id, '1');
      } catch {}
      setHostToken(''); setHostInfo(null); setHostStopped(true);
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      activeBrowserSelection.current = null;
      selectionGeneration.current += 1;
      setBrowserNotice('');
      setHostModal(false);
      setNotice('Emergency stop confirmed. The managed browser is closed, paired sessions are revoked, and new pairing is blocked until the local host process is restarted.');
    } catch (e) {
      setHostMessage(e instanceof Error ? e.message : 'Emergency stop failed.');
    } finally { setHostBusy(false); }
  }
  async function unpairLocalHost() {
    if (!hostToken) return;
    setHostBusy(true); setHostMessage('');
    try {
      const response = await fetchLocalHost(localHostOrigin(hostUrl) + '/v1/unpair', {
        method: 'POST', headers: { Authorization: 'Bearer ' + hostToken }, cache: 'no-store',
      });
      if (!response.ok) throw new Error('Could not revoke the host session. Keep this tab open and retry.');
      try { sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id); } catch {}
      setHostToken(''); setHostInfo(null);
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      setHostMessage('Host session revoked.');
      setHostModal(false);
    } catch (e) {
      setHostMessage(e instanceof Error ? e.message : 'Could not unpair host.');
    } finally { setHostBusy(false); }
  }
  async function hostApi<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!hostToken) throw new Error('Pair the local host first.');
    const headers: Record<string, string> = { Authorization: 'Bearer ' + hostToken };
    const init: RequestInit = { method: options.method || 'GET', headers, cache: 'no-store' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetchLocalHost(localHostOrigin(hostUrl) + path, init);
    } catch (error) {
      setHostInfo(previous => previous ? {
        ...previous, connected: false, executionReady: false, browserPages: 0,
        capabilities: { ...previous.capabilities, browserDraft: false },
      } : previous);
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      if (error instanceof Error && error.message.startsWith('This browser does not support the loopback permission signal')) throw error;
      throw new Error('Could not reach the local host. Allow Rub Minds loopback/local-network access in your browser and verify the host is running on this same device.');
    }
    const payload = await response.json().catch(() => ({})) as { error?: string; message?: string; hint?: string };
    if (!response.ok) {
      if (payload.error === 'host_session_invalid') {
        setHostToken('');
        setHostInfo(null);
        setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
        try { sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id); } catch {}
      }
      throw new Error(payload.hint || payload.message ||
        (payload.error === 'host_session_invalid' ? 'Host pairing expired; restart the host and pair again.' :
         payload.error === 'browser_runtime_unavailable' ? 'Playwright Chromium is not installed on this computer.' :
         'Local host request failed (' + response.status + ').'));
    }
    return payload as T;
  }
  async function refreshBrowserInventory() {
    setBrowserBusy(true); setBrowserNotice('');
    try {
      const [runtimeStatus, pageResult, targetResult] = await Promise.all([
        hostApi<{ running: boolean; pages: number; capabilities: Record<string, boolean> }>('/v1/browser/status'),
        hostApi<{ pages: BrowserPageRow[] }>('/v1/browser/pages'),
        hostApi<{ targets: BrowserTargetRow[] }>('/v1/browser/targets'),
      ]);
      if (typeof runtimeStatus.running !== 'boolean' || !Number.isSafeInteger(runtimeStatus.pages) ||
        runtimeStatus.pages < 0 || !runtimeStatus.capabilities ||
        hostCapabilityKeys.some(key => typeof runtimeStatus.capabilities[key] !== 'boolean')) {
        throw new Error('Local host returned invalid browser runtime status.');
      }
      const capabilities = { ...runtimeStatus.capabilities, browserDraft: runtimeStatus.running && runtimeStatus.capabilities.browserDraft };
      setHostInfo(previous => previous ? {
        ...previous, executionReady: Object.values(capabilities).some(Boolean),
        capabilities, browserPages: runtimeStatus.pages,
      } : previous);
      setBrowserPages(pageResult.pages);
      setBrowserTargets(targetResult.targets);
      if (selectedBrowserTarget && !targetResult.targets.some(t => t.id === selectedBrowserTarget && t.roomId === room?.id)) setSelectedBrowserTarget('');
      setBrowserNotice(!runtimeStatus.running
        ? 'Managed browser is stopped. Launch it before opening or selecting an AI composer.'
        : pageResult.pages.length
          ? 'Managed browser is ready. Choose a tab to register its typing area.'
          : 'No web conversation is open yet. Open a supported HTTPS page in the managed browser, then refresh tabs.');
    } catch (e) { setBrowserNotice(e instanceof Error ? e.message : 'Could not read managed browser tabs.'); }
    finally { setBrowserBusy(false); }
  }
  async function startManagedBrowser() {
    setBrowserBusy(true); setBrowserNotice('');
    try {
      const status = await hostApi<{ running: boolean }>('/v1/browser/start', { method: 'POST' });
      if (!status.running) throw new Error('Managed browser did not start.');
      setHostInfo(previous => previous ? { ...previous, executionReady: true, capabilities: { ...previous.capabilities, browserDraft: true } } : previous);
      setBrowserNotice('Managed browser opened. Sign in to ChatGPT or Claude yourself, then open a conversation.');
      const [pageResult, targetResult] = await Promise.all([
        hostApi<{ pages: BrowserPageRow[] }>('/v1/browser/pages'),
        hostApi<{ targets: BrowserTargetRow[] }>('/v1/browser/targets'),
      ]);
      setBrowserPages(pageResult.pages);
      setBrowserTargets(targetResult.targets);
      if (selectedBrowserTarget && !targetResult.targets.some(t => t.id === selectedBrowserTarget && t.roomId === room?.id)) {
        setSelectedBrowserTarget('');
      }
      void checkLocalHost();
    } catch (e) {
      setBrowserNotice(e instanceof Error ? e.message : 'Could not start the managed browser. Install Chromium with npx playwright install chromium.');
    } finally { setBrowserBusy(false); }
  }
  async function openManagedUrl() {
    if (!browserUrl.trim()) return;
    setBrowserBusy(true); setBrowserNotice('');
    try {
      const page = await hostApi<BrowserPageRow>('/v1/browser/open', { method: 'POST', body: { url: browserUrl.trim() } });
      setBrowserPages(previous => [page, ...previous.filter(existing => existing.pageId !== page.pageId)]);
      setBrowserUrl('https://claude.ai/new');
      setBrowserNotice('Website opened in the dedicated browser. Sign in yourself, then open the conversation you want to use.');
    } catch (e) { setBrowserNotice(e instanceof Error ? e.message : 'Could not open this website.'); }
    finally { setBrowserBusy(false); }
  }
  async function stopManagedBrowser() {
    if (!window.confirm('Close the managed browser and all its open tabs? Unsent drafts could be lost.')) return;
    setBrowserBusy(true); setBrowserNotice('');
    try {
      await hostApi('/v1/browser/stop', { method: 'POST' });
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      setHostInfo(previous => previous ? { ...previous, executionReady: false, capabilities: { ...previous.capabilities, browserDraft: false }, browserPages: 0 } : previous);
      setBrowserNotice('Managed browser closed. Its local profile remains on this computer.');
    } catch (e) { setBrowserNotice(e instanceof Error ? e.message : 'Could not stop the managed browser.'); }
    finally { setBrowserBusy(false); }
  }
  async function registerBrowserInput(pageId: string) {
    const selectedRoomId = room?.id;
    if (!selectedRoomId) { setBrowserNotice('Select a Rub Minds group before registering a typing area.'); return; }
    const generation = ++selectionGeneration.current;
    activeBrowserSelection.current = { pageId, roomId: selectedRoomId, generation, attemptId: null };
    let selectionAttemptId: string | null = null;
    const isCurrentSelection = () =>
      selectionGeneration.current === generation &&
      activeBrowserSelection.current?.generation === generation &&
      activeBrowserSelection.current?.pageId === pageId &&
      activeBrowserSelection.current?.roomId === selectedRoomId;
    const cancelServerSelection = async () => {
      // Cancellation must name the attempt started by this invocation, so a
      // delayed request cannot cancel a newer selection in the same room.
      if (!selectionAttemptId) return;
      try {
        await hostApi('/v1/browser/select/cancel', {
          method: 'POST', body: { pageId, roomId: selectedRoomId, attemptId: selectionAttemptId },
        });
      } catch { /* Host loss and group changes still cancel the local polling loop. */ }
    };
    setBrowserBusy(true); setBrowserNotice('Selection started. Switch to the managed browser and drag a rectangle around exactly one text input. Press Escape to cancel.');
    try {
      const started = await hostApi<{ state: string; selectionAttemptId?: string }>(
        '/v1/browser/select', { method: 'POST', body: { pageId, roomId: selectedRoomId } },
      );
      if (typeof started.selectionAttemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(started.selectionAttemptId)) {
        throw new Error('Local host returned an invalid selection attempt ID. Restart the host before retrying.');
      }
      const currentAttemptId = started.selectionAttemptId;
      selectionAttemptId = currentAttemptId;
      if (isCurrentSelection() && activeBrowserSelection.current) {
        activeBrowserSelection.current = { ...activeBrowserSelection.current, attemptId: currentAttemptId };
      }
      if (!isCurrentSelection()) { await cancelServerSelection(); return; }
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 500));
        if (!isCurrentSelection()) { await cancelServerSelection(); return; }
        const result = await hostApi<{ state: string; message?: string }>(
          '/v1/browser/selection/' + encodeURIComponent(pageId) + '/' + encodeURIComponent(currentAttemptId),
        );
        if (!isCurrentSelection()) { await cancelServerSelection(); return; }
        if (result.state === 'selected') {
          if (!isCurrentSelection()) { await cancelServerSelection(); return; }
          const target = await hostApi<BrowserTargetRow>('/v1/browser/targets', {
            method: 'POST', body: { pageId, roomId: selectedRoomId, attemptId: currentAttemptId },
          });
          if (!isCurrentSelection()) {
            // A room switch may race with the target registration response.
            // Revoke only this newly-created room-scoped target before returning.
            try {
              await hostApi('/v1/browser/targets/unregister', {
                method: 'POST', body: { targetId: target.id, roomId: selectedRoomId },
              });
            } catch {}
            await cancelServerSelection();
            return;
          }
          setBrowserTargets(previous => [target, ...previous.filter(existing => existing.id !== target.id)]);
          setSelectedBrowserTarget(target.id);
          setBrowserNotice('Input registered for draft-only use. The host will refuse to overwrite existing text and never presses Send.');
          return;
        }
        if (result.state === 'failed' || result.state === 'cancelled' || result.state === 'unavailable') {
          await cancelServerSelection();
          if (isCurrentSelection()) {
            setBrowserNotice(result.message || (result.state === 'cancelled' ? 'Selection cancelled.' : 'Selection failed or the tab changed.'));
          }
          return;
        }
      }
      await cancelServerSelection();
      if (isCurrentSelection()) setBrowserNotice('Selection timed out. The browser overlay was cancelled; start selection again.');
    } catch (e) {
      if (isCurrentSelection()) setBrowserNotice(e instanceof Error ? e.message : 'Input selection failed.');
      await cancelServerSelection();
    } finally {
      if (activeBrowserSelection.current?.generation === generation) activeBrowserSelection.current = null;
      setBrowserBusy(false);
    }
  }
  async function removeBrowserTarget() {
    const target = roomBrowserTargets.find(t => t.id === selectedBrowserTarget);
    if (!target || !room?.id || !window.confirm('Remove this typing-area registration from the selected group? This will not clear any text currently in the AI composer.')) return;
    setBrowserBusy(true); setBrowserNotice('');
    try {
      const result = await hostApi<{ removed: boolean }>('/v1/browser/targets/unregister', {
        method: 'POST', body: { targetId: target.id, roomId: room.id },
      });
      if (!result.removed) throw new Error('Target is no longer registered in this group.');
      setBrowserTargets(previous => previous.filter(existing => existing.id !== target.id));
      setSelectedBrowserTarget('');
      setBrowserNotice('Typing-area registration removed. Existing text in the AI app was left untouched.');
    } catch (e) { setBrowserNotice(e instanceof Error ? e.message : 'Could not remove typing area.'); }
    finally { setBrowserBusy(false); }
  }
  async function draftToBrowser() {
    if (!selectedBrowserTarget || !browserDraftText.trim()) return;
    const target = browserTargets.find(t => t.id === selectedBrowserTarget && t.roomId === room?.id);
    if (!target || !window.confirm('Insert this text into the selected empty composer on ' + target.site + '? It will NOT be sent.')) return;
    setBrowserBusy(true); setBrowserNotice('');
    try {
      const result = await hostApi<{ state: string; result?: { result?: { drafted?: boolean; submitted?: boolean } }; reason?: string }>(
        '/v1/browser/draft', { method: 'POST', body: { targetId: target.id, roomId: room?.id, text: browserDraftText, approved: true } },
      );
      setBrowserNotice(result.state === 'completed'
        ? 'Draft inserted and verified. Send was not clicked.'
        : result.state === 'needs_review'
          ? 'Draft outcome is uncertain. Check the actual AI composer before doing anything else. Do not retry automatically or assume the text was not inserted.'
          : 'Draft was not verified (' + result.state + (result.reason ? ': ' + result.reason : '') + '). Check the AI composer before retrying.');
    } catch (e) {
      setBrowserNotice('Could not confirm the draft operation: ' +
        (e instanceof Error ? e.message : 'Connection or execution error.') +
        ' Check the AI composer manually before retrying; the text may already have been inserted.');
    }
    finally { setBrowserBusy(false); }
  }
  function add() {
    if (!room || !name.trim() || spaces.length >= 30) return;
    const next = { id: randomId(), name: name.trim().slice(0, 60), app: app.trim().slice(0, 100), surface, createdAt: Date.now() };
    save([...spaces, next]); setActive(next.id); setSelection(null); setAdding(false); setName(''); setApp('');
    setNotice('Space layout created locally. A device host is still required to connect this app.');
  }
  if (loading) return <div className="br-gate">Checking Backroom access…</div>;
  if (!user || error) return <div className="br-gate"><ShieldCheck size={36}/><h1>Backroom access</h1><p>{error || 'Please sign in.'}</p><a href="/">Return to Rub Minds</a></div>;
  return <div className="br-shell">
    <aside className="br-sidebar">
      <a className="br-brand" href="/"><span className="br-brand-mark"><Layers3 size={22}/></span><span><b>rub minds</b><small>BACKROOM</small></span></a>
      <div className="br-side-heading">WORKSPACE</div>
      <label className="br-room-label" htmlFor="br-room">Active group</label>
      <div className="br-select-wrap"><select id="br-room" aria-label="Active Rub Minds group" value={room?.id || ''} onChange={e => { setRoomId(e.target.value); history.replaceState(null, '', '/?backroom=1&room=' + encodeURIComponent(e.target.value)); }}><option value="">Select a group</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><ChevronDown size={15}/></div>
      <div className="br-side-heading br-space-heading">SPACES <span>{spaces.length}</span></div>
      <div className="br-space-list">{spaces.map(s => { const Icon = iconFor(s.surface); return <button className={'br-space-item' + (s.id === active ? ' active' : '')} key={s.id} onClick={() => { setActive(s.id); setSelection(null); setNotice(''); }}><span className="br-space-icon"><Icon size={18}/></span><span className="br-space-name"><b>{s.name}</b><small>{surfaces.find(t => t.id === s.surface)?.name}</small></span><span className="br-offline-dot"/></button>; })}</div>
      <button className="br-add-side" onClick={() => setAdding(true)} disabled={!room || spaces.length >= 30}><Plus size={17}/> Add a space</button>
      <div className="br-side-footer"><span>{hostInfo?.connected ? <Check size={15}/> : <WifiOff size={15}/>} {hostInfo?.connected ? "Local host connected" : hostInfo ? "Local host not reachable" : "No device host connected"}</span><small>{hostInfo?.capabilities.browserDraft ? "Browser draft only · native drivers unavailable" : hostInfo?.connected ? "Host online · browser driver not started" : "Workspace layouts remain local · no active device control"}</small></div>
    </aside>
    <main className="br-main">
      <header className="br-topbar"><div className="br-breadcrumb"><a href="/"><ArrowLeft size={15}/> Groups</a><span>/</span><b>Backroom</b></div><div className="br-top-right"><button type="button" className={'br-status-pill' + (hostInfo ? ' paired' : '') + (hostStopped ? ' br-status-stopped' : '')} onClick={() => setHostModal(true)}><span/> {hostStopped ? 'Emergency stop · restart required' : hostInfo?.connected ? (hostInfo.capabilities.browserDraft ? 'Host paired · browser ready' : 'Host paired · browser idle') : hostInfo ? 'Host offline · session saved' : 'Host offline'}</button><span className="br-avatar">{user.email?.slice(0, 1).toUpperCase() || 'U'}</span></div></header>
      {!room ? <div className="br-empty"><Layers3 size={42}/><h1>Choose a Rub Minds group</h1><p>Backroom spaces are scoped to your authenticated group. Select one from the sidebar to begin.</p></div> :
      <div className="br-content">
        <div className="br-title-row"><div><div className="br-eyebrow"><Activity size={14}/> MULTI-SPACE COORDINATION</div><h1>Backroom <span>workspace</span></h1><p>One group. Multiple AI interfaces. Start with an explicitly approved browser draft.</p></div><button className="br-primary" onClick={() => setAdding(true)} disabled={spaces.length >= 30}><Plus size={17}/> New space</button></div>
        <div className="br-metrics"><div><span>Registered spaces</span><strong>{spaces.length.toString().padStart(2, '0')}</strong><small>Local workspace layouts</small></div><div><span>Connected hosts</span><strong>{hostInfo?.connected ? "01" : "00"}</strong><small>{hostInfo?.connected ? "Local host is reachable" : hostInfo ? "Reconnect to verify the saved host" : "Pair a local host to connect"}</small></div><div><span>Active automations</span><strong>00</strong><small>No device commands running</small></div></div>
        {notice && <div className="br-notice" role="status"><CircleHelp size={16}/>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {!current ? <div className="br-empty-card"><div className="br-empty-symbol"><Layers3 size={34}/></div><h2>Give every AI its own space.</h2><p>Create spaces for phone apps, desktop assistants, terminals and browser sessions. Pair the local host for browser drafts; native Android, desktop, Windows and terminal drivers are still in development.</p><button className="br-primary" onClick={() => setAdding(true)}><Plus size={16}/> Create your first space</button><div className="br-platforms">{surfaces.map(s => { const Icon = iconFor(s.id); return <span key={s.id} title={s.name}><Icon size={18}/></span>; })}</div></div> :
        <div className="br-workspace-grid"><section className="br-panel br-stage"><div className="br-panel-head"><div><span className="br-eyebrow">ACTIVE SPACE</span><h2>{current.name}</h2><p>{current.app || surfaces.find(s => s.id === current.surface)?.detail}</p></div><button className="br-icon-button" aria-label="Remove this local space" title="Remove local space" onClick={() => { if (!confirm('Remove this local space layout? No external app will be changed.')) return; save(spaces.filter(s => s.id !== current.id)); setActive(''); setSelection(null); }}><Trash2 size={17}/></button></div><Preview key={current.id} surface={current.surface} selected={selection} onSelect={setSelection}/><div className="br-stage-foot"><MousePointer2 size={16}/><span>Drag across the simulated app to test target selection. This does not control a real device.</span><button type="button" className="br-sample-select" onClick={() => setSelection({ x: 12, y: 72, width: 76, height: 17 })}>Select sample input</button></div></section>
        <section className="br-panel br-inspector"><span className="br-eyebrow">SPACE INSPECTOR</span><h2>Connection details</h2><div className="br-detail"><span>Platform</span><b>{surfaces.find(s => s.id === current.surface)?.name}</b></div><div className="br-detail"><span>Host status</span><b className="br-muted">{hostInfo?.connected ? (hostInfo.capabilities.browserDraft ? 'Paired · browser draft only' : 'Paired · browser idle') : hostInfo ? 'Offline · paired before' : 'Not connected'}</b></div><div className="br-detail"><span>Typing target</span><b>{selection ? 'Preview region selected' : 'Not registered'}</b></div>{selection && <div className="br-coords"><b>Preview selection</b><code>x {selection.x.toFixed(1)}% · y {selection.y.toFixed(1)}%</code><code>w {selection.width.toFixed(1)}% · h {selection.height.toFixed(1)}%</code><button onClick={() => setSelection(null)}>Clear selection</button></div>}<div className="br-warning"><ShieldCheck size={19}/><div><b>Preview selection only</b><p>{hostInfo?.capabilities.browserDraft ? 'This simulated space preview is not bound to a real app target. Use the Managed browser panel to select a real empty composer and insert a confirmed draft. Native and terminal spaces remain preview-only.' : 'This simulated preview does not control a real app. Pair the local host and launch its managed browser for the current draft-only path. Native Android, Windows, desktop-app and terminal control remain unavailable.'}</p></div></div><button className="br-disabled-action" onClick={() => setHostModal(true)}><Command size={16}/> {hostInfo ? 'Manage local host' : 'Pair local host'} <span>{hostInfo?.connected ? 'Online' : hostInfo ? 'Offline' : 'Connect'}</span></button></section></div>}
        <div className="br-bottom-note"><Cpu size={16}/><span>Backroom foundation preview — group-scoped local layouts only. No hidden device access, background AI replies or remote commands.</span><a href="https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47" target="_blank" rel="noreferrer">Development status <ExternalLink size={13}/></a></div>
      </div>}
    </main>
    {hostModal && <div className="br-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setHostModal(false); }}><div className="br-modal" role="dialog" aria-modal="true" aria-labelledby="br-host-title"><div className="br-modal-top"><div className="br-modal-icon"><Cpu size={22}/></div><button className="br-icon-button" onClick={() => setHostModal(false)} aria-label="Close host pairing"><X size={20}/></button></div><h2 id="br-host-title">{hostStopped ? 'Emergency stop is active' : hostInfo ? 'Local host connection' : 'Pair a local host'}</h2><p>Run the Backroom host on this same computer, then enter its one-time code. Use a current Chrome or Edge browser; local-network permission may be required. Embedded webviews, Firefox or Safari may block this HTTP loopback connection. Pairing connects host status first; only the managed browser draft adapter is available today.</p>{hostMessage && <div className="br-host-message" role="status">{hostMessage}</div>}{!hostInfo ? <>{hostStopped && <div className="br-host-message br-host-stopped" role="status">The previous host session was emergency-stopped. Stop the old local host process with Ctrl+C, restart it to generate a fresh one-time code, then pair below. The host health check will reject pairing if the emergency stop is still latched.</div>}<label htmlFor="br-host-url">Local host address</label><input id="br-host-url" autoFocus value={hostUrl} onChange={e => setHostUrl(e.target.value)} placeholder="http://127.0.0.1:43781" autoCapitalize="none" spellCheck={false}/><label htmlFor="br-pair-code">One-time pairing code</label><input id="br-pair-code" value={pairingCode} onChange={e => setPairingCode(e.target.value.trim().slice(0, 32))} placeholder="Paste code from the host terminal" autoComplete="off" autoCapitalize="none" spellCheck={false}/><div className="br-warning"><ShieldCheck size={19}/><div><b>Local-only connection</b><p>The host should bind to 127.0.0.1. Never share the pairing code or session token with a Rub Minds group.</p></div></div><div className="br-modal-actions"><button className="br-secondary" onClick={() => setHostModal(false)}>Close</button><button className="br-primary" onClick={() => void pairLocalHost()} disabled={hostBusy || !/^[a-f0-9]{32}$/i.test(pairingCode.trim())}>{hostBusy ? 'Pairing…' : 'Pair host'} <ArrowRight size={16}/></button></div></> : <><div className="br-detail"><span>Host ID</span><b>{hostInfo.hostId}</b></div><div className="br-detail"><span>Connection</span><b>{hostInfo.connected ? 'Authenticated' : 'Offline'}</b></div><div className="br-detail"><span>Available local capability</span><b className="br-muted">{hostInfo.capabilities.browserDraft ? 'Browser draft insertion only' : 'No execution driver enabled'}</b></div><div className="br-warning"><ShieldCheck size={19}/><div><b>{hostInfo.capabilities.browserDraft ? 'Browser draft adapter ready' : 'Browser adapter not started'}</b><p>{hostInfo.capabilities.browserDraft ? 'The managed browser supports inserting text into an explicitly registered empty composer. It never presses Send.' : 'Launch a dedicated visible browser profile. Log into AI websites yourself; Backroom does not copy existing cookies or sign you in.'} Native Windows, Android and terminal drivers are still unavailable.</p></div></div>
<div className="br-browser-panel"><div className="br-browser-panel-head"><div><b>Managed browser</b><small>Visible Chromium · local profile only</small></div><button className="br-secondary" onClick={() => void refreshBrowserInventory()} disabled={browserBusy || !hostInfo.capabilities.browserDraft}><Activity size={14}/> Refresh tabs</button></div>
{!hostInfo.capabilities.browserDraft ? <button className="br-primary br-browser-launch" onClick={() => void startManagedBrowser()} disabled={browserBusy}>{browserBusy ? 'Starting browser…' : 'Launch managed browser'} <ArrowRight size={15}/></button> : <>
<div className="br-browser-open"><label className="br-browser-field-label" htmlFor="br-browser-url">Open an AI website</label><div className="br-browser-open-row"><input id="br-browser-url" type="url" value={browserUrl} onChange={e=>setBrowserUrl(e.target.value)} placeholder="https://chatgpt.com/" autoCapitalize="none" spellCheck={false}/><button className="br-primary" onClick={() => void openManagedUrl()} disabled={browserBusy || !browserUrl.trim()}>Open</button></div><div className="br-browser-quick"><button className="br-secondary" onClick={()=>setBrowserUrl('https://chatgpt.com/')} disabled={browserBusy}>ChatGPT</button><button className="br-secondary" onClick={()=>setBrowserUrl('https://claude.ai/new')} disabled={browserBusy}>Claude</button></div></div><div className="br-browser-pages">{browserPages.map(page => <div className="br-browser-page" key={page.pageId}><div className="br-browser-page-icon"><Monitor size={16}/></div><div className="br-browser-page-label"><b>{page.site}</b><small>{page.title || 'Untitled conversation tab'}</small></div><button className="br-secondary" onClick={() => void registerBrowserInput(page.pageId)} disabled={browserBusy}>Select input</button></div>)}{!browserPages.length && <p className="br-browser-empty">No supported browser tabs found. Open a conversation in the managed browser and refresh.</p>}</div>
{roomBrowserTargets.length>0 && <><label className="br-browser-field-label" htmlFor="br-browser-target">Registered typing area</label><select id="br-browser-target" value={selectedBrowserTarget} onChange={e=>setSelectedBrowserTarget(e.target.value)}><option value="">Choose a typing target</option>{roomBrowserTargets.map(t=><option key={t.id} value={t.id}>{t.site} · {t.title}</option>)}</select><div className="br-browser-target-actions"><button className="br-secondary" onClick={() => void removeBrowserTarget()} disabled={browserBusy || !roomBrowserTargets.some(t => t.id === selectedBrowserTarget)}>Remove selected target</button></div><label className="br-browser-field-label" htmlFor="br-group-message">Source group message (optional)</label><select id="br-group-message" value={selectedGroupMessageId} onChange={e => { const id = e.target.value; setSelectedGroupMessageId(id); const message = groupMessages.find(m => m.id === id); if (message) setBrowserDraftText(message.body); }}><option value="">Write a manual draft instead</option>{groupMessages.map(m => <option key={m.id} value={m.id}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {m.body.slice(0, 90).replace(/\s+/g, ' ')}</option>)}</select><label className="br-browser-field-label" htmlFor="br-browser-draft">Text to draft (not sent)</label><textarea id="br-browser-draft" rows={3} maxLength={10000} value={browserDraftText} onChange={e=>setBrowserDraftText(e.target.value)} placeholder="Write the exact text to insert into the selected composer…"/><button className="br-primary br-browser-draft" onClick={() => void draftToBrowser()} disabled={browserBusy || !roomBrowserTargets.some(t => t.id === selectedBrowserTarget) || !browserDraftText.trim()}>Insert draft — never send <ArrowRight size={15}/></button><p className="br-browser-caption">Target registration stores the selector locally. Text is inserted only after confirmation, only into an empty input, and is read back to verify success.</p></>}
<button className="br-secondary br-browser-stop" onClick={() => void stopManagedBrowser()} disabled={browserBusy}>Close managed browser</button></>}
{browserNotice && <div className="br-host-message" role="status">{browserNotice}</div>}</div>
<div className="br-warning"><ShieldCheck size={19}/><div><b>Experimental hosted AI wake</b><p>Register the host first. Choose a live AI MCP session and a locally selected browser composer for this group. Registration never sends anything; an explicit five-minute wake grant is required.</p></div></div>
{room?.id && hostInfo.enrollmentDigest && <div>
  <div className="br-modal-actions"><button className="br-secondary" onClick={() => void discoverHostedAiSessions()} disabled={hostBusy || browserBusy}>Find joined AI sessions</button></div>
  {hostedAiSessions.length>0 && <>
    <label htmlFor="br-hosted-ai-session">Joined AI conversation</label>
    <select id="br-hosted-ai-session" value={selectedHostedSession} onChange={e=>setSelectedHostedSession(e.target.value)}>{hostedAiSessions.map(s=><option key={s.sessionDigest} value={s.sessionDigest}>{s.displayName} · {s.participantId.slice(0,8)}</option>)}</select>
    <p>Selected local input: {browserTargets.find(t=>t.id===selectedBrowserTarget)?.title || 'Select a managed browser target before binding.'}</p>
    <div className="br-modal-actions"><button className="br-secondary" onClick={() => void bindHostedWakeInput()} disabled={hostBusy || browserBusy || !selectedBrowserTarget}>Register inactive AI input binding</button></div>
  </>}
  {hostedWakeBinding && hostedWakeBinding.roomId===room.id && <>
    <div className="br-detail"><span>Wake status</span><b>{hostedWakeBinding.requiresRevoke?'Existing binding · revoke before rebind':hostedWakeGrantId?'Locally consented · time-limited':'Off · binding registered'}</b></div>
    <div className="br-modal-actions">
      {hostedWakeBinding.requiresRevoke
        ? <button className="br-danger-action" disabled={hostBusy || browserBusy} onClick={() => void revokeHostedWakeBinding()}>Revoke existing binding and rebind</button>
        : !hostedWakeGrantId
          ? <button className="br-primary" disabled={hostBusy || browserBusy || hostedWakeBinding.targetId!==selectedBrowserTarget} onClick={() => void enableHostedWake()}>Enable wake for 5 minutes</button>
          : <button className="br-danger-action" disabled={hostBusy || browserBusy} onClick={() => void revokeHostedWake()}>Revoke wake</button>}
    </div>
    {!hostedWakeBinding.requiresRevoke && <div className="br-modal-actions"><button className="br-secondary" disabled={hostBusy || browserBusy} onClick={() => void revokeHostedWakeBinding()}>Permanently unbind this AI input</button></div>}
  </>}
</div>}
<div className="br-emergency-stop-row"><div><b>Emergency stop</b><small>Close Chromium, revoke all paired sessions, and block reconnection until the host is restarted.</small></div><button className="br-danger-action" onClick={() => void emergencyStopLocalHost()} disabled={hostBusy || browserBusy || !hostToken}>Stop all</button></div>
{hostInfo.enrollmentDigest && <><div className="br-modal-actions"><button className="br-secondary" onClick={() => void registerHostedWakeHost()} disabled={hostBusy || browserBusy}>Register or renew hosted wake host</button></div><div className="br-modal-actions"><button className="br-danger-action" onClick={() => void revokeHostedWakeHost()} disabled={hostBusy || browserBusy}>Permanently revoke hosted host</button></div></>}<div className="br-modal-actions"><button className="br-secondary" onClick={() => void unpairLocalHost()} disabled={hostBusy || browserBusy}>Unpair</button><button className="br-primary" onClick={() => void checkLocalHost()} disabled={hostBusy || browserBusy}>{hostBusy ? 'Checking…' : 'Check connection'}</button></div></>}</div></div>}
    {adding && <div className="br-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAdding(false); }}><div className="br-modal" role="dialog" aria-modal="true" aria-labelledby="br-modal-title"><div className="br-modal-top"><div className="br-modal-icon"><Plus size={22}/></div><button className="br-icon-button" onClick={() => setAdding(false)} aria-label="Close"><X size={20}/></button></div><h2 id="br-modal-title">Add a new space</h2><p>Choose the kind of interface this workspace will connect to.</p><label htmlFor="br-name">Space name</label><input id="br-name" maxLength={60} autoFocus placeholder="e.g. Claude research assistant" value={name} onChange={e => setName(e.target.value)}/><label htmlFor="br-app">App or session label <span>(optional)</span></label><input id="br-app" maxLength={100} placeholder="e.g. Claude Desktop · Research thread" value={app} onChange={e => setApp(e.target.value)}/><div className="br-modal-label">Interface type</div><div className="br-surface-options">{surfaces.map(s => { const Icon = iconFor(s.id); return <button key={s.id} className={'br-surface-option' + (surface === s.id ? ' chosen' : '')} onClick={() => setSurface(s.id)}><Icon size={20}/><span><b>{s.name}</b><small>{s.detail}</small></span>{surface === s.id && <Check size={17}/>}</button>; })}</div><div className="br-modal-actions"><button className="br-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="br-primary" onClick={add} disabled={!name.trim()}>Create space <ArrowRight size={16}/></button></div></div></div>}
  </div>;
}
