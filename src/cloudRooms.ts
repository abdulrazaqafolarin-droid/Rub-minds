import { supabase } from './supabase';
import type { SessionMemoryDocument } from './aiRelay';
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

/** Owner-only: revokes this invitation token so it cannot create new memberships. */
export async function revokeCloudInvite(token: string): Promise<boolean> {
  const { data, error } = await client().rpc('revoke_dual_room_invite', { invite_token: token });
  if (error) throw error;
  return data as boolean;
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

export type PrivateSessionImport = {
  id: string;
  room_id: string;
  participant_id: string;
  source_platform: string;
  title: string;
  context_summary: string;
  imported_context: SessionMemoryDocument;
  created_at: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Save a selected AI context packet privately under the signed-in human participant. */
export async function savePrivateSessionContext(roomId: string, participantId: string, document: SessionMemoryDocument): Promise<PrivateSessionImport> {
  const supabaseClient = client();
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !authData.user) throw new Error("Sign in to save private AI context.");
  const { data: participant, error: participantError } = await supabaseClient.from("participants")
    .select("id, room_id, user_id, kind")
    .eq("id", participantId).eq("room_id", roomId).eq("user_id", authData.user.id).eq("kind", "human").maybeSingle();
  if (participantError || !participant) throw new Error("Only your own human participant can save private context for this group.");
  const serialized = stableJson(document);
  const { data, error } = await supabaseClient.from("room_session_imports").insert({
    room_id: roomId,
    participant_id: participantId,
    owner_id: authData.user.id,
    document_version: 1,
    source_platform: document.source.platform,
    title: document.source.session_label || "Imported AI session",
    context_summary: document.summary,
    imported_context: document,
    content_sha256: await sha256Hex(serialized),
  }).select("id, room_id, participant_id, source_platform, title, context_summary, imported_context, created_at").single();
  if (error || !data) throw new Error("Could not save private AI context. Check your group membership and session-memory permissions.");
  return data as PrivateSessionImport;
}

/** Lists only private session imports belonging to this signed-in human participant. */
export async function listPrivateSessionContexts(roomId: string, participantId: string): Promise<PrivateSessionImport[]> {
  const { data, error } = await client().from("room_session_imports")
    .select("id, room_id, participant_id, source_platform, title, context_summary, imported_context, created_at")
    .eq("room_id", roomId).eq("participant_id", participantId)
    .order("created_at", { ascending: false }).limit(10);
  if (error) throw error;
  return (data || []) as PrivateSessionImport[];
}

/** Delete one of the signed-in user's private context imports. RLS enforces ownership again. */
export async function deletePrivateSessionContext(roomId: string, participantId: string, importId: string): Promise<void> {
  const { data, error } = await client().from("room_session_imports").delete()
    .eq("id", importId).eq("room_id", roomId).eq("participant_id", participantId)
    .select("id").maybeSingle();
  if (error || !data) throw new Error("Could not delete that private context import.");
}

export type GroupMemoryEntry = {
  id: string;
  room_id: string;
  created_by_participant_id: string;
  entry_type: "goal" | "insight" | "decision" | "open_question" | "progress" | "summary";
  visibility: "group";
  content: string;
  created_at: string;
  updated_at: string;
};

const groupMemoryTypes = new Set(["goal", "insight", "decision", "open_question", "progress", "summary"]);

/** Lists only group-visible memory; RLS keeps other participants' private entries hidden. */
export async function listGroupMemoryEntries(roomId: string): Promise<GroupMemoryEntry[]> {
  const { data, error } = await client().from("room_memory_entries")
    .select("id, room_id, created_by_participant_id, entry_type, visibility, content, created_at, updated_at")
    .eq("room_id", roomId).eq("visibility", "group")
    .order("updated_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data || []) as GroupMemoryEntry[];
}

/** Share only the explicit text the human reviewed; private context is never copied automatically. */
export async function saveGroupMemoryEntry(roomId: string, participantId: string, entryType: GroupMemoryEntry["entry_type"], content: string): Promise<GroupMemoryEntry> {
  const cleanContent = content.trim();
  if (!groupMemoryTypes.has(entryType)) throw new Error("Choose a supported group memory type.");
  if (!cleanContent || cleanContent.length > 12000) throw new Error("Shared insight must be 1-12,000 characters.");
  const supabaseClient = client();
  const { data: authData, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !authData.user) throw new Error("Sign in before sharing group memory.");
  const { data: participant, error: participantError } = await supabaseClient.from("participants")
    .select("id, room_id, user_id, kind")
    .eq("id", participantId).eq("room_id", roomId).eq("user_id", authData.user.id).eq("kind", "human").maybeSingle();
  if (participantError || !participant) throw new Error("Only your own human participant can publish group memory.");
  const { data, error } = await supabaseClient.from("room_memory_entries").insert({
    room_id: roomId,
    created_by_participant_id: participantId,
    owner_id: authData.user.id,
    entry_type: entryType,
    visibility: "group",
    content: cleanContent,
    source_message_ids: [],
    idempotency_key: crypto.randomUUID(),
  }).select("id, room_id, created_by_participant_id, entry_type, visibility, content, created_at, updated_at").single();
  if (error || !data) throw new Error("Could not share this insight. Check your group membership and memory permissions.");
  return data as GroupMemoryEntry;
}

/** A user may delete only their own group memory entry; RLS enforces the same rule server-side. */
export async function deleteGroupMemoryEntry(roomId: string, participantId: string, entryId: string): Promise<void> {
  const { data, error } = await client().from("room_memory_entries").delete()
    .eq("id", entryId).eq("room_id", roomId).eq("created_by_participant_id", participantId)
    .select("id").maybeSingle();
  if (error || !data) throw new Error("Could not delete that group memory entry.");
}

export function subscribeToGroupMemoryEntries(roomId: string, refresh: () => void) {
  const channel = client().channel("room-memory:" + roomId)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_memory_entries", filter: "room_id=eq." + roomId }, refresh)
    .subscribe();
  return () => { void client().removeChannel(channel); };
}


export type GroupTaskStatus = "backlog" | "assigned" | "in_progress" | "blocked" | "review" | "completed" | "failed" | "cancelled";
export type GroupTask = {
  id: string;
  room_id: string;
  created_by_participant_id: string;
  assigned_to_participant_id: string | null;
  title: string;
  description: string;
  expected_output: string;
  acceptance_criteria: string[];
  priority: number;
  status: GroupTaskStatus;
  due_at: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};
export type GroupTaskDependency = {
  id: string;
  room_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_by_participant_id: string;
  created_at: string;
};
export type GroupTaskSubmission = {
  id: string;
  room_id: string;
  task_id: string;
  submitted_by_participant_id: string;
  result_content: string;
  source_message_ids: string[];
  created_at: string;
};
export type GroupTaskReview = {
  id: string;
  room_id: string;
  task_id: string;
  submission_id: string;
  reviewer_participant_id: string;
  outcome: "approved" | "revision_requested";
  feedback: string;
  created_at: string;
};

export async function listGroupTasks(roomId: string): Promise<GroupTask[]> {
  const { data, error } = await client().from("room_tasks")
    .select("id,room_id,created_by_participant_id,assigned_to_participant_id,title,description,expected_output,acceptance_criteria,priority,status,due_at,blocked_reason,created_at,updated_at,version")
    .eq("room_id", roomId)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data || []) as GroupTask[];
}

export async function listGroupTaskDependencies(roomId: string): Promise<GroupTaskDependency[]> {
  const { data, error } = await client().from("room_task_dependencies")
    .select("id,room_id,task_id,depends_on_task_id,created_by_participant_id,created_at")
    .eq("room_id", roomId).order("created_at", { ascending: true }).limit(500);
  if (error) throw error;
  return (data || []) as GroupTaskDependency[];
}

export async function listGroupTaskSubmissions(roomId: string): Promise<GroupTaskSubmission[]> {
  const { data, error } = await client().from("room_task_submissions")
    .select("id,room_id,task_id,submitted_by_participant_id,result_content,source_message_ids,created_at")
    .eq("room_id", roomId).order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data || []) as GroupTaskSubmission[];
}

export async function listGroupTaskReviews(roomId: string): Promise<GroupTaskReview[]> {
  const { data, error } = await client().from("room_task_reviews")
    .select("id,room_id,task_id,submission_id,reviewer_participant_id,outcome,feedback,created_at")
    .eq("room_id", roomId).order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data || []) as GroupTaskReview[];
}

export async function createGroupTask(input: {
  roomId: string;
  creatorParticipantId: string;
  title: string;
  description?: string;
  expectedOutput?: string;
  assignedToParticipantId?: string | null;
  dependencyIds?: string[];
  acceptanceCriteria?: string[];
  priority?: number;
  dueAt?: string | null;
  idempotencyKey: string;
}): Promise<string> {
  const { data, error } = await client().rpc("create_room_task", {
    p_room_id: input.roomId,
    p_created_by_participant_id: input.creatorParticipantId,
    p_title: input.title.trim(),
    p_description: (input.description || "").trim(),
    p_expected_output: (input.expectedOutput || "").trim(),
    p_assigned_to_participant_id: input.assignedToParticipantId || null,
    p_dependency_ids: input.dependencyIds || [],
    p_priority: input.priority ?? 3,
    p_due_at: input.dueAt || null,
    p_acceptance_criteria: input.acceptanceCriteria || [],
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  if (typeof data !== "string") throw new Error("Task creation did not return a task ID.");
  return data;
}

export async function cancelGroupTask(roomId: string, taskId: string): Promise<void> {
  const { data, error } = await client().rpc("cancel_room_task", {
    p_room_id: roomId,
    p_task_id: taskId,
  });
  if (error || !data || data.cancelled !== true) throw new Error("Could not cancel this task. It may already be completed or failed.");
}

export async function assignGroupTask(roomId: string, taskId: string, participantId: string | null): Promise<void> {
  const { data, error } = await client().rpc("assign_room_task", {
    p_room_id: roomId,
    p_task_id: taskId,
    p_assigned_to_participant_id: participantId,
  });
  if (error || !data) throw new Error("Could not assign this task. Check its status and your group permissions.");
}

export async function reviewGroupTask(
  roomId: string,
  taskId: string,
  outcome: "approved" | "revision_requested",
  feedback = "",
): Promise<void> {
  const { data, error } = await client().rpc("review_room_task", {
    p_room_id: roomId,
    p_task_id: taskId,
    p_outcome: outcome,
    p_feedback: feedback.trim(),
  });
  if (error || !data) throw new Error("Could not save this task review. It may no longer be awaiting review.");
}

export async function claimGroupTaskAsHuman(roomId: string, taskId: string, participantId: string): Promise<void> {
  const { data, error } = await client().rpc("claim_room_task_human", {
    p_room_id: roomId,
    p_task_id: taskId,
    p_participant_id: participantId,
  });
  if (error || !data || data.claimed !== true) {
    const reason = data?.reason === "dependencies_incomplete"
      ? "Finish the prerequisite tasks before starting this one."
      : "Could not start this task. It may be assigned to another participant.";
    throw new Error(reason);
  }
}

export async function submitGroupTaskResultAsHuman(
  roomId: string,
  taskId: string,
  participantId: string,
  result: string,
  submissionKey: string,
): Promise<void> {
  const { data, error } = await client().rpc("submit_room_task_result_human", {
    p_room_id: roomId,
    p_task_id: taskId,
    p_participant_id: participantId,
    p_result_content: result.trim(),
    p_source_message_ids: [],
    p_idempotency_key: submissionKey,
  });
  if (error || !data) throw new Error("Could not submit this task result.");
}

export function subscribeToGroupTasks(roomId: string, refresh: () => void) {
  const channel = client().channel("room-tasks:" + roomId)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_tasks", filter: "room_id=eq." + roomId }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_task_dependencies", filter: "room_id=eq." + roomId }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_task_submissions", filter: "room_id=eq." + roomId }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_task_reviews", filter: "room_id=eq." + roomId }, refresh)
    .subscribe();
  return () => { void client().removeChannel(channel); };
}
