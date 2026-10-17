import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Bot, Link2, LogOut, Plus, Send, Sparkles, Users } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import {
  createCloudRoom, createCloudInvite, redeemCloudInvite, connectCloudAgent, listAgentConnections, revokeCloudAgent, getCloudRoom, listCloudMessages, listCloudParticipants,
  listCloudRooms, postCloudMessage, signInWithPassword, signUpWithPassword, requestPasswordReset, updateAccountPassword, signOut,
  subscribeToCloudMessages, type CloudRoom, type CloudMessage, type CloudParticipant, type AgentConnection,
} from './cloudRooms';

export default function CloudApp() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | 'forgot' | 'reset'>(() => new URLSearchParams(location.search).get('reset') === 'password' ? 'reset' : 'signin');
  const [authNotice, setAuthNotice] = useState('');
  const [error, setError] = useState('');
  const [rooms, setRooms] = useState<CloudRoom[]>([]);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get('room') || '');
  const [room, setRoom] = useState<CloudRoom | null>(null);
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [participants, setParticipants] = useState<CloudParticipant[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => {
    const queryToken = new URLSearchParams(location.search).get('invite');
    const pathToken = location.pathname.match(/^\/invite=([^/]+)\/?$/i)?.[1];
    return queryToken || pathToken || '';
  });
  const inviteTokenValid = /^[0-9a-f]{64}$/i.test(inviteToken);\n  const [joining, setJoining] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [agentSecret, setAgentSecret] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentConnections, setAgentConnections] = useState<AgentConnection[]>([]);
  const [showAgents, setShowAgents] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    // getSession() is appropriate during startup: getUser() makes a server request
    // and can return AuthSessionMissingError for a normal first-time visitor.
    void supabase.auth.getSession().then(({ data, error: authError }) => {
      setUser(data.session?.user ?? null);
      if (authError) setError('Could not restore your session. Please sign in again.');
    }).catch(() => setError('Could not reach authentication. Please refresh and try again.')).finally(() => setReady(true));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setAuthMode('reset');
      setUser(session?.user || null);
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!user) { setRooms([]); setRoom(null); return; }
    let active = true;
    void listCloudRooms().then(items => { if (active) setRooms(items); }).catch(e => { if (active) setError(String(e.message || e)); });
    return () => { active = false; };
  }, [user]);
  useEffect(() => {
    if (!user || !selected) { setRoom(null); setMessages([]); setParticipants([]); return; }
    let active = true;
    async function refresh() {
      try {
        const [nextRoom, nextMessages, nextParticipants] = await Promise.all([
          getCloudRoom(selected), listCloudMessages(selected), listCloudParticipants(selected),
        ]);
        if (active) { setRoom(nextRoom); setMessages(nextMessages); setParticipants(nextParticipants); }
      } catch (e) { if (active) setError(String(e instanceof Error ? e.message : e)); }
    }
    void refresh();
    const unsubscribe = subscribeToCloudMessages(selected, () => { void refresh(); });
    return () => { active = false; unsubscribe(); };
  }, [user, selected]);
  async function makeInvite() {
    if (!room) return;
    setBusy(true); setError('');
    try {
      const token = await createCloudInvite(room.id);
      const link = new URL('/', window.location.origin);
      link.searchParams.set('invite', token);
      setInviteLink(link.toString());
      try { await navigator.clipboard.writeText(link.toString()); }
      catch { /* Show the link for manual copying if clipboard access is denied. */ }
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function addAgent() {
    if (!room) return;
    const name = window.prompt('Name this AI agent (for example, Research Agent):');
    if (!name?.trim()) return;
    setBusy(true); setError('');
    try {
      const secret = await connectCloudAgent(room.id, name.trim());
      setAgentName(name.trim()); setAgentSecret(secret);
      setParticipants(await listCloudParticipants(room.id));
      setAgentConnections(await listAgentConnections(room.id));
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function manageAgents() {
    if (!room) return;
    try { setAgentConnections(await listAgentConnections(room.id)); setShowAgents(true); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function revokeAgent(id: string) {
    if (!room || !window.confirm('Revoke this agent credential immediately?')) return;
    try { await revokeCloudAgent(id); setAgentConnections(await listAgentConnections(room.id)); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function joinInvite() {
    if (!inviteToken) return;
    setJoining(true); setError('');
    try {
      const id = await redeemCloudInvite(inviteToken);
      setInviteToken(''); setRooms(await listCloudRooms()); navigate(id);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setJoining(false); }
  }
  function navigate(id: string) {
    setSelected(id); setError(''); setInviteLink(''); setAgentSecret(''); setShowAgents(false);
    history.replaceState(null, '', id ? '/?room=' + encodeURIComponent(id) : '/');
  }
  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setAuthNotice('');
    try {
      if (authMode === 'signin') {
        await signInWithPassword(email.trim(), password);
      } else if (authMode === 'signup') {
        if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const result = await signUpWithPassword(email.trim(), password, inviteToken);
        setAuthNotice(result.confirmationRequired
          ? 'Account created. Check your email for a verification link before signing in. If email delivery is not configured, contact the administrator.'
          : 'Account created. You can now use Rub Minds.');
      } else if (authMode === 'forgot') {
        await requestPasswordReset(email.trim());
        setAuthNotice('If an account exists for this address, a password reset email will be sent.');
      } else {
        if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        await updateAccountPassword(password);
        setAuthNotice('Password updated successfully.');
        setAuthMode('signin');
        setPassword(''); setConfirmPassword('');
        history.replaceState(null, '', '/');
      }
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const id = await createCloudRoom(title.trim(), objective.trim());
      setRooms(await listCloudRooms()); setCreating(false); setTitle(''); setObjective(''); navigate(id);
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function send(e: FormEvent) {
    e.preventDefault(); if (!selected || !draft.trim()) return;
    setBusy(true); setError('');
    try {
      await postCloudMessage(selected, draft.trim());
      setDraft(''); setMessages(await listCloudMessages(selected));
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  if (!ready) return <div className="empty"><h2>Loading Rub Minds…</h2></div>;
  if (!user || authMode === 'reset') return <main className="auth-page"><div className="auth-panel">
    <div className="brand-icon"><Sparkles/></div>
    <h1>{authMode === 'signup' ? 'Create your Rub Minds account' : authMode === 'forgot' ? 'Reset your password' : authMode === 'reset' ? 'Choose a new password' : inviteToken ? (inviteTokenValid ? 'You’re invited to Rub Minds' : 'Invitation link looks incomplete') : 'Welcome to Rub Minds'}</h1>
    <p>{authMode === 'signup' ? 'Sign up with your email and a secure password.' : authMode === 'forgot' ? 'Enter your account email to request a reset link.' : authMode === 'reset' ? 'Enter a new password to secure your account.' : inviteToken ? (inviteTokenValid ? 'Sign in or create an account to continue to your group invitation. You will be able to accept it after signing in.' : 'This invitation link appears incomplete. Ask the person who created it to generate a fresh invitation link before you continue.') : 'Sign in with your email and password to collaborate.'}</p>
    {inviteToken && authMode !== 'forgot' && authMode !== 'reset' && <div className="objective" role="status"><Link2 size={18}/><span>{inviteTokenValid ? 'Group invitation detected. Your invite will be kept while you sign in.' : `This link contains ${inviteToken.length} characters; invitations need 64. Please request a new link.`}</span></div>}
    <form onSubmit={login}>
      {authMode !== 'reset' && <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>}
      {authMode !== 'forgot' && <label>Password<input type="password" autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'} required minLength={authMode === 'signin' ? undefined : 8} value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password"/></label>}
      {(authMode === 'signup' || authMode === 'reset') && <label>Confirm password<input type="password" autoComplete="new-password" required minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Repeat password"/></label>}
      <button className="primary" disabled={busy}>{busy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : authMode === 'forgot' ? 'Send reset link' : authMode === 'reset' ? 'Update password' : 'Sign in'}</button>
    </form>
    {authNotice && <p className="objective" role="status">{authNotice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="auth-switch">
      {authMode !== 'signin' && <button type="button" onClick={() => { setAuthMode('signin'); setError(''); setAuthNotice(''); }}>Back to sign in</button>}
      {authMode === 'signin' && <><button type="button" onClick={() => { setAuthMode('signup'); setError(''); setAuthNotice(''); }}>Create an account</button><button type="button" onClick={() => { setAuthMode('forgot'); setError(''); setAuthNotice(''); }}>Forgot password?</button></>}
    </div>
  </div></main>;
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Sparkles size={22}/></div><div><strong>Rub Minds</strong><small>Live collaboration</small></div></div>
      <button className="new-room" onClick={() => setCreating(true)}><Plus size={18}/> New group</button>
      <div className="section-label">YOUR GROUPS <span>{rooms.length}</span></div>
      <nav className="room-list">{rooms.map(r => <button key={r.id} className={'room-link ' + (r.id === selected ? 'active' : '')} onClick={() => navigate(r.id)}><Users size={17}/><span>{r.title}</span></button>)}</nav>
      <div className="sidebar-footer"><span className="status-dot"/> Supabase connected <button className="logout" onClick={() => { void signOut().catch(e => setError(String(e))); }}><LogOut size={14}/> Sign out</button></div>
    </aside>
    <main className="main">
      {error && <p className="error" role="alert">{error}</p>}
      {showAgents && <div className="invite-share"><strong>External agent connections</strong>{agentConnections.length ? agentConnections.map(a => <div key={a.id} style={{width:'100%',display:'flex',gap:12,alignItems:'center',justifyContent:'space-between'}}><span>{participants.find(p => p.id === a.participant_id)?.display_name || 'Agent'} — {a.revoked_at ? 'Revoked' : new Date(a.expires_at) <= new Date() ? 'Expired' : 'Active credential'}</span>{!a.revoked_at && <button onClick={() => { void revokeAgent(a.id); }}>Revoke</button>}</div>) : <p>No external agents connected yet.</p>}<button onClick={() => setShowAgents(false)}>Close</button></div>}
      {agentSecret && <div className="invite-share" role="status"><strong>{agentName} — agent connection created</strong><p>Copy this credential now. It is displayed only here, expires in 7 days, and grants access to this room's messages. Treat it like a password.</p><input readOnly aria-label="Agent credential" value={agentSecret} onFocus={e => e.target.select()}/><button onClick={() => { void navigator.clipboard.writeText(agentSecret).catch(() => setError('Select and copy the credential manually.')); }}>Copy credential</button><p>API endpoint: https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/agent-messages — use Authorization: Bearer YOUR_CREDENTIAL. GET reads messages; POST with JSON body sends one.</p><button onClick={() => setAgentSecret('')}>I've saved it</button></div>}
      {inviteLink && <div className="invite-share" role="status"><strong>Invitation created</strong><p>Valid for 24 hours, up to 10 joins. Anyone with this link can request to join.</p><input aria-label="Shareable invitation URL" readOnly value={inviteLink} onFocus={e => e.target.select()}/><button onClick={() => { void navigator.clipboard.writeText(inviteLink).catch(() => setError('Select and copy the invitation URL manually.')); }}>Copy invitation</button><button onClick={() => setInviteLink('')}>Close</button></div>}
      {inviteToken ? <section className="empty"><Link2 size={40}/><h1>{inviteTokenValid ? 'Join a Rub Minds group' : 'Invitation link looks incomplete'}</h1><p>{inviteTokenValid ? 'You have received a group invitation. Join to participate in the conversation with your signed-in account.' : `This link contains ${inviteToken.length} characters, but a valid invitation needs 64. Ask the group owner to create and send a new link.`}</p><button className="primary" onClick={() => { void joinInvite(); }} disabled={joining || !inviteTokenValid}>{joining ? 'Joining…' : 'Accept invitation'}</button><p className="disclaimer">Invitations expire after 24 hours or 10 successful joins.</p></section>
      : selected && room ? <>
        <header className="room-header"><button className="back" onClick={() => navigate('')}><ArrowLeft size={18}/></button><div className="room-heading"><h2>{room.title}</h2><span><span className="status-dot"/> {participants.length} participants · {messages.length} messages</span></div>{room.owner_id === user.id && <><button className="invite" disabled={busy} onClick={() => { void makeInvite(); }}><Link2 size={17}/> Invite members</button><button className="invite" disabled={busy} onClick={() => { void addAgent(); }}><Bot size={17}/> Connect AI</button><button className="invite" onClick={() => { void manageAgents(); }}>Manage agents</button></>}</header>
        <div className="objective"><Sparkles size={17}/><div><strong>Group objective</strong><p>{room.objective || 'Collaborate together.'}</p></div></div>
        <div className="messages" aria-live="polite">{messages.map(m => { const p = participants.find(p => p.id === m.sender_id); return <div className="message" key={m.id}><div className="avatar">{p?.kind === 'human' ? (p.display_name[0] || 'H') : <Bot size={18}/>}</div><div><div className="message-meta"><strong>{p?.display_name || 'Participant'}</strong><time>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{m.body}</p></div></div>; })}</div>
        <div className="composer-area"><form className="composer" onSubmit={send}><input aria-label="Message" placeholder="Message your group…" value={draft} onChange={e => setDraft(e.target.value)} maxLength={10000}/><button disabled={busy || !draft.trim()} aria-label="Send"><Send size={18}/></button></form><p className="disclaimer">Live room · Owner-created invitations support signed-in humans. External agents can connect using owner-created API credentials. An active agent runtime is required.</p></div>
      </> : selected ? <section className="empty"><h2>Room unavailable</h2><p>You may not have permission to view this room. Ask the room owner for an invitation link.</p><button className="primary" onClick={() => navigate('')}>Back to groups</button></section>
      : <section className="welcome"><div className="eyebrow"><Sparkles size={15}/> LIVE COLLABORATION</div><h1>Different minds.<br/><em>One conversation.</em></h1><p>Create a secure group to begin. AI invitation and autonomous collaboration are being developed next.</p><button className="primary" onClick={() => setCreating(true)}><Plus size={18}/> Create your first group</button></section>}
    </main>
    {creating && <div className="modal-backdrop" onClick={() => setCreating(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={create}><div className="modal-icon"><Users/></div><h2>Create a live group</h2><p>Start a shared collaboration space.</p><label>Group name<input autoFocus required maxLength={80} value={title} onChange={e => setTitle(e.target.value)}/></label><label>Objective<textarea rows={3} maxLength={500} value={objective} onChange={e => setObjective(e.target.value)}/></label><div className="modal-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy}>Create group</button></div></form></div>}
  </div>;
}
