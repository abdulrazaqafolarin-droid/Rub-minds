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
  v_rejoin_definition text;
  v_termination_definition text;
  v_activation_definition text;
  v_session_from integer;
  v_binding_from integer;
  v_session_lock integer;
  v_binding_lock integer;
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

  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = v_table
      and t.tgname = 'rub_minds_mcp_bridge_state_binding_guard'
      and not t.tgisinternal
  ) then
    raise exception 'Bridge-state live-session binding guard trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'enforce_rub_minds_mcp_bridge_state_binding'
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception 'Bridge-state trigger must be SECURITY DEFINER with an empty pinned search_path';
  end if;

  if pg_catalog.to_regprocedure('public.load_rub_minds_mcp_bridge_state(text,uuid,uuid)') is null
     or pg_catalog.to_regprocedure('public.save_rub_minds_mcp_bridge_state(text,uuid,uuid,bigint,timestamp with time zone,uuid,uuid,timestamp with time zone,text,uuid,text)') is null then
    raise exception 'Parent-first bridge-state RPC functions are missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.load_rub_minds_mcp_bridge_state(text,uuid,uuid)')
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'Bridge-state load RPC must be service-role-only SECURITY DEFINER with empty search_path';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.save_rub_minds_mcp_bridge_state(text,uuid,uuid,bigint,timestamp with time zone,uuid,uuid,timestamp with time zone,text,uuid,text)')
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'Bridge-state save RPC must be service-role-only SECURITY DEFINER with empty search_path';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.clear_rub_minds_mcp_bridge_state_for_rejoin(text,text)')
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'MCP rejoin cleanup RPC must be service-role-only SECURITY DEFINER with empty search_path';
  end if;

  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.clear_rub_minds_mcp_bridge_state_for_rejoin(text,text)'::regprocedure
  )) into v_rejoin_definition;
  if position('rub_minds_mcp_join_requests' in v_rejoin_definition) = 0
     or position('agent_connections' in v_rejoin_definition) = 0
     or position('c.revoked_at is null' in v_rejoin_definition) = 0
     or position('c.expires_at > pg_catalog.clock_timestamp()' in v_rejoin_definition) = 0 then
    raise exception 'MCP rejoin cleanup must delete the prior idempotency row only after its participant credential is inactive';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.terminate_rub_minds_mcp_bridge_session(text,text,text,timestamp with time zone)')
      and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'MCP termination RPC must be service-role-only SECURITY DEFINER with empty search_path';
  end if;

  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.terminate_rub_minds_mcp_bridge_session(text,text,text,timestamp with time zone)'::regprocedure
  )) into v_termination_definition;
  if position('pg_advisory_xact_lock' in v_termination_definition)=0
     or position('backroom_input_bindings' in v_termination_definition)=0
     or position('backroom_wake_jobs' in v_termination_definition)=0
     or position('state = ''cancelled''' in v_termination_definition)=0 then
    raise exception 'MCP Leave must serialize with enqueue and revoke Backroom bindings and queued/leased wakes';
  end if;

  -- Auto activation and Leave must take locks in the same parent-first order.
  if pg_catalog.to_regprocedure('public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)') is null then
    raise exception 'Backroom wake activation RPC is missing';
  end if;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)'::regprocedure
  )) into v_activation_definition;
  v_session_from := pg_catalog.strpos(v_activation_definition,'from public.rub_minds_mcp_sessions');
  v_binding_from := pg_catalog.strpos(v_activation_definition,'from public.backroom_input_bindings');
  if pg_catalog.strpos(v_activation_definition,'pg_advisory_xact_lock')=0
     or v_session_from=0 or v_binding_from=0 or v_session_from>=v_binding_from then
    raise exception 'Wake activation must lock the MCP parent before the input binding';
  end if;
  v_session_lock := pg_catalog.strpos(pg_catalog.substr(v_activation_definition,v_session_from),'for update');
  v_binding_lock := pg_catalog.strpos(pg_catalog.substr(v_activation_definition,v_binding_from),'for update');
  if v_session_lock=0 or v_binding_lock=0 or
     v_session_from+v_session_lock-1 >= v_binding_from+v_binding_lock-1 then
    raise exception 'Wake activation must lock both the MCP parent and binding in parent-first order';
  end if;
end;
$bridge_state_security$;

rollback;
