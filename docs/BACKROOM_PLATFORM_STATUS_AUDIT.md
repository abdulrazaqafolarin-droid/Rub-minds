# Rub Minds platform readiness audit

**Audit date:** 28 October 2026, 19:26 Africa/Lagos (18:26 UTC)  
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
| Backroom Preview | Latest ready branch Preview is `7c3d9b127599daeb9135927c600ee7dfc6ba8bed` at [preview URL](https://rub-minds-p7hyd4mfr-abdulrazaqafolarin-droids-projects.vercel.app). Vercel build events confirm `tsc -b && vite build`, 1,630 modules transformed and deployment completed. | Current PR head `d25ff4e19768130e2434d5779d8999e137a13f16` is one commit ahead; the only change since that ready Preview is a test-file update. Vercel reports no deployment for the exact head because of the free daily deployment limit. Build passed on the prior, source-equivalent frontend; this is not a current-head test-suite pass. |
| GitHub Actions | PR #47 remains draft. `mcp-migration`, `build` and `local-supabase-stack` are explicitly skipped while draft. | The jobs allocate no runner and execute no steps. Skipped is not a pass. Current HEAD's GitHub commit status is `failure` from Vercel with `api-deployments-free-per-day` / retry-in-24-hours; this is a deployment quota error, not test output. |
| Visual smoke test | The page-rendering tool could not render the public website during this audit. | Requires a signed-in browser smoke test; the tool limitation is not evidence the site is down. |

Links: [PR #47](https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47) · [production inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/GoZJtiMszDSXdhYaSZQVwefcH8DS) · [latest ready Preview inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/9TUDVRNHF1s3YrfnsAgqApmnGcMN).

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
- **Current-head test gates remain unverified.** A prior isolated source tree reported `npm run build`, `npm test` (25 tests), `npm run test:backroom` (97/97), `npm run test:runtime` (197/197), `npm run test:backroom:browser` (8/8), Deno checks and an isolated PostgreSQL smoke as passing under Node 24. Those results were not from a native Node 22 run against the current final SHA. More code/tests were added afterward; current-head `node --test`, full Vitest, Deno, local migration replay/MCP interoperability and Chromium E2E have not been rerun. GitHub Actions jobs are skipped while this PR is draft.

## Live security and performance findings (rechecked 18:26 UTC)

1. Four RLS-enabled backend-only tables have no policies: `agent_request_log`, `public_request_rate_limits`, `rub_minds_mcp_join_requests`, `rub_minds_mcp_sessions`. A live read-only grants check confirmed both `anon` and `authenticated` lack SELECT on all four. Do not add public policies simply to silence the advisor.
2. Eight `SECURITY DEFINER` functions callable by `authenticated` were flagged. A live read-only query confirmed all eight have an empty `search_path`; the definitions examined include `auth.uid()` and owner/membership checks. This makes a blind revoke risky because invite creation/redemption and room RPC flows depend on these functions. The warning still deserves a documented, function-by-function review; it does not by itself establish an exploit.
3. Supabase Auth reports leaked-password protection disabled. Enabling this changes Auth configuration and needs a separate decision; it was not changed during this audit.
4. Performance advisors report nine foreign keys without covering indexes and two apparently unused indexes. Review workload/query plans before adding or dropping indexes.
5. The MCP encryption key's presence/configuration remains unverified. Do not expose its value; test availability through a safe staging/runtime check and redacted failure behavior.

The last 24-hour unified-log summary returned 222 records across pgbouncer (76), edge (51), Postgres (31), PostgREST (28), Realtime (19), function (8), function-edge (5), auth audit (2) and auth (2). The schema query has no top-level `level` field; therefore this was only an activity count, not an error-level review or error-free certification.

## Remaining work in release-gate order

1. **Native/current-head test gate:** run `npm ci`, `npm run build`, `npm test`, `npm run test:runtime`, `npm run test:backroom`, Deno checks, clean local migration replay and MCP client integration tests, then `npm run test:backroom:browser`. The current draft gate skips GitHub Actions; skipped is not passed.
2. **Live browser-provider acceptance:** on a user-authorized dedicated profile, test ChatGPT web and Claude web separately. Verify draft-only insertion, login walls, route and composer swaps, occupied fields, user typing races, target deletion, unpair/revoke and no-send behavior. Safe response reading/submission must be separate, explicitly permissioned capabilities.
3. **Cloud/local coordinator:** implement/test durable room-event/task queue, idempotent claiming, cursor recovery, offline/ambiguous outcomes, execution-time group/permission/target checks and global/per-space Stop. Prove a two-client authorized group round trip with a real provider.
4. **Native adapters:** integrate a reviewed Windows/desktop driver (CUA/UIA), named terminal PTY with explicit operation classes and separate dangerous-command approvals, then Android ARTEMIS/accessibility/overlay on a real authorized test device. Verify permission denial and Stop on each OS.
5. **Hardening:** review exposed SECURITY DEFINER functions; verify secret presence without exposing secrets; decide on leaked-password protection; assess indexes; test redacted logs, private export/delete, restart recovery, global limits and ambiguous submit handling.
6. **Release hygiene:** PR #47 has accumulated many commits. Consolidate/review the final diff where practical, rerun all release gates against the final commit, obtain explicit release approval and deploy Production separately. Keep `main` and Production unchanged until the release decision.

## Changes during this audit

- Changed the feature branch's session bridge to block AI-origin messages by default, unless explicitly enabled with bounded server-supplied turn depth.
- Added bounded session-bridge deduplication coverage. The latest commit `d25ff4e1` adds a test case only; the source comparison against the last ready Vercel Preview shows one file changed (`integrations/playwright/session-bridge.node-test.mjs`, +23/-1).
- Fresh read-only live checks confirmed the production alias remains `READY` on `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`, Supabase is `ACTIVE_HEALTHY`, and the five listed Edge Functions remain `ACTIVE`. The current PR head has no exact-SHA deployment because Vercel's free daily deployment limit has been exceeded.
- No Production DB/schema/policy/Auth setting, Edge Function, `main` branch or Production deployment was changed.
