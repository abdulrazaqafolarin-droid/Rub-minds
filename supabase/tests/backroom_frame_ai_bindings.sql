-- Security and structural contract for the host-independent frame/AI binding.
-- This test is read-only and rolls back.
begin;

do $frame_ai_binding_contract$
declare
  v_challenges oid := pg_catalog.to_regclass('public.backroom_frame_ai_binding_challenges');
  v_bindings oid := pg_catalog.to_regclass('public.backroom_frame_ai_bindings');
  v_create oid := pg_catalog.to_regprocedure('public.create_backroom_frame_ai_binding_challenge(uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text)');
  v_complete oid := pg_catalog.to_regprocedure('public.complete_backroom_frame_ai_binding(uuid,text,uuid,uuid,text,text,text,text,text,text)');
  v_revoke oid := pg_catalog.to_regprocedure('public.revoke_backroom_frame_ai_binding(uuid,uuid,uuid,uuid)');
  v_create_def text;
  v_complete_def text;
  v_app_android_pos integer;
  v_app_desktop_pos integer;
  v_challenge_lock_pos integer;
  v_trigger_count integer;
  v_table oid;
begin
  if v_challenges is null or v_bindings is null or v_create is null
    or v_complete is null or v_revoke is null then
    raise exception 'Device-frame binding tables or RPCs are missing';
  end if;

  foreach v_table in array array[v_challenges,v_bindings] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid=v_table) then
      raise exception 'Device-frame tables must enable RLS';
    end if;
    if exists(select 1 from pg_catalog.pg_policies p
      where p.schemaname='public'
        and p.tablename=(select c.relname from pg_catalog.pg_class c where c.oid=v_table)) then
      raise exception 'Device-frame tables must not expose client-facing RLS policies';
    end if;
    if pg_catalog.has_table_privilege('anon',v_table,'SELECT')
      or pg_catalog.has_table_privilege('anon',v_table,'INSERT')
      or pg_catalog.has_table_privilege('anon',v_table,'UPDATE')
      or pg_catalog.has_table_privilege('authenticated',v_table,'SELECT')
      or pg_catalog.has_table_privilege('authenticated',v_table,'INSERT')
      or pg_catalog.has_table_privilege('authenticated',v_table,'UPDATE') then
      raise exception 'Client roles must not read or mutate device-frame binding rows';
    end if;
    if not pg_catalog.has_table_privilege('service_role',v_table,'SELECT')
      or not pg_catalog.has_table_privilege('service_role',v_table,'INSERT')
      or not pg_catalog.has_table_privilege('service_role',v_table,'UPDATE') then
      raise exception 'service_role must manage device-frame binding rows';
    end if;
    if exists(select 1 from pg_catalog.pg_constraint c
      where c.conrelid=v_table and c.confrelid='public.backroom_hosts'::regclass) then
      raise exception 'Host-independent device-frame tables must not reference backroom_hosts';
    end if;
  end loop;

  if pg_catalog.has_function_privilege('anon',v_create,'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated',v_create,'EXECUTE')
    or not pg_catalog.has_function_privilege('service_role',v_create,'EXECUTE')
    or pg_catalog.has_function_privilege('anon',v_complete,'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated',v_complete,'EXECUTE')
    or not pg_catalog.has_function_privilege('service_role',v_complete,'EXECUTE')
    or pg_catalog.has_function_privilege('anon',v_revoke,'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated',v_revoke,'EXECUTE')
    or not pg_catalog.has_function_privilege('service_role',v_revoke,'EXECUTE') then
    raise exception 'Frame binding RPC privileges must be service-role-only';
  end if;

  if not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=v_create and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[])
    or not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=v_complete and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[])
    or not exists(select 1 from pg_catalog.pg_proc p
    where p.oid=v_revoke and p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]) then
    raise exception 'Frame binding RPCs must be SECURITY DEFINER with an empty search_path';
  end if;

  select pg_catalog.lower(pg_catalog.pg_get_functiondef(v_create)) into v_create_def;
  select pg_catalog.lower(pg_catalog.pg_get_functiondef(v_complete)) into v_complete_def;
  if position('backroom_hosts' in v_create_def)>0 or position('backroom_input_bindings' in v_create_def)>0
    or position('backroom_hosts' in v_complete_def)>0 or position('backroom_input_bindings' in v_complete_def)>0 then
    raise exception 'Hostless frame binding path must not depend on the legacy host or input-binding tables';
  end if;

  if position('pg_advisory_xact_lock' in v_complete_def)=0
    or position('rub_minds_mcp_sessions' in v_complete_def)=0
    or position('backroom_frame_ai_binding_challenges' in v_complete_def)=0
    or position('v_challenge.expires_at<=v_now' in v_complete_def)=0
    or position('least(v_runtime.expires_at,v_mcp.expires_at,v_agent.expires_at)' in v_complete_def)=0 then
    raise exception 'Completion must bind to a live MCP session and cap lifetime by live parent sessions, not challenge TTL';
  end if;

  if position('from public.backroom_device_apps' in v_complete_def)=0
    or position('from public.backroom_desktop_apps' in v_complete_def)=0
    or position('for update' in lower(v_complete_def))=0
    or position('for update' in lower(v_complete_def))>position('from public.backroom_frame_ai_binding_challenges c' in v_complete_def) then
    raise exception 'Completion must lock selected app inventory before the challenge row';
  end if;

  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
      where p.proname='complete_backroom_frame_ai_binding'
        and p.pronamespace='public'::regnamespace)<>1 then
    raise exception 'Exactly one frame completion RPC definition must exist';
  end if;

  v_app_android_pos := position('select a.* into v_android_app' in v_complete_def);
  v_app_desktop_pos := position('select a.* into v_desktop_app' in v_complete_def);
  v_challenge_lock_pos := position('select c.* into v_challenge' in v_complete_def);
  if v_app_android_pos=0 or v_app_desktop_pos=0 or v_challenge_lock_pos=0
    or v_app_android_pos>=v_challenge_lock_pos
    or v_app_desktop_pos>=v_challenge_lock_pos
    or position('for update' in pg_catalog.substr(v_complete_def,v_app_android_pos,v_challenge_lock_pos-v_app_android_pos))=0
    or position('for update' in pg_catalog.substr(v_complete_def,v_app_desktop_pos,v_challenge_lock_pos-v_app_desktop_pos))=0 then
    raise exception 'Completion must lock selected app inventory before locking the one-use challenge';
  end if;

  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
      where p.proname='complete_backroom_frame_ai_binding'
        and p.pronamespace='public'::regnamespace)<>1 then
    raise exception 'Exactly one frame completion RPC definition must exist';
  end if;

  if pg_catalog.to_regprocedure('public.refresh_backroom_frame_ai_bindings_for_scope(uuid,text,text)') is null then
    raise exception 'Parent lease refresh helper is missing';
  end if;
  if position('refresh_backroom_frame_ai_bindings_for_scope' in lower(
      pg_catalog.pg_get_functiondef('public.revoke_backroom_frame_ai_bindings_on_parent_change()'::regprocedure)
    ))=0 then
    raise exception 'Runtime/MCP/credential expiry updates must refresh live frame bindings rather than revoke them';
  end if;
  if position('new.expires_at' in lower(pg_catalog.pg_get_functiondef(
      'public.revoke_backroom_frame_ai_bindings_on_parent_change()'::regprocedure
    )))=0 then
    raise exception 'Lifecycle trigger must distinguish expiry updates from identity revocation';
  end if;

  if pg_catalog.to_regclass('public.backroom_frame_ai_bindings_active_mcp_session_uq') is null
    or pg_catalog.to_regclass('public.backroom_frame_ai_bindings_active_runtime_uq') is null then
    raise exception 'One-active-session and one-active-frame uniqueness indexes are required';
  end if;

  if not exists(select 1 from pg_catalog.pg_attribute a
    where a.attrelid=v_bindings and a.attname='wake_enabled'
      and a.atthasdef) then
    raise exception 'Wake consent must remain a distinct defaulted capability';
  end if;

  select pg_catalog.count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  where not t.tgisinternal
    and t.tgname in (
      'backroom_frame_ai_room_lifecycle',
      'backroom_frame_ai_session_lifecycle',
      'backroom_frame_ai_mcp_lifecycle',
      'backroom_frame_ai_participant_lifecycle',
      'backroom_frame_ai_agent_lifecycle',
      'backroom_frame_ai_device_lifecycle',
      'backroom_frame_ai_device_room_lifecycle',
      'backroom_frame_ai_android_app_lifecycle',
      'backroom_frame_ai_desktop_app_lifecycle'
    );
  if v_trigger_count<>9 then
    raise exception 'All nine parent lifecycle invalidation triggers are required';
  end if;
end;
$frame_ai_binding_contract$;

rollback;
