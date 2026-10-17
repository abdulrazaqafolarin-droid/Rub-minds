import { supabase } from './supabase';
import { buildInviteRedirectUrl } from './inviteLinks';

export type CloudRoom = {
  id: string; owner_id: string; title: string; objective: string; created_at: string;
};
export type CloudParticipant = {
  id: string; room_id: string; user_id: string | null; display_name: string; kind: string; status: string;
};
export type CloudMessage = {
  id: string; room_id: string; sender_id: string; body: string; created_at: string;
};
function client() {
  if (!supabase) throw new Error('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  return supabase;
}
export async function signInWithPassword(email: string, password: string) {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signUpWithPassword(email: string, password: string, inviteToken = '') {
  // Keep the pending invitation through Supabase email confirmation so new users
  // return to the room invite instead of landing on the generic home page.
  const redirect = buildInviteRedirectUrl(window.location.origin, inviteToken);
  const { data, error } = await client().auth.signUp({
    email, password, options: { emailRedirectTo: redirect },
  });
  if (error) throw error;
  return { confirmationRequired: !data.session };
}
export async function requestPasswordReset(email: string) {
  const { error } = await client().auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/?reset=password',
  });
  if (error) throw error;
}
export async function updateAccountPassword(password: string) {
  const { error } = await client().auth.updateUser({ password });
  if (error) throw error;
}
export async function signOut() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}
export async function createCloudRoom(title: string, objective: string): Promise<string> {
  const { data, error } = await client().rpc('create_room_with_owner', { room_title: title, room_objective: objective });
  if (error) throw error;
  return data as string;
}
export async function listCloudRooms(): Promise<CloudRoom[]> {
  const { data, error } = await client().from('rooms').select('id,owner_id,title,objective,created_at').order('created_at', { ascending: false });
  if (error) throw error;
  return data as CloudRoom[];
}
export async function getCloudRoom(roomId: string): Promise<CloudRoom | null> {
  const { data, error } = await client().from('rooms').select('id,owner_id,title,objective,created_at').eq('id', roomId).maybeSingle();
  if (error) throw error;
  return data as CloudRoom | null;
}
export async function listCloudMessages(roomId: string): Promise<CloudMessage[]> {
  const { data, error } = await client().from('messages').select('id,room_id,sender_id,body,created_at').eq('room_id', roomId).order('created_at', { ascending: true }).limit(500);
  if (error) throw error;
  return data as CloudMessage[];
}
export async function listCloudParticipants(roomId: string): Promise<CloudParticipant[]> {
  const { data, error } = await client().from('participants').select('id,room_id,user_id,display_name,kind,status').eq('room_id', roomId);
  if (error) throw error;
  return data as CloudParticipant[];
}
export async function postCloudMessage(roomId: string, body: string): Promise<CloudMessage> {
  const { data: userResult, error: authError } = await client().auth.getUser();
  if (authError || !userResult.user) throw new Error('Sign in before sending messages.');
  const { data: member, error: memberError } = await client().from('participants')
    .select('id').eq('room_id', roomId).eq('user_id', userResult.user.id).single();
  if (memberError || !member) throw new Error('You are not a member of this room.');
  const { data, error } = await client().from('messages')
    .insert({ room_id: roomId, sender_id: member.id, body }).select('id,room_id,sender_id,body,created_at').single();
  if (error) throw error;
  return data as CloudMessage;
}
export function subscribeToCloudMessages(roomId: string, refresh: () => void) {
  const channel = client().channel('room-messages:' + roomId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'room_id=eq.' + roomId }, refresh)
    .subscribe();
  return () => { void client().removeChannel(channel); };
}

/** Returns a one-time-visible raw invitation token; only a room owner can create it. */
export async function createCloudInvite(roomId: string, allowAI = false, aiUses = 0): Promise<string> {
  const { data, error } = await client().rpc('create_dual_room_invite', {
    target_room: roomId, valid_hours: 24, allowed_uses: 10,
    allow_ai_participants: allowAI, allowed_ai_uses: allowAI ? aiUses : 0,
  });
  if (error) throw error;
  return data as string;
}
/** Redeem after authentication. Invalid, expired, revoked, or exhausted tokens fail. */
export async function redeemCloudInvite(token: string): Promise<string> {
  const { data, error } = await client().rpc('redeem_room_invite', { invite_token: token });
  if (error) throw error;
  return data as string;
}

/** Redeems the AI route of a dual invitation and returns a unique scoped credential once. */
export type AIInviteRedemption = {
  room_id: string; participant_id: string; agent_secret: string; expires_at: string;
};
export async function redeemAIInvite(token: string, agentLabel: string): Promise<AIInviteRedemption> {
  const { data, error } = await client().functions.invoke('redeem-ai-invite', {
    body: { invite_token: token, agent_label: agentLabel },
  });
  if (error) throw error;
  if (!data || typeof data.agent_secret !== 'string' || typeof data.room_id !== 'string') {
    throw new Error('AI invitation response was incomplete.');
  }
  return data as AIInviteRedemption;
}

/** Owner-only: creates an external agent participant and returns its secret once. */
export async function connectCloudAgent(roomId: string, name: string): Promise<string> {
  const { data, error } = await client().rpc('connect_external_agent', {
    target_room: roomId, agent_label: name,
  });
  if (error) throw error;
  return data as string;
}

export type AgentConnection = {
  id: string; room_id: string; participant_id: string;
  expires_at: string; revoked_at: string | null;
};
export async function listAgentConnections(roomId: string): Promise<AgentConnection[]> {
  const { data, error } = await client().from('agent_connections')
    .select('id,room_id,participant_id,expires_at,revoked_at')
    .eq('room_id', roomId).order('created_at', { ascending: false });
  if (error) throw error;
  return data as AgentConnection[];
}
export async function revokeCloudAgent(connectionId: string): Promise<boolean> {
  const { data, error } = await client().rpc('revoke_external_agent', { connection_id: connectionId });
  if (error) throw error;
  return data as boolean;
}
