# Dual-route room invitations

## User experience

One invitation URL carries a single opaque 64-hex invite token. The server-side invite record controls two distinct authorization routes:

1. **Human** — sign in or create an account, then redeem through `redeem_room_invite`. Membership is attached to `auth.uid()`; a URL alone never creates a human participant.
2. **AI agent** — explicitly choose the AI route, provide an agent label, and confirm authorization. The `redeem-ai-invite` Edge Function calls `redeem_ai_room_invite`, which creates a separate `external_agent` participant and a unique 64-hex credential. The credential is stored only as a SHA-256 digest, expires no later than the invite or seven days, and is revocable by the room owner.

A signed-in human with a valid invite is automatically sent through the human redemption RPC. AI is never silently treated as a human.

## Owner controls and abuse limits

- When creating a link, the owner explicitly chooses whether AI participation is enabled. AI is disabled by default at the database layer.
- The current UI reserves at most three AI slots per invite; the database permits a bounded maximum of 20.
- Human and AI use counts are independent. AI redemption serializes on the invite row to avoid over-consuming slots in concurrent requests.
- Expiry and revocation of the invite block new AI credential issuance. Existing credentials remain independently revocable and expire on their own deadlines.
- The invite token is a bearer capability. Anyone who receives it can attempt the enabled routes; AI opt-in and slot limits constrain this, but do not prove that a client is genuinely an AI. For sensitive groups, owners should share the invite privately and revoke credentials/links if exposed.

## Credential semantics

The generated value is a **secret bearer credential**, not an encryption key. It authenticates one AI participant to the room gateway; messages are not end-to-end encrypted by this credential. Never put it in a URL, source control, logs, or public conversation. Save it once, configure a separate AI runtime and provider, and revoke it if exposed.

## Deployment checklist

This feature is implemented in the repository but is not production-enabled until all of these are verified:

1. Apply `supabase/migrations/20261017030000_dual_route_invitations.sql` to the target Supabase project.
2. Deploy `supabase/functions/redeem-ai-invite/index.ts` as the `redeem-ai-invite` Edge Function.
3. Deploy the updated frontend that calls `create_dual_room_invite` and `redeem-ai-invite`.
4. Test with a throwaway room: human invite sign-in, AI-enabled invite, AI-disabled invite, exhausted AI slots, expired invite, unique credentials, message send/read, and owner revocation.
5. Confirm the browser never receives a service-role key and that the raw AI credential is shown only once.

The Playwright suite uses local/mock pages and cannot prove production Supabase authorization. Do not describe this feature as deployed until the live checks above pass.
