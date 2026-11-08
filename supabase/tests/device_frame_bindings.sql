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
  if not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='rub_minds_mcp_sessions' and column_name='agent_credential_digest') then
    raise exception 'Exact AI credential digest is missing from MCP sessions';
  end if;
  if not exists(select 1 from pg_catalog.pg_trigger t where t.tgname='rub_minds_mcp_session_credential_digest_guard' and not t.tgisinternal) then
    raise exception 'Unjoined MCP session credential digest guard is missing';
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
  if not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=v_challenge
    and c.confrelid='public.rub_minds_mcp_sessions'::regclass
    and position('target_session_digest' in pg_catalog.pg_get_constraintdef(c.oid))>0
    and position('ON DELETE CASCADE' in upper(pg_catalog.pg_get_constraintdef(c.oid)))>0) then
    raise exception 'Challenge must cascade with the exact target MCP session';
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
  foreach v_name in array array['target_session_digest','rub_minds_mcp_sessions','participants','agent_connections','backroom_device_room_bindings',
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
-- Exercise real binding behavior against disposable rows. The enclosing file
-- transaction rolls every identity, credential and runtime back at the end.
do $device_frame_functional$
declare
  v_owner uuid:=pg_catalog.gen_random_uuid();
  v_room uuid:=pg_catalog.gen_random_uuid();
  v_human uuid:=pg_catalog.gen_random_uuid();
  v_ai_one uuid:=pg_catalog.gen_random_uuid();
  v_ai_two uuid:=pg_catalog.gen_random_uuid();
  v_ai_three uuid:=pg_catalog.gen_random_uuid();
  v_android uuid:=pg_catalog.gen_random_uuid();
  v_windows uuid:=pg_catalog.gen_random_uuid();
  v_android_runtime uuid:=pg_catalog.gen_random_uuid();
  v_terminal_runtime uuid:=pg_catalog.gen_random_uuid();
  v_expired_runtime uuid:=pg_catalog.gen_random_uuid();
  v_android_challenge uuid:=pg_catalog.gen_random_uuid();
  v_terminal_challenge uuid:=pg_catalog.gen_random_uuid();
  v_expired_challenge uuid:=pg_catalog.gen_random_uuid();
  v_android_package text:='com.rubminds.framebindingtest';
  v_android_signer text:=pg_catalog.repeat('b',64);
  v_android_session text:=pg_catalog.repeat('1',64);
  v_unjoined_session text:=pg_catalog.repeat('8',64);
  v_android_alt_session text:=pg_catalog.repeat('7',64);
  v_android_credential text:=pg_catalog.repeat('a',64);
  v_windows_session text:=pg_catalog.repeat('2',64);
  v_windows_credential text:=pg_catalog.repeat('c',64);
  v_expired_session text:=pg_catalog.repeat('3',64);
  v_expired_credential text:=pg_catalog.repeat('e',64);
  v_android_nonce text:=pg_catalog.repeat('d',64);
  v_terminal_nonce text:=pg_catalog.repeat('f',64);
  v_expired_nonce text:=pg_catalog.repeat('9',64);
  v_result jsonb;
  v_revoked_at timestamptz;
  v_binding_expiry_before timestamptz;
  v_binding_expiry_after timestamptz;
  v_parent_expiry timestamptz;
  v_desktop_app uuid:=pg_catalog.gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
  values(v_owner,'authenticated','authenticated',
    'frame-binding-'||pg_catalog.replace(v_owner::text,'-','')||'@example.test',
    '',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp());

  insert into public.rooms(id,owner_id,title,objective)
  values(v_room,v_owner,'Device frame binding SQL test','Disposable transactional validation');
  insert into public.participants(id,room_id,user_id,display_name,kind,status)
  values(v_human,v_room,v_owner,'Frame Test Owner','human','connected');
  insert into public.participants(id,room_id,display_name,kind,status)
  values
    (v_ai_one,v_room,'Frame Test AI One','external_agent','connected'),
    (v_ai_two,v_room,'Frame Test AI Two','external_agent','connected'),
    (v_ai_three,v_room,'Frame Test AI Three','external_agent','connected');

  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at)
  values
    (v_room,v_ai_one,v_owner,v_android_credential,pg_catalog.clock_timestamp()+interval '2 hours'),
    (v_room,v_ai_two,v_owner,v_windows_credential,pg_catalog.clock_timestamp()+interval '2 hours'),
    (v_room,v_ai_three,v_owner,v_expired_credential,pg_catalog.clock_timestamp()+interval '2 hours');

  insert into public.rub_minds_mcp_sessions(
    session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at
  ) values
    (v_android_session,'test-encrypted-ai-credential',v_android_credential,v_room,v_ai_one,pg_catalog.clock_timestamp()+interval '2 hours'),
    (v_android_alt_session,'test-encrypted-ai-credential',v_android_credential,v_room,v_ai_one,pg_catalog.clock_timestamp()+interval '2 hours'),
    (v_windows_session,'test-encrypted-ai-credential',v_windows_credential,v_room,v_ai_two,pg_catalog.clock_timestamp()+interval '2 hours'),
    (v_expired_session,'test-encrypted-ai-credential',v_expired_credential,v_room,v_ai_three,pg_catalog.clock_timestamp()+interval '2 hours');

  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_digest,expires_at)
  values(v_unjoined_session,pg_catalog.repeat('9',64),pg_catalog.clock_timestamp()+interval '2 hours');
  if (select agent_credential_digest from public.rub_minds_mcp_sessions where session_digest=v_unjoined_session) is not null then
    raise exception 'Unjoined MCP session retained a stale AI credential digest';
  end if;

  begin
    insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at)
    values(pg_catalog.repeat('0',64),'test-encrypted-ai-credential','invalid',v_room,v_ai_three,pg_catalog.clock_timestamp()+interval '2 hours');
    raise exception 'MCP session accepted a malformed AI credential digest';
  exception when check_violation then null;
  end;

  insert into public.backroom_devices(
    device_id,owner_id,token_digest,device_label,platform,status,approved_at
  ) values
    (v_android,v_owner,pg_catalog.repeat('4',64),'Frame SQL Android','android','active',pg_catalog.clock_timestamp()),
    (v_windows,v_owner,pg_catalog.repeat('5',64),'Frame SQL Windows','windows','active',pg_catalog.clock_timestamp());
  insert into public.backroom_device_room_bindings(device_id,room_id,owner_id)
  values (v_android,v_room,v_owner),(v_windows,v_room,v_owner);
  insert into public.backroom_device_apps(
    device_id,package_name,app_label,signing_certificate_sha256
  ) values(v_android,v_android_package,'Frame SQL AI',v_android_signer);
  insert into public.backroom_desktop_apps(device_id,app_id,app_label,executable_sha256)
  values(v_windows,v_desktop_app,'Frame SQL Desktop AI',pg_catalog.repeat('6',64));

  insert into public.backroom_desktop_sessions(
    session_id,device_id,room_id,requested_by,session_type,status,expires_at,
    target_app_id,target_app_fingerprint
  ) values
    (v_android_runtime,v_android,v_room,v_owner,'screen','active',pg_catalog.clock_timestamp()+interval '1 hour',
      v_android_package,v_android_signer),
    (v_terminal_runtime,v_windows,v_room,v_owner,'terminal','active',pg_catalog.clock_timestamp()+interval '1 hour',
      null,null),
    (v_expired_runtime,v_windows,v_room,v_owner,'terminal','active',pg_catalog.clock_timestamp()+interval '1 hour',
      null,null);

  -- PostgreSQL CHECK constraints accept NULL, so test that incomplete app
  -- identity pairs are rejected rather than silently passing a regex check.
  begin
    insert into public.backroom_desktop_sessions(
      session_id,device_id,room_id,requested_by,session_type,status,expires_at,
      target_app_id,target_app_fingerprint
    ) values(pg_catalog.gen_random_uuid(),v_windows,v_room,v_owner,'screen','active',
      pg_catalog.clock_timestamp()+interval '1 hour',v_desktop_app::text,null);
    raise exception 'runtime accepted an app ID with a missing fingerprint';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.backroom_device_frame_binding_challenges(
      id,requested_by,target_participant_id,room_id,device_id,runtime_session_id,
      surface,target_app_id,target_app_fingerprint,nonce_digest,expires_at
    ) values(pg_catalog.gen_random_uuid(),v_owner,v_ai_one,v_room,v_android,v_android_runtime,
      'android_app',null,null,pg_catalog.repeat('8',64),pg_catalog.clock_timestamp()+interval '90 seconds');
    raise exception 'Android challenge accepted a missing app identity';
  exception when check_violation then
    null;
  end;

  insert into public.backroom_device_frame_binding_challenges(
    id,requested_by,target_participant_id,target_session_digest,room_id,device_id,runtime_session_id,
    surface,target_app_id,target_app_fingerprint,nonce_digest,expires_at
  ) values(v_android_challenge,v_owner,v_ai_one,v_android_session,v_room,v_android,v_android_runtime,
    'android_app',v_android_package,v_android_signer,v_android_nonce,
    pg_catalog.clock_timestamp()+interval '90 seconds');

  v_result:=public.complete_backroom_device_frame_binding(v_android_challenge,v_android_nonce,v_android_session);
  if v_result->>'ok'<>'true' or v_result->>'bound'<>'true'
    or v_result->>'participant_id'<>v_ai_one::text
    or v_result->>'surface'<>'android_app' or v_result->>'replayed'<>'false' then
    raise exception 'Valid Android AI/frame association was rejected: %',v_result;
  end if;

  v_result:=public.complete_backroom_device_frame_binding(v_android_challenge,v_android_nonce,v_windows_session);
  if v_result->>'ok'<>'false' or v_result->>'reason'<>'selected_ai_session_mismatch' then
    raise exception 'Wrong AI participant was not rejected: %',v_result;
  end if;
  v_result:=public.complete_backroom_device_frame_binding(v_android_challenge,v_android_nonce,v_android_alt_session);
  if v_result->>'ok'<>'false' or v_result->>'reason'<>'selected_ai_session_mismatch' then
    raise exception 'A different MCP handle for the same participant was not rejected: %',v_result;
  end if;

  v_result:=public.complete_backroom_device_frame_binding(v_android_challenge,v_android_nonce,v_android_session);
  if v_result->>'ok'<>'true' or v_result->>'replayed'<>'true' then
    raise exception 'Same-session challenge retry was not idempotent: %',v_result;
  end if;

  -- Renewed phone screen leases must extend an unexpired AI/frame link, capped
  -- by the MCP session and credential. A shortened lease must shorten the link.
  select expires_at into v_binding_expiry_before
  from public.backroom_device_frame_bindings where challenge_id=v_android_challenge;
  update public.backroom_desktop_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '3 hours'
  where session_id=v_android_runtime;
  select b.expires_at into v_binding_expiry_after
  from public.backroom_device_frame_bindings b where b.challenge_id=v_android_challenge;
  select least(s.expires_at,ac.expires_at) into v_parent_expiry
  from public.rub_minds_mcp_sessions s
  join public.agent_connections ac on ac.credential_digest=s.agent_credential_digest
  where s.session_digest=v_android_session;
  if v_binding_expiry_after<=v_binding_expiry_before or v_binding_expiry_after>v_parent_expiry then
    raise exception 'Frame binding did not renew within MCP/credential expiry: before %, after %, cap %',
      v_binding_expiry_before,v_binding_expiry_after,v_parent_expiry;
  end if;
  update public.backroom_desktop_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '30 minutes'
  where session_id=v_android_runtime;
  select expires_at into v_binding_expiry_after
  from public.backroom_device_frame_bindings where challenge_id=v_android_challenge;
  if v_binding_expiry_after>pg_catalog.clock_timestamp()+interval '31 minutes' then
    raise exception 'Shortened runtime lease did not shorten the frame link: %',v_binding_expiry_after;
  end if;

  v_result:=public.complete_backroom_device_frame_binding(v_android_challenge,pg_catalog.repeat('8',64),v_android_session);
  if v_result->>'ok'<>'false' or v_result->>'reason'<>'challenge_not_found_or_invalid' then
    raise exception 'Incorrect challenge nonce was not rejected: %',v_result;
  end if;

  update public.backroom_device_apps
  set signing_certificate_sha256=pg_catalog.repeat('7',64)
  where device_id=v_android and package_name=v_android_package;
  select revoked_at into v_revoked_at from public.backroom_device_frame_bindings
    where challenge_id=v_android_challenge;
  if v_revoked_at is null then
    raise exception 'App inventory signer change did not revoke its frame association';
  end if;

  insert into public.backroom_device_frame_binding_challenges(
    id,requested_by,target_participant_id,target_session_digest,room_id,device_id,runtime_session_id,
    surface,target_app_id,target_app_fingerprint,nonce_digest,expires_at
  ) values(v_terminal_challenge,v_owner,v_ai_two,v_windows_session,v_room,v_windows,v_terminal_runtime,
    'terminal',null,null,v_terminal_nonce,pg_catalog.clock_timestamp()+interval '90 seconds');

  v_result:=public.complete_backroom_device_frame_binding(v_terminal_challenge,v_terminal_nonce,v_windows_session);
  if v_result->>'ok'<>'true' or v_result->>'surface'<>'terminal'
    or v_result->>'participant_id'<>v_ai_two::text then
    raise exception 'Valid terminal AI/runtime association was rejected: %',v_result;
  end if;

  update public.rub_minds_mcp_sessions
  set agent_credential_ciphertext=null,room_id=null,participant_id=null,
      terminated_at=pg_catalog.clock_timestamp()
  where session_digest=v_windows_session;
  if (select agent_credential_digest from public.rub_minds_mcp_sessions where session_digest=v_windows_session) is not null then
    raise exception 'Removing an MCP encrypted credential did not clear its credential digest';
  end if;
  select revoked_at into v_revoked_at from public.backroom_device_frame_bindings
    where challenge_id=v_terminal_challenge;
  if v_revoked_at is null then
    raise exception 'MCP session termination did not revoke the terminal frame link';
  end if;

  insert into public.backroom_device_frame_binding_challenges(
    id,requested_by,target_participant_id,target_session_digest,room_id,device_id,runtime_session_id,
    surface,target_app_id,target_app_fingerprint,nonce_digest,created_at,expires_at
  ) values(v_expired_challenge,v_owner,v_ai_three,v_expired_session,v_room,v_windows,v_expired_runtime,
    'terminal',null,null,v_expired_nonce,
    pg_catalog.clock_timestamp()-interval '5 minutes',
    pg_catalog.clock_timestamp()-interval '1 minute');
  v_result:=public.complete_backroom_device_frame_binding(v_expired_challenge,v_expired_nonce,v_expired_session);
  if v_result->>'ok'<>'false' or v_result->>'reason'<>'challenge_expired_or_revoked' then
    raise exception 'Expired frame challenge was not rejected: %',v_result;
  end if;
end;
$device_frame_functional$;

rollback;
