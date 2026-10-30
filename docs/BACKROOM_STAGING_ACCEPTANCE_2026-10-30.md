# Backroom staging acceptance — 2026-10-30

This document records the isolated staging path and repeatable evidence for the Backroom feature branch. It is deliberately explicit about what was tested in a real staging service, what was tested with rollback-only SQL fixtures, and what still needs a real user/device.

## Isolated environment

- Git branch: `feat/backroom-cua-artemis-workspaces`
- Latest branch HEAD at this document update: `f5bd0ed64f90cd6dbd9b6d6590d1484a40a4895b` (documentation-only commit after the tested code head)
- Latest tested code head: `dd075ebace1ceb7f30a47b2b312655d879a48406`
- Latest Vercel Preview deployment: `dpl_AwEhJ5PciAk8nQ41zKooWp4XxQzN` — READY (documentation-only branch head)
- Full 683-test / TypeScript / Vite evidence: deployment `dpl_E3iL5erk4e2s5Rqq9Yo8hTMNAQS2` on tested code head `dd075eb`
- Stable Preview origin: `https://rub-minds-git-feat-ba-fce441-abdulrazaqafolarin-droids-projects.vercel.app`
- Supabase staging project ref: `tzcuuynmviiuactafpld` (PostgreSQL 17.11)
- Staging `backroom-config`: version 2, `verify_jwt=true`
- Staging `backroom-wake`: version 7, ACTIVE, `verify_jwt=false`; its own host-token, host/binding/session and active-consent authorization is enforced before private queue operations.

Vercel has two **Preview-only and feature-branch-scoped** variables for this branch:
- `VITE_SUPABASE_URL=https://tzcuuynmviiuactafpld.supabase.co`
- `VITE_SUPABASE_ANON_KEY` contains the staging project's Supabase publishable key (encrypted in Vercel; never copy the value into source control or documentation).

The shared/base Vercel variables were checked and still point to production project `zucaeevlbwhcvjwbhwmq`. The two project environments were compared without exposing the key. No production variables were changed.

## Local host origin requirement

The local Backroom host accepts exact browser origins only. The feature branch's default `scripts/backroom-host-server.mjs` allowlist now includes the stable Preview origin above, and the regression test rejects a lookalike attacker hostname.

**Restart an already-running local Backroom host after updating to this commit.** The old process keeps the old origin allowlist in memory.

If `BACKROOM_ALLOWED_ORIGINS` is set in the local environment, it replaces the defaults. Include the exact stable Preview origin as one comma-separated value, for example:

```text
BACKROOM_ALLOWED_ORIGINS=https://rub-minds.vercel.app,https://rub-minds-git-feat-ba-fce441-abdulrazaqafolarin-droids-projects.vercel.app,http://localhost:5173,http://127.0.0.1:5173
```

Do not use wildcard origins. Pairing remains one-time, exact-origin-bound and loopback-only.

## Automated verification

### Current-head Vercel build

The Preview build for latest branch commit `63ab12fef7dbd9cfcec56dd62c27fcacc7dc11fa` reached READY. This is a documentation-only follow-up to executable-code head `f5bd0ed64f90cd6dbd9b6d6590d1484a40a4895b`. Its current prebuild suites reported:

| Suite | Passed | Failed |
|---|---:|---:|
| Runtime | 374 | 0 |
| Backroom | 261 | 0 |
| External workspaces | 48 | 0 |
| **Total** | **683** | **0** |

TypeScript (`tsc -b`) and Vite production bundling also completed successfully. The stable Preview branch alias resolves to this deployment.

### Exact local-host Preview pairing

Command run in an isolated Node 22 runner against the current branch source:

```bash
node --test integrations/backroom/host-server.node-test.mjs
```

Result: **32 passed, 0 failed**. The additional test verifies:
- exact stable Preview origin is accepted by the default host allowlist;
- OPTIONS preflight and the one-time pairing flow succeed for that origin;
- an attacker-controlled lookalike hostname is rejected.

### Drag/select and draft safety

```bash
node --test integrations/backroom/selection-geometry.node-test.mjs integrations/backroom/browser-draft-adapter.node-test.mjs integrations/backroom/target-registry.node-test.mjs
```

Result: **21 passed, 0 failed**. Coverage includes reverse drag / calibrated Android portrait coordinates, desktop display offsets, stale/out-of-bounds selections, unique composer targeting, conversation identity rechecks, occupied composers, independent read-back, and no automatic Send.

The Playwright Chromium browser tests were executed in a disposable isolated Node 22 sandbox with Playwright 1.56.1 (matching the repository's package range), Chromium and its Linux runtime dependencies installed:

```bash
node --test integrations/backroom/browser-overlay.browser-test.mjs integrations/backroom/browser-draft.browser-test.mjs
node --test integrations/backroom/browser-host-e2e.browser-test.mjs
```

Result: **8 passed, 0 failed**. The first command covers seven real-browser cases (one-field selection, multiple-input rejection, Escape, stale overlay/listener cleanup, read-only rejection, and empty-composer draft without Send). The second runs the complete local-host → Chromium overlay → group-scoped target registration → read-back-verified draft flow, including isolation/identity regression checks. The temporary sandbox was isolated from the project and later shut down. The simulated Backroom preview panel is not itself a live application binding; the managed-browser overlay is the real browser target-selection path.

## Live Supabase staging HTTP checks

These requests were sent to the deployed staging project, not mocked:
- approved stable Preview Origin OPTIONS preflight to `backroom-config`: **204** with exact allow-origin and required request headers;
- unlisted origin preflight: **403**, no CORS allow-origin;
- unauthenticated POST to `backroom-config/host`: **401**;
- unauthenticated POST to `backroom-wake/claim`: **401**;
- staging publishable key against Auth settings/health and a read-only PostgREST table query: **200**.

A publishable key was not used against privileged OpenAPI discovery; that endpoint correctly demands a secret key. No service-role key was exposed to the browser.

## Rollback-only PostgreSQL lifecycle tests

Executed against staging PostgreSQL 17.11 inside explicit `BEGIN … ROLLBACK` transactions. The test fixtures were not retained. Follow-up queries confirmed zero rows remained for the fixture room, participant, host, binding and wake jobs.

Verified:
1. bounded local-consent grant activation and persisted expiry;
2. enqueue, scope-bound lease claim and server-issued lease token;
3. acknowledgement and idempotent duplicate enqueue;
4. lease retry, token/owner clearing, safe error code and return to pending;
5. binding revocation, cancellation of pending/leased jobs, failed reactivation, host revocation and idempotent host revoke;
6. the real `messages` INSERT trigger: ordinary non-mention group message did not wake a mention-only binding;
7. a matching human `@Staging Test AI` message created exactly one canonical pending `@RMconnects` job;
8. the trigger-created job was claimed and acknowledged using the same queue RPCs.

These tests exercise the deployed database trigger and security-definer functions, but they do not substitute for an authenticated browser owner session or a real remote AI provider.

## Still unverified — do not advertise as complete

- Owner-JWT-authenticated `backroom-config/host` and `/binding` calls from a real signed-in Preview session.
- Browser UI acceptance with Vercel's protected Preview in a user's browser, plus local host pairing from the same desktop.
- Pairing and overlay acceptance in the user's own installed browser/desktop with the local host, plus a real authenticated session in the protected Preview.
- Real ChatGPT or Claude original-session participation, hosted wake response, and group reply roundtrip.
- Physical desktop CUA Driver, ARTEMIS on an allowlisted Android device/work profile, and local gVisor terminal lifecycle.
- Production parity or release approval. This PR remains draft.

## Production safety record

No production Supabase migration, production Edge Function deployment, production Vercel variable change, production deployment, branch merge, or PR merge was performed for this acceptance work.


### Additional negative-path queue tests — same rollback-only staging method

A second transaction passed four more security checks:
- Same consent-grant ID is idempotent; a competing grant cannot replace a still-active grant.
- Wrong host ID, wrong session digest and wrong binding ID each return zero leases and leave the pending queue unchanged.
- An incorrect lease token cannot acknowledge or mutate a live lease.
- Deactivation disables consent, cancels pending and leased work, rejects stale acknowledgement and blocks subsequent claims. Repeating deactivation with the same grant is idempotently confirmed.

All rows were rolled back. The repository remains free of these fixture IDs and no staging migration/schema change was needed for these tests.


## Staging Supabase security-advisor review

The staging advisor was reviewed after the lifecycle tests:
- Seven RLS-enabled internal tables have no client policies. A role-grant inspection confirmed `anon` and `authenticated` have no direct SELECT/INSERT/UPDATE/DELETE privileges on these tables; the service role has the required access. This is an intentional deny-by-default shape for Backroom host credentials, bindings, queue jobs, MCP session material, request logs and rate-limit state.
- Eight existing product RPCs were flagged because they are `SECURITY DEFINER` and callable by `authenticated`. Source definitions were inspected: all eight set `search_path TO ''`, deny anonymous execution, and enforce `auth.uid()` plus room-owner/token checks for their intended room creation, invitation, membership or external-agent operation. The Supabase advisor warning remains visible because these are still privileged authenticated RPC entrypoints and deserve ongoing API review; this acceptance work did not modify them.
- Backroom queue RPCs (`enqueue/claim/ack/retry/activate/deactivate/revoke`) are not in that authenticated-RPC set; grant checks confirmed they are executable by `service_role` only, not `anon` or `authenticated`.
- Supabase Auth leaked-password protection is disabled in staging. Supabase's published guidance says this feature requires Pro or above. No plan change or Auth configuration change was made as part of this no-paid/staging-only task.

Security-advisor remediation reference: [Supabase database linter](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).


## Final Vercel environment-value verification

The Vercel environment records were resolved by their exact environment-variable IDs (not by list order) and compared directly to each Supabase project's active publishable key:
- Project-wide/base `VITE_SUPABASE_URL` still exactly equals the Production project's URL.
- Project-wide/base `VITE_SUPABASE_ANON_KEY` still exactly equals the Production project's active publishable key.
- Branch-scoped Preview `VITE_SUPABASE_URL` exactly equals the Staging project's URL.
- Branch-scoped Preview `VITE_SUPABASE_ANON_KEY` exactly equals the Staging project's active publishable key.
- Both Preview overrides remain targeted only to `preview` and only to `feat/backroom-cua-artemis-workspaces`. No secret values were printed or copied into this document.
- Final documentation commit `34e1aef670fa60d5d0737cf9031ade419322487e` has a READY Vercel Preview deployment above; its changes after code head `72b6268` are documentation-only.


### Smart-mode AI loop-prevention test — same rollback-only staging method

A further transaction exercised two AI participants plus a human sender and a bound `smart`-mode input:
- AI-originated text without a mention did not enqueue a wake.
- AI-originated text with an explicit `@AI Beta` mention still did not enqueue in `smart` mode (prevents AI-to-AI echo loops).
- A human group message did enqueue exactly one job; the job was claimed and acknowledged normally.

The test rows were rolled back. This confirms that the database trigger's smart-mode loop guard is active in the deployed staging schema.


## Staging Auth behavior for the first Preview sign-in

A public Auth settings request using the staging publishable key returned HTTP 200 and confirmed:
- Email sign-in provider is enabled.
- New signups are not globally disabled.
- `mailer_autoconfirm=false`: email confirmation is required; users are not auto-confirmed.

The Preview authenticates against the isolated staging project. Do not assume a Production account/session is shared or copy Production user data into Staging. A tester should use a staging-specific sign-in and complete its confirmation flow. No confirmation or Auth setting was changed by this acceptance work.


## Deno Edge Runtime host-token fix and HTTP validation — 2026-10-30

The first live Backroom wake gateway request returned 503 during host-token verification. The deployed adapter used `Buffer.from()` without importing Buffer. This passed Node tests because Node exposes a global Buffer, but the deployed Supabase Deno 2 runtime does not expose Buffer as a global in user code; the correct Deno-compatible form is an explicit `node:buffer` import. See [Deno's Node compatibility reference](https://docs.deno.com/runtime/fundamentals/node/). The adapter now imports `Buffer` explicitly.

The HTTP boundary was also tightened. It now validates required UUIDs, session digests, lease-token UUIDs, consent TTLs, retry bounds and retry error codes before calling the privileged gateway/database functions. Malformed input returns HTTP 400 instead of reaching a SQL exception and being misreported as 503.

Verification:
- Authenticated gateway + HTTP adapter tests: **17 passed, 0 failed**. This includes a regression test that sets `globalThis.Buffer=undefined` and proves host-token verification still succeeds through the explicit import.
- Staging Edge Function is ACTIVE at `backroom-wake` version 7 with the corrected source. Its gateway continues to use its internal host-token protocol (`verify_jwt=false`); the function does not accept browser cookies or public CORS requests.
- Live staging HTTP checks against the deployed gateway: missing authorization returned **401**; malformed binding UUID returned **400**.
- The first live request exposed a deployed-source mismatch: staging `backroom-wake` v3 did not include the branch's explicit `node:buffer` import, so Deno 2 threw during host-token verification and the HTTP boundary safely returned 503. The corrected function was deployed to staging; it is now ACTIVE at **version 7**.
- Added strict request validation for UUID host/binding/job/lease/grant identifiers, session digests, grant TTL, retry bounds/error codes and acknowledgement outcome. Invalid input is rejected with HTTP 400 before the privileged SQL RPC.
- Authenticated gateway + HTTP adapter regression tests: **17 passed, 0 failed**, including host-token verification with `globalThis.Buffer` removed, malformed job/lease UUIDs, retry bounds, consent operations and fail-closed authorization.
- **Live staging HTTP v7 lifecycle passed:** a wrong host token returned **401**; the valid paired host claimed exactly one correctly scoped message-triggered lease (**200**); a malformed lease-token UUID was rejected as **400**; the server-issued lease token acknowledged the job (**200, accepted=true**); and the next claim returned **zero** jobs.
- The live HTTP retry and deactivation routes were not claimed as tested in this round. The rollback-only PostgreSQL tests separately passed lease retry, consent deactivation, stale-lease rejection and cancellation of pending/leased jobs.
- Every live fixture (room, participant, message, host, binding, job, MCP session and agent connection) was deleted after testing; follow-up counts for all eight sets were **zero**. Both disposable Node runners were stopped.
- No Production deployment, environment variable, function, data row or migration was changed.

This completes the staging **claim → verified draft/host result acknowledgement** HTTP path. It does not yet prove a user's signed-in Preview session can enroll a host/binding or that ChatGPT/Claude real-session wake roundtrip works.

## Owner-authenticated host/binding enrollment contract review

The client and local-host credential contract was checked against the staging Edge Function source:
- `scripts/backroom-host-server.mjs` exposes `enrollmentDigest` in host status from the local persistent identity.
- `integrations/backroom/host-identity.mjs` computes that digest as SHA-256 of the actual local `hostToken`.
- `BackroomApp.tsx` sends the exact `hostId`, `credentialDigest` and bounded `ttlSeconds` fields to `backroom-config/host`.
- The same UI registers the selected `roomId`, joined AI `participantId`, `hostId`, `sessionDigest`, browser space/session/target identity, revision, surface and locator to `backroom-config/binding`.
- The deployed config function resolves the bearer JWT with `db.auth.getUser`, checks room ownership, the joined AI participant, active agent connection and hosted MCP session, and inserts the new binding inactive (`wake_enabled=false`, no confirmation/grant expiry).

This proves source-level contract alignment but does **not** replace a live owner-JWT request. Authenticated host/binding enrollment from a signed-in staging Preview remains an explicit release gate; no disposable Auth user was created in this round.