-- Supabase projects may have default EXECUTE privileges for service_role.
-- Human review is an authenticated-user capability, not a backend service RPC.
revoke all on function public.review_room_task(uuid,uuid,text,text,jsonb) from service_role;
