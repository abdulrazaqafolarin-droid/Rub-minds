# Rub Minds platform readiness audit

**Audit date:** 28 October 2026; current branch/build and live Supabase advisor state rechecked after 19:00 UTC  
**Scope:** read-only review of GitHub source and PR state, Vercel deployment metadata/build events, live Supabase migration/function metadata, RLS grants and advisor findings, and isolated JavaScript test-harness results. No production mutations were made.

## Overall finding

**Rub Minds' production hosting and core Supabase backend are active. The full requested platform is not complete yet.** Backroom has a browser-draft foundation in the draft branch, but not universal native control or a demonstrated, continuously synchronized original-session group round trip.

## Latest status recheck (2026-10-28 20:49 UTC)

This addendum supersedes older branch/preview references below where they differ. The checks were read-only; no deployment, merge, migration, function, Auth setting or database mutation was performed.

- **Application-source snapshot inspected:** `147be4da5abf4c9256e52ce218fbe6aff449c1a8`. This audit was then committed as a documentation-only update; no application source or production resource changed during that update. PR #47 remains open, draft, unmerged, and based on `main`; keep it draft until release gates pass.
- **Latest ready Vercel Preview:** `c811bfe7092ae62907b152ccc82ce97a063ec65d`, URL [open Preview](https://rub-minds-jotc0coad-abdulrazaqafolarin-droids-projects.vercel.app) · [deployment inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/BUUEqbLzL4k2hoHzWP7SHcWJK2y7). This preview is behind the current PR head and does not validate the latest source.
- **Current-head Vercel status:** GitHub's combined commit status for `147be4d` reports the Vercel check as failed with a link to the Vercel build-rate-limit page. That is deployment-quota evidence, not a compiler/test failure. No current-head build has been verified; do not trigger repeated builds while the quota block remains.
- **GitHub Actions:** latest run [40757591722](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/40757591722) for `147be4d` is `skipped`. The workflow intentionally skips jobs for draft PRs; this is neither a pass nor a code failure. The current checked-in tests have not been executed in a native Node 22 checkout for this head.
- **Production:** Vercel reports the `rub-minds.vercel.app` alias as `READY`, target `production`, from `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`. The Backroom branch remains isolated from production.
- **Supabase:** project `zucaeevlbwhcvjwbhwmq` reports `ACTIVE_HEALTHY` in `eu-west-2`, PostgreSQL 17.11. Live migration history contains 18 migrations through `public_invite_rate_limits`; five Edge Functions report `ACTIVE`: `agent-messages` v4, `redeem-ai-invite` v2, `ai-invite-discovery` v2, `session-memory` v2 and `rub-minds-mcp` v3. This is service/deployment metadata, not proof of end-to-end provider interoperability or that required runtime secrets are configured correctly.
- **Feature status:** the latest source adds route-and-node-bound browser draft insertion checks and a terminal draft-only adapter contract, but the actual browser E2E and native terminal/OS drivers are still not verified. The browser adapter does not complete the desired existing-AI-session → group message → AI response → group reply loop.

The most important next step is a clean checkout at this exact head and a real Node 22 dependency install/build/test run, followed by the checked-in controlled Chromium E2E. Since the current build service is rate-limited and Actions jobs are skipped while draft, avoid repeated deploy retries. Keep production unchanged.

## Verified platform status

| Area | Verified state | What this proves—and does not prove |
|---|---|---|
| Production | Vercel alias `rub-minds.vercel.app` is `READY`, target `production`, from `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`. | Deployment metadata is healthy; a full signed-in UI/invitation/provider smoke test is still needed. |
| Database | Supabase project `zucaeevlbwhcvjwbhwmq` is `ACTIVE_HEALTHY`, region `eu-west-2`, PostgreSQL 17.11. | Confirms service metadata, not every API or RLS path. |
| Migrations | Live history includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency` and `public_invite_rate_limits`. | The live schema is beyond the 2026-10-21 observations in older release notes. |
| Edge Functions | `agent-messages` v4, `redeem-ai-invite` v2, `ai-invite-discovery` v2, `session-memory` v2 and `rub-minds-mcp` v3 report `ACTIVE`. | Code is deployed; secret configuration and current official-client interoperability were not independently proven. |
| Backroom Preview | Latest ready Preview is `a72b71c84d08a149f42a101d59354e5b58b3bf10` at [open Preview](https://rub-minds-mqff7e75o-abdulrazaqafolarin-droids-projects.vercel.app) · [deployment inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/A3Tybt8wCzWQX8G237r2fhHUBptX). The source/runtime audit snapshot was `d56fff3410ae45b3bff558d7c697edae5cf34ff8`; subsequent commits in this branch only update the audit/release documentation, and no deployment exists for the audited source snapshot. | The ready Preview proves `tsc -b && vite build` passed at `a72b71c8`, **not** at the later branch head. Vercel's status for `d56fff3` is `failure` linking to the build-rate-limit page; it is a deployment quota failure, not compiler/test output. No current-head build has been verified. The earlier build log also warned about `esbuild`'s install script. |
| GitHub Actions | PR #47 remains draft. Run `40750584435` for head `d56fff3` concluded `skipped`; `mcp-migration`, `build` and `local-supabase-stack` did not execute. | No runner/steps means no CI evidence. The latest commit status is `failure` from Vercel's deployment quota; do not treat it as a test failure or a test pass. Avoid retrying deploys until the quota window clears. |
| Visual smoke test | The page-rendering tool could not render the public website during this audit. | Requires a signed-in browser smoke test; the tool limitation is not evidence the site is down. |

Links: [PR #47](https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47) · [production inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/GoZJtiMszDSXdhYaSZQVwefcH8DS) · [latest ready Preview inspector](https://vercel.com/abdulrazaqafolarin-droids-projects/rub-minds/A3Tybt8wCzWQX8G237r2fhHUBptX) (older than the audited branch head).

## Feature completeness

### Available in source

- Group, invitation, participant, MCP session and private/group memory backend flows are present, with the related live migrations and Edge Functions active.
- Draft PR #47 adds shared target registry/dispatcher contracts; room/host/space/session identity checks; a loopback-only host; one-use pairing and revocation; strict Host/CORS/origin checks; and bounded JSON/request handling.
- The host opens a **separate visible Playwright Chromium profile**. The user signs into ChatGPT/Claude manually; it does not copy the current Chrome/Edge or native-phone app session.
- The browser target is linked to the chosen group, conversation route and exact DOM element selected. Explicit approval and an empty editable field are required, then inserted text is read back. The adapter never presses Send.
- The session bridge defaults to human-origin messages, bounds messages, snapshots startup history and stops on ambiguous delivery without retrying the provider. It requires durable send acknowledgements and one explicit room binding. AI-to-AI handoff remains non-release-ready: the deployed message schema/RPC does not yet supply a server-authenticated turn-depth value, so do not rely on client-supplied depth to enforce the recursion cap.
- PR #47 now also includes a **terminal draft adapter contract** for a named, inspectable terminal editor. It binds an exact `terminal_pty` session, requires an atomic empty-buffer write from an injected driver, rejects line breaks/control characters, passes `submit: false`, and returns `needs_review` when readback/no-submit attestation is ambiguous. It is not connected to a real PTY or the local host.
- The host now exposes an authenticated **Emergency Stop**: it latches the local host, revokes paired sessions, closes the managed browser and blocks further API/pairing until the host process is restarted. If closure cannot be verified, the response is HTTP 503 but the latch/revocation remain active; close the host with Ctrl+C and shut any remaining window manually.

### Partial or not demonstrated

- **No end-to-end AI round trip.** Current Backroom execution inserts a draft. It does not yet safely submit, read the provider response, verify a result and post that result back into the Rub Minds group.
- **No live-provider acceptance demonstrated.** A controlled local test page does not prove compatibility with current ChatGPT/Claude logged-in interfaces, rate limits, rerenders or policy restrictions.
- **Durable cloud/local coordination is incomplete.** No fully demonstrated, durable queue currently routes live group events to an authorized local host with recovery cursors, idempotent outcomes, offline handling, permission rechecks and global stop/revocation.
- **Native drivers are not implemented/wired.** Actual Windows/desktop UI Automation or CUA, a real named terminal PTY/terminal-frontend driver, Android accessibility/overlay and ARTEMIS integration remain separate implementation work. The terminal adapter tests use an injected mock; they do not control a terminal. The other UI surface previews are simulated and do not control native apps.
- **No installable browser extension manifest appeared in the inspected feature tree.** The existing browser-loop source is a userscript, a separate mechanism from the local managed-browser host.
- **No background wake-up guarantee.** If no authorized host and active provider session are running, Rub Minds cannot wake an idle original ChatGPT/Claude phone/desktop conversation. Imported transcripts do not equal live session connection.
- **Build/test status is not release-verified for the audited source snapshot.** The latest ready Preview ran `tsc -b && vite build` at `a72b71c8`, not the later source snapshot `d56fff3`; Vercel returned a build-rate-limit failure for the latter. Separate source-mirrored V8 harnesses previously passed: 27/27 host pairing/server route test bodies (mock HTTP server/browser), 19/19 session-bridge tests, 10/10 native-adapter/integration tests and 14/14 terminal-adapter/guard/dispatcher tests. These harnesses run copied source/test bodies with fake dependencies; they are not native Node tests, real TCP, a real PTY or actual OS automation. Recent browser-adapter route-race changes have not been revalidated by the checked-in native test runner. Previous older-head checks (`npm test`, runtime/backroom suites, browser smoke, Deno and PostgreSQL smoke) cannot certify the audited source snapshot. Current-source build, Vitest, native Node suites, Deno, migration replay/MCP interoperability and real Chromium host E2E still need a real test-runner pass.

## Live security and performance findings (latest advisor observation 19:46 UTC)

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

- Added a host-wide Emergency Stop endpoint and Backroom UI control. The focused host-pairing/server route suite passed 27/27 checked-in test bodies in a source-mirrored V8 harness; its HTTP server and browser were fakes, so an actual Node HTTP/Playwright pass remains required.
- Hardened session bridge handling for ambiguous delivery, explicit acknowledgements, message-size limits, single-room binding and startup-history snapshot. Its checked-in test bodies passed 19/19 in an isolated V8 harness.
- Hardened native draft success claims by requiring explicit `submitted:false` attestation; the native adapter/integration harness passed 10/10 with mock drivers. Added/extended a terminal draft-only contract that requires a named `assistant_composer` input, atomic empty-buffer writing, no-submit attestation and readback; its adapter + integration harness passed 14/14 with a mock driver.
- The latest ready Vercel Preview is for `a72b71c84d08a149f42a101d59354e5b58b3bf10`, not the later audited head `d56fff3410ae45b3bff558d7c697edae5cf34ff8`. The later head has no deployment because Vercel reported a build-rate-limit failure. The Preview is not Production.
- Fresh read-only checks confirmed Production remains `READY` on `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`, Supabase is `ACTIVE_HEALTHY`, 18 production migrations are applied and the five listed Edge Functions remain `ACTIVE`.
- No Production DB/schema/policy/Auth setting, Edge Function, `main` branch or Production deployment was changed.
