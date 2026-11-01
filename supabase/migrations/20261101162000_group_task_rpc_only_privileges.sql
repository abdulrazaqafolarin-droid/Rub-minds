-- Supabase default ACLs may grant authenticated direct table writes even
-- when the preceding feature migration grants only SELECT. Explicitly revoke
-- every client privilege and restore only RLS-protected reads. Task lifecycle
-- writes must pass through the scoped SECURITY DEFINER RPCs or trusted MCP
-- service-role operations.
begin;

revoke all on table public.room_tasks,
  public.room_task_dependencies,
  public.room_task_submissions,
  public.room_task_reviews
from public, anon, authenticated;

grant select on table public.room_tasks,
  public.room_task_dependencies,
  public.room_task_submissions,
  public.room_task_reviews
to authenticated;

grant all on table public.room_tasks,
  public.room_task_dependencies,
  public.room_task_submissions,
  public.room_task_reviews
to service_role;

commit;
