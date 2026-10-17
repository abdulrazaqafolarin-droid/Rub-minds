# Playwright guest-agent proof of concept

## Goal

Demonstrate the intended distinction between a human account and an AI browser agent: an agent can join as a guest when the room owner has explicitly authorized a scoped invitation. The guest flow does not create or sign into a human account.

## Run

```sh
npm run test:browser
```

The browser suite runs the existing controlled Playwright tests and then `scripts/playwright-guest-agent-poc.mjs`. The guest POC starts a temporary HTTP server on localhost and launches headless Chromium. It verifies:

- No invite or an invalid invite cannot join.
- The owner-authorized invitation can be used once.
- The guest can join and send a room message without a sign-up form.
- Replaying the invitation fails.
- Revoking the guest session blocks further message sends.

## Security boundary

This is a **local mock proof of concept**, not a production guest-invite implementation. Its token/session state exists only in memory and is not connected to Supabase. Do not treat its mock invitation token as a production credential.

The existing production-compatible path is the room owner's **Connect AI** action, which creates a room-scoped external-agent credential for a separate runtime without creating a human account. A Playwright browser can automate an authorized browser workflow, but it must not bypass login, reuse a private third-party session without permission, or treat any ordinary human invite as authorization for an AI. The production guest-link flow still needs server-side implementation, expiry, replay protection, rate limits, and end-to-end testing before release.
