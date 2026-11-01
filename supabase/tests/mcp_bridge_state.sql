-- Bridge-state schema/security acceptance. The test is read-only and rolls back.
begin;

do $bridge_state_security$
declare
  v_table oid := pg_catalog.to_regclass('public.rub_minds_mcp_bridge_state');
  v_rls boolean;
  v_policy_count integer;
  v_service_select boolean;
  v_service_insert boolean;
  v_service_update boolean;
  v_anon_privileges boolean;
  v_authenticated_privileges boolean;
  v_constraint_count integer;
  v_session_fk text;
begin
  if v_table is null then
    raise exception 'Bridge-state table is missing';
  end if;

  select c.relrowsecurity
    into v_rls
  from pg_catalog.pg_class c
  where c.oid = v_table;
  if v_rls is distinct from true then
    raise exception 'Bridge-state table must have row-level security enabled';
  end if;

  select pg_catalog.count(*)
    into v_policy_count
  from pg_catalog.pg_policies p
  where p.schemaname='public' and p.tablename='rub_minds_mcp_bridge_state';
  if v_policy_count <> 0 then
    raise exception 'Bridge-state table must not expose a client-facing RLS policy';
  end if;

  select
    pg_catalog.has_table_privilege('anon',v_table,'SELECT')
    or pg_catalog.has_table_privilege('anon',v_table,'INSERT')
    or pg_catalog.has_table_privilege('anon',v_table,'UPDATE')
    or pg_catalog.has_table_privilege('anon',v_table,'DELETE')
    or pg_catalog.has_table_privilege('anon',v_table,'TRUNCATE')
  into v_anon_privileges;
  if v_anon_privileges then
    raise exception 'anon must have no bridge-state table privileges';
  end if;

  select
    pg_catalog.has_table_privilege('authenticated',v_table,'SELECT')
    or pg_catalog.has_table_privilege('authenticated',v_table,'INSERT')
    or pg_catalog.has_table_privilege('authenticated',v_table,'UPDATE')
    or pg_catalog.has_table_privilege('authenticated',v_table,'DELETE')
    or pg_catalog.has_table_privilege('authenticated',v_table,'TRUNCATE')
  into v_authenticated_privileges;
  if v_authenticated_privileges then
    raise exception 'authenticated must have no direct bridge-state table privileges';
  end if;

  select
    pg_catalog.has_table_privilege('service_role',v_table,'SELECT'),
    pg_catalog.has_table_privilege('service_role',v_table,'INSERT'),
    pg_catalog.has_table_privilege('service_role',v_table,'UPDATE')
  into v_service_select,v_service_insert,v_service_update;
  if not coalesce(v_service_select,false)
     or not coalesce(v_service_insert,false)
     or not coalesce(v_service_update,false) then
    raise exception 'service_role requires read/write access to bridge-state rows';
  end if;

  select pg_catalog.count(*)
    into v_constraint_count
  from pg_catalog.pg_constraint c
  where c.conrelid=v_table
    and c.conname in (
      'mcp_bridge_cursor_pair_check',
      'mcp_bridge_pending_pair_check',
      'mcp_bridge_blocked_pair_check',
      'mcp_bridge_pending_blocked_exclusive_check'
    );
  if v_constraint_count <> 4 then
    raise exception 'Bridge-state cursor, pending-response, blocked-state and exclusivity constraints are required';
  end if;

  select pg_catalog.pg_get_constraintdef(c.oid)
    into v_session_fk
  from pg_catalog.pg_constraint c
  where c.conrelid=v_table and c.contype='f'
    and c.confrelid='public.rub_minds_mcp_sessions'::regclass;
  if v_session_fk is null or position('ON DELETE CASCADE' in upper(v_session_fk))=0 then
    raise exception 'Bridge-state rows must cascade-delete with the owning MCP session';
  end if;

  if pg_catalog.to_regclass('public.rub_minds_mcp_bridge_state_room_updated_idx') is null then
    raise exception 'Bridge-state room/update index is missing';
  end if;
end;
$bridge_state_security$;

rollback;
