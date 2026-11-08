const MESSAGE_LIMIT = 100;
const MEMORY_LIMIT = 20;
const TASK_LIMIT = 30;
const MAX_MESSAGE_CHARS = 10_000;

function failOnError(error, fallback) {
  if (error) throw new Error(error.message || fallback);
}

function isMissingTasksRelation(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /room_tasks.*(not found|does not exist)|relation .*room_tasks/i.test(error?.message || "");
}

function requireRoomId(roomId) {
  if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 128) {
    throw new TypeError("Choose a valid Rub Minds group.");
  }
  return roomId;
}

/** Returns only rooms visible to the authenticated user under the existing RLS policies. */
export async function listDesktopWorkspaceRooms(client) {
  const { data, error } = await client.from("rooms")
    .select("id,owner_id,title,objective,created_at")
    .order("created_at", { ascending: false });
  failOnError(error, "Could not load your Rub Minds groups.");
  return Array.isArray(data) ? data : [];
}

/**
 * Loads a bounded, read-only group snapshot. Private session imports are never
 * selected; the memory query explicitly filters visibility='group'.
 */
export async function loadDesktopGroupWorkspace(client, roomId) {
  requireRoomId(roomId);
  const [roomResult, messageResult, participantResult, memoryResult, taskResult] = await Promise.all([
    client.from("rooms").select("id,owner_id,title,objective,created_at").eq("id", roomId).maybeSingle(),
    client.from("messages").select("id,room_id,sender_id,body,created_at")
      .eq("room_id", roomId).order("created_at", { ascending: false }).limit(MESSAGE_LIMIT),
    client.from("participants").select("id,room_id,user_id,display_name,kind,status")
      .eq("room_id", roomId).limit(100),
    client.from("room_memory_entries").select("id,room_id,created_by_participant_id,entry_type,content,updated_at")
      .eq("room_id", roomId).eq("visibility", "group")
      .order("updated_at", { ascending: false }).limit(MEMORY_LIMIT),
    client.from("room_tasks").select("id,title,status,priority,due_at,assigned_to_participant_id,updated_at")
      .eq("room_id", roomId).order("updated_at", { ascending: false }).limit(TASK_LIMIT),
  ]);
  failOnError(roomResult.error, "Could not load this Rub Minds group.");
  failOnError(messageResult.error, "Could not load group messages.");
  failOnError(participantResult.error, "Could not load group participants.");
  failOnError(memoryResult.error, "Could not load shared group memory.");

  let tasks = [];
  let tasksAvailable = true;
  if (taskResult.error) {
    if (!isMissingTasksRelation(taskResult.error)) {
      throw new Error(taskResult.error.message || "Could not load group tasks.");
    }
    tasksAvailable = false;
  } else {
    tasks = Array.isArray(taskResult.data) ? taskResult.data : [];
  }

  if (!roomResult.data) throw new Error("You no longer have access to this Rub Minds group.");
  const messages = Array.isArray(messageResult.data) ? [...messageResult.data].reverse() : [];
  return {
    room: roomResult.data,
    messages,
    participants: Array.isArray(participantResult.data) ? participantResult.data : [],
    memories: Array.isArray(memoryResult.data) ? memoryResult.data : [],
    tasks,
    tasksAvailable,
  };
}

/** Sends as the authenticated human participant; database RLS remains authoritative. */
export async function sendDesktopGroupMessage(client, roomId, body) {
  requireRoomId(roomId);
  if (typeof body !== "string" || !body.trim() || body.length > MAX_MESSAGE_CHARS) {
    throw new TypeError("A group message must contain 1-10,000 characters.");
  }
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData?.user) throw new Error("Sign in before sending a group message.");

  const { data: participant, error: participantError } = await client.from("participants")
    .select("id")
    .eq("room_id", roomId)
    .eq("user_id", authData.user.id)
    .eq("kind", "human")
    .eq("status", "active")
    .maybeSingle();
  failOnError(participantError, "Could not verify your group membership.");
  if (!participant?.id) throw new Error("You are not an active human member of this group.");

  const { data, error } = await client.from("messages")
    .insert({ id: crypto.randomUUID(), room_id: roomId, sender_id: participant.id, body: body.trim() })
    .select("id,room_id,sender_id,body,created_at")
    .single();
  failOnError(error, "Could not confirm the group message. Refresh the conversation before retrying to avoid duplicates.");
  if (!data) throw new Error("The message was not confirmed. Refresh the conversation before retrying.");
  return data;
}

/** Realtime only triggers a bounded refresh; it does not carry or trust message content. */
export function subscribeDesktopGroupWorkspace(client, roomId, refresh) {
  requireRoomId(roomId);
  if (typeof refresh !== "function") throw new TypeError("A workspace refresh callback is required.");
  const channel = client.channel("desktop-group-workspace:" + roomId)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "messages", filter: "room_id=eq." + roomId,
    }, refresh)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "room_memory_entries", filter: "room_id=eq." + roomId,
    }, refresh)
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

export const DESKTOP_GROUP_WORKSPACE_LIMITS = Object.freeze({
  messages: MESSAGE_LIMIT,
  sharedMemories: MEMORY_LIMIT,
  tasks: TASK_LIMIT,
  messageChars: MAX_MESSAGE_CHARS,
});
