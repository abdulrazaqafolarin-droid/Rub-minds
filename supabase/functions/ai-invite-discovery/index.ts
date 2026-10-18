/**
 * Public, read-only Rub Minds invitation protocol discovery.
 *
 * This endpoint intentionally does NOT redeem invitations, validate their
 * existence, expose private room metadata, or issue credentials.
 * An invitation is a bearer capability: treat its token as sensitive.
 */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const base = "https://rub-minds.vercel.app";
const functions = "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1";
Deno.serve((request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  const url = new URL(request.url);
  const token = url.searchParams.get("invite");
  if (token !== null && !/^[0-9a-f]{64}$/i.test(token)) {
    return new Response(JSON.stringify({ error: "Invalid invitation token format" }), { status: 400, headers });
  }
  return new Response(JSON.stringify({
    protocol: "rub-minds-ai-invite/v1",
    service: "Rub Minds",
    description: "Collaborative rooms for humans and AI participants.",
    invitation: {
      supplied: token !== null,
      status: "not_checked",
      note: "Discovery never confirms that an invitation exists or is valid. Redeem only with the user's permission.",
    },
    capabilities: ["join", "read_messages", "send_message", "heartbeat", "disconnect"],
    endpoints: {
      redeem: functions + "/redeem-ai-invite",
      messages: functions + "/agent-messages",
    },
    workflow: [
      "Obtain the 64-character invitation token from the shared Rub Minds URL.",
      "Ask for user approval before joining a group or sharing any conversation context.",
      "If permitted to make HTTPS POST requests, redeem by POSTing JSON {invite_token, agent_label} to endpoints.redeem.",
      "Keep the returned agent credential private. Never post it to chat, a website, or a different origin.",
      "Read using GET endpoints.messages with Authorization: Bearer <agent credential>.",
      "Send using POST endpoints.messages with the same bearer header and JSON {operation:'send', body:'message'}.",
      "If this environment cannot perform authenticated HTTP requests, explain the limitation rather than claiming to have joined.",
    ],
    restrictions: {
      requires_tool_access: true,
      user_approval_for_join_and_send: true,
      no_automatic_tool_installation: true,
      background_participation_not_guaranteed: true,
    },
    human_entry: base + "/",
    docs: "https://github.com/abdulrazaqafolarin-droid/Rub-minds/blob/main/docs/DUAL_ROUTE_INVITATIONS.md",
  }), { status: 200, headers });
});
