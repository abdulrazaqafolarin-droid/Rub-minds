import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, Copy, Link2, MessageCircle, Plus, Send, Sparkles, Users, Zap } from 'lucide-react';
import { createRoom, getRoom, getRooms, inviteUrl, sendMessage, subscribe, type Room } from './roomStore';

function useRooms() {
  const [rooms, setRooms] = useState<Room[]>(getRooms);
  useEffect(() => subscribe(() => setRooms(getRooms())), []);
  return rooms;
}

export default function App() {
  const rooms = useRooms();
  const [selected, setSelected] = useState<string>(() => new URLSearchParams(location.search).get('room') || '');
  const [newRoom, setNewRoom] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [draft, setDraft] = useState('');
  const [name, setName] = useState(() => sessionStorage.getItem('rub-name') || 'You');
  const [copied, setCopied] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const room = rooms.find(r => r.id === selected);
  const unknownInvite = !!selected && !room;

  function openRoom(id: string) {
    setSelected(id); history.replaceState(null, '', id ? '/?room=' + encodeURIComponent(id) : '/');
  }
  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const room = createRoom(title, objective);
    setNewRoom(false); setTitle(''); setObjective(''); openRoom(room.id);
    sendMessage(room.id, 'Rub Minds', 'system', 'Room created. Invite an AI collaborator or send the first message.');
  }
  function onSend(e: FormEvent) {
    e.preventDefault(); if (!room || !draft.trim()) return;
    const displayName = name.trim() || 'You';
    sessionStorage.setItem('rub-name', displayName);
    sendMessage(room.id, displayName, 'human', draft); setDraft('');
  }
  async function copyInvite() {
    if (!room) return;
    try { await navigator.clipboard.writeText(inviteUrl(room.id)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { window.prompt('Copy the demo room link:', inviteUrl(room.id)); }
  }
  async function simulateAgent() {
    if (!room || agentBusy) return;
    setAgentBusy(true);
    const latest = getRoom(room.id)?.messages.filter(m => m.role === 'human').at(-1);
    const response = latest
      ? 'I have joined this Rub Minds demo room. I can see the latest human message: “' + latest.text.slice(0, 180) + '”. This is a simulated response, not a connected ChatGPT or Claude session.'
      : 'Hello! I am a simulated AI participant. Send a message and run this demo again to see a response. Real external AI connections are not implemented yet.';
    await new Promise(resolve => setTimeout(resolve, 550));
    sendMessage(room.id, 'Demo Agent', 'agent', response);
    setAgentBusy(false);
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-icon"><Sparkles size={22}/></div><div><strong>Rub Minds</strong><small>Collective intelligence</small></div></div>
        <button className="new-room" onClick={() => setNewRoom(true)}><Plus size={18}/> New group</button>
        <div className="section-label">YOUR GROUPS <span>{rooms.length}</span></div>
        <nav className="room-list">{rooms.length === 0 ? <p className="muted small">No groups yet. Create your first collaboration space.</p> : rooms.map(r => <button key={r.id} className={'room-link ' + (r.id === selected ? 'active' : '')} onClick={() => openRoom(r.id)}><MessageCircle size={17}/><span>{r.title}</span><ArrowRight size={14}/></button>)}</nav>
        <div className="sidebar-footer"><span className="status-dot"/> Local prototype <small>Not yet cloud-connected</small></div>
      </aside>
      <main className="main">
        {unknownInvite ? <section className="empty"><Link2 size={40}/><h1>Invitation link received</h1><p>This prototype stores rooms in the creator's browser only. To join from another device or AI, we must connect the Supabase backend.</p><button className="primary" onClick={() => openRoom('')}>Return home</button></section>
        : room ? <>
          <header className="room-header"><button className="back" onClick={() => openRoom('')} aria-label="Back"><ArrowLeft size={18}/></button><div className="room-heading"><h2>{room.title}</h2><span><span className="status-dot"/> Demo workspace · {room.messages.length} messages</span></div><button className="invite" onClick={copyInvite}>{copied ? <Check size={17}/> : <Link2 size={17}/>} {copied ? 'Copied' : 'Copy invite'} </button></header>
          <div className="objective"><Sparkles size={17}/><div><strong>Group objective</strong><p>{room.objective || 'Explore ideas and collaborate together.'}</p></div></div>
          <div className="messages" aria-live="polite">{room.messages.map(m => <div key={m.id} className={'message ' + m.role}><div className="avatar">{m.role === 'agent' ? <Bot size={18}/> : m.role === 'system' ? <Sparkles size={16}/> : m.sender.slice(0, 1).toUpperCase()}</div><div><div className="message-meta"><strong>{m.sender}</strong><time>{new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.text}</p></div></div>)}</div>
          <div className="composer-area"><div className="demo-action"><span><Bot size={16}/> Test an AI participant</span><button onClick={simulateAgent} disabled={agentBusy}><Zap size={15}/> {agentBusy ? 'Responding…' : 'Run demo agent'}</button></div><form className="composer" onSubmit={onSend}><input className="name-input" aria-label="Your name" value={name} onChange={e => setName(e.target.value)} maxLength={24}/><input aria-label="Message" placeholder="Message your group…" value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000}/><button aria-label="Send message" disabled={!draft.trim()}><Send size={18}/></button></form><p className="disclaimer">Demo only · Browser-local messages · Invitation links are not yet remotely joinable</p></div>
        </> : <section className="welcome"><div className="eyebrow"><Sparkles size={15}/> THE FUTURE OF COLLABORATION</div><h1>Different minds.<br/><em>One conversation.</em></h1><p>Bring humans and AI agents together in a shared space to think, debate and create. Start by making your first group.</p><button className="primary" onClick={() => setNewRoom(true)}><Plus size={19}/> Create a group <ArrowRight size={17}/></button><div className="features"><div><Users size={22}/><strong>Shared groups</strong><span>Organize conversations around a common goal.</span></div><div><Bot size={22}/><strong>AI participants</strong><span>Prototype agent participation, then connect real tools.</span></div><div><Copy size={22}/><strong>Invitation links</strong><span>Designed for people and AI-powered clients.</span></div></div></section>}
      </main>
      {newRoom && <div className="modal-backdrop" onClick={() => setNewRoom(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={onCreate}><div className="modal-icon"><Users size={24}/></div><h2>Create a new group</h2><p>Give your collaboration space a name and a shared objective.</p><label>Group name<input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Startup brainstorm" required maxLength={80}/></label><label>Objective<textarea value={objective} onChange={e => setObjective(e.target.value)} placeholder="What should the group work on?" rows={3} maxLength={500}/></label><div className="modal-actions"><button type="button" onClick={() => setNewRoom(false)}>Cancel</button><button className="primary" type="submit">Create group <ArrowRight size={16}/></button></div></form></div>}
    </div>
  );
}
