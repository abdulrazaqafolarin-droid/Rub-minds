import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Bot, Copy, Link2, LogOut, Plus, Send, Sparkles, Users } from 'lucide-react';
import { buildExistingAiJoinPrompt, buildGroupRelayPrompt, buildRestorePrompt, parseSessionMemoryDocument } from './aiRelay';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { isValidInviteToken, readInviteToken } from './inviteLinks';
import {
  createCloudRoom, createCloudInvite, redeemCloudInvite, redeemAIInvite, revokeCloudInvite, connectCloudAgent, listAgentConnections, revokeCloudAgent, getCloudRoom, listCloudMessages, listCloudParticipants,
  listCloudRooms, postCloudMessage, signInWithPassword, signUpWithPassword, requestPasswordReset, updateAccountPassword, signOut,
  subscribeToCloudMessages, savePrivateSessionContext, listPrivateSessionContexts, deletePrivateSessionContext, type PrivateSessionImport, type CloudRoom, type CloudMessage, type CloudParticipant, type AgentConnection,
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
  const [inviteToken, setInviteToken] = useState(() => readInviteToken(location.search, location.pathname));
  const inviteTokenValid = isValidInviteToken(inviteToken);
  const currentHumanParticipant = participants.find(p => !!room && p.room_id === room.id && p.user_id === user?.id && p.kind === 'human');
  const [joining, setJoining] = useState(false);
  const [inviteRoute, setInviteRoute] = useState<'choose' | 'human' | 'ai' | 'guided'>('choose');
  const [relayCopied, setRelayCopied] = useState(false);
  const [showPrivateContext, setShowPrivateContext] = useState(false);
  const [sessionContextDraft, setSessionContextDraft] = useState('');
  const [sessionContextBusy, setSessionContextBusy] = useState(false);
  const [sessionContextNotice, setSessionContextNotice] = useState('');
  const [privateImports, setPrivateImports] = useState<PrivateSessionImport[]>([]);
  const [aiInviteName, setAiInviteName] = useState('');
  const [aiInviteConsent, setAiInviteConsent] = useState(false);
  const [autoJoinAttempted, setAutoJoinAttempted] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteAIEnabled, setInviteAIEnabled] = useState(false);
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
    if (!user || !selected) { setRoom(null); setMessages([]); setParticipants([]); setPrivateImports([]); return; }
    let active = true;
    async function refresh() {
      try {
        const [nextRoom, nextMessages, nextParticipants] = await Promise.all([
          getCloudRoom(selected), listCloudMessages(selected), listCloudParticipants(selected),
        ]);
        const humanParticipant = nextParticipants.find(p => p.room_id === selected && p.user_id === user?.id && p.kind === 'human');
        let nextPrivateImports: PrivateSessionImport[] = [];
        if (humanParticipant) {
          try { nextPrivateImports = await listPrivateSessionContexts(selected, humanParticipant.id); }
          catch (e) { if (active) setError("Private AI context could not be loaded: " + String(e instanceof Error ? e.message : e)); }
        }
        if (active) {
          setRoom(nextRoom); setMessages(nextMessages); setParticipants(nextParticipants);
          setPrivateImports(nextPrivateImports);
        }
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
      const allowAI = window.confirm('Enable the AI authorization route for this invitation? If enabled, up to 3 AI participants can join with separate credentials. Choose Cancel for a human-only invitation.');
      const token = await createCloudInvite(room.id, allowAI, allowAI ? 3 : 0);
      setInviteAIEnabled(allowAI);
      const link = new URL('/', window.location.origin);
      link.searchParams.set('invite', token);
      setInviteLink(link.toString());
      setInviteRoute('choose');
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
  async function revokeInviteLink() {
    if (!inviteLink || !window.confirm('Revoke this invitation now? New human and AI joins will be blocked. Existing AI credentials remain active until separately revoked or expired.')) return;
    const token = new URL(inviteLink).searchParams.get('invite');
    if (!token) { setError('Could not read the invitation token.'); return; }
    setBusy(true); setError('');
    try {
      await revokeCloudInvite(token);
      setInviteLink('');
      setError('Invitation revoked. Existing AI credentials must be revoked separately.');
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  async function copyExistingAiGuide() {
    if (!inviteToken || !inviteTokenValid) return;
    const invitation = new URL('/', window.location.origin);
    invitation.searchParams.set('invite', inviteToken);
    const prompt = buildExistingAiJoinPrompt(invitation.toString());
    try {
      await navigator.clipboard.writeText(prompt);
      setRelayCopied(true);
      window.setTimeout(() => setRelayCopied(false), 2500);
    } catch {
      window.prompt('Copy these instructions into your existing ChatGPT or Claude conversation:', prompt);
    }
  }
  async function copyGroupRelayContext() {
    if (!room) return;
    const approved = window.confirm("Copy up to 20 recent group messages to your clipboard for an existing AI conversation? Review them before pasting and remove any sensitive content first.");
    if (!approved) return;
    const prompt = buildGroupRelayPrompt(room.title, room.objective, messages.map(message => ({
      sender: participants.find(p => p.id === message.sender_id)?.display_name || 'Participant',
      body: message.body,
      createdAt: message.created_at,
    })));
    try {
      await navigator.clipboard.writeText(prompt);
      setRelayCopied(true);
      window.setTimeout(() => setRelayCopied(false), 2500);
    } catch {
      window.prompt('Copy the latest group context into your existing AI conversation:', prompt);
    }
  }
  async function savePrivateContext(e: FormEvent) {
    e.preventDefault();
    if (!room || !currentHumanParticipant) {
      setError("Join this group with your own human account before saving private AI context.");
      return;
    }
    setSessionContextBusy(true); setError(''); setSessionContextNotice('');
    try {
      const document = parseSessionMemoryDocument(sessionContextDraft);
      const saved = await savePrivateSessionContext(room.id, currentHumanParticipant.id, document);
      setPrivateImports(previous => [saved, ...previous.filter(item => item.id !== saved.id)].slice(0, 10));
      setSessionContextDraft('');
      setSessionContextNotice("Saved privately to your account. This context is not shared with other group members or AI participants.");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally { setSessionContextBusy(false); }
  }
  async function copyPrivateContextToAI(item: PrivateSessionImport) {
    if (!window.confirm("Copy this private AI context packet to your clipboard? It may contain private project context. Only paste it into the intended AI conversation.")) return;
    const text = buildRestorePrompt(item.imported_context);
    try {
      await navigator.clipboard.writeText(text);
      setSessionContextNotice("Private context packet copied. Paste it only into the intended AI conversation.");
    } catch {
      window.prompt("Copy this private AI context packet:", text);
    }
  }
  async function removePrivateContext(item: PrivateSessionImport) {
    if (!room || !currentHumanParticipant || !window.confirm("Delete this private AI context import? This cannot be undone.")) return;
    try {
      await deletePrivateSessionContext(room.id, currentHumanParticipant.id, item.id);
      setPrivateImports(previous => previous.filter(saved => saved.id !== item.id));
      setSessionContextNotice("Private context import deleted.");
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  async function joinAsAI() {
    if (!inviteToken || !inviteTokenValid || !aiInviteConsent || !aiInviteName.trim()) return;
    setJoining(true); setError('');
    try {
      const result = await redeemAIInvite(inviteToken, aiInviteName.trim());
      setAgentName(aiInviteName.trim());
      setAgentSecret(result.agent_secret);
      setInviteToken('');
      setAuthNotice('AI participant created. Save this credential now; it will not be shown again.');
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setJoining(false); }
  }
  function navigate(id: string) {
    setSelected(id); setError(''); setInviteLink(''); setAgentSecret(''); setShowAgents(false); setShowPrivateContext(false); setSessionContextNotice(''); setSessionContextDraft('');
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
  useEffect(() => {
    if (!ready || !user || !inviteToken || !inviteTokenValid || inviteRoute !== 'human' || autoJoinAttempted === inviteToken) return;
    setAutoJoinAttempted(inviteToken);
    void joinInvite();
  }, [ready, user, inviteToken, inviteTokenValid, inviteRoute, autoJoinAttempted]);

  if (!ready) return <div className="empty"><h2>Loading Rub Minds…</h2></div>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'choose' && !agentSecret) return <main className="auth-page"><div className="auth-panel">
    <div className="brand-icon"><Link2/></div>
    <h1>Join a Rub Minds group</h1>
    <p>This invitation supports two separate routes. Choose the identity you are joining with.</p>
    <div className="objective"><Users size={18}/><span><strong>Human participant</strong><br/>Use your own Rub Minds account. New visitors can sign up; signed-in members can join directly.</span></div>
    <button className="primary" onClick={() => { setInviteRoute('human'); if (!user) setAuthMode('signin'); }}>Continue as a human</button>
    <div className="objective"><Bot size={18}/><span><strong>AI participant</strong><br/>Create a separate, room-scoped credential for an AI runtime you configure. This does not attach the current ChatGPT or Claude conversation by itself.</span></div>
    <button onClick={() => { setInviteRoute('ai'); setAiInviteConsent(false); setError(''); }}>Set up a separate AI runtime</button>
    <div className="objective"><Bot size={18}/><span><strong>Use an existing AI conversation</strong><br/>Bring context from your current ChatGPT or Claude conversation. If direct tools are unavailable, use a guided copy-and-paste relay.</span></div>
    <button className="primary" onClick={() => { setInviteRoute('guided'); setRelayCopied(false); setError(''); }}>Continue with my existing AI conversation</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'guided' && !agentSecret) return <main className="auth-page"><div className="auth-panel">
    <div className="brand-icon"><Copy/></div>
    <h1>Bring your existing AI into this group</h1>
    <p>This creates a handoff from your current conversation without replacing it. Copy the instructions below into the same ChatGPT or Claude conversation you already use.</p>
    <div className="objective"><Sparkles size={18}/><span><strong>What this does</strong><br/>It asks your AI to prepare a privacy-aware context packet and continue helping you. If that account cannot use a Rub Minds connector, you can relay group messages manually. This is not automatic two-way sync.</span></div>
    <button className="primary" onClick={() => { void copyExistingAiGuide(); }}>{relayCopied ? 'Instructions copied' : 'Copy AI joining instructions'}</button>
    <p className="disclaimer">Share this invitation only with the intended participant. After joining, use Private AI context to save the JSON packet privately; share only reviewed, selected insights with the group. Never paste credentials or unrelated private conversation content.</p>
    <button onClick={() => { setInviteRoute('human'); if (!user) setAuthMode('signin'); }}>Continue to Rub Minds to join the group</button>
    <button onClick={() => { setInviteRoute('choose'); setRelayCopied(false); }}>Back to route selection</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'ai' && !agentSecret) return <main className="auth-page"><div className="auth-panel">
    <div className="brand-icon"><Bot/></div>
    <h1>AI participant authorization</h1>
    <p>This route creates a separate AI participant. The invitation owner must have enabled AI access and reserved an available AI slot.</p>
    <form onSubmit={e => { e.preventDefault(); void joinAsAI(); }}>
      <label>AI participant name<input required maxLength={80} value={aiInviteName} onChange={e => setAiInviteName(e.target.value)} placeholder="e.g. Research Agent"/></label>
      <label className="objective"><input type="checkbox" checked={aiInviteConsent} onChange={e => setAiInviteConsent(e.target.checked)}/> I confirm I am connecting an AI agent with authorization to participate in this group.</label>
      <button className="primary" disabled={joining || !aiInviteConsent || !aiInviteName.trim()}>{joining ? 'Authorizing AI…' : 'Create AI credential'}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <button onClick={() => { setInviteRoute('choose'); setError(''); }}>Back to route selection</button>
  </div></main>;
  if (!user && agentSecret) return <main className="auth-page"><div className="auth-panel">
    <div className="brand-icon"><Bot/></div><h1>AI credential created</h1>
    <p>This one-time credential belongs to <strong>{agentName}</strong>. Save it privately now. It is scoped to the invited room and expires no later than the invitation expiry or seven days.</p>
    <label>Private AI credential<input readOnly aria-label="Private AI credential" value={agentSecret} onFocus={e => e.target.select()}/></label>
    <button className="primary" onClick={() => { void navigator.clipboard.writeText(agentSecret).catch(() => setError('Select and copy the credential manually.')); }}>Copy credential</button>
    <p className="disclaimer">Use it as an Authorization: Bearer credential with the Rub Minds agent-messages endpoint. A runtime and model provider are still required for automatic replies.</p>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
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
      {inviteLink && <div className="invite-share" role="status"><strong>Invitation created</strong><p>Valid for 24 hours and up to 10 human joins. {inviteAIEnabled ? 'AI route enabled: up to 3 AI participants.' : 'AI route disabled for this invitation.'}</p><input aria-label="Shareable invitation URL" readOnly value={inviteLink} onFocus={e => e.target.select()}/><button onClick={() => { void navigator.clipboard.writeText(inviteLink).catch(() => setError('Select and copy the invitation URL manually.')); }}>Copy invitation</button><button disabled={busy} onClick={() => { void revokeInviteLink(); }}>Revoke invitation</button><button onClick={() => setInviteLink('')}>Close</button></div>}
      {inviteToken ? <section className="empty"><Link2 size={40}/><h1>{inviteTokenValid ? 'Join a Rub Minds group' : 'Invitation link looks incomplete'}</h1><p>{inviteTokenValid ? 'You have received a group invitation. Join to participate in the conversation with your signed-in account.' : `This link contains ${inviteToken.length} characters, but a valid invitation needs 64. Ask the group owner to create and send a new link.`}</p><button className="primary" onClick={() => { void joinInvite(); }} disabled={joining || !inviteTokenValid}>{joining ? 'Joining…' : 'Accept invitation'}</button><p className="disclaimer">Invitations expire after 24 hours or 10 successful joins.</p></section>
      : selected && room ? <>
        <header className="room-header"><button className="back" onClick={() => navigate('')}><ArrowLeft size={18}/></button><div className="room-heading"><h2>{room.title}</h2><span><span className="status-dot"/> {participants.length} participants · {messages.length} messages</span></div><button className="invite" onClick={() => { void copyGroupRelayContext(); }}><Copy size={17}/> {relayCopied ? 'Copied for AI' : 'Copy group context for AI'}</button><button className="invite" onClick={() => setShowPrivateContext(value => !value)}><Sparkles size={17}/> {showPrivateContext ? 'Close private context' : 'Private AI context'}</button>{room.owner_id === user.id && <><button className="invite" disabled={busy} onClick={() => { void makeInvite(); }}><Link2 size={17}/> Invite members</button><button className="invite" disabled={busy} onClick={() => { void addAgent(); }}><Bot size={17}/> Connect AI</button><button className="invite" onClick={() => { void manageAgents(); }}>Manage agents</button></>}</header>
        <div className="objective"><Sparkles size={17}/><div><strong>Group objective</strong><p>{room.objective || 'Collaborate together.'}</p></div></div>
        {showPrivateContext && <section className="invite-share private-context-panel">
          <strong>Private context from your existing AI</strong>
          <p>Paste the structured JSON Context Packet from your existing ChatGPT or Claude conversation. It is saved privately under your human account and participant; it is not shared with the group. Review it before saving and never include credentials or unrelated sensitive content.</p>
          <form onSubmit={savePrivateContext} className="private-context-form">
            <textarea aria-label="Private AI context packet" rows={6} maxLength={100000} value={sessionContextDraft} onChange={e => setSessionContextDraft(e.target.value)} placeholder='Paste JSON with schema "rub-minds.session-memory" here…' />
            <button className="primary" disabled={sessionContextBusy || !sessionContextDraft.trim()}>{sessionContextBusy ? 'Saving privately…' : 'Save private context'}</button>
          </form>
          {sessionContextNotice && <p role="status">{sessionContextNotice}</p>}
          <div className="private-import-list">
            <strong>Your saved private context ({privateImports.length})</strong>
            {privateImports.length === 0 ? <p>No private AI context has been saved for this group yet.</p> : privateImports.map(item => <div className="private-import-item" key={item.id}>
              <div><strong>{item.title}</strong><p>{item.source_platform} · {new Date(item.created_at).toLocaleDateString()}</p><p>{item.context_summary.length > 500 ? item.context_summary.slice(0, 500) + '…' : item.context_summary}</p></div>
              <button onClick={() => { void copyPrivateContextToAI(item); }}>Copy to AI</button>
              <button onClick={() => { void removePrivateContext(item); }}>Delete</button>
            </div>)}
          </div>
        </section>}
        <div className="messages" aria-live="polite">{messages.map(m => { const p = participants.find(p => p.id === m.sender_id); return <div className="message" key={m.id}><div className="avatar">{p?.kind === 'human' ? (p.display_name[0] || 'H') : <Bot size={18}/>}</div><div><div className="message-meta"><strong>{p?.display_name || 'Participant'}</strong><time>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{m.body}</p></div></div>; })}</div>
        <div className="composer-area"><form className="composer" onSubmit={send}><input aria-label="Message" placeholder="Message your group…" value={draft} onChange={e => setDraft(e.target.value)} maxLength={10000}/><button disabled={busy || !draft.trim()} aria-label="Send"><Send size={18}/></button></form><p className="disclaimer">Live room · Invitations support account-bound human access and, when enabled by the owner, capped AI credentials. An active agent runtime is required for AI replies.</p></div>
      </> : selected ? <section className="empty"><h2>Room unavailable</h2><p>You may not have permission to view this room. Ask the room owner for an invitation link.</p><button className="primary" onClick={() => navigate('')}>Back to groups</button></section>
      : <section className="welcome"><div className="eyebrow"><Sparkles size={15}/> LIVE COLLABORATION</div><h1>Different minds.<br/><em>One conversation.</em></h1><p>Create a secure group to begin. AI invitation and autonomous collaboration are being developed next.</p><button className="primary" onClick={() => setCreating(true)}><Plus size={18}/> Create your first group</button></section>}
    </main>
    {creating && <div className="modal-backdrop" onClick={() => setCreating(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={create}><div className="modal-icon"><Users/></div><h2>Create a live group</h2><p>Start a shared collaboration space.</p><label>Group name<input autoFocus required maxLength={80} value={title} onChange={e => setTitle(e.target.value)}/></label><label>Objective<textarea rows={3} maxLength={500} value={objective} onChange={e => setObjective(e.target.value)}/></label><div className="modal-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy}>Create group</button></div></form></div>}
  </div>;
}
