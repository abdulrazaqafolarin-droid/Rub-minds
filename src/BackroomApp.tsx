import { useEffect, useState, type PointerEvent } from 'react';
import { Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, CircleHelp, Command, Cpu, ExternalLink, Laptop, Layers3, Monitor, MousePointer2, Plus, ShieldCheck, Smartphone, SquareTerminal, Trash2, WifiOff, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { listCloudRooms, type CloudRoom } from './cloudRooms';
import './backroom.css';

type Surface = 'browser_tab' | 'desktop_app' | 'windows_app' | 'terminal' | 'android_app';
type Space = { id: string; name: string; surface: Surface; app: string; createdAt: number };
type Rect = { x: number; y: number; width: number; height: number };
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
  const [error, setError] = useState('');
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
    if (!supabase) { setError('Cloud authentication is not configured.'); setLoading(false); return; }
    let alive = true;
    void supabase.auth.getUser().then(async ({ data, error: authError }) => {
      if (!alive) return;
      if (authError || !data.user) { setError('Sign in to Rub Minds before opening Backroom.'); return; }
      setUser(data.user);
      const list = await listCloudRooms();
      if (alive) setRooms(list);
    }).catch(() => { if (alive) setError('Could not verify your group access.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const room = rooms.find(r => r.id === roomId);
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
      <div className="br-select-wrap"><select id="br-room" value={room?.id || ''} onChange={e => { setRoomId(e.target.value); history.replaceState(null, '', '/?backroom=1&room=' + encodeURIComponent(e.target.value)); }}><option value="">Select a group</option>{rooms.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><ChevronDown size={15}/></div>
      <div className="br-side-heading br-space-heading">SPACES <span>{spaces.length}</span></div>
      <div className="br-space-list">{spaces.map(s => { const Icon = iconFor(s.surface); return <button className={'br-space-item' + (s.id === active ? ' active' : '')} key={s.id} onClick={() => { setActive(s.id); setSelection(null); setNotice(''); }}><span className="br-space-icon"><Icon size={18}/></span><span className="br-space-name"><b>{s.name}</b><small>{surfaces.find(t => t.id === s.surface)?.name}</small></span><span className="br-offline-dot"/></button>; })}</div>
      <button className="br-add-side" onClick={() => setAdding(true)} disabled={!room || spaces.length >= 30}><Plus size={17}/> Add a space</button>
      <div className="br-side-footer"><span><WifiOff size={15}/> No device host connected</span><small>Local workspace preview · no device automation</small></div>
    </aside>
    <main className="br-main">
      <header className="br-topbar"><div className="br-breadcrumb"><a href="/"><ArrowLeft size={15}/> Groups</a><span>/</span><b>Backroom</b></div><div className="br-top-right"><span className="br-status-pill"><span/> Host offline</span><span className="br-avatar">{user.email?.slice(0, 1).toUpperCase() || 'U'}</span></div></header>
      {!room ? <div className="br-empty"><Layers3 size={42}/><h1>Choose a Rub Minds group</h1><p>Backroom spaces are scoped to your authenticated group. Select one from the sidebar to begin.</p></div> :
      <div className="br-content">
        <div className="br-title-row"><div><div className="br-eyebrow"><Activity size={14}/> MULTI-SPACE COORDINATION</div><h1>Backroom <span>workspace</span></h1><p>One group. Multiple AI interfaces. Every space under your control.</p></div><button className="br-primary" onClick={() => setAdding(true)} disabled={spaces.length >= 30}><Plus size={17}/> New space</button></div>
        <div className="br-metrics"><div><span>Registered spaces</span><strong>{spaces.length.toString().padStart(2, '0')}</strong><small>Local workspace layouts</small></div><div><span>Connected hosts</span><strong>00</strong><small>Host pairing not available yet</small></div><div><span>Active automations</span><strong>00</strong><small>No device commands running</small></div></div>
        {notice && <div className="br-notice" role="status"><CircleHelp size={16}/>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={15}/></button></div>}
        {!current ? <div className="br-empty-card"><div className="br-empty-symbol"><Layers3 size={34}/></div><h2>Give every AI its own space.</h2><p>Set up separate workspaces for native phone apps, desktop assistants, terminals and browser sessions. The next step will pair each space with a real device host.</p><button className="br-primary" onClick={() => setAdding(true)}><Plus size={16}/> Create your first space</button><div className="br-platforms">{surfaces.map(s => { const Icon = iconFor(s.id); return <span key={s.id} title={s.name}><Icon size={18}/></span>; })}</div></div> :
        <div className="br-workspace-grid"><section className="br-panel br-stage"><div className="br-panel-head"><div><span className="br-eyebrow">ACTIVE SPACE</span><h2>{current.name}</h2><p>{current.app || surfaces.find(s => s.id === current.surface)?.detail}</p></div><button className="br-icon-button" aria-label="Remove this local space" title="Remove local space" onClick={() => { if (!confirm('Remove this local space layout? No external app will be changed.')) return; save(spaces.filter(s => s.id !== current.id)); setActive(''); setSelection(null); }}><Trash2 size={17}/></button></div><Preview key={current.id} surface={current.surface} selected={selection} onSelect={setSelection}/><div className="br-stage-foot"><MousePointer2 size={16}/><span>Drag across the simulated app to test target selection. This does not control a real device.</span><button type="button" className="br-sample-select" onClick={() => setSelection({ x: 12, y: 72, width: 76, height: 17 })}>Select sample input</button></div></section>
        <section className="br-panel br-inspector"><span className="br-eyebrow">SPACE INSPECTOR</span><h2>Connection details</h2><div className="br-detail"><span>Platform</span><b>{surfaces.find(s => s.id === current.surface)?.name}</b></div><div className="br-detail"><span>Host status</span><b className="br-muted">Not connected</b></div><div className="br-detail"><span>Typing target</span><b>{selection ? 'Preview region selected' : 'Not registered'}</b></div>{selection && <div className="br-coords"><b>Preview selection</b><code>x {selection.x.toFixed(1)}% · y {selection.y.toFixed(1)}%</code><code>w {selection.width.toFixed(1)}% · h {selection.height.toFixed(1)}%</code><button onClick={() => setSelection(null)}>Clear selection</button></div>}<div className="br-warning"><ShieldCheck size={19}/><div><b>Execution locked</b><p>Real app selection and message submission require an installed host, target identity verification and explicit permission. No device access is active.</p></div></div><button className="br-disabled-action" disabled><Command size={16}/> Connect device host <span>Coming next</span></button></section></div>}
        <div className="br-bottom-note"><Cpu size={16}/><span>Backroom foundation preview — group-scoped local layouts only. No hidden device access, background AI replies or remote commands.</span><a href="https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47" target="_blank" rel="noreferrer">Development status <ExternalLink size={13}/></a></div>
      </div>}
    </main>
    {adding && <div className="br-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAdding(false); }}><div className="br-modal" role="dialog" aria-modal="true" aria-labelledby="br-modal-title"><div className="br-modal-top"><div className="br-modal-icon"><Plus size={22}/></div><button className="br-icon-button" onClick={() => setAdding(false)} aria-label="Close"><X size={20}/></button></div><h2 id="br-modal-title">Add a new space</h2><p>Choose the kind of interface this workspace will connect to.</p><label htmlFor="br-name">Space name</label><input id="br-name" maxLength={60} autoFocus placeholder="e.g. Claude research assistant" value={name} onChange={e => setName(e.target.value)}/><label htmlFor="br-app">App or session label <span>(optional)</span></label><input id="br-app" maxLength={100} placeholder="e.g. Claude Desktop · Research thread" value={app} onChange={e => setApp(e.target.value)}/><div className="br-modal-label">Interface type</div><div className="br-surface-options">{surfaces.map(s => { const Icon = iconFor(s.id); return <button key={s.id} className={'br-surface-option' + (surface === s.id ? ' chosen' : '')} onClick={() => setSurface(s.id)}><Icon size={20}/><span><b>{s.name}</b><small>{s.detail}</small></span>{surface === s.id && <Check size={17}/>}</button>; })}</div><div className="br-modal-actions"><button className="br-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="br-primary" onClick={add} disabled={!name.trim()}>Create space <ArrowRight size={16}/></button></div></div></div>}
  </div>;
}
