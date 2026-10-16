create or replace function public.revoke_external_agent(connection_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare affected integer;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 update public.agent_connections set revoked_at=now()
 where id=connection_id and owner_id=auth.uid() and revoked_at is null;
 get diagnostics affected = row_count;
 return affected > 0;
end;
$$;
revoke all on function public.revoke_external_agent(uuid) from public, anon;
grant execute on function public.revoke_external_agent(uuid) to authenticated;
