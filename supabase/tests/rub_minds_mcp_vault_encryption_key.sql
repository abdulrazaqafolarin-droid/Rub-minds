-- Run after 20261101165353_rub_minds_mcp_vault_encryption_key.sql.
-- This test never prints the secret value.

begin;

do $vault_key_security$
declare
  v_secret_count integer;
  v_key_length integer;
begin
  if has_function_privilege(
    'anon',
    'public.get_rub_minds_mcp_session_encryption_key()',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.get_rub_minds_mcp_session_encryption_key()',
    'EXECUTE'
  ) then
    raise exception 'Browser roles must not be able to retrieve the MCP Vault key';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.get_rub_minds_mcp_session_encryption_key()',
    'EXECUTE'
  ) then
    raise exception 'The service role must be able to retrieve the MCP Vault key';
  end if;

  select pg_catalog.count(*),
         pg_catalog.max(pg_catalog.length(ds.decrypted_secret))
    into v_secret_count, v_key_length
  from vault.decrypted_secrets as ds
  where ds.name = 'rub_minds_mcp_session_encryption_key'
    and ds.decrypted_secret ~ '^[0-9a-f]{64}$';

  if v_secret_count <> 1 or v_key_length <> 64 then
    raise exception 'Exactly one valid 256-bit MCP Vault key must exist';
  end if;
end;
$vault_key_security$;

set local role service_role;

do $service_role_vault_read$
declare
  v_key_length integer;
begin
  v_key_length := pg_catalog.length(
    public.get_rub_minds_mcp_session_encryption_key()
  );
  if v_key_length <> 64 then
    raise exception 'The service-role-only Vault RPC did not return a valid key';
  end if;
end;
$service_role_vault_read$;

rollback;
