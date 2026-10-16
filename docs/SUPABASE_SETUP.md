# Supabase integration setup

The repository now contains a typed Supabase client and cloud-room service. Cloud operations remain inactive until a dedicated project is selected and the environment is configured.

1. Create or select a **dedicated** Supabase project for Rub Minds.
2. Apply `supabase/migrations/20261016000000_initial.sql` via the connected Supabase migration tool or CLI.
3. Enable email OTP/magic-link sign-in in Supabase Auth; configure the deployed site URL and allowed redirect URLs.
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the frontend deployment. These are public client credentials; never use `service_role` in the browser.
5. Use the functions in `src/cloudRooms.ts` to sign in, create/list rooms, list/post messages, and subscribe to changes.
6. Confirm Realtime publication settings include `public.messages` and verify RLS behavior with two separate authenticated users.

## Security warning

The current SQL migration has no invitation redemption mechanism and intentionally disallows browser clients from creating arbitrary participants. Do not expose a public join endpoint without a server-validated, hashed, expiring invitation and scoped membership creation.

## Status

Cloud service module is implemented, but **not yet wired to the UI**, deployed or integration-tested. The browser-local demo remains the default until Supabase setup and auth UI are completed.
