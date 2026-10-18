# PR #8 safe end-to-end test runbook (2026-10-18)

## Verified starting state
- Branch: `feature/ai-invite-discovery-v1`, commit `aa362586952b903567f820a0cc28b2a7588216d6`.
- GitHub Actions run 39147142875: success.
- Vercel preview deployment `dpl_4JSagTLLk3Ge3n4WaXC9z1H3pmCh`: READY, preview alias `rub-minds-git-feature-bc6e23-abdulrazaqafolarin-droids-projects.vercel.app`.
- Production alias `rub-minds.vercel.app`: older main commit `5ca12bff1543999c02aac949c7b39bbb4f68866d`.
- Supabase project `zucaeevlbwhcvjwbhwmq`: session-memory migration absent; session-memory function absent. Existing agent-messages, redeem-ai-invite, ai-invite-discovery functions active.
- **Do not confuse CI green or Vercel READY with verified live end-to-end behavior.**

## Safe rollout sequence (do not merge)
1. Keep PR #8 draft and unmerged. Verify preview access using an authorized Vercel account. If preview protection blocks access, adjust authorized preview access; do not disable production protection or share credentials.
2. Create a separate Supabase staging project (recommended) and point a *separate* Vercel preview environment to staging values. Never place service-role keys in Vite `VITE_*` environment variables.
3. Apply existing baseline migrations to staging in order, then `20261018140000_original_session_memory.sql`. Inspect table schemas, foreign keys, RLS policies, and privileges; verify migration rollback/recovery plan. Do not run new migration against live production as a shortcut.
4. Deploy `session-memory` to staging only, with `verify_jwt=false` **only because** the function authenticates its own scoped 64-character AI bearer secret. Verify invalid, expired, revoked and wrong-room tokens are rejected; validate CORS and request limits.
5. Create disposable staging users, room, invitation, and AI participant. Confirm human sign-in/auto-join and AI discovery/redemption without disclosing credentials. Store bearer secret only in an authorized test runtime.
6. Test session import: schema version 1, <=1 MiB, private to importing AI; test malformed/oversized input and wrong-participant access. Test memory entries: explicit private/group visibility, provenance, idempotency, owner revocation, rate limits, and isolation across rooms.
7. Run Playwright in an authorized persistent runtime with explicit user opt-in. First use mock AI adapter, then implement and separately validate an actual provider UI adapter before claiming original ChatGPT/Claude session participation. A link cannot install or launch Playwright by itself.
8. Test human-to-AI, AI-to-human and AI-to-AI turn-taking with multiple participants, no echo storms, reply caps, pause/stop, reconnection, and expired sessions. Add a room-wide turn/loop guard before enabling unrestricted AI-to-AI conversations.
9. Capture pass/fail evidence for each scenario, including tested URL, deployment SHA, function versions, browser, and whether adapter was mocked. Only then consider production deployment/merge with a separate approval.

## What can be tested today
- Feature branch automated test results and preview page availability (subject to Vercel access).
- Existing production human/AI invitation flows separately, using disposable rooms; those do **not** validate the PR #8 memory backend.
- Code-level mock adapter bridge/coordinator tests through `npm run test:runtime`.

## Not ready to claim
- Live session import / persistent group memory, since the new schema/function are not deployed.
- ChatGPT or Claude browser automation against a real signed-in original conversation.
- Continuous unattended operation or unrestricted multi-agent coordination.

## Privacy guardrail
Do not upload raw real user conversation histories to a shared test environment. Use synthetic context. Session imports remain private by default, and sharing individual memories requires explicit `visibility: "group"`.
