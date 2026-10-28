# Rub Minds platform readiness audit

**Audit date:** 28 October 2026  
**Scope:** read-only review of GitHub source and PR state, Vercel deployment metadata/build events, live Supabase migration/function metadata, RLS grants and advisor findings, and isolated JavaScript test-harness results. No production mutations were made.

## Overall finding

**Rub Minds' production hosting and core Supabase backend are active. The full requested platform is not complete yet.** Backroom has a browser-draft foundation in the draft branch, but not universal native control or a demonstrated, continuously synchronized original-session group round trip.

## Verified platform status

| Area | Verified state | What this proves—and does not prove |
|---|---|---|
| Production | Vercel alias `rub-minds.vercel.app` is `READY`, target `production`, from `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`. | Deployment metadata is healthy; a full signed-in UI/invitation/provider smoke test is still needed. |
| Database | Supabase project `zucaeevlbwhcvjwbhwmq` is `ACTIVE_HEALTHY`, region `eu-west-2`, PostgreSQL 17.11. | Confirms service metadata, not every API or RLS path. |
| Migrations | Live history includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency` and `public_invite_rate_limits`. | The live schema is beyond the 2026-10-21 observations in older release notes. |
| Edge Functions | `agent-messages` v4, `redeem-ai-invite` v2, `ai-invite-discovery` v2, `session-memory` v2 and `rub-minds-mcp` v3 report `ACTIVE`. | Code is deployed; secret configuration and current official-client interoperability were not independently proven. |
| Backroom Preview | Vercel Preview at `d3711aafd30a218f92dde69e1f3a57fcc8928196` is `READY`. Build events confirm `tsc -b && vite build`, 1,630 modules transformed, and deployment completed. | The static TS/Vite build passed. It did not execute Node/Vitest/Deno/MCP/Chromium acceptance suites. |
| GitHub Actions | PR #47 remains draft. Current workflow skips build and integration jobs until the PR is ready. | Skipped is not a pass and is not a current-head code failure. |
| Visual smoke test | The page-rendering tool could not render the public website during this audit. | Requires a signed-in browser smoke test; the tool limitation is not evidence the site is down. |

Links: [PR #47](https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47) · [production inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/GoZJtiMszDSXdhYaSZQVwefcH8DS) · [latest inspected Preview build](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/DXJgLHwZeSTQT6LXBENx6iLnWmPR).

## Feature completeness

### Available in source

- Group, invitation, participant, MCP session and private/group memory backend flows are present, with the related live migrations and Edge Functions active.
- Draft PR #47 adds shared target registry/dispatcher contracts; room/host/space/session identity checks; a loopback-only host; one-use pairing and revocation; strict Host/CORS/origin checks; and bounded JSON/request handling.
- The host opens a **separate visible Playwright Chromium profile**. The user signs into ChatGPT/Claude manually; it does not copy the current Chrome/Edge or native-phone app session.
- The browser target is linked to the chosen group, conversation route and exact DOM element selected. Explicit approval and an empty editable field are required, then inserted text is read back. The adapter never presses Send.
- The session bridge now defaults to human-origin messages. AI-to-AI processing needs explicit opt-in and a server-supplied turn depth below its configured cap.

### Partial or not demonstrated

- **No end-to-end AI round trip.** Current Backroom execution inserts a draft. It does not yet safely submit, read the provider response, verify a result and post that result back into the Rub Minds group.
- **No live-provider acceptance demonstrated.** A controlled local test page does not prove compatibility with current ChatGPT/Claude logged-in interfaces, rate limits, rerenders or policy restrictions.
- **Durable cloud/local coordination is incomplete.** No fully demonstrated, durable queue currently routes live group events to an authorized local host with recovery cursors, idempotent outcomes, offline handling, permission rechecks and global stop/revocation.
- **Native drivers are not implemented/wired.** Actual Windows/desktop UI Automation or CUA, named terminal PTY, Android accessibility/overlay and ARTEMIS integration remain separate implementation work. The other UI surface previews are simulated and do not control native apps.
- **No installable browser extension manifest appeared in the inspected feature tree.** The existing browser-loop source is a userscript, a separate mechanism from the local managed-browser host.
- **No background wake-up guarantee.** If no authorized host and active provider session are running, Rub Minds cannot wake an idle original ChatGPT/Claude phone/desktop conversation. Imported transcripts do not equal live session connection.
- **Native test gates have not been satisfied on current HEAD.** Isolated V8 harness tests are logic checks, not the native Node runner. The newest session-bridge harness run passed 8/8, but current-head `node --test`, full Vitest, Deno, local migration replay/MCP interop and real local Chromium E2E still need to pass.

## Live security and performance findings

1. Four RLS-enabled backend-only tables have no policies: `agent_request_log`, `public_request_rate_limits`, `rub_minds_mcp_join_requests`, `rub_minds_mcp_sessions`. Read-only grants checks found neither `anon` nor `authenticated` has SELECT privilege on them. Do not add public policies simply to silence the advisor.
2. Eight authenticated-callable SECURITY DEFINER functions were flagged. Read-only inspection found `auth.uid()` and ownership/membership predicates in the eight functions examined, with empty search paths. Keep a reviewed function-by-function security check; the advisory warrants review but does not by itself prove an exploit.
3. Leaked-password protection is disabled. Enabling it is a separate Auth configuration change; it was not changed during this audit.
4. Nine foreign-key index notices and two unused-index notices need a workload-aware performance review before changes.
5. The MCP encryption key's presence/configuration remains unverified. Do not expose its value; test availability through a safe staging/runtime check and redacted failure behavior.

A recent 24-hour aggregate query showed log activity across Edge, Postgres, PostgREST and Realtime. It was not an error-level review and is not an error-free certification.

## Remaining work in release-gate order

1. **Native/current-head test gate:** run `npm ci`, `npm run build`, `npm test`, `npm run test:runtime`, `npm run test:backroom`, Deno checks, clean local migration replay and MCP client integration tests, then `npm run test:backroom:browser`. The current draft gate skips GitHub Actions; skipped is not passed.
2. **Live browser-provider acceptance:** on a user-authorized dedicated profile, test ChatGPT web and Claude web separately. Verify draft-only insertion, login walls, route and composer swaps, occupied fields, user typing races, target deletion, unpair/revoke and no-send behavior. Safe response reading/submission must be separate, explicitly permissioned capabilities.
3. **Cloud/local coordinator:** implement/test durable room-event/task queue, idempotent claiming, cursor recovery, offline/ambiguous outcomes, execution-time group/permission/target checks and global/per-space Stop. Prove a two-client authorized group round trip with a real provider.
4. **Native adapters:** integrate a reviewed Windows/desktop driver (CUA/UIA), named terminal PTY with explicit operation classes and separate dangerous-command approvals, then Android ARTEMIS/accessibility/overlay on a real authorized test device. Verify permission denial and Stop on each OS.
5. **Hardening:** review exposed SECURITY DEFINER functions; verify secret presence without exposing secrets; decide on leaked-password protection; assess indexes; test redacted logs, private export/delete, restart recovery, global limits and ambiguous submit handling.
6. **Release hygiene:** PR #47 has accumulated many commits. Consolidate/review the final diff where practical, rerun all release gates against the final commit, obtain explicit release approval and deploy Production separately. Keep `main` and Production unchanged until the release decision.

## Changes during this audit

- Changed the feature branch's session bridge to block AI-origin messages by default, unless explicitly enabled with bounded server-supplied turn depth.
- Added targeted bridge tests; test bodies passed 8/8 in an isolated V8 harness only, **not** native Node test execution.
- No Production DB/schema/policy/Auth setting, Edge Function, main branch or Production deployment was changed.
