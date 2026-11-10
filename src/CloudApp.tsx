import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, BrainCircuit, Bot, Cable, ChevronRight, CircleAlert, Copy, Layers3, Link2, LockKeyhole, LogOut, Monitor, MessageCircle, Plus, RefreshCw, Send, Sparkles, SquareTerminal, Smartphone, UserPlus, Users } from 'lucide-react';
import { buildExistingAiJoinPrompt, buildGroupRelayPrompt, buildRestorePrompt, parseSessionMemoryDocument } from './aiRelay';
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { getInviteStatusMessage, isValidInviteToken, readInviteToken } from './inviteLinks';
import { shouldShowSessionRestoreError } from './authStartup';
import { errorMessage } from './errorMessage';
import { ThemeToggle } from './UiPreferences';
import { participantKindLabel } from './uiFlow';
type ConfirmDialog = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
};
type CopyFallback = { title: string; description: string; value: string };

import {
  createCloudRoom, createCloudInvite, redeemCloudInvite, redeemAIInvite, revokeCloudInvite, connectCloudAgent, listAgentConnections, revokeCloudAgent, getCloudRoom, listCloudMessages, listCloudParticipants,
  listCloudRooms, postCloudMessage, signInWithPassword, signUpWithPassword, requestPasswordReset, updateAccountPassword, signOut,
  subscribeToCloudMessages, subscribeToGroupMemoryEntries, savePrivateSessionContext, listPrivateSessionContexts, deletePrivateSessionContext, listGroupMemoryEntries, saveGroupMemoryEntry, deleteGroupMemoryEntry, type PrivateSessionImport, type GroupMemoryEntry, type CloudRoom, type CloudMessage, type CloudParticipant, type AgentConnection,
} from './cloudRooms';

function AuthStory() {
  return <aside className="rm-auth-story">
    <a className="rm-auth-story-brand" href="/">
      <span className="rm-auth-story-mark"><Sparkles size={19}/></span>
      <span><strong>Rub Minds</strong><small>Collective intelligence</small></span>
    </a>
    <span className="rm-auth-story-kicker">THINK BETTER, TOGETHER</span>
    <h2>One room.<br/><em>More perspectives.</em></h2>
    <p>Bring people and the AI conversations they already use into one shared space. Keep each mind's identity, context and permissions clear.</p>
    <div className="rm-auth-story-visual" aria-hidden="true">
      <div className="rm-auth-story-grid"/>
      <svg viewBox="0 0 440 250" role="presentation">
        <path d="M74 65 C145 65 146 124 220 124 S294 65 366 65"/>
        <path d="M74 190 C145 190 146 124 220 124 S294 190 366 190"/>
        <path d="M74 65 C96 115 96 153 74 190 M366 65 C344 115 344 153 366 190"/>
        <circle cx="74" cy="65" r="8"/><circle cx="366" cy="65" r="8"/>
        <circle cx="74" cy="190" r="8"/><circle cx="366" cy="190" r="8"/>
      </svg>
      <span className="rm-auth-story-core"><Sparkles size={30}/></span>
      <span className="rm-auth-story-node rm-story-people"><Users size={15}/> People</span>
      <span className="rm-auth-story-node rm-story-ai"><Bot size={15}/> AI sessions</span>
      <span className="rm-auth-story-node rm-story-memory"><BrainCircuit size={15}/> Shared memory</span>
      <span className="rm-auth-story-node rm-story-devices"><Monitor size={15}/> Devices</span>
    </div>
    <div className="rm-auth-story-promises">
      <span><LockKeyhole size={14}/> Private context stays private</span>
      <span><Layers3 size={14}/> One group across every surface</span>
    </div>
    <span className="rm-auth-story-foot">Your work, your people, your AI sessions — together.</span>
  </aside>;
}

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
  const [activePanel, setActivePanel] = useState<'conversation' | 'participants' | 'private-context' | 'shared-memory' | 'connections'>('conversation');
  const [sessionContextDraft, setSessionContextDraft] = useState('');
  const [sessionContextBusy, setSessionContextBusy] = useState(false);
  const [sessionContextNotice, setSessionContextNotice] = useState('');
  const [privateImports, setPrivateImports] = useState<PrivateSessionImport[]>([]);
  const [groupMemories, setGroupMemories] = useState<GroupMemoryEntry[]>([]);
  const [shareMemoryType, setShareMemoryType] = useState<GroupMemoryEntry['entry_type']>('insight');
  const [shareMemoryDraft, setShareMemoryDraft] = useState('');
  const [sharedMemoryBusy, setSharedMemoryBusy] = useState(false);
  const [sharedMemoryNotice, setSharedMemoryNotice] = useState('');
  const [aiInviteName, setAiInviteName] = useState('');
  const [aiInviteConsent, setAiInviteConsent] = useState(false);
  const [autoJoinAttempted, setAutoJoinAttempted] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteAIEnabled, setInviteAIEnabled] = useState(false);
  const [agentSecret, setAgentSecret] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentConnections, setAgentConnections] = useState<AgentConnection[]>([]);
  const [joinLinkOpen, setJoinLinkOpen] = useState(false);
  const [joinLinkDraft, setJoinLinkDraft] = useState('');
  const [inviteOptionsOpen, setInviteOptionsOpen] = useState(false);
  const [inviteAIChoice, setInviteAIChoice] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [copyFallback, setCopyFallback] = useState<CopyFallback | null>(null);
  const [agentCreateOpen, setAgentCreateOpen] = useState(false);
  const [agentNameDraft, setAgentNameDraft] = useState('');
  useEffect(() => {
    if (!supabase) {
      // Do not leave invite visitors stuck on the loading screen when preview
      // or deployment environment variables are missing.
      setError('Rub Minds authentication is not configured in this deployment. Please contact the administrator.');
      setReady(true);
      return;
    }
    // getSession() is appropriate during startup: getUser() makes a server request
    // and can return AuthSessionMissingError for a normal first-time visitor.
    void supabase.auth.getSession().then(({ data, error: authError }) => {
      setUser(data.session?.user ?? null);
      if (shouldShowSessionRestoreError(authError)) setError('Could not restore your session. Please sign in again.');
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
    void listCloudRooms().then(items => { if (active) setRooms(items); }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [user]);
  useEffect(() => {
    if (!user || !selected) { setRoom(null); setMessages([]); setParticipants([]); setPrivateImports([]); setGroupMemories([]); return; }
    let active = true;
    async function refresh() {
      try {
        const [nextRoom, nextMessages, nextParticipants] = await Promise.all([
          getCloudRoom(selected), listCloudMessages(selected), listCloudParticipants(selected),
        ]);
        let nextGroupMemories: GroupMemoryEntry[] = [];
        try { nextGroupMemories = await listGroupMemoryEntries(selected); }
        catch (e) { if (active) setError("Shared group memory could not be loaded: " + errorMessage(e)); }
        const humanParticipant = nextParticipants.find(p => p.room_id === selected && p.user_id === user?.id && p.kind === 'human');
        let nextPrivateImports: PrivateSessionImport[] = [];
        if (humanParticipant) {
          try { nextPrivateImports = await listPrivateSessionContexts(selected, humanParticipant.id); }
          catch (e) { if (active) setError("Private AI context could not be loaded: " + errorMessage(e)); }
        }
        if (active) {
          setRoom(nextRoom); setMessages(nextMessages); setParticipants(nextParticipants);
          setPrivateImports(nextPrivateImports); setGroupMemories(nextGroupMemories);
        }
      } catch (e) { if (active) setError(errorMessage(e)); }
    }
    void refresh();
    const unsubscribe = subscribeToCloudMessages(selected, () => { void refresh(); });
    const unsubscribeMemory = subscribeToGroupMemoryEntries(selected, () => { void refresh(); });
    return () => { active = false; unsubscribe(); unsubscribeMemory(); };
  }, [user, selected]);
  async function makeInvite() {
    if (!room) return;
    setBusy(true); setError('');
    try {
      const allowAI = inviteAIChoice;
      const token = await createCloudInvite(room.id, allowAI, allowAI ? 3 : 0);
      setInviteOptionsOpen(false);
      setInviteAIEnabled(allowAI);
      const link = new URL('/', window.location.origin);
      link.searchParams.set('invite', token);
      setInviteLink(link.toString());
      setInviteRoute('choose');
      try { await navigator.clipboard.writeText(link.toString()); }
      catch { /* Show the link for manual copying if clipboard access is denied. */ }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  function addAgent() {
    if (!room) return;
    setAgentNameDraft('');
    setAgentCreateOpen(true);
  }
  async function createAgent(e: FormEvent) {
    e.preventDefault();
    if (!room || !agentNameDraft.trim()) return;
    setBusy(true); setError('');
    try {
      const name = agentNameDraft.trim();
      const secret = await connectCloudAgent(room.id, name);
      setAgentName(name); setAgentSecret(secret);
      setParticipants(await listCloudParticipants(room.id));
      setAgentConnections(await listAgentConnections(room.id));
      setAgentCreateOpen(false); setAgentNameDraft('');
      setActivePanel('connections');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function manageAgents() {
    if (!room) return;
    try { setAgentConnections(await listAgentConnections(room.id)); openPanel('connections'); }
    catch (e) { setError(errorMessage(e)); }
  }
  function revokeAgent(id: string) {
    if (!room) return;
    askForConfirmation({
      title: 'Revoke this AI credential?',
      description: 'This immediately blocks the selected runtime from using this credential in this group. Other credentials and group membership are not changed.',
      confirmLabel: 'Revoke credential',
      destructive: true,
      onConfirm: () => {
        void (async () => {
          try { await revokeCloudAgent(id); setAgentConnections(await listAgentConnections(room.id)); }
          catch (e) { setError(errorMessage(e)); }
        })();
      },
    });
  }
  async function joinInvite() {
    if (!inviteToken) return;
    setJoining(true); setError('');
    try {
      const id = await redeemCloudInvite(inviteToken);
      setInviteToken(''); setRooms(await listCloudRooms()); navigate(id);
    } catch (e) { setError(errorMessage(e)); }
    finally { setJoining(false); }
  }
  function revokeInviteLink() {
    if (!inviteLink) return;
    askForConfirmation({
      title: 'Revoke this invitation?',
      description: 'New human and AI participants will no longer be able to redeem this link. AI credentials already created from it stay active until separately revoked or expired.',
      confirmLabel: 'Revoke invitation',
      destructive: true,
      onConfirm: () => { void revokeInviteLinkNow(); },
    });
  }
  async function revokeInviteLinkNow() {
    const token = new URL(inviteLink).searchParams.get('invite');
    if (!token) { setError('Could not read the invitation token.'); return; }
    setBusy(true); setError('');
    try {
      await revokeCloudInvite(token);
      setInviteLink('');
      setError('Invitation revoked. Existing AI credentials must be revoked separately.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function copyExistingAiGuide() {
    if (!inviteToken || !inviteTokenValid) return;
    const invitation = new URL('/', window.location.origin);
    invitation.searchParams.set('invite', inviteToken);
    const prompt = buildExistingAiJoinPrompt(invitation.toString());
    await copyToClipboard(prompt, 'AI joining instructions', 'Copy these instructions into the same ChatGPT or Claude conversation you already use.', () => {
      setRelayCopied(true);
      window.setTimeout(() => setRelayCopied(false), 2500);
    });
  }
  function copyGroupRelayContext() {
    if (!room) return;
    askForConfirmation({
      title: 'Copy group context to your AI?',
      description: 'Up to 20 recent messages and shared group memory entries will be copied to your clipboard. Review the content and remove anything sensitive before pasting it into another AI conversation.',
      confirmLabel: 'Copy selected group context',
      onConfirm: () => { void copyGroupRelayContextNow(); },
    });
  }
  async function copyGroupRelayContextNow() {
    if (!room) return;
    const prompt = buildGroupRelayPrompt(room.title, room.objective, messages.map(message => ({
      sender: participants.find(p => p.id === message.sender_id)?.display_name || 'Participant',
      body: message.body,
      createdAt: message.created_at,
    })), groupMemories.map(memory => ({ type: memory.entry_type, content: memory.content, updatedAt: memory.updated_at })));
    await copyToClipboard(prompt, 'Group context ready to copy', 'Paste this selected group context into the intended AI conversation.', () => {
      setRelayCopied(true);
      window.setTimeout(() => setRelayCopied(false), 2500);
    });
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
      setError(errorMessage(e));
    } finally { setSessionContextBusy(false); }
  }
  function shareGroupMemory(e: FormEvent) {
    e.preventDefault();
    if (!room || !currentHumanParticipant || !shareMemoryDraft.trim()) return;
    askForConfirmation({
      title: 'Share this insight with the group?',
      description: 'This selected entry will become visible to every human participant and connected AI runtime in this group. Do not include private notes or credentials.',
      confirmLabel: 'Share with group',
      onConfirm: () => { void saveGroupMemoryNow(); },
    });
  }
  async function saveGroupMemoryNow() {
    if (!room || !currentHumanParticipant || !shareMemoryDraft.trim()) return;
    setSharedMemoryBusy(true); setError(''); setSharedMemoryNotice('');
    try {
      const saved = await saveGroupMemoryEntry(room.id, currentHumanParticipant.id, shareMemoryType, shareMemoryDraft);
      setGroupMemories(previous => [saved, ...previous.filter(item => item.id !== saved.id)].slice(0, 50));
      setShareMemoryDraft('');
      setSharedMemoryNotice('Selected insight shared with the group.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setSharedMemoryBusy(false); }
  }
  function removeGroupMemory(memory: GroupMemoryEntry) {
    if (!room || !currentHumanParticipant || memory.created_by_participant_id !== currentHumanParticipant.id) return;
    askForConfirmation({
      title: 'Delete this shared memory entry?',
      description: 'This entry will be removed for everyone in the group, including connected AI participants. This cannot be undone.',
      confirmLabel: 'Delete shared entry',
      destructive: true,
      onConfirm: () => {
        void (async () => {
          try {
            await deleteGroupMemoryEntry(room.id, currentHumanParticipant.id, memory.id);
            setGroupMemories(previous => previous.filter(item => item.id !== memory.id));
            setSharedMemoryNotice('Shared group memory entry deleted.');
          } catch (e) { setError(errorMessage(e)); }
        })();
      },
    });
  }
  function copyPrivateContextToAI(item: PrivateSessionImport) {
    askForConfirmation({
      title: 'Copy your private AI context?',
      description: 'This packet may contain private project context from your account. It is not shared with the group, but it will be placed on your clipboard. Paste it only into the intended AI conversation.',
      confirmLabel: 'Copy private context',
      onConfirm: () => {
        const text = buildRestorePrompt(item.imported_context);
        void copyToClipboard(text, 'Private context ready to copy', 'Paste this packet only into the intended AI conversation.', () => {
          setSessionContextNotice('Private context packet copied. Paste it only into the intended AI conversation.');
        });
      },
    });
  }
  function removePrivateContext(item: PrivateSessionImport) {
    if (!room || !currentHumanParticipant) return;
    askForConfirmation({
      title: 'Delete this private context import?',
      description: 'This removes the saved context packet from your account for this group. Other participants cannot see it. This cannot be undone.',
      confirmLabel: 'Delete private context',
      destructive: true,
      onConfirm: () => {
        void (async () => {
          try {
            await deletePrivateSessionContext(room.id, currentHumanParticipant.id, item.id);
            setPrivateImports(previous => previous.filter(saved => saved.id !== item.id));
            setSessionContextNotice('Private context import deleted.');
          } catch (e) { setError(errorMessage(e)); }
        })();
      },
    });
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
    } catch (e) { setError(errorMessage(e)); }
    finally { setJoining(false); }
  }
  function navigate(id: string) {
    setSelected(id); setError(''); setInviteLink(''); setAgentSecret(''); setActivePanel('conversation');
    setSessionContextNotice(''); setSessionContextDraft(''); setSharedMemoryNotice(''); setShareMemoryDraft('');
    history.replaceState(null, '', id ? '/?room=' + encodeURIComponent(id) : '/');
  }
  function askForConfirmation(dialog: ConfirmDialog) {
    setConfirmDialog(dialog);
  }
  function runConfirmedAction() {
    const dialog = confirmDialog;
    setConfirmDialog(null);
    dialog?.onConfirm();
  }
  async function copyToClipboard(value: string, title: string, description: string, onCopied?: () => void) {
    try {
      await navigator.clipboard.writeText(value);
      onCopied?.();
    } catch {
      setCopyFallback({ title, description: description + ' The text is shown below so you can select and copy it manually.', value });
    }
  }
  function openInviteOptions(enableAI = false) {
    setInviteAIChoice(enableAI);
    setInviteOptionsOpen(true);
  }
  function openPanel(panel: 'conversation' | 'participants' | 'private-context' | 'shared-memory' | 'connections') {
    setActivePanel(panel);
    if (panel === 'shared-memory' && room) void listGroupMemoryEntries(room.id).then(setGroupMemories).catch(e => setError(errorMessage(e)));
    if (panel === 'connections' && room) void listAgentConnections(room.id).then(setAgentConnections).catch(e => setError(errorMessage(e)));
  }
  function beginInviteFromLink() {
    try {
      const candidate = new URL(joinLinkDraft.trim(), window.location.origin);
      const token = readInviteToken(candidate.search, candidate.pathname);
      if (!isValidInviteToken(token)) throw new Error('That link does not contain a valid Rub Minds invitation.');
      setInviteToken(token); setInviteRoute('choose'); setJoinLinkOpen(false); setJoinLinkDraft(''); setError('');
      history.replaceState(null, '', candidate.pathname + candidate.search);
    } catch (e) { setError(errorMessage(e)); }
  }
  async function copyCreatedInviteForAI() {
    if (!inviteLink) { setError('Create an invitation first, then share it with the existing AI conversation.'); return; }
    const prompt = buildExistingAiJoinPrompt(inviteLink);
    try { await navigator.clipboard.writeText(prompt); setRelayCopied(true); window.setTimeout(() => setRelayCopied(false), 2500); }
    catch { setCopyFallback({ title: 'AI invitation instructions', description: 'Copy these instructions into the same ChatGPT or Claude conversation you already use.', value: prompt }); }
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
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const id = await createCloudRoom(title.trim(), objective.trim());
      setRooms(await listCloudRooms()); setCreating(false); setTitle(''); setObjective(''); navigate(id);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function send(e: FormEvent) {
    e.preventDefault(); if (!selected || !draft.trim()) return;
    setBusy(true); setError('');
    try {
      await postCloudMessage(selected, draft.trim());
      setDraft(''); setMessages(await listCloudMessages(selected));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  // A signed-in human opening an invitation should join directly. Keep the
  // explicit route picker for anonymous visitors and users choosing the AI relay.
  useEffect(() => {
    if (ready && user && inviteToken && inviteTokenValid && inviteRoute === 'choose') {
      setInviteRoute('human');
    }
  }, [ready, user, inviteToken, inviteTokenValid, inviteRoute]);

  useEffect(() => {
    if (!ready || !user || !inviteToken || !inviteTokenValid || inviteRoute !== 'human' || autoJoinAttempted === inviteToken) return;
    setAutoJoinAttempted(inviteToken);
    void joinInvite();
  }, [ready, user, inviteToken, inviteTokenValid, inviteRoute, autoJoinAttempted]);

  if (!ready) return <div className="empty"><h2>Loading Rub Minds…</h2></div>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'choose' && !agentSecret) return <main className="auth-page"><AuthStory/><div className="auth-panel"><div className="rm-auth-top"><a className="rm-auth-brand" href="/"><span className="brand-icon"><Sparkles size={17}/></span><strong>Rub Minds</strong></a><ThemeToggle compact/></div>
    
    <h1>Join a Rub Minds group</h1>
    <div className="objective" role="status"><Link2 size={18}/><span>{getInviteStatusMessage(inviteToken)}</span></div>
    <p>This invitation supports two separate routes. Choose the identity you are joining with.</p>
    <div className="objective"><Users size={18}/><span><strong>Human participant</strong><br/>Use your own Rub Minds account. New visitors can sign up; signed-in members can join directly.</span></div>
    <button className="primary" onClick={() => { setInviteRoute('human'); if (!user) setAuthMode('signin'); }}>Continue as a human</button>
    <div className="objective"><Bot size={18}/><span><strong>AI participant</strong><br/>Create a separate, room-scoped credential for an AI runtime you configure. This does not attach the current ChatGPT or Claude conversation by itself.</span></div>
    <button onClick={() => { setInviteRoute('ai'); setAiInviteConsent(false); setError(''); }}>Set up a separate AI runtime</button>
    <div className="objective"><Bot size={18}/><span><strong>Use an existing AI conversation</strong><br/>Bring context from your current ChatGPT or Claude conversation. If direct tools are unavailable, use a guided copy-and-paste relay.</span></div>
    <button className="primary" onClick={() => { setInviteRoute('guided'); setRelayCopied(false); setError(''); }}>Continue with my existing AI conversation</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'guided' && !agentSecret) return <main className="auth-page"><AuthStory/><div className="auth-panel"><div className="rm-auth-top"><a className="rm-auth-brand" href="/"><span className="brand-icon"><Sparkles size={17}/></span><strong>Rub Minds</strong></a><ThemeToggle compact/></div>
    
    <h1>Bring your existing AI into this group</h1>
    <p>This creates a handoff from your current conversation without replacing it. Copy the instructions below into the same ChatGPT or Claude conversation you already use.</p>
    <div className="objective"><Sparkles size={18}/><span><strong>What this does</strong><br/>It asks your AI to prepare a privacy-aware context packet and continue helping you. If that account cannot use a Rub Minds connector, you can relay group messages manually. This is not automatic two-way sync.</span></div>
    <button className="primary" onClick={() => { void copyExistingAiGuide(); }}>{relayCopied ? 'Instructions copied' : 'Copy AI joining instructions'}</button>
    <p className="disclaimer">Share this invitation only with the intended participant. After joining, use Private AI context to save the JSON packet privately; share only reviewed, selected insights with the group. Never paste credentials or unrelated private conversation content.</p>
    <button onClick={() => { setInviteRoute('human'); if (!user) setAuthMode('signin'); }}>Continue to Rub Minds to join the group</button>
    <button onClick={() => { setInviteRoute('choose'); setRelayCopied(false); }}>Back to route selection</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
  if (inviteToken && inviteTokenValid && inviteRoute === 'ai' && !agentSecret) return <main className="auth-page"><AuthStory/><div className="auth-panel"><div className="rm-auth-top"><a className="rm-auth-brand" href="/"><span className="brand-icon"><Sparkles size={17}/></span><strong>Rub Minds</strong></a><ThemeToggle compact/></div>
    
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
  if (!user && agentSecret) return <main className="auth-page"><AuthStory/><div className="auth-panel"><div className="rm-auth-top"><a className="rm-auth-brand" href="/"><span className="brand-icon"><Sparkles size={17}/></span><strong>Rub Minds</strong></a><ThemeToggle compact/></div>
    <h1>AI credential created</h1>
    <p>This one-time credential belongs to <strong>{agentName}</strong>. Save it privately now. It is scoped to the invited room and expires no later than the invitation expiry or seven days.</p>
    <label>Private AI credential<input readOnly aria-label="Private AI credential" value={agentSecret} onFocus={e => e.target.select()}/></label>
    <button className="primary" onClick={() => { void copyToClipboard(agentSecret, 'Private AI credential', 'Save this credential somewhere secure. It is shown only once.'); }}>Copy credential</button>
    <p className="disclaimer">Use it as an Authorization: Bearer credential with the Rub Minds agent-messages endpoint. A runtime and model provider are still required for automatic replies.</p>
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>;
  if (!user || authMode === 'reset') return <main className="auth-page"><AuthStory/><div className="auth-panel"><div className="rm-auth-top"><a className="rm-auth-brand" href="/"><span className="brand-icon"><Sparkles size={17}/></span><strong>Rub Minds</strong></a><ThemeToggle compact/></div>
    
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
      {authMode !== 'reset' && authMode !== 'forgot' && !inviteToken && <button type="button" onClick={() => setJoinLinkOpen(true)}><Link2 size={13}/> Have an invitation? Join with link</button>}
    </div>
    {joinLinkOpen && <div className="modal-backdrop" onClick={() => setJoinLinkOpen(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); beginInviteFromLink(); }}><div className="modal-icon"><Link2/></div><h2>Join a group</h2><p>Paste the invitation link you received. Your invite stays available while you choose how to join.</p><label>Invitation link<input autoFocus required value={joinLinkDraft} onChange={e => setJoinLinkDraft(e.target.value)} placeholder="https://rub-minds.vercel.app/?invite=…"/></label><div className="modal-actions"><button type="button" onClick={() => setJoinLinkOpen(false)}>Cancel</button><button className="primary" disabled={!joinLinkDraft.trim()}>Continue <ArrowRight size={15}/></button></div></form></div>}
  </div></main>;
  return <div className="app rm-app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Sparkles size={21}/></div><div><strong>Rub Minds</strong><small>Collective intelligence</small></div></div>
      <div className="rm-sidebar-top"><span className="rm-sidebar-kicker">YOUR WORKSPACE</span><ThemeToggle/></div>
      <button className="new-room" onClick={() => setCreating(true)}><Plus size={17}/> Create a group</button>
      <button className="rm-join-shortcut" onClick={() => setJoinLinkOpen(true)}><Link2 size={16}/> Join with invitation</button>
      <div className="section-label">YOUR GROUPS <span>{rooms.length}</span></div>
      <nav className="room-list" aria-label="Your groups">
        {rooms.length ? rooms.map(r => <button key={r.id} className={'room-link ' + (r.id === selected ? 'active' : '')} onClick={() => navigate(r.id)}><MessageCircle size={16}/><span>{r.title}</span><ChevronRight size={14}/></button>) : <p className="rm-sidebar-empty">Your groups will appear here.</p>}
      </nav>
      <a className="rm-backroom-link" href={selected ? '/?backroom=1&room=' + encodeURIComponent(selected) : '/?backroom=1'}><Monitor size={16}/> Backroom device workspace <ChevronRight size={14}/></a>
      <div className="sidebar-footer"><span className="status-dot"/> Secure group workspace
        <div className="rm-sidebar-account"><div className="rm-account-avatar">{(user.email || 'R').slice(0,1).toUpperCase()}</div><div className="rm-account-copy"><strong>{user.email || 'Your account'}</strong><small>Signed in</small></div><button className="rm-logout-icon" aria-label="Sign out" title="Sign out" onClick={() => { void signOut().catch(e => setError(errorMessage(e))); }}><LogOut size={16}/></button></div>
      </div>
    </aside>
    <main className="main rm-main">
      {error && <p className="error" role="alert">{error}</p>}
      {agentSecret && <div className="invite-share" role="status"><strong>{agentName} — runtime credential created</strong><p>This credential is shown only here. Save it privately; it is scoped to this group and expires. It does not attach your current ChatGPT or Claude conversation by itself.</p><input readOnly aria-label="Private AI credential" value={agentSecret} onFocus={e => e.target.select()}/><button onClick={() => { void navigator.clipboard.writeText(agentSecret).catch(() => setError('Select and copy the credential manually.')); }}>Copy credential</button><button onClick={() => setAgentSecret('')}>Done</button></div>}
      {inviteLink && <div className="invite-share rm-invite-banner" role="status"><strong>Invitation ready to share</strong><p>Valid for 24 hours and up to 10 human joins. {inviteAIEnabled ? 'This invite also enables up to 3 separate AI credentials.' : 'This is a human-only invitation.'} Send it to a person or open it in the existing AI conversation to see its available join route.</p><input aria-label="Shareable invitation URL" readOnly value={inviteLink} onFocus={e => e.target.select()}/><button onClick={() => { void copyToClipboard(inviteLink, 'Group invitation link', 'Share this link only with the intended group participants.'); }}>Copy link</button>{inviteAIEnabled && <button onClick={() => { void copyCreatedInviteForAI(); }}>{relayCopied ? 'Instructions copied' : 'Copy AI instructions'}</button>}<button disabled={busy} onClick={() => { void revokeInviteLink(); }}>Revoke</button><button onClick={() => setInviteLink('')}>Close</button></div>}
      {inviteToken ? <section className="empty rm-invite-accept"><span className="rm-invite-icon"><Link2 size={22}/></span><span className="rm-eyebrow">YOU HAVE AN INVITATION</span><h1>{inviteTokenValid ? 'Join your next great conversation.' : 'This invitation needs attention.'}</h1><p>{inviteTokenValid ? 'Accept this invitation with your Rub Minds account. Your access stays scoped to this group.' : 'This invitation is incomplete. Ask the group owner for a fresh link.'}</p><button className="primary" onClick={() => { void joinInvite(); }} disabled={joining || !inviteTokenValid}>{joining ? 'Joining group…' : 'Accept group invitation'} <ArrowRight size={16}/></button><p className="disclaimer">Invitations expire after 24 hours or 10 successful joins.</p></section>
      : selected && room ? <>
        <header className="rm-room-header"><div className="rm-room-title-block"><span className="rm-eyebrow"><Users size={13}/> COLLABORATION SPACE</span><h2>{room.title}</h2><span className="rm-room-meta"><span className="status-dot"/> {participants.length} participants <span>·</span> {messages.length} messages</span></div>
          <div className="rm-room-actions"><a className="rm-button-secondary" href={'/?backroom=1&room=' + encodeURIComponent(room.id)}><Monitor size={15}/> Backroom</a><button className="rm-button-secondary" onClick={() => { void copyGroupRelayContext(); }}><Copy size={15}/> {relayCopied ? 'Context copied' : 'Share context with AI'}</button>{room.owner_id === user.id && <button className="rm-primary-action" disabled={busy} onClick={() => openInviteOptions()}><UserPlus size={15}/> Invite</button>}</div>
        </header>
        <div className="objective"><Sparkles size={15}/><div><strong>SHARED OBJECTIVE</strong><p>{room.objective || 'Bring perspectives together and make thoughtful progress.'}</p></div></div>
        <nav className="rm-room-tabs" aria-label="Group workspace sections">
          <button className={activePanel === 'conversation' ? 'active' : ''} onClick={() => openPanel('conversation')}><MessageCircle/> Conversation <span>{messages.length}</span></button>
          <button className={activePanel === 'participants' ? 'active' : ''} onClick={() => openPanel('participants')}><Users/> People <span>{participants.length}</span></button>
          <button className={activePanel === 'private-context' ? 'active' : ''} onClick={() => openPanel('private-context')}><LockKeyhole/> Private context</button>
          <button className={activePanel === 'shared-memory' ? 'active' : ''} onClick={() => openPanel('shared-memory')}><BrainCircuit/> Shared memory <span>{groupMemories.length}</span></button>
          <button className={activePanel === 'connections' ? 'active' : ''} onClick={() => openPanel('connections')}><Cable/> Connections</button>
        </nav>
        {activePanel === 'conversation' && <>
          <div className="messages" aria-live="polite">{messages.length === 0 ? <div className="rm-empty-messages"><span className="rm-empty-orbit"><Sparkles size={25}/></span><strong>Start the group's first conversation</strong><p>Set the direction with a message. Invite people and existing AI conversations when the room is ready.</p></div> : messages.map(m => { const p = participants.find(p => p.id === m.sender_id); return <div className="message" key={m.id}><div className={'avatar ' + (p?.kind === 'human' ? 'human' : 'ai')}>{p?.kind === 'human' ? (p.display_name[0] || 'H').toUpperCase() : <Bot size={18}/>}</div><div className="rm-message-body"><div className="message-meta"><strong>{p?.display_name || 'Participant'}</strong><time>{new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time><span className="rm-kind-pill">{participantKindLabel(p?.kind || '')}</span></div><p>{m.body}</p></div></div>; })}</div>
          <div className="composer-area"><form className="composer" onSubmit={send}><input aria-label="Message" placeholder="Share a thought, question or next step…" value={draft} onChange={e => setDraft(e.target.value)} maxLength={10000}/><button disabled={busy || !draft.trim()} aria-label="Send message"><Send size={17}/></button></form><p className="disclaimer">People and AI sessions share this same conversation. AI replies require an active connected runtime.</p></div>
        </>}
        {activePanel === 'participants' && <section className="rm-panel rm-people-panel"><div className="rm-people-heading"><div><span className="rm-eyebrow">THE MINDS IN THIS ROOM</span><h3>{participants.length} participants</h3><p>One group identity for every person and connected AI session.</p></div>{room.owner_id === user.id && <button className="rm-primary-action" onClick={() => openInviteOptions()}><UserPlus size={15}/> Invite someone</button>}</div>
          <div className="rm-people-grid">{participants.map(p => <article key={p.id} className="rm-person-card"><span className="rm-person-avatar">{p.kind === 'human' ? <Users size={17}/> : <Bot size={18}/>}</span><span className="rm-person-copy"><strong>{p.display_name}</strong><small>{participantKindLabel(p.kind)} · {p.status || 'joined'}</small></span><span className="rm-person-status">{p.status || 'joined'}</span></article>)}</div>
        </section>}
        {activePanel === 'private-context' && <section className="rm-panel private-context-panel"><span className="rm-eyebrow"><LockKeyhole size={13}/> PRIVATE TO YOUR ACCOUNT</span><strong>Bring context from your existing AI</strong><p>Paste the structured JSON context packet from your existing ChatGPT or Claude conversation. It stays private to your account and is not visible to other group members. Review it before saving; never include credentials or unrelated sensitive content.</p>
          <form onSubmit={savePrivateContext} className="private-context-form"><textarea aria-label="Private AI context packet" rows={7} maxLength={100000} value={sessionContextDraft} onChange={e => setSessionContextDraft(e.target.value)} placeholder='Paste JSON with schema "rub-minds.session-memory" here…'/><button className="primary" disabled={sessionContextBusy || !sessionContextDraft.trim()}>{sessionContextBusy ? 'Saving privately…' : 'Save private context'} <ArrowRight size={15}/></button></form>
          {sessionContextNotice && <p role="status">{sessionContextNotice}</p>}
          <div className="private-import-list"><strong>Your saved private context ({privateImports.length})</strong>{privateImports.length === 0 ? <p>No private AI context has been saved for this group yet.</p> : privateImports.map(item => <div className="private-import-item" key={item.id}><div><strong>{item.title}</strong><p>{item.source_platform} · {new Date(item.created_at).toLocaleDateString()}</p><p>{item.context_summary.length > 500 ? item.context_summary.slice(0,500) + '…' : item.context_summary}</p></div><button onClick={() => { void copyPrivateContextToAI(item); }}>Copy to AI</button><button onClick={() => { void removePrivateContext(item); }}>Delete</button></div>)}</div>
        </section>}
        {activePanel === 'shared-memory' && <section className="rm-panel shared-memory-panel"><span className="rm-eyebrow"><BrainCircuit size={13}/> GROUP-VISIBLE MEMORY</span><strong>What the group should remember</strong><p>Entries here are visible to every human participant and connected AI session. This is separate from your private AI context. Share only selected, reviewed insights.</p>
          {currentHumanParticipant && <form onSubmit={shareGroupMemory} className="private-context-form"><select aria-label="Shared memory type" value={shareMemoryType} onChange={e => setShareMemoryType(e.target.value as GroupMemoryEntry['entry_type'])}><option value="insight">Insight</option><option value="decision">Decision</option><option value="goal">Goal</option><option value="open_question">Open question</option><option value="progress">Progress</option><option value="summary">Summary</option></select><textarea aria-label="Selected insight to share with the group" rows={4} maxLength={12000} value={shareMemoryDraft} onChange={e => setShareMemoryDraft(e.target.value)} placeholder="Write only the insight the whole group should remember…"/><button className="primary" disabled={sharedMemoryBusy || !shareMemoryDraft.trim()}>{sharedMemoryBusy ? 'Sharing…' : 'Share selected insight'} <ArrowRight size={15}/></button></form>}
          {sharedMemoryNotice && <p role="status">{sharedMemoryNotice}</p>}
          <div className="private-import-list"><strong>Shared entries ({groupMemories.length})</strong>{groupMemories.length === 0 ? <p>No group memory entries yet.</p> : groupMemories.map(memory => <div className="private-import-item" key={memory.id}><div><strong>{memory.entry_type.replace('_',' ')} · {participants.find(p => p.id === memory.created_by_participant_id)?.display_name || 'Participant'}</strong><p>{memory.content.length > 800 ? memory.content.slice(0,800) + '…' : memory.content}</p></div>{memory.created_by_participant_id === currentHumanParticipant?.id && <button onClick={() => { void removeGroupMemory(memory); }}>Delete</button>}</div>)}</div>
        </section>}
        {activePanel === 'connections' && <section className="rm-panel rm-connections-panel"><div className="rm-people-heading"><div><span className="rm-eyebrow">INVITATIONS & ACCESS</span><h3>Connect more minds</h3><p>Invite a person, bring an existing AI conversation, or manage a separately configured runtime.</p></div></div>
          <div className="rm-connection-cards">
            <article><span><Users size={18}/></span><strong>Invite people</strong><p>Share a room-scoped link. They sign in or create an account, then join.</p>{room.owner_id === user.id && <button className="rm-primary-action" disabled={busy} onClick={() => openInviteOptions()}>Create invitation <ArrowRight size={14}/></button>}</article>
            <article><span><MessageCircle size={18}/></span><strong>Bring an existing AI conversation</strong><p>Share an invitation with the same ChatGPT or Claude conversation. Its join route explains what that particular client can actually do.</p><button className="rm-button-secondary" onClick={() => { if (inviteLink) void copyCreatedInviteForAI(); else openInviteOptions(true); }}>Create / copy AI invitation</button></article>
            <article><span><Bot size={18}/></span><strong>External AI runtime</strong><p>Create a separate room-scoped credential for a configured agent runtime. This does not attach a native ChatGPT or Claude conversation.</p>{room.owner_id === user.id && <button className="rm-button-secondary" disabled={busy} onClick={() => { void addAgent(); }}>Create runtime credential</button>}</article>
          </div>
          <div className="rm-connections-management"><div><strong>Separate AI credentials</strong><p>Active credentials are scoped to this group and can be revoked independently.</p></div><button className="rm-button-secondary" onClick={() => { void manageAgents(); }}>Refresh connections <RefreshCw size={14}/></button>
            {agentConnections.length ? agentConnections.map(a => <div className="rm-connection-row" key={a.id}><span>{participants.find(p => p.id === a.participant_id)?.display_name || 'AI runtime'}<small>{a.revoked_at ? 'Revoked' : new Date(a.expires_at) <= new Date() ? 'Expired' : 'Active'}</small></span>{!a.revoked_at && room.owner_id === user.id && <button onClick={() => { void revokeAgent(a.id); }}>Revoke</button>}</div>) : <p>No separate runtime credentials loaded.</p>}
          </div>
        </section>}
      </> : selected ? <section className="empty rm-room-unavailable"><span className="rm-invite-icon"><CircleAlert size={22}/></span><h2>Room unavailable</h2><p>You may not have permission to view this group. Ask the owner for an invitation.</p><button className="primary" onClick={() => navigate('')}>Back to your groups</button></section>
      : <section className="welcome rm-home"><div className="rm-home-hero"><div className="rm-home-copy"><span className="eyebrow"><Sparkles size={14}/> COLLECTIVE INTELLIGENCE</span><h1>More minds.<br/><em>Better thinking.</em></h1><p>Bring people and the AI conversations they already use into one shared space to explore ideas, challenge assumptions and make progress together.</p><div className="rm-home-actions"><button className="primary" onClick={() => setCreating(true)}><Plus size={17}/> Create a group</button><button className="rm-secondary-action" onClick={() => setJoinLinkOpen(true)}><Link2 size={16}/> Join with invitation</button></div></div>
          <div className="rm-hero-visual" aria-hidden="true"><div className="rm-hero-grid"/><svg className="rm-constellation" viewBox="0 0 440 290" fill="none"><path d="M80 73 C140 73 140 145 220 145 S300 73 360 73"/><path d="M70 230 C145 230 150 145 220 145 S295 230 370 230"/><path d="M80 73 C115 160 138 230 70 230 M360 73 C320 150 320 230 370 230"/><circle cx="80" cy="73" r="8"/><circle cx="360" cy="73" r="8"/><circle cx="70" cy="230" r="8"/><circle cx="370" cy="230" r="8"/></svg><div className="rm-orbit-core"><Sparkles size={34}/></div><div className="rm-orbit-node people"><Users size={15}/> People</div><div className="rm-orbit-node ai"><Bot size={15}/> AI sessions</div><div className="rm-orbit-node phone"><Smartphone size={15}/> Phone</div><div className="rm-orbit-node terminal"><SquareTerminal size={15}/> Terminal</div></div></div>
        <div className="rm-home-proof"><div className="rm-proof-card"><Users/><div><strong>One shared group</strong><span>People and existing AI sessions collaborate together.</span></div></div><div className="rm-proof-card"><LockKeyhole/><div><strong>Privacy by choice</strong><span>Private context and group-visible memory stay separate.</span></div></div><div className="rm-proof-card"><Layers3/><div><strong>Every surface</strong><span>One collaboration space across phone, desktop and terminal.</span></div></div></div>
        <div className="rm-home-groups"><div className="rm-section-heading"><div><h2>Your groups</h2><p>{rooms.length ? 'Pick up where your group left off.' : 'Your collaboration spaces will appear here.'}</p></div><button className="rm-button-secondary" onClick={() => setCreating(true)}><Plus size={15}/> New group</button></div>{rooms.length ? <div className="rm-group-grid">{rooms.map(group => <button key={group.id} className="rm-group-card" onClick={() => navigate(group.id)}><span className="rm-group-card-top"><span className="rm-group-card-icon"><Users size={17}/></span><ArrowUpRight size={16}/></span><h3>{group.title}</h3><p>{group.objective || 'Shared space for people and AI collaborators.'}</p><span className="rm-group-card-foot"><span>Open group</span><ArrowRight size={14}/></span></button>)}</div> : <div className="rm-home-empty">No groups yet. Create a group, then invite the people or existing AI conversations you want in the room.</div>}</div>
      </section>}
    </main>
    {creating && <div className="modal-backdrop" onClick={() => setCreating(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={create}><div className="modal-icon"><Users/></div><h2>Create a live group</h2><p>Start a shared collaboration space.</p><label>Group name<input autoFocus required maxLength={80} value={title} onChange={e => setTitle(e.target.value)}/></label><label>Objective<textarea rows={3} maxLength={500} value={objective} onChange={e => setObjective(e.target.value)}/></label><div className="modal-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy}>Create group</button></div></form></div>}
    {joinLinkOpen && <div className="modal-backdrop" onClick={() => setJoinLinkOpen(false)}><form className="modal" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); beginInviteFromLink(); }}><div className="modal-icon"><Link2/></div><h2>Join a group</h2><p>Paste a Rub Minds invitation link. We’ll preserve it and guide you through sign-in or the available AI onboarding route.</p><label>Invitation link<input autoFocus required value={joinLinkDraft} onChange={e => setJoinLinkDraft(e.target.value)} placeholder="https://rub-minds.vercel.app/?invite=…"/></label><div className="modal-actions"><button type="button" onClick={() => setJoinLinkOpen(false)}>Cancel</button><button className="primary" disabled={!joinLinkDraft.trim()}>Continue <ArrowRight size={15}/></button></div></form></div>}
    {agentCreateOpen && <div className="modal-backdrop" onClick={() => setAgentCreateOpen(false)}><form className="modal rm-agent-create" onClick={e => e.stopPropagation()} onSubmit={createAgent}><div className="modal-icon"><Bot/></div><span className="rm-eyebrow">SEPARATE RUNTIME</span><h2>Connect an AI runtime</h2><p>This creates a scoped credential for an independently configured agent. It does not attach your current ChatGPT or Claude conversation.</p><label>Runtime display name<input autoFocus required maxLength={80} value={agentNameDraft} onChange={e => setAgentNameDraft(e.target.value)} placeholder="e.g. Research Agent"/></label><div className="modal-actions"><button type="button" onClick={() => setAgentCreateOpen(false)}>Cancel</button><button className="primary" disabled={busy || !agentNameDraft.trim()}>{busy ? 'Creating…' : 'Create credential'} <ArrowRight size={15}/></button></div></form></div>}
    {confirmDialog && <div className="modal-backdrop" onClick={() => setConfirmDialog(null)}><section className="modal rm-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rm-confirm-title" aria-describedby="rm-confirm-description" onClick={e => e.stopPropagation()}><div className="modal-icon"><CircleAlert/></div><span className="rm-eyebrow">CONFIRM THIS ACTION</span><h2 id="rm-confirm-title">{confirmDialog.title}</h2><p id="rm-confirm-description">{confirmDialog.description}</p><div className="modal-actions"><button type="button" onClick={() => setConfirmDialog(null)}>Cancel</button><button type="button" className={confirmDialog.destructive ? 'rm-danger-action' : 'primary'} onClick={runConfirmedAction}>{confirmDialog.confirmLabel}</button></div></section></div>}
    {copyFallback && <div className="modal-backdrop" onClick={() => setCopyFallback(null)}><section className="modal rm-copy-fallback" role="dialog" aria-modal="true" aria-labelledby="rm-copy-title" onClick={e => e.stopPropagation()}><div className="modal-icon"><Copy/></div><h2 id="rm-copy-title">{copyFallback.title}</h2><p>{copyFallback.description}</p><textarea id="rm-copy-fallback-text" readOnly autoFocus rows={8} value={copyFallback.value} onFocus={e => e.currentTarget.select()} onClick={e => e.currentTarget.select()}/><div className="modal-actions"><button type="button" onClick={() => { const el = document.getElementById('rm-copy-fallback-text') as HTMLTextAreaElement | null; el?.focus(); el?.select(); }}>Select all text</button><button type="button" className="primary" onClick={() => setCopyFallback(null)}>Done</button></div></section></div>}
    {inviteOptionsOpen && <div className="modal-backdrop" onClick={() => setInviteOptionsOpen(false)}><form className="modal rm-invite-options" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void makeInvite(); }}><div className="modal-icon"><UserPlus/></div><span className="rm-eyebrow">INVITE TO THIS GROUP</span><h2>Create a group invitation</h2><p>Share a secure, time-limited link. People join with their own Rub Minds account. You can also enable a separate AI credential route for a configured runtime.</p><label className="rm-invite-ai-option"><input type="checkbox" checked={inviteAIChoice} onChange={e => setInviteAIChoice(e.target.checked)}/><span><strong>Allow AI runtime credentials</strong><small>Up to 3 separate AI participants can redeem this invitation. This does not automatically connect a native ChatGPT or Claude conversation.</small></span></label><div className="modal-actions"><button type="button" onClick={() => setInviteOptionsOpen(false)}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Creating invitation…' : 'Create invitation'} <ArrowRight size={15}/></button></div></form></div>}
  </div>;
}
