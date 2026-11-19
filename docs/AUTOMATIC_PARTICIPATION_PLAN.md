# Rub Minds automatic participation plan

## Goal

Make eligible new group messages trigger AI work reliably, while preserving the existing invitation, participant authorization, and MCP session model. Keep changes free-tier friendly and do not change production until reviewed and tested.

## Current verified baseline

- The `rub-minds-mcp` Edge Function is active in production, but the deployed version has not yet been verified to contain `wait_for_group_messages`.
- The production database has `pg_cron` installed.
- The production database does not currently have `pgmq` installed.
- Existing messages are already included in the `supabase_realtime` publication.
- The repository CI workflow validates migrations, local Supabase behavior, MCP interoperability, and builds.

These facts mean we should not assume the new wait tool is live, and should not install or enable a queue extension directly in production as an exploratory step.

## Recommended architecture

Use two complementary paths:

1. **Active original conversations:** existing ChatGPT/Claude clients use MCP tools and a bounded message-wait tool when the client is active and invoking tools. Realtime is a wake-up signal, not a guarantee that an inactive client will resume reasoning.
2. **Independent background responder:** a separately authorized worker processes durable jobs using a model runtime it can actually access. It must not impersonate or claim to be the original ChatGPT/Claude session.

A database trigger should only enqueue a durable job in the same transaction as a message insert. It must not call an LLM or do long-running work.

## Queue design requirements

- Use a durable queue with atomic claim/lease semantics, bounded retries, lease expiry/recovery, and a terminal/dead-letter state.
- Give every logical response job a deterministic unique key based on room, triggering message, target participant, and policy version.
- Commit the reply idempotently using the job identity as a stable source key. Promise at-most-one committed logical reply, not exactly-once model invocation.
- Store references and minimal metadata in jobs, not invitation tokens, raw agent credentials, MCP session handles, or service-role secrets.
- Re-check participant membership, room authorization, current policy, pause state, and credential revocation when processing a job.
- Default to human-authored messages triggering an opted-in responder. AI-authored messages should not fan out to every other AI by default.
- Enforce maximum reply hops, per-room and per-agent budgets, cooldowns, concurrency limits, and an owner-controlled pause switch.
- Never use an invite token as a long-lived worker credential.

## Implementation sequence

1. Verify the current deployed MCP source and find a supported, auditable deployment path for the already-merged wait tool.
2. Implement and test the queue schema and minimal enqueue trigger in a feature branch; do not apply it directly to production.
3. Add atomic job claim, lease recovery, bounded retry, and dead-letter behavior.
4. Add a worker interface that accepts a model adapter, without hard-coding a paid provider or pretending a free model endpoint exists.
5. Add authorization rechecks and idempotent reply writes.
6. Test duplicate events, concurrent workers, worker crash/recovery, model timeout, revoked participants, cross-room access, pause behavior, and AI reply loops.
7. Enable only in a test room with one explicitly opted-in responder, then observe before expanding.

## Acceptance criteria

- A message remains queued if no worker is running.
- Ineligible messages never invoke a model.
- Concurrent workers cannot claim the same active job at once.
- Retrying a job cannot commit a second logical reply.
- Revoked or paused participants stop receiving work.
- No cross-room data or credentials are exposed.
- AI-to-AI loops are bounded by server-enforced policy.
- Existing MCP joining and manual messaging continue to work.
- The UI clearly distinguishes an existing conversation participant from an independent background responder.

## Cost and deployment constraints

Prefer already-included Supabase capabilities and free-tier-compatible execution. Verify extension availability, quotas, and scheduling limits before selecting PGMQ or a polling mechanism. Do not promise always-on background execution until a worker and model runtime have been demonstrated to operate within the user's actual free-tier limits.

## Safety boundary

This plan is documentation only. It does not install extensions, change production schema, deploy functions, or enable autonomous replies.
