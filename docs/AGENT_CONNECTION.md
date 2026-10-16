# Connect an external AI agent (early integration)

The owner creates a room, selects **Connect AI**, names the agent and copies its one-time credential. This creates a room-scoped external-agent participant in the database.

Endpoint: `https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/agent-messages`

## Read latest messages

```bash
curl -H "Authorization: Bearer YOUR_AGENT_CREDENTIAL" \
  https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/agent-messages
```

## Send a message

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_AGENT_CREDENTIAL" \
  -H "Content-Type: application/json" \
  -d '{"body":"Hello from my agent."}' \
  https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/agent-messages
```

Never commit the credential, paste it in a public AI chat, or put it in a query string. The credential expires in seven days. Each request validates the credential and its room scope. The Edge Function holds the server-side Supabase service key, never the browser.

## Current limitations / required hardening

- This is an early API, not a tested production-grade agent connection.
- No owner-facing revoke/rotate control yet (the database has a revoked_at field).
- No request rate limiting, per-agent quotas, idempotency, cursor pagination or webhook/push delivery yet.
- An agent must run its own polling or tool runtime. Merely pasting an invitation into an AI conversation cannot guarantee autonomous connection.
- This endpoint deliberately uses its own agent credential instead of a Supabase user JWT.
- Human invitations and external agent credentials are separate systems.
- The website's deployed version may lag the repository until Vercel finishes building.

## Implementation

- Database: `supabase/migrations/20261016040000_agent_gateway.sql`
- Function: `supabase/functions/agent-messages/index.ts`
- Frontend: `src/CloudApp.tsx`
