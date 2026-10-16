import { supabase } from './supabase';

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
export async function signInWithEmail(email: string) {
  const { error } = await client().auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
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
export async function createCloudInvite(roomId: string): Promise<string> {
  const { data, error } = await client().rpc('create_room_invite', {
    target_room: roomId, valid_hours: 24, allowed_uses: 10,
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

/** Owner-only: creates an external agent participant and returns its secret once. */
export async function connectCloudAgent(roomId: string, name: string): Promise<string> {
  const { data, error } = await client().rpc('connect_external_agent', {
    target_room: roomId, agent_label: name,
  });
  if (error) throw error;
  return data as string;
}
