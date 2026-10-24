-- Keep message INSERT events available to the MCP Realtime wait tool.
-- The live project may already have this publication membership; make local,
-- preview and fresh project setup reproducible without duplicating membership.
do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$migration$;
