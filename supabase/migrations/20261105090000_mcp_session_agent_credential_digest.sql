-- Digest of the exact AI invitation credential bound to a hosted MCP session.
-- This must precede migrations that attach native app identity to the MCP row.
begin;
alter table public.rub_minds_mcp_sessions add column if not exists agent_credential_digest text;
update public.rub_minds_mcp_sessions set agent_credential_digest=null
where agent_credential_ciphertext is null and agent_credential_digest is not null;
do $mcp_credential_digest_constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.rub_minds_mcp_sessions'::regclass
    and conname='rub_minds_mcp_sessions_agent_credential_digest_check') then
    alter table public.rub_minds_mcp_sessions add constraint rub_minds_mcp_sessions_agent_credential_digest_check
      check (agent_credential_digest is null or agent_credential_digest ~ '^[a-f0-9]{64}$');
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.rub_minds_mcp_sessions'::regclass
    and conname='rub_minds_mcp_sessions_unjoined_digest_empty_check') then
    alter table public.rub_minds_mcp_sessions add constraint rub_minds_mcp_sessions_unjoined_digest_empty_check
      check (agent_credential_ciphertext is not null or agent_credential_digest is null);
  end if;
end;
$mcp_credential_digest_constraints$;
create index if not exists rub_minds_mcp_sessions_agent_credential_digest_idx
  on public.rub_minds_mcp_sessions(agent_credential_digest) where agent_credential_digest is not null;
create or replace function public.clear_unbound_mcp_agent_credential_digest()
returns trigger language plpgsql set search_path=''
as $function$
begin
  if new.agent_credential_ciphertext is null then new.agent_credential_digest:=null; end if;
  return new;
end;
$function$;
revoke all on function public.clear_unbound_mcp_agent_credential_digest() from public,anon,authenticated;
drop trigger if exists rub_minds_mcp_session_credential_digest_guard on public.rub_minds_mcp_sessions;
create trigger rub_minds_mcp_session_credential_digest_guard
before insert or update of agent_credential_ciphertext on public.rub_minds_mcp_sessions
for each row execute function public.clear_unbound_mcp_agent_credential_digest();
commit;
