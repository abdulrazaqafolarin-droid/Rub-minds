begin;
do $test$
declare
  v_challenge oid:=pg_catalog.to_regclass('public.backroom_device_frame_binding_challenges');
  v_binding oid:=pg_catalog.to_regclass('public.backroom_device_frame_bindings');
  v_rpc oid:=pg_catalog.to_regprocedure('public.complete_backroom_device_frame_binding(uuid,text,text)');
  v_def text;
  v_table oid;
  v_name text;
begin
  if v_challenge is null or v_binding is null or v_rpc is null then raise exception 'Device-frame schema/RPC missing'; end if;
  if not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='backroom_desktop_sessions' and column_name='target_app_id')
    or not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='backroom_desktop_sessions' and column_name='target_app_fingerprint') then
    raise exception 'Selected app identity is not persisted on the runtime';
  end if;
  foreach v_table in array array[v_challenge,v_binding] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid=v_table) then raise exception 'RLS missing'; end if;
    if exists(select 1 from pg_catalog.pg_policies p where p.schemaname='public'
      and p.tablename=(select c.relname from pg_catalog.pg_class c where c.oid=v_table)) then raise exception 'Client policy exists'; end if;
    if pg_catalog.has_table_privilege('anon',v_table,'SELECT') or pg_catalog.has_table_privilege('anon',v_table,'INSERT')
      or pg_catalog.has_table_privilege('authenticated',v_table,'SELECT')
      or pg_catalog.has_table_privilege('authenticated',v_table,'INSERT') then raise exception 'Client grants exist'; end if;
    if not pg_catalog.has_table_privilege('service_role',v_table,'SELECT')
      or not pg_catalog.has_table_privilege('service_role',v_table,'INSERT')
      or not pg_catalog.has_table_privilege('service_role',v_table,'UPDATE') then raise exception 'service_role grants missing'; end if;
    if exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=v_table
      and c.confrelid='public.backroom_hosts'::regclass) then raise exception 'Browser-host FK found'; end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=v_binding
    and c.confrelid='public.rub_minds_mcp_sessions'::regclass
    and position('ON DELETE CASCADE' in upper(pg_catalog.pg_get_constraintdef(c.oid)))>0) then
    raise exception 'MCP session cascade FK missing';
  end if;
  if not exists(select 1 from pg_catalog.pg_index i where i.indexrelid='public.backroom_device_frame_binding_active_participant_idx'::regclass and i.indisunique)
    or not exists(select 1 from pg_catalog.pg_index i where i.indexrelid='public.backroom_device_frame_binding_active_session_idx'::regclass and i.indisunique)
    or not exists(select 1 from pg_catalog.pg_index i where i.indexrelid='public.backroom_device_frame_binding_active_runtime_idx'::regclass and i.indisunique) then
    raise exception 'Active participant/session/runtime unique indexes missing';
  end if;
  if not (select p.prosecdef and p.proconfig @> array['search_path=""']::text[] from pg_catalog.pg_proc p where p.oid=v_rpc)
    or pg_catalog.has_function_privilege('anon',v_rpc,'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated',v_rpc,'EXECUTE')
    or not pg_catalog.has_function_privilege('service_role',v_rpc,'EXECUTE') then
    raise exception 'Completion RPC privilege/search_path boundary incorrect';
  end if;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(v_rpc)) into v_def;
  foreach v_name in array array['rub_minds_mcp_sessions','participants','agent_connections','backroom_device_room_bindings',
    'backroom_desktop_sessions','backroom_devices','backroom_device_apps','backroom_desktop_apps','target_participant_id'] loop
    if position(v_name in v_def)=0 then raise exception 'Completion RPC missing check for %',v_name; end if;
  end loop;
  if position('backroom_hosts' in v_def)>0 then raise exception 'Completion RPC references browser host'; end if;
  foreach v_name in array array['backroom_device_frame_mcp_lifecycle_trigger','backroom_device_frame_runtime_lifecycle_trigger',
    'backroom_device_frame_device_lifecycle_trigger','backroom_device_frame_unpair_lifecycle_trigger',
    'backroom_device_frame_agent_lifecycle_trigger','backroom_device_frame_participant_lifecycle_trigger',
    'backroom_device_frame_android_app_lifecycle_trigger','backroom_device_frame_desktop_app_lifecycle_trigger'] loop
    if not exists(select 1 from pg_catalog.pg_trigger t where t.tgname=v_name and not t.tgisinternal) then
      raise exception 'Required invalidation trigger missing: %',v_name;
    end if;
  end loop;
end;
$test$;
rollback;
