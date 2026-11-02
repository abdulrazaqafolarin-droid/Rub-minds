import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, CircleHelp, Command, Cpu, ExternalLink, Laptop, Layers3, Monitor, MousePointer2, Plus, ShieldCheck, Smartphone, SquareTerminal, Trash2, WifiOff, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { listCloudMessages, listCloudRooms, subscribeToCloudMessages, type CloudMessage, type CloudRoom } from './cloudRooms';
import './backroom.css';
import ExternalWorkspacePanel from './ExternalWorkspacePanel';
import BackroomDesktopControl from './BackroomDesktopControl';
import { interactionModeForParticipationMode, needsWakeBindingRebind, participationModeForInteractionMode } from '../integrations/backroom/interaction-mode.mjs';

type Surface = 'browser_tab' | 'desktop_app' | 'windows_app' | 'terminal' | 'android_app';
type Space = { id: string; name: string; surface: Surface; app: string; createdAt: number; pageId?: string };
type BrowserViewFrame = { pageId: string; roomId: string; grantId: string; frameId: string; mimeType: 'image/jpeg'; image: string; width: number; height: number; expiresAt: number };
type Rect = { x: number; y: number; width: number; height: number };
type HostWakeBindingStatus = { bindingId: string; polling: boolean; consentActive: boolean; deactivationPending: boolean };
type HostStatus = { hostId: string; label: string; expiresAt: number; protocolVersion: string; connected: boolean; executionReady: boolean; capabilities: Record<string, boolean>; nextStep: string; browserPages?: number; enrollmentDigest?: string; wakeGatewayHost?: string; wakeBindings?: HostWakeBindingStatus[] };
type BrowserPageRow = { pageId: string; title: string; site: string; canSelect: boolean };
type BrowserTargetRow = { id: string; pageId: string; roomId: string; title: string; site: string; surface: string; operations: string[]; wakeAvailable?: boolean; spaceId?: string; sessionId?: string; identityFingerprint?: string; revision?: number; locatorKind?: string; locatorValue?: string };
type HostedAiSession = { participantId: string; displayName: string; sessionDigest: string; expiresAt: string; credentialExpiresAt: string };
type WakeInteractionMode = 'off' | 'on' | 'auto';
type HostedWakeBinding = { bindingId: string; roomId: string; participantId: string; sessionId: string; targetId: string; sessionDigest: string; participationMode?: 'mentions' | 'smart' | 'task'; wakeEnabled?: boolean; serverWakeEnabled?: boolean; localPollingConfirmed?: boolean; wakeExpiresAt?: string | null; requiresRevoke?: boolean };
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
const expectedSupabaseHost = (() => {
  try { return new URL(import.meta.env.VITE_SUPABASE_URL).hostname.toLowerCase(); }
  catch { return ''; }
})();
function wakeGatewayMismatch(host: HostStatus | null) {
  return Boolean(host?.wakeGatewayHost && expectedSupabaseHost &&
    host.wakeGatewayHost.toLowerCase() !== expectedSupabaseHost);
}
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
  if (row.wakeGatewayHost !== undefined &&
    (typeof row.wakeGatewayHost !== 'string' || row.wakeGatewayHost.length > 253 ||
      !/^(?:[a-z0-9-]+\\.)*[a-z0-9-]+$/i.test(row.wakeGatewayHost))) {
    throw new HostStatusValidationError('Local host returned an invalid wake gateway hostname.');
  }
  let wakeBindings: HostWakeBindingStatus[] | undefined;
  if (row.wakeBindings !== undefined) {
    if (!Array.isArray(row.wakeBindings) || row.wakeBindings.length > 10 || row.wakeBindings.some(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
      const item=value as Record<string,unknown>;
      return typeof item.bindingId!=='string' || !/^[a-f0-9-]{36}$/i.test(item.bindingId) ||
        typeof item.polling!=='boolean' || typeof item.consentActive!=='boolean' ||
        typeof item.deactivationPending!=='boolean';
    })) throw new HostStatusValidationError('Local host returned invalid durable wake status.');
    wakeBindings = row.wakeBindings as HostWakeBindingStatus[];
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
  if (supplied.browserView !== undefined && typeof supplied.browserView !== 'boolean') {
    throw new HostStatusValidationError('Local host returned an invalid browser-view capability flag.');
  }
  capabilities.browserView = supplied.browserView === true;
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
    ...(typeof row.wakeGatewayHost === 'string' ? { wakeGatewayHost: row.wakeGatewayHost.toLowerCase() } : {}),
    ...(wakeBindings ? { wakeBindings } : {}),
  };
}

function LiveBrowserPreview({ frame, appName, onSelectRegion, wakeMode, onWakeModeChange, wakeModeDisabled, wakeModeStatus, wakeCapable, findSessionsDisabled, onFindSessions }: {
  frame: BrowserViewFrame;
  appName: string;
  onSelectRegion: (frameId: string, region: Rect) => void;
  wakeMode: WakeInteractionMode;
  onWakeModeChange: (mode: WakeInteractionMode) => void;
  wakeModeDisabled: boolean;
  wakeModeStatus: string;
  wakeCapable: boolean;
  findSessionsDisabled: boolean;
  onFindSessions: () => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number; frameId: string } | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [dragFrame, setDragFrame] = useState<BrowserViewFrame | null>(null);
  const visibleFrame = dragFrame ?? frame;
  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width) * 100),
      y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height) * 100),
    };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!start) return;
    const end = point(event);
    setDrag({
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
    });
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    if (!start) return;
    const end = point(event);
    const region = {
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
    };
    if (region.width >= 1.5 && region.height >= 1.5) onSelectRegion(start.frameId, region);
    setStart(null); setDrag(null); setDragFrame(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  const rectangle = drag;
  return <div className="br-live-view">
    <div className="br-live-view-head">
      <div><b>{appName}</b><small>Paired local Chromium · authenticated tab</small></div>
      <span className="br-live-local-chip">LOCAL VIEW · SNAPSHOT</span>
    </div>
    <div className="br-live-frame" aria-label="Local browser tab screenshot">
      <img
        src={'data:' + visibleFrame.mimeType + ';base64,' + visibleFrame.image}
        alt={'Current visual snapshot of ' + appName}
        draggable={false}
      />
      <div
        className="br-live-drag"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const startPoint = point(event);
          setDragFrame(frame);
          setStart({ ...startPoint, frameId: frame.frameId });
          setDrag(null);
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={() => { setStart(null); setDrag(null); setDragFrame(null); }}
        role="group"
        aria-label="Drag around exactly one visible empty AI composer to register it for draft insertion and, when the provider adapter supports it, a separately consented canonical wake"
        tabIndex={0}
      />
      {rectangle && <div className="br-live-selection" style={{
        left: rectangle.x + '%', top: rectangle.y + '%',
        width: rectangle.width + '%', height: rectangle.height + '%',
      }} />}
    </div>
    <div className="br-live-mode-control">
      <div className="br-live-mode-head">
        <div><b>AI participation</b><small>Choose how this exact composer joins the group</small></div>
        <button type="button" className="br-secondary" onClick={onFindSessions} disabled={findSessionsDisabled}>Find joined AI</button>
      </div>
      <label htmlFor="br-frame-wake-mode">Interaction mode</label>
      <select id="br-frame-wake-mode" value={wakeMode} onChange={event => onWakeModeChange(event.target.value as WakeInteractionMode)} disabled={wakeModeDisabled}>
        <option value="off">Off — no automatic triggers</option>
        <option value="on" disabled={!wakeCapable}>On — wake only when mentioned</option>
        <option value="auto" disabled={!wakeCapable}>Auto — wake on human group messages</option>
      </select>
      <p>{wakeModeStatus}</p>
      <small>Auto sends only the fixed @RMconnects trigger to this registered managed-browser composer. It does not copy the group message into the AI chat. The AI must already be joined to Rub Minds through MCP. Native Android and Windows app frames still support verified draft insertion only.</small>
    </div>
    <div className="br-live-caption">Read-only snapshots are refreshed locally. Drag around one visible empty editable composer in this frame; Backroom resolves the region against the live DOM and rejects stale, ambiguous or occupied targets. The frame mode above applies to this managed-browser surface only.</div>
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
  const [selectedBrowserPage, setSelectedBrowserPage] = useState('');
  const [liveViewEnabled, setLiveViewEnabled] = useState(false);
  const [liveFrame, setLiveFrame] = useState<BrowserViewFrame | null>(null);
  const [liveGrantId, setLiveGrantId] = useState('');
  const [hostedAiSessions,setHostedAiSessions] = useState<HostedAiSession[]>([]);
  const [selectedHostedSession,setSelectedHostedSession] = useState('');
  const [hostedWakeBinding,setHostedWakeBinding] = useState<HostedWakeBinding | null>(null);
  const [hostedWakeGrantId,setHostedWakeGrantId] = useState('');
  const [selectedWakeMode,setSelectedWakeMode] = useState<WakeInteractionMode>('off');
  const [wakeBindingStatusKnown,setWakeBindingStatusKnown] = useState(false);
  const bindingStatusRequestRef = useRef(0);
  const selectionGeneration = useRef(0);
  const activeBrowserSelection = useRef<PendingBrowserSelection | null>(null);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get('room') || '');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [active, setActive] = useState('');
  const [adding, setAdding] = useState(false);
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
            setHostInfo({ ...saved.info, connected: false, executionReady: false, browserPages: 0, capabilities: { ...saved.info.capabilities, browserDraft: false, browserView: false } });
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
    setActive(''); setSpaces([]);
    if (!storageKey) return;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(value)) {
        // Only discovered managed-browser tabs represent real saved app sessions.
        // Drop old layout-only demo tiles rather than rendering fake applications.
        const connectedSpaces = value.filter(s =>
          s && typeof s.id === 'string' && typeof s.name === 'string' &&
          s.surface === 'browser_tab' && typeof s.pageId === 'string' && s.pageId.length > 0
        );
        setSpaces(connectedSpaces.slice(0, 30));
      }
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
  const currentBrowserTarget = current?.pageId
    ? roomBrowserTargets.find(target => target.pageId === current.pageId) : undefined;
  const selectedWakeParticipationMode = participationModeForInteractionMode(selectedWakeMode);
  const wakeBindingNeedsRebind = Boolean(hostedWakeBinding && selectedWakeParticipationMode &&
    needsWakeBindingRebind(selectedWakeMode, hostedWakeBinding.participationMode));
  useEffect(() => {
    setLiveViewEnabled(false);
    setLiveGrantId('');
    setLiveFrame(null);
  }, [active, current?.pageId, hostToken]);
  useEffect(() => {
    if (!liveViewEnabled || !current?.pageId || !room?.id || !hostToken || !liveGrantId || hostInfo?.capabilities.browserView !== true) {
      setLiveFrame(null);
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    const pageId = current.pageId;
    const loadFrame = async () => {
      try {
        const next = await hostApi<BrowserViewFrame>('/v1/browser/view/' + encodeURIComponent(pageId) + '/' + encodeURIComponent(room.id) + '/' + encodeURIComponent(liveGrantId));
        if (!disposed) {
          if (next.pageId !== pageId || next.roomId !== room.id || next.grantId !== liveGrantId || next.mimeType !== 'image/jpeg' ||
            typeof next.image !== 'string' || next.image.length === 0 ||
            !Number.isSafeInteger(next.width) || !Number.isSafeInteger(next.height) ||
            next.width <= 0 || next.height <= 0 || !/^[a-f0-9-]{36}$/i.test(next.frameId)) {
            throw new Error('The local host returned an invalid browser view frame.');
          }
          setLiveFrame(next);
        }
      } catch (error) {
        if (!disposed) {
          setLiveViewEnabled(false);
          setLiveGrantId('');
          setLiveFrame(null);
          setNotice('Local browser view paused: ' +
            (error instanceof Error ? error.message : 'the selected tab is no longer available.'));
        }
        return;
      }
      if (!disposed) timer = window.setTimeout(() => { void loadFrame(); }, 1200);
    };
    void loadFrame();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (liveGrantId && current?.pageId && room?.id && hostToken) {
        void hostApi('/v1/browser/view/revoke', { method: 'POST', body: { pageId: current.pageId, roomId: room.id, grantId: liveGrantId } }).catch(() => {});
      }
    };
  }, [liveViewEnabled, current?.pageId, room?.id, hostToken, liveGrantId, hostInfo?.capabilities.browserView, hostUrl]);
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
      setPairingCode(''); setHostMessage('Host paired. Managed browser and any explicitly configured external workspace adapters report capabilities separately.');
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

  async function revokeHostedWakeBinding(alreadyConfirmed = false) {
    const binding=hostedWakeBinding;
    if(!supabase||!user||!binding)return false;
    if(!alreadyConfirmed && !window.confirm('Permanently revoke this AI input binding? Its pending and leased wake events will be cancelled. The host remains registered, but this input must be selected and bound again before wake can be enabled.'))return false;
    setHostBusy(true);
    try{
      // Stop the local grant and poller first. The owner-authenticated server
      // revoke below still cancels queued work if the local host is unreachable,
      // but cannot prove that an already-running local action has stopped.
      let localStopConfirmed=false;
      try{
        if(hostToken){
          const local=await hostApi<{revoked:boolean}>('/v1/browser/wake/bindings/revoke',{
            method:'POST',body:{bindingId:binding.bindingId}
          });
          localStopConfirmed=local.localPollingStopped===true;
        }
      }catch{}
      const {data,error:revokeError}=await supabase.functions.invoke('backroom-config/revoke-binding',{
        body:{bindingId:binding.bindingId}
      });
      if(revokeError||data?.ok!==true||data?.revoked!==true)
        throw new Error('Input binding was not revoked. Check ownership and retry.');
      if(!localStopConfirmed){
        setHostMessage('The server revoked this binding and cancelled queued jobs, but the paired local host did not confirm that polling and any in-flight action have stopped. This mode change is not marked complete. Reconnect to that host and use Emergency Stop before retrying.');
        return false;
      }
      setHostedWakeBinding(null);
      setHostedWakeGrantId('');
      setHostMessage('Off confirmed: the paired local host stopped its wake poller and the server revoked the binding and cancelled pending jobs.');
      return true;
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Input binding revocation failed.');
      return false;
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

  async function restoreHostedWakeBinding(roomId: string, selectedSession: HostedAiSession) {
    if (!supabase) return;
    const requestId = ++bindingStatusRequestRef.current;
    setWakeBindingStatusKnown(false);
    const {data,error} = await supabase.functions.invoke('backroom-config/binding-status',{
      body:{roomId,participantId:selectedSession.participantId,sessionDigest:selectedSession.sessionDigest}
    });
    if (requestId !== bindingStatusRequestRef.current) return;
    if(error || data?.ok!==true || !Array.isArray(data.bindings)) {
      setHostMessage('Wake status is UNKNOWN because the owner-authenticated server check failed. Existing state has been preserved; do not register or arm another binding until status can be restored.');
      return;
    }
    setWakeBindingStatusKnown(true);
    const row=data.bindings.find((value:unknown)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return false;
      const item=value as Record<string,unknown>;
      return item.participantId===selectedSession.participantId &&
        typeof item.bindingId==='string' && typeof item.sessionId==='string' &&
        typeof item.targetId==='string' && ['mentions','smart','task'].includes(String(item.participationMode));
    }) as Record<string,unknown>|undefined;
    setHostedWakeGrantId('');
    if(!row) {
      setHostedWakeBinding(null);
      setSelectedWakeMode('off');
      setHostMessage('No active input binding exists for this exact AI session. Select On or Auto and register the intended composer.');
      return;
    }
    const participationMode=row.participationMode as 'mentions'|'smart'|'task';
    const interactionMode=interactionModeForParticipationMode(participationMode);
    let localPollingConfirmed=false;
    try {
      if(hostToken&&hostInfo?.connected) {
        const localStatus=await hostApi<unknown>('/v1/host');
        const parsed=parseHostStatus(localStatus,hostInfo.hostId);
        setHostInfo(parsed);
        const localBinding=parsed.wakeBindings?.find(item=>item.bindingId===String(row.bindingId));
        localPollingConfirmed=localBinding?.polling===true&&localBinding.consentActive===true&&localBinding.deactivationPending===false;
      }
    } catch { localPollingConfirmed=false; }
    if(requestId!==bindingStatusRequestRef.current)return;
    const serverWakeEnabled=row.wakeEnabled===true;
    const binding: HostedWakeBinding={
      bindingId:String(row.bindingId),roomId,participantId:selectedSession.participantId,
      sessionId:String(row.sessionId),targetId:String(row.targetId),sessionDigest:selectedSession.sessionDigest,
      participationMode,wakeEnabled:serverWakeEnabled&&localPollingConfirmed,
      serverWakeEnabled,localPollingConfirmed,
      wakeExpiresAt:typeof row.wakeExpiresAt==='string'?row.wakeExpiresAt:null,
      requiresRevoke:interactionMode===null
    };
    setHostedWakeBinding(binding);
    setSelectedWakeMode(interactionMode==='on'||interactionMode==='auto'?interactionMode:'off');
    if(roomBrowserTargets.some(target=>target.id===binding.targetId))setSelectedBrowserTarget(binding.targetId);
    if(interactionMode===null) {
      setHostMessage('This binding uses a task-only policy that is not exposed by the Off / On / Auto control. Revoke it before creating a supported mode.');
    } else if(serverWakeEnabled&&!localPollingConfirmed) {
      setHostMessage('The server still has a live wake grant, but the paired host did not confirm an active local poller. Do not treat Auto as running. Turn Off to revoke the stale grant, or reconnect/restart the intended host and check again.');
    } else if(binding.wakeEnabled) {
      const expiry=binding.wakeExpiresAt?Date.parse(binding.wakeExpiresAt):NaN;
      setHostMessage(`${interactionMode.toUpperCase()} is active on the paired host for this exact AI session${Number.isFinite(expiry)?' until '+new Date(expiry).toLocaleTimeString():''}.`);
    } else {
      setHostMessage(`${interactionMode.toUpperCase()} binding restored. It is not currently armed; local consent is required to start its bounded wake grant.`);
    }
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
          typeof x.sessionDigest==='string'&&/^[a-f0-9]{64}$/.test(x.sessionDigest)&&
          typeof x.expiresAt==='string'&&Number.isFinite(Date.parse(x.expiresAt))&&
          typeof x.credentialExpiresAt==='string'&&Number.isFinite(Date.parse(x.credentialExpiresAt));
      }) as HostedAiSession[];
      setHostedAiSessions(sessions);
      setSelectedHostedSession(sessions[0]?.sessionDigest??'');
      if(sessions[0]) await restoreHostedWakeBinding(room.id,sessions[0]);
      else {
        bindingStatusRequestRef.current++;
        setWakeBindingStatusKnown(false);
        setHostMessage('No live joined AI MCP session was found. Existing wake bindings are not assumed Off; reconnect the original AI session and restore its owner-scoped status before changing modes.');
      }
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'AI session discovery failed.');
    }finally{setHostBusy(false);}
  }
  async function bindHostedWakeInput() {
    if (!supabase || !room?.id || !hostInfo?.connected || !hostToken) return;
    if (hostedWakeBinding && hostedWakeBinding.roomId !== room.id) {
      setHostMessage('This view is still tracking a binding from another group. Reopen that group to manage or revoke it before registering another binding here.');
      return;
    }
    const participationMode=participationModeForInteractionMode(selectedWakeMode);
    if (!participationMode) {
      setHostMessage('Wake is Off. Choose On or Auto before registering an AI input binding.');
      return;
    }
    const selectedSession=hostedAiSessions.find(s=>s.sessionDigest===selectedHostedSession);
    const target=browserTargets.find(t=>t.id===selectedBrowserTarget);
    // Capture optional identity fields before any await so TypeScript and runtime share one stable value.
    const targetSessionId=target?.sessionId;
    if(!selectedSession||!target||target.roomId!==room.id||target.wakeAvailable!==true||
       !target.spaceId||!targetSessionId||!target.identityFingerprint||
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
          spaceId:target.spaceId,sessionId:targetSessionId,
          targetId:target.id,targetIdentityFingerprint:target.identityFingerprint,
          targetRevision:target.revision,surface:'browser_tab',
          locatorKind:target.locatorKind,locatorValue:target.locatorValue,
          participationMode,maxWakesPerMinute:6
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
        if(data && typeof data.bindingId==='string'&&
          (data.reason==='existing_binding_active_revoke_first'||data.reason==='existing_binding_requires_revoke')){
          setHostedWakeBinding({
            bindingId:data.bindingId,roomId:room.id,
            participantId:selectedSession.participantId,sessionId:targetSessionId,
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
        participantId:selectedSession.participantId,sessionId:targetSessionId,
        targetId:target.id,sessionDigest:selectedSession.sessionDigest,
        participationMode,wakeEnabled:false,requiresRevoke:false
      });
      setHostedWakeGrantId('');
      setHostMessage('AI session bound to the exact selected composer in ' + selectedWakeMode.toUpperCase() + ' mode. Wake remains OFF until you explicitly arm it.');
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
    const requiredMode=participationModeForInteractionMode(selectedWakeMode);
    if(!requiredMode||binding.participationMode!==requiredMode) {
      setHostMessage('The selected mode does not match this registered input. Revoke and re-register the binding before arming it.');
      return;
    }
    const joinedSession=hostedAiSessions.find(session=>session.sessionDigest===binding.sessionDigest&&session.participantId===binding.participantId);
    const sessionExpiry=typeof joinedSession?.expiresAt==='string'?Date.parse(joinedSession.expiresAt):NaN;
    const credentialExpiry=typeof joinedSession?.credentialExpiresAt==='string'?Date.parse(joinedSession.credentialExpiresAt):NaN;
    const sessionBoundTtlMs=Math.min(86400000,Math.floor(credentialExpiry-Date.now()-15000));
    if(!Number.isFinite(sessionExpiry)||sessionExpiry<=Date.now()||
       !Number.isFinite(sessionBoundTtlMs)||sessionBoundTtlMs<60000) {
      setHostMessage('This joined AI session is no longer live or its exact invitation credential expires too soon for a one-minute wake grant. Rejoin with a valid invitation, refresh the session list, then arm it again.');
      return;
    }
    const consentMinutes=Math.floor(sessionBoundTtlMs/60000);
    const consentDuration=consentMinutes>=60
      ? Math.floor(consentMinutes/60)+' hour(s) '+(consentMinutes%60)+' minute(s)'
      : consentMinutes+' minute(s)';
    if(!window.confirm('Enable the selected original AI conversation to receive canonical @RMconnects event triggers automatically for up to '+consentDuration+'? This can press Send in that exact selected AI chat without per-message confirmation. It is limited to six triggers per minute. It expires with the exact joined invitation credential and cannot be silently renewed. You can revoke it or use Emergency Stop at any time.'))return;
    setHostBusy(true);
    try{
      if(!supabase||!hostInfo.enrollmentDigest)throw new Error('Owner-authenticated host registration is missing. Re-pair before enabling Auto.');
      const {data:renewedHost,error:renewHostError}=await supabase.functions.invoke('backroom-config/host',{
        body:{hostId:hostInfo.hostId,credentialDigest:hostInfo.enrollmentDigest,ttlSeconds:Math.max(86400,Math.ceil(sessionBoundTtlMs/1000)+3600)}
      });
      if(renewHostError||renewedHost?.ok!==true)throw new Error('Could not renew the owner-authorized host lease for the 24-hour Auto session.');
      const grant=await hostApi<{grantId:string;expiresAt:number}>('/v1/browser/wake/grants',{
        method:'POST',body:{
          targetId:binding.targetId,roomId:binding.roomId,
          participantId:binding.participantId,sessionId:binding.sessionId,
          bindingId:binding.bindingId,confirmed:true,ttlMs:sessionBoundTtlMs,maxPerMinute:6
        }
      });
      if(typeof grant.grantId!=='string')throw new Error('Local wake grant was not confirmed.');
      setHostedWakeGrantId(grant.grantId);
      setHostedWakeBinding(current=>current?{...current,wakeEnabled:true,wakeExpiresAt:new Date(grant.expiresAt).toISOString()}:current);
      setHostMessage(selectedWakeMode.toUpperCase() + ' enabled for this one selected AI input until ' + new Date(grant.expiresAt).toLocaleString() + '. The grant is bounded by this AI session’s exact invitation credential and limited to six triggers per minute.');
    }catch(error){
      setHostMessage(error instanceof Error?error.message:'Wake activation failed and must be retried with consent.');
    }finally{setHostBusy(false);}
  }
  async function chooseWakeMode(nextMode: WakeInteractionMode) {
    const currentRoomBinding = hostedWakeBinding?.roomId === room?.id ? hostedWakeBinding : null;
    if (nextMode === 'off') {
      if (currentRoomBinding) {
        if (!window.confirm('Switching to Off permanently revokes this AI input binding and cancels its pending wake events. You can register it again later. Continue?')) return;
        const revoked = await revokeHostedWakeBinding(true);
        if (revoked) setSelectedWakeMode('off');
        return;
      }
      setSelectedWakeMode('off');
      setHostMessage('Interaction mode is Off for this group. No input binding is armed here; other groups’ independently registered bindings are unchanged.');
      return;
    }
    const requiredMode = participationModeForInteractionMode(nextMode);
    if (!requiredMode) return;
    if (currentRoomBinding && needsWakeBindingRebind(nextMode, currentRoomBinding.participationMode)) {
      const oldMode = currentRoomBinding.participationMode
        ? interactionModeForParticipationMode(currentRoomBinding.participationMode) || 'the existing'
        : 'the existing';
      if (!window.confirm('Changing from ' + oldMode + ' to ' + nextMode.toUpperCase() + ' requires revoking the old binding and cancelling its queued wakes. Continue?')) return;
      const revoked = await revokeHostedWakeBinding(true);
      if (!revoked) return;
    }
    setSelectedWakeMode(nextMode);
    setHostMessage(nextMode.toUpperCase() + ' selected. Register or arm the exact browser composer to activate this mode.');
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
        : 'Wake grant revoked locally and polling stopped, but the server did not confirm remote deactivation. The old consent expires within 24 hours. For immediate server-side cancellation, revoke this input binding.');

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
      setHostMessage(info.capabilities.browserDraft ? 'Host is reachable. Browser and external workspace adapters report their own verified capabilities.' : 'Host is reachable. Launch the managed browser or inspect the separately reported external workspace runtime status.');
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
          capabilities: { ...previous.capabilities, browserDraft: false, browserView: false },
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
      const result=await response.json().catch(()=>({})) as {revoked?:boolean;runtimesStopped?:boolean;externalWorkspacesStopped?:boolean;restartRequired?:boolean;error?:string;hint?:string};
      if (!response.ok && result.revoked!==true) throw new Error(result.hint || 'Could not revoke the host session. Keep this tab open and retry.');
      if(result.revoked!==true)throw new Error('The host did not confirm session revocation. Keep this tab open and retry.');
      try { sessionStorage.removeItem('rub-backroom-host-session-v1:' + user?.id); } catch {}
      setHostToken(''); setHostInfo(null);
      setBrowserPages([]); setBrowserTargets([]); setSelectedBrowserTarget('');
      setHostMessage(result.restartRequired
        ? (result.runtimesStopped===false
          ? 'Host session revoked, but local runtime cleanup could not be verified. Stop the Backroom host with Ctrl+C, inspect remaining sandbox processes, then restart it.'
          : 'Host session revoked and local workspace adapters stopped. Restart the Backroom host process before using desktop, Android, or terminal adapters again.')
        : 'Host session revoked.');
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
        capabilities: { ...previous.capabilities, browserDraft: false, browserView: false },
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
  async function toggleLiveBrowserView() {
    if (!current?.pageId || !room?.id || !hostToken || hostInfo?.capabilities.browserView !== true) {
      setNotice('A paired, updated local browser host and a selected managed tab are required for this view adapter.');
      return;
    }
    if (liveViewEnabled && liveGrantId) {
      try {
        const result = await hostApi<{ revoked: boolean }>('/v1/browser/view/revoke', {
          method: 'POST', body: { pageId: current.pageId, roomId: room.id, grantId: liveGrantId },
        });
        if (!result.revoked) throw new Error('The view permission was already expired or revoked.');
        setLiveViewEnabled(false); setLiveGrantId(''); setLiveFrame(null);
        setNotice('Read-only view permission revoked. No further screenshots will be requested.');
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not confirm view revocation.');
      }
      return;
    }
    if (!window.confirm('Request read-only screenshots of this exact managed browser tab? The paired host terminal will ask for a separate local approval. Images stay in this browser session, are not stored by Rub Minds, and are not uploaded. This does not grant draft insertion, sending or terminal access.')) return;
    setBrowserBusy(true);
    setLiveFrame(null);
    try {
      const grant = await hostApi<{ grantId: string; pageId: string; roomId: string; expiresAt: number }>(
        '/v1/browser/view/grant', { method: 'POST', body: { pageId: current.pageId, roomId: room.id } },
      );
      if (grant.pageId !== current.pageId || grant.roomId !== room.id ||
        !/^[a-f0-9-]{36}$/i.test(grant.grantId) || !Number.isFinite(grant.expiresAt)) {
        throw new Error('The local host returned an invalid browser view permission.');
      }
      setLiveGrantId(grant.grantId);
      setLiveViewEnabled(true);
      setNotice('Read-only view approved on the local host. Screenshots will refresh while this view remains open.');
    } catch (error) {
      setLiveGrantId(''); setLiveViewEnabled(false);
      setNotice(error instanceof Error ? error.message : 'Local browser view approval was denied.');
    } finally { setBrowserBusy(false); }
  }
  async function registerLiveRegion(frameId: string, region: Rect) {
    const pageId = current?.pageId;
    const groupId = room?.id;
    if (!pageId || !groupId || !hostToken || !liveViewEnabled || !liveFrame) return;
    if (!window.confirm('Register the field inside this rectangle on the selected live tab? The local host must resolve it to one visible, editable, empty composer. This does not send anything. A provider-specific canonical wake capability, when available, still requires a separate joined-AI binding and explicit local consent before it can submit a fixed @RMconnects trigger.')) return;
    setBrowserBusy(true);
    try {
      const target = await hostApi<BrowserTargetRow>('/v1/browser/select-region', {
        method: 'POST', body: { pageId, roomId: groupId, frameId, region },
      });
      if (target.pageId !== pageId || target.roomId !== groupId || target.surface !== 'browser_tab' ||
        !Array.isArray(target.operations) || !target.operations.includes('draft') ||
        (target.wakeAvailable === true && !target.operations.includes('wake')) ||
        (target.wakeAvailable !== undefined && typeof target.wakeAvailable !== 'boolean')) {
        throw new Error('The local host returned an inconsistent target capability or a target outside the selected tab.');
      }
      setBrowserTargets(previous => [target, ...previous.filter(existing => existing.id !== target.id)]);
      setSelectedBrowserTarget(target.id);
      setNotice(target.wakeAvailable===true ? 'Live composer registered. The host retains the exact DOM node and verified provider wake control. No message was sent; On / Auto still require a joined-AI binding and explicit local consent.' : 'Live text field registered for verified draft insertion only. No message was sent.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not register this live typing area.');
    } finally { setBrowserBusy(false); }
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
      const capabilities = { ...runtimeStatus.capabilities,
        browserDraft: runtimeStatus.running && runtimeStatus.capabilities.browserDraft,
        browserView: runtimeStatus.running && runtimeStatus.capabilities.browserView === true,
      };
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
      const status = await hostApi<{ running: boolean; capabilities?: Record<string, boolean> }>('/v1/browser/start', { method: 'POST' });
      if (!status.running) throw new Error('Managed browser did not start.');
      setHostInfo(previous => previous ? { ...previous, executionReady: true, capabilities: { ...previous.capabilities, browserDraft: true, browserView: status.capabilities?.browserView === true } } : previous);
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
      setHostInfo(previous => previous ? { ...previous, executionReady: false, capabilities: { ...previous.capabilities, browserDraft: false, browserView: false }, browserPages: 0 } : previous);
      setLiveViewEnabled(false); setLiveGrantId(''); setLiveFrame(null);
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
    if (!room || !hostToken || !hostInfo?.connected || !hostInfo.capabilities.browserDraft || spaces.length >= 30) return;
    const selectedPage = browserPages.find(page => page.pageId === selectedBrowserPage && page.canSelect);
    if (!selectedPage) {
      setNotice('Discover and select a verified managed browser tab before adding an app.');
      return;
    }
    const displayName = (selectedPage.title || selectedPage.site || 'Browser conversation').trim().slice(0, 60);
    const next: Space = {
      id: randomId(), name: displayName, app: selectedPage.site, surface: 'browser_tab',
      pageId: selectedPage.pageId, createdAt: Date.now(),
    };
    save([...spaces, next]); setActive(next.id);
    setAdding(false); setSelectedBrowserPage('');
    setLiveViewEnabled(false); setLiveGrantId(''); setLiveFrame(null);
    setNotice('Verified managed browser tab added. Start its separate local view permission from the workspace to display screenshots.');
  }
  if (loading) return <div className="br-gate">Checking Backroom access…</div>;
  if (!user || error) return <div className="br-gate"><ShieldCheck size={36}/><h1>Backroom access</h1><p>{error || 'Please sign in.'}</p><a href="/">Return to Rub Minds</a></div>;
  return <div className="br-shell">
    <aside className="br-sidebar">
      <a className="br-brand" href="/"><span className="br-brand-mark"><Layers3 size={22}/></span><span><b>rub minds</b><small>BACKROOM</small></span></a>
      <div className="br-side-heading">WORKSPACE</div>
      <label className="br-room-label" htmlFor="br-room">Active group</label>
      <div className="br-select-wrap"><select id="br-room" aria-label="Active Rub Minds group" value={room?.id || ''} onChange={e => {
        const params = new URLSearchParams(location.search);
        params.set('backroom', '1');
        params.set('room', e.target.value);
        history.replaceState(null, '', location.pathname + '?' + params.toString());
        setRoomId(e.target.value);
      }}><option value="">Select a group</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><ChevronDown size={15}/></div>
      <div className="br-side-heading br-space-heading">SPACES <span>{spaces.length}</span></div>
      <div className="br-space-list">{spaces.map(s => { const Icon = iconFor(s.surface); return <button className={'br-space-item' + (s.id === active ? ' active' : '')} key={s.id} onClick={() => { setActive(s.id); setNotice(''); }}><span className="br-space-icon"><Icon size={18}/></span><span className="br-space-name"><b>{s.name}</b><small>{surfaces.find(t => t.id === s.surface)?.name}</small></span><span className="br-offline-dot"/></button>; })}</div>
      <button className="br-add-side" onClick={() => setAdding(true)} disabled={!room || spaces.length >= 30}><Plus size={17}/> Add a space</button>
      <div className="br-side-footer"><span>{hostInfo?.connected ? <Check size={15}/> : <WifiOff size={15}/>} {hostInfo?.connected ? "Local host connected" : hostInfo ? "Local host not reachable" : "No device host connected"}</span><small>{wakeGatewayMismatch(hostInfo) ? `Wake gateway mismatch · ${hostInfo?.wakeGatewayHost} is not this Preview's Supabase project.` : hostInfo?.capabilities.browserDraft ? "Browser draft only · native drivers unavailable" : hostInfo?.connected ? "Host online · browser driver not started" : "Workspace layouts remain local · no active device control"}</small></div>
    </aside>
    <main className="br-main">
      <header className="br-topbar"><div className="br-breadcrumb"><a href="/"><ArrowLeft size={15}/> Groups</a><span>/</span><b>Backroom</b></div><div className="br-top-right"><button type="button" className={'br-status-pill' + (hostInfo ? ' paired' : '') + (hostStopped ? ' br-status-stopped' : '')} onClick={() => setHostModal(true)}><span/> {hostStopped ? 'Emergency stop · restart required' : hostInfo?.connected && wakeGatewayMismatch(hostInfo) ? 'Host paired · wake gateway mismatch' : hostInfo?.connected ? (hostInfo.capabilities.browserDraft ? 'Host paired · browser ready' : 'Host paired · browser idle') : hostInfo ? 'Host offline · session saved' : 'Host offline'}</button><span className="br-avatar">{user.email?.slice(0, 1).toUpperCase() || 'U'}</span></div></header>
      {!room ? <div className="br-empty"><Layers3 size={42}/><h1>Choose a Rub Minds group</h1><p>Backroom spaces are scoped to your authenticated group. Select one from the sidebar to begin.</p></div> :
      <div className="br-content">
        <div className="br-title-row"><div><div className="br-eyebrow"><Activity size={14}/> MULTI-SPACE COORDINATION</div><h1>Backroom <span>workspace</span></h1><p>One group. Multiple AI interfaces. Start with an explicitly approved browser draft.</p></div><button className="br-primary" onClick={() => setAdding(true)} disabled={spaces.length >= 30}><Plus size={17}/> New space</button></div>
        <div className="br-metrics"><div><span>Registered spaces</span><strong>{spaces.length.toString().padStart(2, '0')}</strong><small>Local workspace layouts</small></div><div><span>Connected hosts</span><strong>{hostInfo?.connected ? "01" : "00"}</strong><small>{hostInfo?.connected ? "Local host is reachable" : hostInfo ? "Reconnect to verify the saved host" : "Pair a local host to connect"}</small></div><div><span>Active automations</span><strong>00</strong><small>No device commands running</small></div></div>
        {notice && <div className="br-notice" role="status"><CircleHelp size={16}/>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {!current ? <div className="br-empty-card"><div className="br-empty-symbol"><Layers3 size={34}/></div><h2>Give every AI its own space.</h2><p>Connect the original AI apps and sessions on your phone, desktop, terminal or managed browser. Each surface appears only when its real local runtime is registered and reachable.</p><button className="br-primary" onClick={() => setAdding(true)}><Plus size={16}/> Create your first space</button><div className="br-platforms">{surfaces.map(s => { const Icon = iconFor(s.id); return <span key={s.id} title={s.name}><Icon size={18}/></span>; })}</div></div> :
        <div className="br-workspace-grid"><section className="br-panel br-stage"><div className="br-panel-head"><div><span className="br-eyebrow">ACTIVE SPACE</span><h2>{current.name}</h2><p>{current.app || surfaces.find(s => s.id === current.surface)?.detail}</p></div><button className="br-icon-button" aria-label="Remove this local space" title="Remove local space" onClick={() => { if (!confirm('Remove this saved app session from Backroom? This will not close the app on your computer.')) return; save(spaces.filter(s => s.id !== current.id)); setActive(''); }}><Trash2 size={17}/></button></div>{current.pageId
          ? liveViewEnabled && liveFrame
            ? <LiveBrowserPreview key={current.id} frame={liveFrame} appName={current.app || current.name}
              wakeMode={selectedWakeMode}
              onWakeModeChange={mode => void chooseWakeMode(mode)}
              wakeModeDisabled={hostBusy || browserBusy || !wakeBindingStatusKnown}
              findSessionsDisabled={hostBusy || browserBusy}
              wakeCapable={browserTargets.some(target => target.id===selectedBrowserTarget && target.roomId===room.id && target.wakeAvailable===true)}
              wakeModeStatus={!wakeBindingStatusKnown
                ? 'Find the exact joined AI session first so Backroom can restore its server-side mode and local poller state.'
                : !selectedBrowserTarget
                  ? 'Drag-select one exact composer in this frame. On and Auto become available only when its provider adapter verifies canonical wake support.'
                  : !browserTargets.some(target => target.id===selectedBrowserTarget && target.roomId===room.id && target.wakeAvailable===true)
                    ? 'This registered field supports draft insertion only. Choose a verified ChatGPT or Claude composer with a unique visible Send control for On / Auto.'
                  : hostedWakeBinding?.roomId===room.id && hostedWakeBinding.targetId===selectedBrowserTarget
                  ? hostedWakeBinding.serverWakeEnabled && !hostedWakeBinding.localPollingConfirmed
                    ? 'A server grant exists but the paired host did not confirm its poller. Revoke or restart/re-pair before enabling this target.'
                    : hostedWakeBinding.wakeEnabled
                      ? selectedWakeMode.toUpperCase() + ' is active on this exact managed-browser target.'
                      : selectedWakeMode.toUpperCase() + ' is selected but not armed. Open host settings to register the joined AI and approve the bounded grant.'
                  : selectedWakeMode==='off'
                    ? 'Off: this frame has no active automatic wake binding.'
                    : selectedWakeMode.toUpperCase() + ' selected. Register this exact frame composer to activate it.'}
              onFindSessions={() => void discoverHostedAiSessions()}
              onSelectRegion={(frameId, region) => void registerLiveRegion(frameId, region)}/>
            : <div className="br-live-placeholder" role="status"><Monitor size={28}/><b>{liveViewEnabled ? 'Connecting to the selected browser tab…' : 'Live view paused'}</b><p>{hostInfo?.capabilities.browserView ? 'Enable the read-only local view to display the actual managed tab here. Its screenshots are not stored or uploaded.' : 'This paired host does not advertise the browser-view adapter. Update and restart the local host.'}</p></div>
          : <div className="br-live-placeholder" role="status">
              <Monitor size={28}/><b>No verified app session</b>
              <p>This saved entry is not linked to a discovered live browser tab. Add the original app from the paired local browser instead.</p>
            </div>}
        <div className="br-stage-foot"><MousePointer2 size={16}/><span>{current.pageId ? (liveFrame ? 'Local screenshot view. Drag around one empty field to register a real DOM target.' : 'This space is linked to a discovered tab; no screenshot is being captured while paused.') : 'This saved entry has no verified live app session.'}</span>{current.pageId
          ? <button type="button" className="br-sample-select" onClick={() => void toggleLiveBrowserView()} disabled={browserBusy || !hostInfo?.connected || hostInfo.capabilities.browserView !== true}>{liveViewEnabled ? 'Revoke view permission' : 'Request local view permission'}</button>
          : <button type="button" className="br-sample-select" onClick={() => { save(spaces.filter(space => space.id !== current.id)); setActive(''); }}>Remove disconnected entry</button>}</div></section>
        <section className="br-panel br-inspector"><span className="br-eyebrow">SPACE INSPECTOR</span><h2>Connection details</h2><div className="br-detail"><span>Platform</span><b>{surfaces.find(s => s.id === current.surface)?.name}</b></div><div className="br-detail"><span>Host status</span><b className="br-muted">{hostInfo?.connected ? (hostInfo.capabilities.browserDraft ? 'Paired · browser draft only' : 'Paired · browser idle') : hostInfo ? 'Offline · paired before' : 'Not connected'}</b></div><div className="br-detail"><span>App view</span><b className="br-muted">{current.pageId ? (liveFrame ? 'Local screenshot view active' : liveViewEnabled ? 'Connecting' : 'Paused') : 'No verified app session'}</b></div><div className="br-detail"><span>View permission</span><b className="br-muted">{current.pageId && liveViewEnabled ? 'Enabled for this tab' : 'Not enabled'}</b></div><div className="br-detail"><span>Typing target</span><b>{currentBrowserTarget ? (currentBrowserTarget.wakeAvailable===true && currentBrowserTarget.operations.includes('wake') ? 'Verified · canonical wake available' : 'Verified · draft only') : 'Not registered'}</b></div><div className="br-onboard-steps"><b>Open this app in Backroom</b><div><span>1</span> Connect and authenticate the device host</div><div><span>2</span> Choose the real app, window, tab or terminal session</div><div><span>3</span> Approve view and draft permissions separately on the device</div><div><span>4</span> Start an authorized live view (driver required)</div></div><div className="br-warning"><ShieldCheck size={19}/><div><b>{current.pageId ? 'Local tab identity and draft-only permissions' : 'No verified app connection'}</b><p>{current.pageId ? 'This tile is linked to a discovered managed browser tab. View permission is separate from draft registration. The local host resolves drag selections against one exact visible DOM field, then revalidates the node and conversation before inserting text. Enter, Send and submission are not part of this adapter.' : 'This saved entry has no verified app connection. Add an original app only after the paired local runtime discovers its real session and identity.'}</p></div></div><button className="br-disabled-action" onClick={() => setHostModal(true)}><Command size={16}/> {hostInfo ? 'Manage local host' : 'Pair local host'} <span>{hostInfo?.connected ? 'Online' : hostInfo ? 'Offline' : 'Connect'}</span></button></section></div>}
        <BackroomDesktopControl roomId={room.id} />
        {hostToken && <ExternalWorkspacePanel
          hostToken={hostToken}
          roomId={room.id}
          hostApi={hostApi}
          sessions={hostedAiSessions}
          selectedSessionDigest={selectedHostedSession}
          onSelectSession={setSelectedHostedSession}
          onFindSessions={() => void discoverHostedAiSessions()}
        />}
        <div className="br-bottom-note"><Cpu size={16}/><span>This browser workspace displays the actual managed Chromium app session after trusted host approval. Draft insertion is separate and never submits. Phone, desktop and terminal controls are provided by their respective paired local runtimes; availability and target capability are reported per connected device.</span><a href="https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/48" target="_blank" rel="noreferrer">Backroom core <ExternalLink size={13}/></a></div>
      </div>}
    </main>
    {hostModal && <div className="br-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setHostModal(false); }}><div className="br-modal" role="dialog" aria-modal="true" aria-labelledby="br-host-title"><div className="br-modal-top"><div className="br-modal-icon"><Cpu size={22}/></div><button className="br-icon-button" onClick={() => setHostModal(false)} aria-label="Close host pairing"><X size={20}/></button></div><h2 id="br-host-title">{hostStopped ? 'Emergency stop is active' : hostInfo ? 'Local host connection' : 'Pair a local host'}</h2><p>Run the Backroom host on this same computer, then enter its one-time code. Use a current Chrome or Edge browser; local-network permission may be required. Embedded webviews, Firefox or Safari may block this HTTP loopback connection. Pairing exposes host status first. Browser, desktop, Android and terminal capabilities are advertised only when the respective local runtime is actually configured and ready.</p>{hostMessage && <div className="br-host-message" role="status">{hostMessage}</div>}{hostInfo && wakeGatewayMismatch(hostInfo) && <div className="br-host-message br-host-stopped" role="alert">This local host sends wake requests to {hostInfo.wakeGatewayHost}, but this Rub Minds Preview uses {expectedSupabaseHost}. Stop the host and restart it with BACKROOM_WAKE_GATEWAY_URL set to this project's exact backroom-wake function URL before enabling hosted wake.</div>}{!hostInfo ? <>{hostStopped && <div className="br-host-message br-host-stopped" role="status">The previous host session was emergency-stopped. Stop the old local host process with Ctrl+C, restart it to generate a fresh one-time code, then pair below. The host health check will reject pairing if the emergency stop is still latched.</div>}<label htmlFor="br-host-url">Local host address</label><input id="br-host-url" autoFocus value={hostUrl} onChange={e => setHostUrl(e.target.value)} placeholder="http://127.0.0.1:43781" autoCapitalize="none" spellCheck={false}/><label htmlFor="br-pair-code">One-time pairing code</label><input id="br-pair-code" value={pairingCode} onChange={e => setPairingCode(e.target.value.trim().slice(0, 32))} placeholder="Paste code from the host terminal" autoComplete="off" autoCapitalize="none" spellCheck={false}/><div className="br-warning"><ShieldCheck size={19}/><div><b>Local-only connection</b><p>The host should bind to 127.0.0.1. Never share the pairing code or session token with a Rub Minds group.</p></div></div><div className="br-modal-actions"><button className="br-secondary" onClick={() => setHostModal(false)}>Close</button><button className="br-primary" onClick={() => void pairLocalHost()} disabled={hostBusy || !/^[a-f0-9]{32}$/i.test(pairingCode.trim())}>{hostBusy ? 'Pairing…' : 'Pair host'} <ArrowRight size={16}/></button></div></> : <><div className="br-detail"><span>Host ID</span><b>{hostInfo.hostId}</b></div><div className="br-detail"><span>Connection</span><b>{hostInfo.connected ? 'Authenticated' : 'Offline'}</b></div><div className="br-detail"><span>Available local capability</span><b className="br-muted">{hostInfo.capabilities.browserDraft ? 'Browser draft insertion only' : 'No execution driver enabled'}</b></div><div className="br-warning"><ShieldCheck size={19}/><div><b>{hostInfo.capabilities.browserDraft ? 'Browser draft adapter ready' : 'Browser adapter not started'}</b><p>{hostInfo.capabilities.browserDraft ? 'The managed browser supports inserting text into an explicitly registered empty composer. It never presses Send.' : 'Launch a dedicated visible browser profile. Log into AI websites yourself; Backroom does not copy existing cookies or sign you in.'} Desktop, Android and terminal actions appear in Connected workspaces only when their local adapters are configured and ready.</p></div></div>
<div className="br-browser-panel"><div className="br-browser-panel-head"><div><b>Managed browser</b><small>Visible Chromium · local profile only</small></div><button className="br-secondary" onClick={() => void refreshBrowserInventory()} disabled={browserBusy || !hostInfo.capabilities.browserDraft}><Activity size={14}/> Refresh tabs</button></div>
{!hostInfo.capabilities.browserDraft ? <button className="br-primary br-browser-launch" onClick={() => void startManagedBrowser()} disabled={browserBusy}>{browserBusy ? 'Starting browser…' : 'Launch managed browser'} <ArrowRight size={15}/></button> : <>
<div className="br-browser-open"><label className="br-browser-field-label" htmlFor="br-browser-url">Open an AI website</label><div className="br-browser-open-row"><input id="br-browser-url" type="url" value={browserUrl} onChange={e=>setBrowserUrl(e.target.value)} placeholder="https://chatgpt.com/" autoCapitalize="none" spellCheck={false}/><button className="br-primary" onClick={() => void openManagedUrl()} disabled={browserBusy || !browserUrl.trim()}>Open</button></div><div className="br-browser-quick"><button className="br-secondary" onClick={()=>setBrowserUrl('https://chatgpt.com/')} disabled={browserBusy}>ChatGPT</button><button className="br-secondary" onClick={()=>setBrowserUrl('https://claude.ai/new')} disabled={browserBusy}>Claude</button></div></div><div className="br-browser-pages">{browserPages.map(page => <div className="br-browser-page" key={page.pageId}><div className="br-browser-page-icon"><Monitor size={16}/></div><div className="br-browser-page-label"><b>{page.site}</b><small>{page.title || 'Untitled conversation tab'}</small></div><button className="br-secondary" onClick={() => void registerBrowserInput(page.pageId)} disabled={browserBusy}>Select input</button></div>)}{!browserPages.length && <p className="br-browser-empty">No supported browser tabs found. Open a conversation in the managed browser and refresh.</p>}</div>
{roomBrowserTargets.length>0 && <><label className="br-browser-field-label" htmlFor="br-browser-target">Registered typing area</label><select id="br-browser-target" value={selectedBrowserTarget} onChange={e=>setSelectedBrowserTarget(e.target.value)}><option value="">Choose a typing target</option>{roomBrowserTargets.map(t=><option key={t.id} value={t.id}>{t.site} · {t.title}</option>)}</select><div className="br-browser-target-actions"><button className="br-secondary" onClick={() => void removeBrowserTarget()} disabled={browserBusy || !roomBrowserTargets.some(t => t.id === selectedBrowserTarget)}>Remove selected target</button></div><label className="br-browser-field-label" htmlFor="br-group-message">Source group message (optional)</label><select id="br-group-message" value={selectedGroupMessageId} onChange={e => { const id = e.target.value; setSelectedGroupMessageId(id); const message = groupMessages.find(m => m.id === id); if (message) setBrowserDraftText(message.body); }}><option value="">Write a manual draft instead</option>{groupMessages.map(m => <option key={m.id} value={m.id}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {m.body.slice(0, 90).replace(/\s+/g, ' ')}</option>)}</select><label className="br-browser-field-label" htmlFor="br-browser-draft">Text to draft (not sent)</label><textarea id="br-browser-draft" rows={3} maxLength={10000} value={browserDraftText} onChange={e=>setBrowserDraftText(e.target.value)} placeholder="Write the exact text to insert into the selected composer…"/><button className="br-primary br-browser-draft" onClick={() => void draftToBrowser()} disabled={browserBusy || !roomBrowserTargets.some(t => t.id === selectedBrowserTarget) || !browserDraftText.trim()}>Insert draft — never send <ArrowRight size={15}/></button><p className="br-browser-caption">Target registration stores the selector locally. Text is inserted only after confirmation, only into an empty input, and is read back to verify success.</p></>}
<button className="br-secondary br-browser-stop" onClick={() => void stopManagedBrowser()} disabled={browserBusy}>Close managed browser</button></>}
{browserNotice && <div className="br-host-message" role="status">{browserNotice}</div>}</div>
<div className="br-browser-caption">Choose Off / On / Auto beside the live composer frame. On requires an explicit mention; Auto wakes on human-authored group messages. Both use only the canonical trigger and require local consent.</div>
{room?.id && hostInfo.enrollmentDigest && <div>
  <div className="br-modal-actions"><button className="br-secondary" onClick={() => void discoverHostedAiSessions()} disabled={hostBusy || browserBusy}>Find joined AI sessions</button></div>
  {hostedAiSessions.length>0 && <>
    <label htmlFor="br-hosted-ai-session">Joined AI conversation</label>
    <select id="br-hosted-ai-session" value={selectedHostedSession} onChange={e=>{const digest=e.target.value;setSelectedHostedSession(digest);const selected=hostedAiSessions.find(s=>s.sessionDigest===digest);if(selected&&room?.id)void restoreHostedWakeBinding(room.id,selected);}}>{hostedAiSessions.map(s=><option key={s.sessionDigest} value={s.sessionDigest}>{s.displayName} · {s.participantId.slice(0,8)}</option>)}</select>
    <p>Selected local input: {browserTargets.find(t=>t.id===selectedBrowserTarget)?.title || 'Select a managed browser target before binding.'}</p>
    <div className="br-modal-actions"><button className="br-secondary" onClick={() => void bindHostedWakeInput()} disabled={hostBusy || browserBusy || !wakeBindingStatusKnown || !selectedBrowserTarget || selectedWakeMode==='off'}>Register inactive {selectedWakeMode==='auto'?'Auto':'On'} input binding</button></div>
  </>}
  {hostedWakeBinding && hostedWakeBinding.roomId===room.id && <>
    <div className="br-detail"><span>Wake status</span><b>{hostedWakeBinding.requiresRevoke?'Existing binding · revoke before rebind':wakeBindingNeedsRebind?'Mode change · rebind required':hostedWakeBinding.serverWakeEnabled&&!hostedWakeBinding.localPollingConfirmed?'Server grant stale · revoke required':(hostedWakeGrantId||hostedWakeBinding.wakeEnabled)?selectedWakeMode.toUpperCase()+' armed · up to 24 hours':selectedWakeMode==='off'?'Off · no wake grant':selectedWakeMode.toUpperCase()+' selected · not armed'}</b></div>
    <div className="br-modal-actions">
      {hostedWakeBinding.requiresRevoke || wakeBindingNeedsRebind
        ? <button className="br-danger-action" disabled={hostBusy || browserBusy} onClick={() => void revokeHostedWakeBinding()}>Revoke binding to apply selected mode</button>
        : (hostedWakeGrantId || hostedWakeBinding.wakeEnabled || hostedWakeBinding.serverWakeEnabled)
          ? <button className="br-danger-action" disabled={hostBusy || browserBusy} onClick={() => void chooseWakeMode('off')}>Turn Off and revoke binding</button>
          : !wakeBindingStatusKnown
            ? <span className="br-browser-caption">Wake status is unknown. Restore the exact joined AI session status before changing modes or creating another binding.</span>
          : selectedWakeMode==='off'
            ? <span className="br-browser-caption">Off is not armed. Choose On or Auto, then register the intended input.</span>
            : <button className="br-primary" disabled={hostBusy || browserBusy || !wakeBindingStatusKnown || hostedWakeBinding.targetId!==selectedBrowserTarget} onClick={() => void enableHostedWake()}>Arm {selectedWakeMode.toUpperCase()} for 24 hours</button>}
    </div>
    {!hostedWakeBinding.requiresRevoke && <div className="br-modal-actions"><button className="br-secondary" disabled={hostBusy || browserBusy} onClick={() => void revokeHostedWakeBinding()}>Permanently unbind this AI input</button></div>}
  </>}
</div>}
<div className="br-emergency-stop-row"><div><b>Emergency stop</b><small>Close Chromium, revoke all paired sessions, and block reconnection until the host is restarted.</small></div><button className="br-danger-action" onClick={() => void emergencyStopLocalHost()} disabled={hostBusy || browserBusy || !hostToken}>Stop all</button></div>
{hostInfo.enrollmentDigest && <><div className="br-modal-actions"><button className="br-secondary" onClick={() => void registerHostedWakeHost()} disabled={hostBusy || browserBusy}>Register or renew hosted wake host</button></div><div className="br-modal-actions"><button className="br-danger-action" onClick={() => void revokeHostedWakeHost()} disabled={hostBusy || browserBusy}>Permanently revoke hosted host</button></div></>}<div className="br-modal-actions"><button className="br-secondary" onClick={() => void unpairLocalHost()} disabled={hostBusy || browserBusy}>Unpair</button><button className="br-primary" onClick={() => void checkLocalHost()} disabled={hostBusy || browserBusy}>{hostBusy ? 'Checking…' : 'Check connection'}</button></div></>}</div></div>}
    {adding && <div className="br-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAdding(false); }}><div className="br-modal" role="dialog" aria-modal="true" aria-labelledby="br-modal-title"><div className="br-modal-top"><div className="br-modal-icon"><Plus size={22}/></div><button className="br-icon-button" onClick={() => setAdding(false)} aria-label="Close"><X size={20}/></button></div><h2 id="br-modal-title">Add a discovered app</h2><p>A space is created only from an app or session the paired local host actually discovered. This first live adapter supports managed Chromium tabs.</p>{!hostToken || !hostInfo?.connected
          ? <div className="br-discovery-state"><b>Device disconnected</b><p>Connect and authenticate the Backroom host on this computer before discovering applications.</p><button className="br-primary" onClick={() => { setAdding(false); setHostModal(true); }}>Connect device</button></div>
          : !hostInfo.capabilities.browserDraft
            ? <div className="br-discovery-state"><b>Browser driver unavailable</b><p>Pair the host, then launch the dedicated managed Chromium profile. Sign in to ChatGPT, Claude or another supported site yourself.</p><button className="br-primary" onClick={() => { setAdding(false); setHostModal(true); }}>Open device setup</button></div>
            : <><div className="br-discovery-tools"><button className="br-secondary" onClick={() => void refreshBrowserInventory()} disabled={browserBusy}>Discover / refresh verified tabs</button><span>{browserBusy ? 'Discovering…' : browserPages.length + ' discovered tab(s)'}</span></div><label htmlFor="br-discovered-tab">Select a discovered browser session</label><select id="br-discovered-tab" value={selectedBrowserPage} onChange={event => setSelectedBrowserPage(event.target.value)}><option value="">Choose a verified open tab</option>{browserPages.filter(page => page.canSelect).map(page => <option key={page.pageId} value={page.pageId}>{page.site} · {page.title || 'Untitled tab'}</option>)}</select>{!browserPages.length && <p className="br-browser-empty">No supported tabs have been discovered yet. Open a page in the managed browser, then refresh this list.</p>}{browserPages.length > 0 && !browserPages.some(page => page.canSelect) && <p className="br-browser-empty">The host discovered tabs, but none currently has a supported view target.</p>}</>}
          <div className="br-modal-label">Other application drivers</div><div className="br-surface-options">{surfaces.filter(item => item.id !== 'browser_tab').map(item => { const Icon = iconFor(item.id); return <div className="br-surface-option br-surface-unavailable" key={item.id} aria-disabled="true"><Icon size={20}/><span><b>{item.name}</b><small>Driver unavailable · no verified local targets discovered</small></span><span className="br-driver-status">Unavailable</span></div>; })}</div><div className="br-modal-actions"><button className="br-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="br-primary" onClick={add} disabled={!browserPages.some(page => page.pageId === selectedBrowserPage && page.canSelect) || !hostInfo?.connected || !hostInfo.capabilities.browserDraft}>Add selected app <ArrowRight size={16}/></button></div></div></div>}
  </div>;
}
