-- Publish only group memory changes to Realtime.
-- Private session imports intentionally remain outside the publication.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_memory_entries'
  ) then
    execute 'alter publication supabase_realtime add table public.room_memory_entries';
  end if;
end
$$;
