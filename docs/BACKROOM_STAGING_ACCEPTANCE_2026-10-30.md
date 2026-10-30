# Backroom staging acceptance — 2026-10-30

This document records the isolated staging path and repeatable evidence for the Backroom feature branch. It is deliberately explicit about what was tested in a real staging service, what was tested with rollback-only SQL fixtures, and what still needs a real user/device.

## Isolated environment

- Git branch: `feat/backroom-cua-artemis-workspaces`
- Latest branch HEAD: `34e1aef670fa60d5d0737cf9031ade419322487e` (documentation-only updates after the tested code head)
- Last full executable-code test head: `72b6268b6d5acefd4dfb87192435b4133c758d6a`
- Latest Vercel Preview deployment: `dpl_2CfnhqjgZHPtXZFbo9HgDjm8WuuM` — READY
- Full prebuild / TypeScript / Vite evidence is for executable-code head `72b6268b6d5acefd4dfb87192435b4133c758d6a`; later commits only revise this acceptance document.
- Stable Preview origin: `https://rub-minds-git-feat-ba-fce441-abdulrazaqafolarin-droids-projects.vercel.app`
- Supabase staging project ref: `tzcuuynmviiuactafpld` (PostgreSQL 17.11)
- Staging `backroom-config`: version 2, `verify_jwt=true`
- Staging `backroom-wake`: version 3, `verify_jwt=false` because it uses its own host-token authorization protocol; host/binding/session/lease authorization is checked server-side before any queue operation.

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

The Preview build for commit `72b6268b6d5acefd4dfb87192435b4133c758d6a` reached READY. Its prebuild suites reported:

| Suite | Passed | Failed |
|---|---:|---:|
| Runtime | 370 | 0 |
| Backroom | 257 | 0 |
| External workspaces | 48 | 0 |
| **Total** | **675** | **0** |

TypeScript (`tsc -b`) and Vite production bundling also completed successfully.

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
- Actual Playwright Chromium browser overlay test in the user's real installed browser; browser test files are present but the isolated Node runner did not have Playwright installed.
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
