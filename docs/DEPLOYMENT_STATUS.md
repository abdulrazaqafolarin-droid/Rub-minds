# Live backend status

Supabase project **Rub Minds** was created in region `eu-west-2` on 2026-10-16.
Project ref: `zucaeevlbwhcvjwbhwmq`.

Applied through Supabase management:
- `initial_authenticated_rooms` — rooms, participants, messages, RLS, create-room RPC.
- `enable_message_realtime` — message inserts added to Supabase Realtime publication.

The React UI now chooses `CloudApp` when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are provided; otherwise it shows the local demo.

## Remaining before public testing
- Verify GitHub CI build.
- Configure a Vercel/Cloudflare deployment and set the Supabase public URL and publishable key.
- Configure Supabase Auth site URL and redirect allowlist.
- Test two signed-in users with an invitation-redemption flow (not yet built).
- Test RLS and message Realtime with real authenticated clients.

Do not share Supabase service-role secrets with the browser. Do not claim a copied room URL is a functioning invitation.
