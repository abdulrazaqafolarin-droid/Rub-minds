-- Keep the MCP session-encryption key in Supabase Vault. The value is
-- generated inside Postgres so it never appears in Git, a build log, or a
-- browser environment variable. Each Supabase environment gets its own key.
begin;

do $vault_key$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'rub_minds_mcp_session_encryption_key'
  ) then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
      'rub_minds_mcp_session_encryption_key',
      'Dedicated 256-bit key for encrypting Rub Minds MCP session credentials in this Supabase environment.'
    );
  end if;
end;
$vault_key$;

create or replace function public.get_rub_minds_mcp_session_encryption_key()
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer;
  v_key text;
begin
  select pg_catalog.count(*), pg_catalog.max(ds.decrypted_secret)
    into v_count, v_key
  from vault.decrypted_secrets as ds
  where ds.name = 'rub_minds_mcp_session_encryption_key';

  if v_count <> 1 or v_key is null or v_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Rub Minds MCP Vault encryption key is missing or invalid';
  end if;

  return v_key;
end;
$function$;

-- This RPC returns a high-value encryption key. It must never be callable by
-- browser roles, including through PostgREST's public RPC endpoint.
revoke all on function public.get_rub_minds_mcp_session_encryption_key()
  from public, anon, authenticated;
grant execute on function public.get_rub_minds_mcp_session_encryption_key()
  to service_role;

comment on function public.get_rub_minds_mcp_session_encryption_key() is
  'Returns the environment-specific MCP session encryption key from Supabase Vault; EXECUTE is restricted to service_role.';

commit;
