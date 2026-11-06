-- Integration contract for the durable wake queue, provider-identity and native-settlement migrations.
do $test$
declare
  v_owner uuid := '20000000-0000-0000-0000-000000000099';
  v_trigger_room uuid := '10000000-0000-4000-8000-000000000098';
  v_trigger_ai uuid := '30000000-0000-4000-8000-000000000098';
  v_trigger_human uuid := '30000000-0000-4000-8000-000000000097';
  v_trigger_binding uuid := '60000000-0000-4000-8000-000000000008';
  v_trigger_message uuid;
  v_room uuid := '10000000-0000-0000-0000-000000000099';
  v_participant uuid := '30000000-0000-0000-0000-000000000099';
  v_session_digest text := repeat('b',64);
  v_first jsonb;
  v_repeat jsonb;
  v_retry_job jsonb;
  v_cancel_job jsonb;
  v_expire_job jsonb;
  v_claim record;
  v_claim_retry record;
  v_count integer;
  v_conflict boolean := false;
  v_retry_state text;
  v_ok boolean;
  v_key text;
  v_capacity_first jsonb;
  v_purge_count integer;
  i integer;

  v_host_test text := '40000000-0000-4000-8000-000000000099';
  v_host_capacity text := '40000000-0000-4000-8000-000000000098';
  v_host_wrong text := '40000000-0000-4000-8000-000000000097';
  v_binding_1 uuid := '60000000-0000-4000-8000-000000000001';
  v_binding_2 uuid := '60000000-0000-4000-8000-000000000002';
  v_binding_3 uuid := '60000000-0000-4000-8000-000000000003';
  v_binding_4 uuid := '60000000-0000-4000-8000-000000000004';
  v_binding_5 uuid := '60000000-0000-4000-8000-000000000005';
  v_binding_6 uuid := '60000000-0000-4000-8000-000000000006';
  v_binding_7 uuid := '60000000-0000-4000-8000-000000000007';
  v_binding_native uuid := '60000000-0000-4000-8000-000000000010';
  v_binding_native_draft uuid := '60000000-0000-4000-8000-000000000011';
  v_native_provider_digest text := repeat('9',64);
  v_native_job jsonb;
  v_native_claim record;
  v_native_handoff uuid := '80000000-0000-4000-8000-000000000010';
  v_native_device uuid := '81000000-0000-4000-8000-000000000010';
  v_native_screen_session uuid := '82000000-0000-4000-8000-000000000010';
  v_native_result jsonb;
  v_bad_native_result jsonb;
  v_native_settlement text;
  v_rejected boolean;
  v_error_message text;
  v_preflight_job jsonb;
  v_preflight_claim record;
  v_preflight_handoff uuid := '80000000-0000-4000-8000-000000000011';
  v_preflight_result jsonb;
  v_preflight_retry_claim record;
  v_preflight_retry_handoff uuid := '80000000-0000-4000-8000-000000000013';
  v_preflight_retry_result jsonb;
  v_review_job jsonb;
  v_review_claim record;
  v_review_handoff uuid := '80000000-0000-4000-8000-000000000012';
  v_review_result jsonb;
  v_settlement_definition text;
  v_advisory_lock_position integer;
  v_session_lock_position integer;
  v_binding_lock_position integer;
  v_job_lock_position integer;
  v_native_binding_definition text;
  v_attest_advisory_position integer;
  v_attest_session_position integer;
  v_attest_binding_position integer;
  v_attest_challenge_position integer;
  v_attest_screen_position integer;
  v_attest_device_position integer;
  v_native_challenge uuid := '83000000-0000-4000-8000-000000000010';
  v_native_nonce text := repeat('f',64);
  v_native_attestation jsonb;
  v_native_mapping_id uuid;
  v_native_challenge_retry uuid := '83000000-0000-4000-8000-000000000011';
  v_native_nonce_retry text := repeat('1',64);
  v_native_screen_session_retry uuid := '82000000-0000-4000-8000-000000000011';
  v_native_mapping_retry_id uuid;
  v_native_challenge_screen_cap uuid := '83000000-0000-4000-8000-000000000012';
  v_native_nonce_screen_cap text := repeat('2',64);
  v_native_challenge_host_cap uuid := '83000000-0000-4000-8000-000000000013';
  v_native_nonce_host_cap text := repeat('3',64);
  v_native_screen_cap_expiry timestamptz;
  v_native_screen_challenge_cap_expiry timestamptz;
  v_native_host_cap_expiry timestamptz;
  v_native_host_challenge_cap_expiry timestamptz;
  v_native_authority_cap_expiry timestamptz;
  v_native_authority_challenge_cap_expiry timestamptz;
begin
  select pg_catalog.pg_get_functiondef(
    'public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)'::regprocedure
  ) into v_settlement_definition;
  v_advisory_lock_position:=pg_catalog.position('pg_advisory_xact_lock' in v_settlement_definition);
  v_session_lock_position:=pg_catalog.position('from public.rub_minds_mcp_sessions s' in v_settlement_definition);
  v_binding_lock_position:=pg_catalog.position('from public.backroom_input_bindings b' in v_settlement_definition);
  v_job_lock_position:=pg_catalog.position('from public.backroom_wake_jobs j' in v_settlement_definition);
  if v_advisory_lock_position=0 or v_session_lock_position=0
    or v_binding_lock_position=0 or v_job_lock_position=0
    or not (v_advisory_lock_position<v_session_lock_position
      and v_session_lock_position<v_binding_lock_position
      and v_binding_lock_position<v_job_lock_position) then
    raise exception 'Native settlement must lock session, binding, then job to serialize with consent revocation';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.register_backroom_android_native_binding(uuid,text,uuid,uuid,text,text,text,text,text)'::regprocedure
  ) into v_native_binding_definition;
  v_attest_advisory_position:=pg_catalog.position('pg_advisory_xact_lock' in v_native_binding_definition);
  v_attest_session_position:=pg_catalog.position('from public.rub_minds_mcp_sessions s' in v_native_binding_definition);
  v_attest_binding_position:=pg_catalog.position('where b.id=v_challenge.binding_id for update' in v_native_binding_definition);
  v_attest_challenge_position:=pg_catalog.position('where c.id=p_challenge_id for update' in v_native_binding_definition);
  v_attest_screen_position:=pg_catalog.position('where s.session_id=p_screen_session_id' in v_native_binding_definition);
  v_attest_device_position:=pg_catalog.position('where d.device_id=p_device_id' in v_native_binding_definition);
  if v_attest_advisory_position=0 or v_attest_session_position=0
    or v_attest_binding_position=0 or v_attest_challenge_position=0
    or v_attest_screen_position=0 or v_attest_device_position=0
    or not (v_attest_advisory_position<v_attest_session_position
      and v_attest_session_position<v_attest_binding_position
      and v_attest_binding_position<v_attest_challenge_position
      and v_attest_challenge_position<v_attest_screen_position
      and v_attest_screen_position<v_attest_device_position)
    or (select p.prosecdef from pg_catalog.pg_proc p
      where p.oid='public.register_backroom_android_native_binding(uuid,text,uuid,uuid,text,text,text,text,text)'::regprocedure) then
    raise exception 'Native binding registration must use invoker privileges and consistent session-to-device lock ordering';
  end if;

  insert into auth.users(id) values (v_owner);
  insert into public.rooms(id,owner_id,title) values (v_room,v_owner,'Backroom wake queue test room');
  insert into public.participants(id,room_id,display_name,kind,status) values (v_participant,v_room,'Test Backroom Agent','external_agent','active');
  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at)
  values (v_room,v_participant,v_owner,repeat('a',64),pg_catalog.clock_timestamp()+interval '48 hours',null);

  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at,terminated_at)
  values
    (repeat('b',64),'ci-ciphertext-b',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('c',64),'ci-ciphertext-c',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('d',64),'ci-ciphertext-d',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('e',64),'ci-ciphertext-e',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('f',64),'ci-ciphertext-f',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',pg_catalog.clock_timestamp()),
    (repeat('6',64),'ci-ciphertext-6',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at,terminated_at)
    values (repeat('7',64),'ci-ciphertext-7',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at,terminated_at)
    values (repeat('8',64),'ci-ciphertext-8',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at,terminated_at)
    values (repeat('5',64),'ci-ciphertext-5',repeat('a',64),v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at,revoked_at)
  values (v_host_test,v_owner,repeat('1',64),pg_catalog.clock_timestamp()+interval '48 hours',null),
         (v_host_capacity,v_owner,repeat('2',64),pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.backroom_input_bindings(
    id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,
    target_identity_fingerprint,target_revision,surface,locator_kind,locator_value,participation_mode,
    wake_enabled,wake_grant_id,wake_expires_at,max_wakes_per_minute,confirmed_at,revoked_at
  ) values
    (v_binding_1,v_owner,v_room,v_participant,v_host_test,repeat('b',64),'space-1','session-1','target-1','fingerprint-1',1,'browser_tab','dom','composer-1','mentions',true,'70000000-0000-4000-8000-000000000001'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_2,v_owner,v_room,v_participant,v_host_test,repeat('c',64),'space-1','session-2','target-2','fingerprint-2',2,'browser_tab','dom','composer-2','mentions',true,'70000000-0000-4000-8000-000000000002'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_3,v_owner,v_room,v_participant,v_host_test,repeat('d',64),'space-1','session-3','target-3','fingerprint-3',1,'browser_tab','dom','composer-3','mentions',true,'70000000-0000-4000-8000-000000000003'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_4,v_owner,v_room,v_participant,v_host_test,repeat('e',64),'space-1','session-4','target-4','fingerprint-4',1,'browser_tab','dom','composer-4','mentions',true,'70000000-0000-4000-8000-000000000004'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_5,v_owner,v_room,v_participant,v_host_test,repeat('f',64),'space-1','session-5','target-5','fingerprint-5',1,'browser_tab','dom','composer-5','mentions',true,'70000000-0000-4000-8000-000000000005'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_6,v_owner,v_room,v_participant,v_host_test,repeat('6',64),'space-1','session-6','target-6','fingerprint-6',1,'browser_tab','dom','composer-6','mentions',true,'70000000-0000-4000-8000-000000000006'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null),
    (v_binding_7,v_owner,v_room,v_participant,v_host_capacity,repeat('7',64),'space-capacity','session-capacity','target-capacity','fingerprint-capacity',1,'browser_tab','dom','composer-capacity','mentions',true,'70000000-0000-4000-8000-000000000007'::uuid,pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null);

  insert into public.backroom_input_bindings(
    id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,
    target_identity_fingerprint,provider_conversation_identity_digest,target_revision,surface,
    locator_kind,locator_value,participation_mode,wake_enabled,wake_grant_id,wake_expires_at,
    max_wakes_per_minute,confirmed_at,revoked_at
  ) values (
    v_binding_native,v_owner,v_room,v_participant,v_host_test,repeat('8',64),
    'space-native','session-native','target-native','fingerprint-native',v_native_provider_digest,1,
    'android_app','accessibility','composer-native','mentions',true,
    '70000000-0000-4000-8000-000000000020'::uuid,
    pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null
  );

  -- Native composer selection remains available for manual draft typing without a provider resolver.
  insert into public.backroom_input_bindings(
    id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,
    target_identity_fingerprint,provider_conversation_identity_digest,target_revision,surface,
    locator_kind,locator_value,participation_mode,wake_enabled,wake_grant_id,wake_expires_at,
    max_wakes_per_minute,confirmed_at,revoked_at
  ) values (
    v_binding_native_draft,v_owner,v_room,v_participant,v_host_test,repeat('5',64),
    'space-native-draft','session-native-draft','target-native-draft','fingerprint-native-draft',null,1,
    'android_app','accessibility','composer-native-draft','mentions',false,
    null,null,6,null,null
  );

  v_conflict := false;
  begin
    update public.backroom_input_bindings
    set wake_enabled=true,wake_grant_id='70000000-0000-4000-8000-000000000021'::uuid,
        confirmed_at=pg_catalog.clock_timestamp(),
        wake_expires_at=pg_catalog.clock_timestamp()+interval '1 hour'
    where id=v_binding_native_draft;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then
    raise exception 'Native draft binding without provider identity must not enable autonomous wake';
  end if;

  -- Create a paired Android device, live app-screen session and owner-approved
  -- one-time challenge. Only the device-bearer completion RPC may attach the
  -- first provider digest to this draft-only group binding.
  insert into public.backroom_devices(device_id,owner_id,token_digest,device_label,platform,status)
  values(v_native_device,v_owner,repeat('d',64),'Android CI device','android','active');
  insert into public.backroom_device_room_bindings(device_id,room_id,owner_id)
  values(v_native_device,v_room,v_owner);
  insert into public.backroom_device_apps(
    device_id,package_name,app_label,signing_certificate_sha256,version_name
  ) values(v_native_device,'com.example.notes','Example Notes',repeat('e',64),'1.0');
  insert into public.backroom_desktop_sessions(
    session_id,device_id,room_id,requested_by,session_type,status,expires_at
  ) values(v_native_screen_session,v_native_device,v_room,v_owner,'screen','active',
    pg_catalog.clock_timestamp()+interval '1 hour');
  insert into public.backroom_android_native_binding_challenges(
    id,owner_id,room_id,binding_id,device_id,screen_session_id,app_package_name,nonce_digest,expires_at
  ) values(
    v_native_challenge,v_owner,v_room,v_binding_native_draft,v_native_device,
    v_native_screen_session,'com.example.notes',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce,'UTF8')),'hex'),
    pg_catalog.clock_timestamp()+interval '90 seconds'
  );

  if has_function_privilege('anon','public.register_backroom_android_native_binding(uuid,text,uuid,uuid,text,text,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.register_backroom_android_native_binding(uuid,text,uuid,uuid,text,text,text,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.register_backroom_android_native_binding(uuid,text,uuid,uuid,text,text,text,text,text)','EXECUTE') then
    raise exception 'Android native binding registration RPC must be service-role only';
  end if;

  select public.register_backroom_android_native_binding(
    v_native_challenge,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce,'UTF8')),'hex'),
    v_native_device,v_native_screen_session,'com.example.notes',repeat('e',64),
    repeat('c',64),repeat('d',64),v_native_provider_digest
  ) into v_native_attestation;
  if v_native_attestation->>'ok' is distinct from 'true'
    or v_native_attestation->>'replayed' is distinct from 'false'
    or not exists(select 1 from public.backroom_input_bindings b
      where b.id=v_binding_native_draft
        and b.provider_conversation_identity_digest=v_native_provider_digest
        and b.wake_enabled=false and b.wake_grant_id is null)
    or not exists(select 1 from public.backroom_android_native_bindings n
      where n.id=(v_native_attestation->>'nativeBindingId')::uuid
        and n.binding_id=v_binding_native_draft and n.device_id=v_native_device
        and n.screen_session_id=v_native_screen_session
        and n.app_signing_certificate_sha256=repeat('e',64)
        and n.composer_identity_digest=repeat('c',64)
        and n.send_control_identity_digest=repeat('d',64)
        and n.provider_conversation_identity_digest=v_native_provider_digest
        and n.revoked_at is null) then
    raise exception 'Android device evidence must create the exact group-to-phone native binding without enabling wake';
  end if;
  v_native_mapping_id:=(v_native_attestation->>'nativeBindingId')::uuid;

  -- The same consumed challenge/evidence may be replayed idempotently; a new
  -- set of digests cannot reuse that challenge.
  select public.register_backroom_android_native_binding(
    v_native_challenge,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce,'UTF8')),'hex'),
    v_native_device,v_native_screen_session,'com.example.notes',repeat('e',64),
    repeat('c',64),repeat('d',64),v_native_provider_digest
  ) into v_native_attestation;
  if v_native_attestation->>'ok' is distinct from 'true'
    or v_native_attestation->>'replayed' is distinct from 'true'
    or (v_native_attestation->>'nativeBindingId')::uuid is distinct from v_native_mapping_id then
    raise exception 'The same device binding evidence must replay idempotently';
  end if;

  v_conflict:=false;
  begin
    update public.backroom_input_bindings
    set provider_conversation_identity_digest=repeat('a',64)
    where id=v_binding_native_draft;
  exception when check_violation then
    v_conflict:=true;
  end;
  if not v_conflict then
    raise exception 'A device-attested provider digest must remain immutable after first registration';
  end if;

  -- Shortening a live screen lease caps both the attestation and any pending challenge.
  insert into public.backroom_android_native_binding_challenges(
    id,owner_id,room_id,binding_id,device_id,screen_session_id,app_package_name,nonce_digest,expires_at
  ) values(
    v_native_challenge_screen_cap,v_owner,v_room,v_binding_native_draft,v_native_device,
    v_native_screen_session,'com.example.notes',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce_screen_cap,'UTF8')),'hex'),
    pg_catalog.clock_timestamp()+interval '45 minutes'
  );
  update public.backroom_desktop_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '5 minutes'
  where session_id=v_native_screen_session and status='active';
  if not exists(select 1 from public.backroom_android_native_bindings n
      join public.backroom_desktop_sessions s on s.session_id=n.screen_session_id
      where n.id=v_native_mapping_id and n.revoked_at is null
        and n.expires_at<=s.expires_at)
    or not exists(select 1 from public.backroom_android_native_binding_challenges c
      join public.backroom_desktop_sessions s on s.session_id=c.screen_session_id
      where c.id=v_native_challenge_screen_cap and c.revoked_at is null
        and c.expires_at<=s.expires_at) then
    raise exception 'Shortening a screen lease must cap its mapping and pending challenge';
  end if;
  select n.expires_at into v_native_screen_cap_expiry
  from public.backroom_android_native_bindings n where n.id=v_native_mapping_id;
  select c.expires_at into v_native_screen_challenge_cap_expiry
  from public.backroom_android_native_binding_challenges c where c.id=v_native_challenge_screen_cap;
  -- Extending the screen later must not silently renew either proof.
  update public.backroom_desktop_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '1 hour'
  where session_id=v_native_screen_session and status='active';
  if (select n.expires_at from public.backroom_android_native_bindings n where n.id=v_native_mapping_id)
       is distinct from v_native_screen_cap_expiry
    or (select c.expires_at from public.backroom_android_native_binding_challenges c
       where c.id=v_native_challenge_screen_cap) is distinct from v_native_screen_challenge_cap_expiry then
    raise exception 'Screen renewal must not silently extend a native mapping or challenge';
  end if;

  -- Stopping the exact Android screen session revokes both active and pending phone authority.
  update public.backroom_desktop_sessions
  set status='stopped',stopped_at=pg_catalog.clock_timestamp()
  where session_id=v_native_screen_session and status='active';
  if not exists(select 1 from public.backroom_android_native_bindings n
    where n.id=v_native_mapping_id and n.revoked_at is not null)
    or not exists(select 1 from public.backroom_android_native_binding_challenges c
      where c.id=v_native_challenge_screen_cap and c.revoked_at is not null) then
    raise exception 'Stopping the Android screen session must revoke its native mapping and pending challenges';
  end if;
  select public.register_backroom_android_native_binding(
    v_native_challenge,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce,'UTF8')),'hex'),
    v_native_device,v_native_screen_session,'com.example.notes',repeat('e',64),
    repeat('c',64),repeat('d',64),v_native_provider_digest
  ) into v_native_attestation;
  if v_native_attestation->>'ok' is distinct from 'false'
    or v_native_attestation->>'reason' is distinct from 'challenge_already_consumed' then
    raise exception 'A consumed challenge must not replay a revoked phone attestation';
  end if;

  -- Rebind the same exact group AI to a new live screen session with a fresh
  -- owner challenge; MCP Leave later must revoke this still-active mapping.
  insert into public.backroom_desktop_sessions(
    session_id,device_id,room_id,requested_by,session_type,status,expires_at
  ) values(v_native_screen_session_retry,v_native_device,v_room,v_owner,'screen','active',
    pg_catalog.clock_timestamp()+interval '1 hour');
  insert into public.backroom_android_native_binding_challenges(
    id,owner_id,room_id,binding_id,device_id,screen_session_id,app_package_name,nonce_digest,expires_at
  ) values(
    v_native_challenge_retry,v_owner,v_room,v_binding_native_draft,v_native_device,
    v_native_screen_session_retry,'com.example.notes',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce_retry,'UTF8')),'hex'),
    pg_catalog.clock_timestamp()+interval '90 seconds'
  );
  select public.register_backroom_android_native_binding(
    v_native_challenge_retry,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce_retry,'UTF8')),'hex'),
    v_native_device,v_native_screen_session_retry,'com.example.notes',repeat('e',64),
    repeat('c',64),repeat('d',64),v_native_provider_digest
  ) into v_native_attestation;
  if v_native_attestation->>'ok' is distinct from 'true'
    or v_native_attestation->>'replayed' is distinct from 'false' then
    raise exception 'A fresh owner challenge must rebind the exact group AI to a new live phone session';
  end if;
  v_native_mapping_retry_id:=(v_native_attestation->>'nativeBindingId')::uuid;

  -- Shortening the paired host lease caps both the native mapping and outstanding challenge.
  insert into public.backroom_android_native_binding_challenges(
    id,owner_id,room_id,binding_id,device_id,screen_session_id,app_package_name,nonce_digest,expires_at
  ) values(
    v_native_challenge_host_cap,v_owner,v_room,v_binding_native_draft,v_native_device,
    v_native_screen_session_retry,'com.example.notes',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce_host_cap,'UTF8')),'hex'),
    pg_catalog.clock_timestamp()+interval '45 minutes'
  );
  update public.backroom_hosts
  set expires_at=pg_catalog.clock_timestamp()+interval '10 minutes'
  where host_id=v_host_test;
  if not exists(select 1 from public.backroom_android_native_bindings n
      join public.backroom_hosts h on h.host_id=v_host_test
      where n.id=v_native_mapping_retry_id and n.revoked_at is null
        and n.expires_at<=h.expires_at)
    or not exists(select 1 from public.backroom_android_native_binding_challenges c
      join public.backroom_hosts h on h.host_id=v_host_test
      where c.id=v_native_challenge_host_cap and c.revoked_at is null
        and c.expires_at<=h.expires_at) then
    raise exception 'Shortening a host lease must cap its native mapping and pending challenge';
  end if;
  select n.expires_at into v_native_host_cap_expiry
  from public.backroom_android_native_bindings n where n.id=v_native_mapping_retry_id;
  select c.expires_at into v_native_host_challenge_cap_expiry
  from public.backroom_android_native_binding_challenges c where c.id=v_native_challenge_host_cap;
  -- A renewed host does not silently renew an already-issued native attestation.
  update public.backroom_hosts
  set expires_at=pg_catalog.clock_timestamp()+interval '48 hours'
  where host_id=v_host_test;
  if (select n.expires_at from public.backroom_android_native_bindings n
      where n.id=v_native_mapping_retry_id) is distinct from v_native_host_cap_expiry
    or (select c.expires_at from public.backroom_android_native_binding_challenges c
      where c.id=v_native_challenge_host_cap) is distinct from v_native_host_challenge_cap_expiry then
    raise exception 'Host renewal must not silently extend a native mapping or challenge';
  end if;

  -- Expiring the exact MCP session caps its phone attestation and outstanding challenge.
  update public.rub_minds_mcp_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '8 minutes'
  where session_digest=repeat('5',64);
  if not exists(select 1 from public.backroom_android_native_bindings n
      join public.rub_minds_mcp_sessions m on m.session_digest=repeat('5',64)
      where n.id=v_native_mapping_retry_id and n.revoked_at is null
        and n.expires_at<=m.expires_at)
    or not exists(select 1 from public.backroom_android_native_binding_challenges c
      join public.rub_minds_mcp_sessions m on m.session_digest=repeat('5',64)
      where c.id=v_native_challenge_host_cap and c.revoked_at is null
        and c.expires_at<=m.expires_at) then
    raise exception 'Shortening an MCP session must cap its native mapping and pending challenge';
  end if;
  update public.rub_minds_mcp_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '1 hour'
  where session_digest=repeat('5',64);
  select n.expires_at into v_native_authority_cap_expiry
  from public.backroom_android_native_bindings n where n.id=v_native_mapping_retry_id;
  select c.expires_at into v_native_authority_challenge_cap_expiry
  from public.backroom_android_native_binding_challenges c where c.id=v_native_challenge_host_cap;
  if (select n.expires_at from public.backroom_android_native_bindings n
      where n.id=v_native_mapping_retry_id) is distinct from v_native_authority_cap_expiry
    or (select c.expires_at from public.backroom_android_native_binding_challenges c
      where c.id=v_native_challenge_host_cap) is distinct from v_native_authority_challenge_cap_expiry then
    raise exception 'MCP session renewal must not silently extend native proofs';
  end if;

  -- Revoking or shortening the exact agent credential is another independent consent boundary.
  update public.agent_connections
  set expires_at=pg_catalog.clock_timestamp()+interval '6 minutes'
  where credential_digest=repeat('a',64);
  if not exists(select 1 from public.backroom_android_native_bindings n
      where n.id=v_native_mapping_retry_id and n.revoked_at is null
        and n.expires_at<=pg_catalog.clock_timestamp()+interval '6 minutes')
    or not exists(select 1 from public.backroom_android_native_binding_challenges c
      where c.id=v_native_challenge_host_cap and c.revoked_at is null
        and c.expires_at<=pg_catalog.clock_timestamp()+interval '6 minutes') then
    raise exception 'Shortening an AI credential must cap its native mapping and pending challenge';
  end if;
  update public.agent_connections
  set expires_at=pg_catalog.clock_timestamp()+interval '48 hours'
  where credential_digest=repeat('a',64);
  select n.expires_at into v_native_authority_cap_expiry
  from public.backroom_android_native_bindings n where n.id=v_native_mapping_retry_id;
  select c.expires_at into v_native_authority_challenge_cap_expiry
  from public.backroom_android_native_binding_challenges c where c.id=v_native_challenge_host_cap;
  if (select n.expires_at from public.backroom_android_native_bindings n
      where n.id=v_native_mapping_retry_id) is distinct from v_native_authority_cap_expiry
    or (select c.expires_at from public.backroom_android_native_binding_challenges c
      where c.id=v_native_challenge_host_cap) is distinct from v_native_authority_challenge_cap_expiry then
    raise exception 'AI credential renewal must not silently extend native proofs';
  end if;

  -- A consumed challenge can still acknowledge an exact duplicate after the
  -- group owner explicitly arms wake; it must not create a second mapping.
  if not public.activate_backroom_wake_grant(
    v_host_test,repeat('5',64),v_binding_native_draft,
    '70000000-0000-4000-8000-000000000022'::uuid,300
  ) then
    raise exception 'A device-attested native binding with a provider digest may be explicitly armed';
  end if;
  select public.register_backroom_android_native_binding(
    v_native_challenge_retry,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_nonce_retry,'UTF8')),'hex'),
    v_native_device,v_native_screen_session_retry,'com.example.notes',repeat('e',64),
    repeat('c',64),repeat('d',64),v_native_provider_digest
  ) into v_native_attestation;
  if v_native_attestation->>'ok' is distinct from 'true'
    or v_native_attestation->>'replayed' is distinct from 'true'
    or (v_native_attestation->>'nativeBindingId')::uuid is distinct from v_native_mapping_retry_id
    or (select count(*) from public.backroom_android_native_bindings
      where binding_id=v_binding_native_draft and revoked_at is null)<>1 then
    raise exception 'Exact duplicate attestation replay must remain idempotent after wake activation';
  end if;

  -- A registered binding cannot silently switch to a different valid provider conversation.
  v_conflict := false;
  begin
    update public.backroom_input_bindings set provider_conversation_identity_digest=repeat('a',64)
    where id=v_binding_native;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Provider conversation identity must be immutable for a binding'; end if;

  -- An enabled native binding must not lose its provider-conversation digest.
  v_conflict := false;
  begin
    update public.backroom_input_bindings set provider_conversation_identity_digest=null
    where id=v_binding_native;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'An enabled native binding must retain its provider-conversation digest'; end if;

  -- A wake grant is a single, explicit persisted consent state; inconsistent deactivation is forbidden.
  v_conflict := false;
  begin
    update public.backroom_input_bindings set wake_enabled=false where id=v_binding_1;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Disabling wake must clear its grant ID, confirmation and expiry atomically'; end if;

  v_conflict := false;
  begin
    update public.backroom_input_bindings set wake_grant_id=null where id=v_binding_1;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'An enabled wake binding must retain a grant ID'; end if;


  -- Atomic grant lifecycle: only this binding's currently active grant may be
  -- removed, deactivation cancels queued/leased events, and retries are idempotent.
  if has_function_privilege('anon','public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)','EXECUTE') then
    raise exception 'Grant activation RPC privileges are unsafe';
  end if;
  if has_function_privilege('anon','public.deactivate_backroom_wake_grant(text,text,uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.deactivate_backroom_wake_grant(text,text,uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.deactivate_backroom_wake_grant(text,text,uuid,uuid)','EXECUTE') then
    raise exception 'Grant deactivation RPC privileges are unsafe';
  end if;

  if not public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000006'::uuid,300) then
    raise exception 'Retrying the same live grant must be idempotent';
  end if;
  if public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000008'::uuid,300) then
    raise exception 'A different active consent grant must not replace the current grant';
  end if;

  v_first := public.enqueue_backroom_wake_job(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('grant-deactivation-job','UTF8')),'hex'),
    v_owner,v_room,v_participant,v_host_test,'space-1','session-6',repeat('6',64),
    v_binding_6,'target-6','fingerprint-6',1,'grant-deactivation-event',
    '@RMconnects'||chr(10)||'Event: grant-deactivation-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_claim from public.claim_backroom_wake_jobs(
    v_host_test,repeat('6',64),v_binding_6,5,30) limit 1;
  if not found then raise exception 'Grant-deactivation fixture must have a live lease'; end if;

  if not public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000006'::uuid) then
    raise exception 'Current grant must be deactivated';
  end if;
  if not public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000006'::uuid) then
    raise exception 'Repeated same-grant deactivation must be idempotently confirmed';
  end if;
  if exists(select 1 from public.backroom_wake_jobs where binding_id=v_binding_6 and state in ('pending','leased')) then
    raise exception 'Deactivation must cancel pending and leased wakes atomically';
  end if;

  if not public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000008'::uuid,300) then
    raise exception 'A new grant may activate after the previous grant is deactivated';
  end if;
  if public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000006'::uuid) then
    raise exception 'A stale grant must not revoke a new active grant';
  end if;
  if not exists(select 1 from public.backroom_input_bindings where id=v_binding_6
      and wake_enabled=true and wake_grant_id='70000000-0000-4000-8000-000000000008'::uuid) then
    raise exception 'Stale deactivation must preserve the new grant';
  end if;
  if not public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000008'::uuid) then
    raise exception 'New grant must be deactivatable';
  end if;

  -- A locally approved Auto session may extend this still-live MCP handle,
  -- but only to the exact invitation credential's expiry and never past 24 hours.
  update public.rub_minds_mcp_sessions
  set expires_at=pg_catalog.clock_timestamp()+interval '12 hours'
  where session_digest=repeat('6',64);
  if not public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000d'::uuid,86400) then
    raise exception 'A live MCP handle may be extended by the owner explicit 24-hour Auto consent';
  end if;
  if not exists(
    select 1
    from public.rub_minds_mcp_sessions s
    join public.agent_connections ac
      on ac.credential_digest=s.agent_credential_digest
     and ac.room_id=s.room_id
     and ac.participant_id=s.participant_id
     and ac.owner_id=v_owner
    where s.session_digest=repeat('6',64)
      and s.expires_at=ac.expires_at
      and ac.expires_at > pg_catalog.clock_timestamp()+interval '47 hours 59 minutes'
  ) then
    raise exception 'The MCP session must remain valid only until its exact invitation credential expires';
  end if;
  if not public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000d'::uuid) then
    raise exception 'The session-extension grant must be revocable';
  end if;

  -- A different active credential for the same participant cannot extend this session.
  update public.rub_minds_mcp_sessions
  set agent_credential_digest=repeat('9',64)
  where session_digest=repeat('6',64);
  if public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000f'::uuid,86400) then
    raise exception 'Auto must use the exact invitation credential bound to the MCP session';
  end if;
  update public.rub_minds_mcp_sessions
  set agent_credential_digest=repeat('a',64)
  where session_digest=repeat('6',64);
  update public.agent_connections
  set expires_at=pg_catalog.clock_timestamp()+interval '12 hours'
  where room_id=v_room and participant_id=v_participant;
  if public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000e'::uuid,86400) then
    raise exception 'A 24-hour Auto grant must not outlive its AI participant credential';
  end if;
  update public.agent_connections
  set expires_at=pg_catalog.clock_timestamp()+interval '48 hours'
  where room_id=v_room and participant_id=v_participant and credential_digest=repeat('a',64);

  -- The paired owner host lease must outlive the entire Auto consent window.
  if not exists(select 1 from public.backroom_hosts where host_id=v_host_test
      and expires_at > pg_catalog.clock_timestamp()+interval '24 hours') then
    raise exception '24-hour Auto host lease fixture must remain valid for the entire consent window';
  end if;

  -- One explicit Auto consent may persist for up to 24 hours, never longer.
  if not public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000b'::uuid,86400) then
    raise exception 'A new 24-hour Auto grant must activate';
  end if;
  if not exists(select 1 from public.backroom_input_bindings where id=v_binding_6
      and wake_grant_id='70000000-0000-4000-8000-00000000000b'::uuid
      and wake_expires_at > pg_catalog.clock_timestamp()+interval '23 hours 59 minutes'
      and wake_expires_at <= pg_catalog.clock_timestamp()+interval '24 hours') then
    raise exception '24-hour Auto consent expiry must be persisted exactly within its bound';
  end if;

  if not exists(
    select 1
    from public.rub_minds_mcp_sessions s
    join public.agent_connections ac
      on ac.credential_digest=s.agent_credential_digest
     and ac.room_id=s.room_id
     and ac.participant_id=s.participant_id
     and ac.owner_id=v_owner
    where s.session_digest=repeat('6',64)
      and s.expires_at=ac.expires_at
      and ac.expires_at > pg_catalog.clock_timestamp()+interval '47 hours 59 minutes'
  ) then
    raise exception 'Each bounded Auto grant must leave the MCP handle valid until its exact credential expiry';
  end if;
  v_conflict := false;
  begin
    perform public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000c'::uuid,86401);
  exception when others then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Auto consent beyond 24 hours must be rejected'; end if;
  if not public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-00000000000b'::uuid) then
    raise exception '24-hour Auto grant must be revocable';
  end if;

  -- Recovery after a host crash: a stale, expired grant must not block fresh consent.
  update public.backroom_input_bindings
  set wake_enabled=true,wake_grant_id='70000000-0000-4000-8000-000000000009'::uuid,
      wake_last_revoked_grant_id=null,
      confirmed_at=pg_catalog.clock_timestamp()-interval '2 minutes',
      wake_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
  where id=v_binding_6;
  if not public.activate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000010'::uuid,300) then
    raise exception 'A new consent must replace an expired stale grant after host crash';
  end if;
  if not exists(select 1 from public.backroom_input_bindings where id=v_binding_6
      and wake_enabled=true and wake_grant_id='70000000-0000-4000-8000-000000000010'::uuid
      and wake_expires_at>pg_catalog.clock_timestamp()) then
    raise exception 'Expired-grant recovery must install the new grant and fresh expiry';
  end if;
  if public.deactivate_backroom_wake_grant(v_host_test,repeat('6',64),v_binding_6,
      '70000000-0000-4000-8000-000000000009'::uuid) then
    raise exception 'An expired previous grant must not deactivate its replacement';
  end if;

  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.backroom_wake_jobs'::regclass) then
    raise exception 'Backroom wake jobs must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.backroom_wake_jobs','SELECT')
    or has_table_privilege('authenticated','public.backroom_wake_jobs','SELECT')
    or has_table_privilege('anon','public.backroom_wake_jobs','INSERT')
    or has_table_privilege('authenticated','public.backroom_wake_jobs','INSERT') then
    raise exception 'Client roles must not access the durable wake queue directly';
  end if;
  if has_function_privilege('anon','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,uuid,text,text,integer,text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,uuid,text,text,integer,text,text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,uuid,text,text,integer,text,text,integer)','EXECUTE') then
    raise exception 'Enqueue RPC grants are unsafe';
  end if;
  if has_function_privilege('anon','public.claim_backroom_wake_jobs(text,text,uuid,integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.claim_backroom_wake_jobs(text,text,uuid,integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_backroom_wake_jobs(text,text,uuid,integer,integer)','EXECUTE') then
    raise exception 'Claim RPC grants are unsafe';
  end if;
  if has_function_privilege('anon','public.ack_backroom_wake_job(uuid,text,text,uuid,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.ack_backroom_wake_job(uuid,text,text,uuid,text,text)','EXECUTE')
    or not has_function_privilege('service_role','public.ack_backroom_wake_job(uuid,text,text,uuid,text,text)','EXECUTE') then
    raise exception 'Acknowledge RPC grants are unsafe';
  end if;
  if has_function_privilege('anon','public.retry_backroom_wake_job(uuid,text,text,uuid,text,integer,text)','EXECUTE')
    or has_function_privilege('authenticated','public.retry_backroom_wake_job(uuid,text,text,uuid,text,integer,text)','EXECUTE')
    or not has_function_privilege('service_role','public.retry_backroom_wake_job(uuid,text,text,uuid,text,integer,text)','EXECUTE') then
    raise exception 'Retry RPC grants are unsafe';
  end if;
  if has_function_privilege('anon','public.purge_backroom_wake_jobs(integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.purge_backroom_wake_jobs(integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.purge_backroom_wake_jobs(integer,integer)','EXECUTE') then
    raise exception 'Purge RPC grants are unsafe';
  end if;

  -- A format-valid digest is not sufficient: terminated MCP sessions cannot enqueue.
  v_conflict := false;
  begin
    perform public.enqueue_backroom_wake_job(
      repeat('5',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-5',repeat('f',64),
      v_binding_5,'target-5','fingerprint-5',1,'event-5','@RMconnects'||chr(10)||'Event: event-5'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  exception when others then
    if sqlerrm <> 'Active MCP session does not authorize this group participant' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Terminated MCP sessions must not enqueue wake jobs'; end if;

  -- Caller-supplied owner IDs are not trusted; room ownership must match the active session.
  v_conflict := false;
  begin
    perform public.enqueue_backroom_wake_job(
      repeat('8',64),'20000000-0000-0000-0000-000000000098',v_room,v_participant,
      v_host_test,'space-1','session-8',v_session_digest,
      v_binding_1,'target-8','fingerprint-8',1,'event-8',
      '@RMconnects'||chr(10)||'Event: event-8'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  exception when others then
    if sqlerrm <> 'Active MCP session does not authorize this group participant' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'A different room owner must not enqueue wakes for this session'; end if;

  v_first := public.enqueue_backroom_wake_job(
    repeat('1',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-1',v_session_digest,
    v_binding_1,'target-1','fingerprint-1',1,'event-1','@RMconnects'||chr(10)||'Event: event-1'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  v_repeat := public.enqueue_backroom_wake_job(
    repeat('1',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-1',v_session_digest,
    v_binding_1,'target-1','fingerprint-1',1,'event-1','@RMconnects'||chr(10)||'Event: event-1'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  if (v_first->>'created') <> 'true' or (v_repeat->>'created') <> 'false'
    or (v_first->>'job_id') <> (v_repeat->>'job_id') then
    raise exception 'Identical enqueue retries must return the same job idempotently';
  end if;
  begin
    perform public.enqueue_backroom_wake_job(
      repeat('1',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-2',repeat('c',64),
      v_binding_2,'target-2','fingerprint-2',2,'event-1','@RMconnects'||chr(10)||'Event: event-1'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  exception when others then
      if sqlerrm <> 'Wake idempotency key conflicts with a different request' then raise; end if;
      v_conflict := true;
  end;
  if not v_conflict then raise exception 'Same idempotency key with a different prompt must fail'; end if;

  select * into v_claim from public.claim_backroom_wake_jobs(v_host_test,v_session_digest,v_binding_1,5,30) limit 1;
  if not found or v_claim.out_job_id::text <> (v_first->>'job_id')
    or v_claim.out_attempt_count <> 1 or v_claim.out_lease_token is null
    or v_claim.out_target_identity_fingerprint <> 'fingerprint-1'
    or v_claim.out_prompt_digest <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_claim.out_prompt,'UTF8')),'hex') then
    raise exception 'Claim must return the job and a one-shot lease token';
  end if;

  if has_function_privilege('anon','public.claim_backroom_wake_jobs_with_provider_identity(text,text,uuid,integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.claim_backroom_wake_jobs_with_provider_identity(text,text,uuid,integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_backroom_wake_jobs_with_provider_identity(text,text,uuid,integer,integer)','EXECUTE') then
    raise exception 'Provider-aware claim wrapper privileges are unsafe';
  end if;
  v_native_job := public.enqueue_backroom_wake_job(
    repeat('8',64),v_owner,v_room,v_participant,v_host_test,'space-native','session-native',repeat('8',64),
    v_binding_native,'target-native','fingerprint-native',1,'native-provider-event',
    '@RMconnects'||chr(10)||'Event: native-provider-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  if not exists(select 1 from public.backroom_wake_jobs j
      where j.id=(v_native_job->>'job_id')::uuid
        and j.provider_conversation_identity_digest=v_native_provider_digest) then
    raise exception 'Queue trigger must copy the exact binding provider-conversation digest';
  end if;
  select * into v_native_claim from public.claim_backroom_wake_jobs_with_provider_identity(
    v_host_test,repeat('8',64),v_binding_native,5,30) limit 1;
  if not found or v_native_claim.out_job_id::text<>(v_native_job->>'job_id')
    or v_native_claim.out_provider_conversation_identity_digest<>v_native_provider_digest then
    raise exception 'Provider-aware claim must return the exact native conversation digest';
  end if;
  if has_function_privilege('anon','public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)','EXECUTE')
    or (select p.prosecdef from pg_catalog.pg_proc p
      where p.oid='public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)'::regprocedure) then
    raise exception 'Native result settlement must be service-role only';
  end if;

  v_native_result := jsonb_build_object(
    'version',1,'kind','native_wake_result','handoffId',v_native_handoff::text,
    'jobId',v_native_claim.out_job_id::text,'deviceId',v_native_device::text,
    'roomId',v_room::text,'screenSessionId',v_native_screen_session::text,
    'bindingId',v_binding_native::text,'targetId','target-native','targetRevision',1,
    'state','submitted','promptInserted',true,'sendInvoked',true,'composerCleared',true,
    'promptReadbackVerified',true,'composerIdentityRevalidated',true,
    'sendControlIdentityRevalidated',true,
    'composerIdentityDigest',repeat('a',64),'sendControlIdentityDigest',repeat('b',64),
    'providerConversationIdentityRevalidated',true,
    'providerConversationIdentityDigest',v_native_provider_digest
  );
  -- SQL is an independent trust boundary: JSON nulls must not pass through
  -- PL/pgSQL three-valued comparisons as an apparently valid native result.
  foreach v_bad_native_result in array array[
    v_native_result || jsonb_build_object('state',null),
    v_native_result || jsonb_build_object('promptInserted',null),
    v_native_result || jsonb_build_object('roomId',null)
  ] loop
    v_rejected := false;
    v_error_message := null;
    begin
      perform public.settle_backroom_android_native_wake_result(
        v_native_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_claim.out_lease_token,'UTF8')),'hex'),
        v_native_handoff,v_native_device,v_native_screen_session,'target-native',1,
        repeat('a',64),repeat('b',64),v_native_provider_digest,v_bad_native_result
      );
    exception when others then
      get stacked diagnostics v_error_message = message_text;
      v_rejected := v_error_message = 'Invalid native wake result evidence';
    end;
    if not v_rejected then
      raise exception 'Native settlement must reject JSON null for required result fields';
    end if;
    if not exists(select 1 from public.backroom_wake_jobs j
        where j.id=v_native_claim.out_job_id and j.state='leased'
          and j.lease_token_hash=pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(v_native_claim.out_lease_token,'UTF8')),'hex')) then
      raise exception 'Rejected null evidence must leave the original lease untouched';
    end if;
  end loop;

  v_native_settlement := public.settle_backroom_android_native_wake_result(
    v_native_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_claim.out_lease_token,'UTF8')),'hex'),
    v_native_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_native_result
  );
  if v_native_settlement<>'acknowledged'
    or not exists(select 1 from public.backroom_wake_jobs j
      where j.id=v_native_claim.out_job_id and j.state='acknowledged'
        and j.lease_token_hash is null and j.native_result_payload=v_native_result
        and j.native_result_at is not null) then
    raise exception 'A proven Android Send must settle the original group job as acknowledged';
  end if;
  if public.settle_backroom_android_native_wake_result(
    v_native_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_native_claim.out_lease_token,'UTF8')),'hex'),
    v_native_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_native_result
  )<>'replayed' then
    raise exception 'Duplicate native result ACK must be idempotent';
  end if;

  -- A preflight denial proves no insertion and no Send; only this outcome may retry.
  v_preflight_job := public.enqueue_backroom_wake_job(
    repeat('4',64),v_owner,v_room,v_participant,v_host_test,'space-native','session-native',repeat('8',64),
    v_binding_native,'target-native','fingerprint-native',1,'native-preflight-event',
    '@RMconnects'||chr(10)||'Event: native-preflight-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_preflight_claim from public.claim_backroom_wake_jobs_with_provider_identity(
    v_host_test,repeat('8',64),v_binding_native,5,30) limit 1;
  if not found or v_preflight_claim.out_job_id::text<>(v_preflight_job->>'job_id') then
    raise exception 'Preflight test must claim the next native job';
  end if;
  v_preflight_result:=jsonb_build_object(
    'version',1,'kind','native_wake_result','handoffId',v_preflight_handoff::text,
    'jobId',v_preflight_claim.out_job_id::text,'deviceId',v_native_device::text,
    'roomId',v_room::text,'screenSessionId',v_native_screen_session::text,
    'bindingId',v_binding_native::text,'targetId','target-native','targetRevision',1,
    'state','preflight_denied','promptInserted',false,'sendInvoked',false,
    'composerCleared',false,'reason','permission_denied'
  );
  if public.settle_backroom_android_native_wake_result(
    v_preflight_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_preflight_claim.out_lease_token,'UTF8')),'hex'),
    v_preflight_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_preflight_result
  )<>'pending' or not exists(select 1 from public.backroom_wake_jobs j
    where j.id=v_preflight_claim.out_job_id and j.state='pending'
      and j.last_error_code='approval_required' and j.lease_token_hash is null
      and j.native_result_payload=v_preflight_result) then
    raise exception 'A proven no-effect permission denial must be returned to bounded retry';
  end if;

  -- A later attempt may settle this same job, but must not overwrite the
  -- first handoff receipt: a delayed exact ACK from that attempt stays replayable.
  update public.backroom_wake_jobs
  set available_at=pg_catalog.clock_timestamp()-interval '1 second'
  where id=v_preflight_claim.out_job_id and state='pending';
  select * into v_preflight_retry_claim from public.claim_backroom_wake_jobs_with_provider_identity(
    v_host_test,repeat('8',64),v_binding_native,5,30) limit 1;
  if not found or v_preflight_retry_claim.out_job_id<>v_preflight_claim.out_job_id then
    raise exception 'Preflight retry must reclaim the same durable job';
  end if;
  v_preflight_retry_result:=jsonb_build_object(
    'version',1,'kind','native_wake_result','handoffId',v_preflight_retry_handoff::text,
    'jobId',v_preflight_retry_claim.out_job_id::text,'deviceId',v_native_device::text,
    'roomId',v_room::text,'screenSessionId',v_native_screen_session::text,
    'bindingId',v_binding_native::text,'targetId','target-native','targetRevision',1,
    'state','needs_review','promptInserted',false,'sendInvoked',false,
    'composerCleared',false,'reason','device_disconnected'
  );
  if public.settle_backroom_android_native_wake_result(
    v_preflight_retry_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_preflight_retry_claim.out_lease_token,'UTF8')),'hex'),
    v_preflight_retry_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_preflight_retry_result
  )<>'failed' or not exists(select 1 from public.backroom_wake_jobs j
    where j.id=v_preflight_retry_claim.out_job_id and j.state='failed'
      and pg_catalog.jsonb_array_length(j.native_result_receipts)=2
      and j.native_result_payload=v_preflight_retry_result) then
    raise exception 'The later uncertain attempt must settle while retaining both handoff receipts';
  end if;
  if public.settle_backroom_android_native_wake_result(
    v_preflight_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_preflight_claim.out_lease_token,'UTF8')),'hex'),
    v_preflight_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_preflight_result
  )<>'replayed' then
    raise exception 'A delayed duplicate ACK must replay after a later retry has settled';
  end if;

  -- Reusing one handoff ID with altered evidence is a conflict, not a replay.
  v_bad_native_result:=v_preflight_result || jsonb_build_object('reason','other');
  v_rejected:=false;
  v_error_message:=null;
  begin
    perform public.settle_backroom_android_native_wake_result(
      v_preflight_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_preflight_claim.out_lease_token,'UTF8')),'hex'),
      v_preflight_handoff,v_native_device,v_native_screen_session,'target-native',1,
      repeat('a',64),repeat('b',64),v_native_provider_digest,v_bad_native_result
    );
  exception when others then
    get stacked diagnostics v_error_message = message_text;
    v_rejected := v_error_message = 'Conflicting native wake result for a previously settled handoff';
  end;
  if not v_rejected then
    raise exception 'A native handoff must not be reused with different result evidence';
  end if;

  -- A post-effect uncertain result is terminal and must never be replayed automatically.
  v_review_job:=public.enqueue_backroom_wake_job(
    repeat('3',64),v_owner,v_room,v_participant,v_host_test,'space-native','session-native',repeat('8',64),
    v_binding_native,'target-native','fingerprint-native',1,'native-review-event',
    '@RMconnects'||chr(10)||'Event: native-review-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_review_claim from public.claim_backroom_wake_jobs_with_provider_identity(
    v_host_test,repeat('8',64),v_binding_native,5,30) limit 1;
  if not found or v_review_claim.out_job_id::text<>(v_review_job->>'job_id') then
    raise exception 'Review test must claim the next native job';
  end if;
  v_review_result:=jsonb_build_object(
    'version',1,'kind','native_wake_result','handoffId',v_review_handoff::text,
    'jobId',v_review_claim.out_job_id::text,'deviceId',v_native_device::text,
    'roomId',v_room::text,'screenSessionId',v_native_screen_session::text,
    'bindingId',v_binding_native::text,'targetId','target-native','targetRevision',1,
    'state','needs_review','promptInserted',true,'sendInvoked',false,
    'composerCleared',false,'reason','outcome_unknown'
  );
  if public.settle_backroom_android_native_wake_result(
    v_review_claim.out_job_id,v_host_test,repeat('8',64),v_binding_native,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_review_claim.out_lease_token,'UTF8')),'hex'),
    v_review_handoff,v_native_device,v_native_screen_session,'target-native',1,
    repeat('a',64),repeat('b',64),v_native_provider_digest,v_review_result
  )<>'failed' or not exists(select 1 from public.backroom_wake_jobs j
    where j.id=v_review_claim.out_job_id and j.state='failed'
      and j.last_error_code='result_unconfirmed' and j.lease_token_hash is null
      and j.native_result_payload=v_review_result) then
    raise exception 'Uncertain native effect must be terminal review, never replayed';
  end if;

  -- The durable job's provider identity is immutable after enqueue.
  v_conflict := false;
  begin
    update public.backroom_wake_jobs
    set provider_conversation_identity_digest=repeat('8',64)
    where id=(v_native_job->>'job_id')::uuid;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then
    raise exception 'A queued native wake must not be retargeted to another provider conversation';
  end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(v_host_test,v_session_digest,v_binding_1,5,30);
  if v_count <> 0 then raise exception 'An active lease must prevent duplicate concurrent claims'; end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(v_host_wrong,v_session_digest,v_binding_1,5,30);
  if v_count <> 0 then raise exception 'A different host must not claim this job'; end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(v_host_test,repeat('c',64),v_binding_2,5,30);
  if v_count <> 0 then raise exception 'A different session digest must not claim this job'; end if;

  if public.ack_backroom_wake_job(v_claim.out_job_id,v_host_test,v_session_digest,v_binding_1,'00000000-0000-0000-0000-000000000000','acknowledged') then
    raise exception 'Incorrect lease token must not acknowledge a job';
  end if;
  if not public.ack_backroom_wake_job(v_claim.out_job_id,v_host_test,v_session_digest,v_binding_1,v_claim.out_lease_token,'acknowledged') then
    raise exception 'Valid lease token should acknowledge the claimed job';
  end if;
  if public.ack_backroom_wake_job(v_claim.out_job_id,v_host_test,v_session_digest,v_binding_1,v_claim.out_lease_token,'acknowledged') then
    raise exception 'Acknowledgement replay must fail';
  end if;

  v_retry_job := public.enqueue_backroom_wake_job(
    repeat('2',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-2',repeat('c',64),
    v_binding_2,'target-2','fingerprint-2',2,'event-2','@RMconnects'||chr(10)||'Event: event-2'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_claim_retry from public.claim_backroom_wake_jobs(v_host_test,repeat('c',64),v_binding_2,1,30) limit 1;
  if not found or v_claim_retry.out_job_id::text <> (v_retry_job->>'job_id') then
    raise exception 'Expected the second session job to be claimed';
  end if;
  v_retry_state := public.retry_backroom_wake_job(
    v_claim_retry.out_job_id,v_host_test,repeat('c',64),v_binding_2,v_claim_retry.out_lease_token,1,'transport_error');
  if v_retry_state <> 'pending' then raise exception 'A retryable failure should return to pending'; end if;
  update public.backroom_wake_jobs set available_at=pg_catalog.clock_timestamp()-interval '1 second' where id=v_claim_retry.out_job_id;
  select * into v_claim_retry from public.claim_backroom_wake_jobs(v_host_test,repeat('c',64),v_binding_2,1,30) limit 1;
  if not found or v_claim_retry.out_attempt_count <> 2 then raise exception 'Retry should be reclaimable and increment attempts'; end if;
  if not public.ack_backroom_wake_job(v_claim_retry.out_job_id,v_host_test,repeat('c',64),v_binding_2,v_claim_retry.out_lease_token,'ignored') then
    raise exception 'A valid ignored outcome should acknowledge the event cursor';
  end if;

  -- Revocation between claim and acknowledgement invalidates the outstanding lease.
  v_retry_job := public.enqueue_backroom_wake_job(
    repeat('6',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-6',repeat('6',64),
    v_binding_6,'target-6','fingerprint-6',1,'event-6','@RMconnects'||chr(10)||'Event: event-6'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_claim_retry from public.claim_backroom_wake_jobs(v_host_test,repeat('6',64),v_binding_6,1,30) limit 1;
  if not found then raise exception 'Expected the revocation-test lease to be claimed'; end if;
  update public.agent_connections set revoked_at=pg_catalog.clock_timestamp() where participant_id=v_participant;
  v_conflict := false;
  begin
    perform public.enqueue_backroom_wake_job(
      repeat('9',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-6',repeat('6',64),
      v_binding_6,'target-6','fingerprint-6',1,'event-9',
      '@RMconnects'||chr(10)||'Event: event-9'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  exception when others then
    if sqlerrm <> 'Active MCP session does not authorize this group participant' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Revoked agent connections must not enqueue wakes'; end if;
  v_ok := public.ack_backroom_wake_job(v_claim_retry.out_job_id,v_host_test,repeat('6',64),v_binding_6,v_claim_retry.out_lease_token,'acknowledged');
  if v_ok then raise exception 'Revoked agent connections must not acknowledge outstanding leases'; end if;
  update public.agent_connections set revoked_at=null where participant_id=v_participant;
  -- Session6 termination is exercised below through the atomic MCP Leave RPC.

  v_cancel_job := public.enqueue_backroom_wake_job(
    repeat('3',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-3',repeat('d',64),
    v_binding_3,'target-3','fingerprint-3',1,'event-3','@RMconnects'||chr(10)||'Event: event-3'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  if public.cancel_backroom_wake_job((v_cancel_job->>'job_id')::uuid,'20000000-0000-0000-0000-000000000098') then
    raise exception 'A different owner must not cancel a wake';
  end if;
  if not public.cancel_backroom_wake_job((v_cancel_job->>'job_id')::uuid,v_owner) then
    raise exception 'The owner should be able to cancel a pending wake';
  end if;
  if public.cancel_backroom_wake_job((v_cancel_job->>'job_id')::uuid,v_owner) then
    raise exception 'Cancelled wake replay should be idempotently refused';
  end if;

  v_expire_job := public.enqueue_backroom_wake_job(
    repeat('4',64),v_owner,v_room,v_participant,v_host_test,'space-1','session-4',repeat('e',64),
    v_binding_4,'target-4','fingerprint-4',1,'event-4','@RMconnects'||chr(10)||'Event: event-4'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  update public.rub_minds_mcp_sessions set terminated_at=pg_catalog.clock_timestamp() where session_digest=repeat('e',64);
  select count(*) into v_count from public.claim_backroom_wake_jobs(v_host_test,repeat('e',64),v_binding_4,5,30);
  if v_count <> 0 then raise exception 'Terminated MCP sessions must not claim queued wake jobs'; end if;
  update public.backroom_wake_jobs set expires_at=pg_catalog.clock_timestamp()-interval '1 second'
    where id=(v_expire_job->>'job_id')::uuid;
  if public.expire_backroom_wake_jobs() < 1 then raise exception 'Expiry function should expire overdue jobs'; end if;
  if (select state from public.backroom_wake_jobs where id=(v_expire_job->>'job_id')::uuid) <> 'expired' then
    raise exception 'Expired job must not remain dispatchable';
  end if;

  -- Queue capacity is enforced per active MCP session but idempotent retries still work at capacity.
  for i in 1..100 loop
    v_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('capacity-key-'||i::text,'UTF8')),'hex');
    v_cancel_job := public.enqueue_backroom_wake_job(
      v_key,v_owner,v_room,v_participant,v_host_capacity,'space-capacity','session-capacity',repeat('7',64),
      v_binding_7,'target-capacity','fingerprint-capacity',1,'capacity-event-'||i::text,
      '@RMconnects'||chr(10)||'Event: capacity-event-'||i::text||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
    if i = 1 then v_capacity_first := v_cancel_job; end if;
    if mod(i,6)=0 then
      -- Age the rate-limit window but retain pending rows so this loop isolates backlog capacity.
      update public.backroom_wake_jobs
      set created_at=pg_catalog.clock_timestamp()-interval '2 minutes'
      where binding_id=v_binding_7;
    end if;
  end loop;
  v_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('capacity-key-1','UTF8')),'hex');
  v_repeat := public.enqueue_backroom_wake_job(
    v_key,v_owner,v_room,v_participant,v_host_capacity,'space-capacity','session-capacity',repeat('7',64),
    v_binding_7,'target-capacity','fingerprint-capacity',1,'capacity-event-1',
    '@RMconnects'||chr(10)||'Event: capacity-event-1'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  if (v_repeat->>'created') <> 'false' or (v_repeat->>'job_id') <> (v_capacity_first->>'job_id') then
    raise exception 'Idempotent retry must work at queue capacity';
  end if;
  v_conflict := false;
  begin
    perform public.enqueue_backroom_wake_job(
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('capacity-key-101','UTF8')),'hex'),
      v_owner,v_room,v_participant,v_host_capacity,'space-capacity','session-capacity',repeat('7',64),
      v_binding_7,'target-capacity','fingerprint-capacity',1,'capacity-event-101',
      '@RMconnects'||chr(10)||'Event: capacity-event-101'||chr(10)||'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  exception when others then
    if sqlerrm <> 'Backroom wake queue is full for this input binding' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Session queue capacity must reject a 101st active wake'; end if;

  update public.backroom_wake_jobs
  set state='expired', created_at=pg_catalog.clock_timestamp()-interval '30 days',
      expires_at=pg_catalog.clock_timestamp()-interval '1 day'
  where session_digest=repeat('7',64);
  v_purge_count := public.purge_backroom_wake_jobs(14,1000);
  if v_purge_count < 100 then raise exception 'Terminal retention purge should delete at least 100 old jobs'; end if;
  select count(*) into v_count from public.backroom_wake_jobs where session_digest=repeat('7',64);
  if v_count <> 0 then raise exception 'Purge must remove old terminal queue records'; end if;
  -- Real message inserts create one canonical wake only for a matching, consented binding.
  insert into public.rooms(id,owner_id,title)
  values (v_trigger_room,v_owner,'Wake trigger integration room');
  insert into public.participants(id,room_id,user_id,display_name,kind,status)
  values
    (v_trigger_ai,v_trigger_room,null,'TestAI','external_agent','connected'),
    (v_trigger_human,v_trigger_room,v_owner,'TestHuman','human','connected');
  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at)
  values (v_trigger_room,v_trigger_ai,v_owner,repeat('8',64),pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,agent_credential_digest,room_id,participant_id,expires_at,terminated_at)
  values (repeat('8',64),'ci-ciphertext-trigger',repeat('8',64),v_trigger_room,v_trigger_ai,pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.backroom_input_bindings(
    id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,
    target_identity_fingerprint,target_revision,surface,locator_kind,locator_value,participation_mode,
    wake_enabled,wake_grant_id,wake_expires_at,max_wakes_per_minute,confirmed_at,revoked_at
  ) values (
    v_trigger_binding,v_owner,v_trigger_room,v_trigger_ai,v_host_test,repeat('8',64),
    'space-trigger','session-trigger','target-trigger','fingerprint-trigger',1,'browser_tab','dom',
    'composer-trigger','mentions',true,'70000000-0000-4000-8000-000000000008'::uuid,
    pg_catalog.clock_timestamp()+interval '1 hour',6,pg_catalog.clock_timestamp(),null
  );

  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'Hey @TestAI, can you help?')
  returning id into v_trigger_message;
  select count(*) into v_count from public.backroom_wake_jobs
    where room_id=v_trigger_room and participant_id=v_trigger_ai and event_id=v_trigger_message::text;
  if v_count <> 1 then raise exception 'A matching @mention must enqueue exactly one wake'; end if;
  if (select prompt from public.backroom_wake_jobs where room_id=v_trigger_room and event_id=v_trigger_message::text)
    <> '@RMconnects'||pg_catalog.chr(10)||'Event: '||v_trigger_message::text||pg_catalog.chr(10)||
       'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.' then
    raise exception 'Message trigger must enqueue only the canonical prompt, not message body';
  end if;

  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'A regular unmentioned update');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 1 then raise exception 'Mentions mode must ignore unaddressed messages'; end if;

  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_ai,'@TestAI this is my own response');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 1 then raise exception 'AI messages must never wake the same participant'; end if;

  -- Whole-token mention validation must reject email fragments but continue to later valid mentions.
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'email@TestAI must not match a mention');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 1 then raise exception 'A mention embedded in an email fragment must be ignored'; end if;
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'email@TestAI followed by a valid @TestAI mention');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 2 then raise exception 'A later whole-name mention must be found after an invalid occurrence'; end if;

  update public.backroom_input_bindings set participation_mode='smart' where id=v_trigger_binding;
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'A regular smart-mode update');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 3 then raise exception 'Smart mode must enqueue unmentioned human messages'; end if;

  -- An AI participant's ordinary smart-mode message cannot propagate a wake storm.
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_ai,'AI output that should not fan out in smart mode');
  select count(*) into v_count from public.backroom_wake_jobs
  where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 3 then raise exception 'Smart mode must not amplify an AI participant own output'; end if;

  update public.backroom_input_bindings set participation_mode='task' where id=v_trigger_binding;
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'Task mode must wait for task events');
  select count(*) into v_count from public.backroom_wake_jobs where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 3 then raise exception 'Task mode must not react to ordinary message inserts'; end if;

  -- The per-binding limiter caps six wakes/minute, while a seventh message still commits.
  update public.backroom_input_bindings set participation_mode='mentions' where id=v_trigger_binding;
  for i in 1..3 loop
    insert into public.messages(room_id,sender_id,body)
    values (v_trigger_room,v_trigger_human,'@TestAI additional wake '||i::text);
  end loop;
  select count(*) into v_count from public.backroom_wake_jobs
    where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 6 then raise exception 'Expected six wakes within one minute'; end if;
  insert into public.messages(room_id,sender_id,body)
  values (v_trigger_room,v_trigger_human,'@TestAI beyond the wake rate limit')
  returning id into v_trigger_message;
  select count(*) into v_count from public.backroom_wake_jobs
    where room_id=v_trigger_room and participant_id=v_trigger_ai;
  if v_count <> 6 then raise exception 'Per-binding rate limit must refuse the seventh wake'; end if;
  if not exists (select 1 from public.messages where id=v_trigger_message) then
    raise exception 'Wake throttling must never roll back a human-authored message';
  end if;


  -- Input binding revocation is owner-scoped; the host and its other bindings remain usable.
  if has_function_privilege('anon','public.revoke_backroom_input_binding(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.revoke_backroom_input_binding(uuid,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.revoke_backroom_input_binding(uuid,uuid)','EXECUTE') then
    raise exception 'Input binding revocation RPC grants are unsafe';
  end if;

  v_first := public.enqueue_backroom_wake_job(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('revoke-binding-job','UTF8')),'hex'),
    v_owner,v_room,v_participant,v_host_test,'space-1','session-1',repeat('b',64),
    v_binding_1,'target-1','fingerprint-1',1,'revoke-binding-event',
    '@RMconnects'||chr(10)||'Event: revoke-binding-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_claim from public.claim_backroom_wake_jobs(
    v_host_test,repeat('b',64),v_binding_1,5,30) limit 1;
  if not found then raise exception 'Binding revoke fixture must have an active lease'; end if;
  if public.revoke_backroom_input_binding(v_binding_1,'20000000-0000-0000-0000-000000000098') then
    raise exception 'Different owner must not revoke an input binding';
  end if;
  if not public.revoke_backroom_input_binding(v_binding_1,v_owner) then
    raise exception 'Owner must be able to revoke their input binding';
  end if;
  if not public.revoke_backroom_input_binding(v_binding_1,v_owner) then
    raise exception 'Repeated input binding revocation should be idempotently confirmed';
  end if;
  if exists(select 1 from public.backroom_input_bindings where id=v_binding_1 and
    (revoked_at is null or wake_enabled or wake_grant_id is not null or confirmed_at is not null or wake_expires_at is not null)) then
    raise exception 'Input revocation must clear consent and revoke only this binding';
  end if;
  if exists(select 1 from public.backroom_wake_jobs where binding_id=v_binding_1 and state in ('pending','leased')) then
    raise exception 'Input revocation must cancel its pending and leased wakes';
  end if;
  if public.ack_backroom_wake_job(v_claim.out_job_id,v_host_test,repeat('b',64),v_binding_1,v_claim.out_lease_token,'acknowledged') then
    raise exception 'Binding revocation must invalidate its outstanding lease';
  end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(
    v_host_test,repeat('b',64),v_binding_1,5,30);
  if v_count <> 0 then raise exception 'Revoked input binding must not claim further jobs'; end if;
  if not exists(select 1 from public.backroom_hosts where host_id=v_host_test and revoked_at is null) then
    raise exception 'Input binding revocation must not revoke the entire host';
  end if;
  if not exists(select 1 from public.backroom_input_bindings where id=v_binding_2 and revoked_at is null) then
    raise exception 'Input binding revocation must not revoke sibling bindings';
  end if;

  -- Host revocation is owner-scoped and atomically cancels a leased job and every active binding.
  if has_function_privilege('anon','public.revoke_backroom_host(text,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.revoke_backroom_host(text,uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.revoke_backroom_host(text,uuid)','EXECUTE') then
    raise exception 'Host revocation RPC grants are unsafe';
  end if;

  v_first := public.enqueue_backroom_wake_job(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('revoke-host-job','UTF8')),'hex'),
    v_owner,v_room,v_participant,v_host_capacity,'space-capacity','session-capacity',
    repeat('7',64),v_binding_7,'target-capacity','fingerprint-capacity',1,'revoke-event',
    '@RMconnects'||chr(10)||'Event: revoke-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  select * into v_claim from public.claim_backroom_wake_jobs(
    v_host_capacity,repeat('7',64),v_binding_7,5,30) limit 1;
  if not found then raise exception 'Revoke fixture must have an active lease'; end if;
  if not public.revoke_backroom_host(v_host_capacity,v_owner) then
    raise exception 'Owner must be able to revoke their active host';
  end if;
  if not public.revoke_backroom_host(v_host_capacity,v_owner) then
    raise exception 'Repeated same-owner host revocation must be idempotently confirmed';
  end if;
  if exists(select 1 from public.backroom_hosts where host_id=v_host_capacity and revoked_at is null) then
    raise exception 'Revoked host must not claim more jobs';
  end if;
  if exists(select 1 from public.backroom_input_bindings where host_id=v_host_capacity and
    (revoked_at is null or wake_enabled or wake_grant_id is not null or confirmed_at is not null or wake_expires_at is not null)) then
    raise exception 'Host revocation must atomically remove every live wake consent';
  end if;
  if exists(select 1 from public.backroom_wake_jobs where host_id=v_host_capacity and state in ('pending','leased')) then
    raise exception 'Host revocation must cancel all queued or leased jobs';
  end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(
    v_host_capacity,repeat('7',64),v_binding_7,5,30);
  if v_count <> 0 then raise exception 'A revoked host must not reclaim cancelled wakes'; end if;

  -- MCP Leave is a full consent revocation boundary, including a leased trigger.
  v_first := public.enqueue_backroom_wake_job(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('leave-pending','UTF8')),'hex'),
    v_owner,v_room,v_participant,v_host_test,'space-1','session-6',repeat('6',64),
    v_binding_6,'target-6','fingerprint-6',1,'leave-pending-event',
    '@RMconnects'||chr(10)||'Event: leave-pending-event'||chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.',3600);
  insert into public.rub_minds_mcp_bridge_state(session_digest,room_id,participant_id)
  values (repeat('6',64),v_room,v_participant);
  select public.terminate_rub_minds_mcp_bridge_session(
    repeat('6',64),'ci-ciphertext-6',repeat('a',64),
    pg_catalog.clock_timestamp()+interval '24 hours'
  ) into v_first;
  if (v_first->>'terminated') <> 'true' or (v_first->>'already_terminated') <> 'false' then
    raise exception 'MCP Leave must atomically terminate the exact joined session';
  end if;
  if exists(select 1 from public.backroom_input_bindings
      where room_id=v_room and participant_id=v_participant
        and (revoked_at is null or wake_enabled or wake_grant_id is not null
          or confirmed_at is not null or wake_expires_at is not null)) then
    raise exception 'MCP Leave must revoke every Backroom input binding for the participant';
  end if;
  if exists(select 1 from public.backroom_android_native_bindings n
      join public.backroom_input_bindings b on b.id=n.binding_id
      where b.room_id=v_room and b.participant_id=v_participant and n.revoked_at is null) then
    raise exception 'MCP Leave must revoke every device-attested Android group binding';
  end if;
  if not exists(select 1 from public.backroom_android_native_bindings n
      where n.id=v_native_mapping_retry_id and n.revoked_at is not null) then
    raise exception 'MCP Leave must revoke a live Android native mapping for the exact group AI';
  end if;
  if exists(select 1 from public.backroom_wake_jobs
      where room_id=v_room and participant_id=v_participant and state in ('pending','leased')) then
    raise exception 'MCP Leave must cancel pending and leased Backroom triggers';
  end if;
  if exists(select 1 from public.backroom_wake_jobs
      where id=(v_retry_job->>'job_id')::uuid and state<>'cancelled') then
    raise exception 'MCP Leave must cancel an already leased trigger';
  end if;
  if exists(select 1 from public.rub_minds_mcp_bridge_state where session_digest=repeat('6',64)) then
    raise exception 'MCP Leave must clear its private cursor and pending-response state';
  end if;
  if exists(select 1 from public.agent_connections where credential_digest=repeat('a',64) and revoked_at is null) then
    raise exception 'MCP Leave must revoke the participant credential';
  end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs(
    v_host_test,repeat('6',64),v_binding_6,5,30);
  if v_count <> 0 then raise exception 'A participant who left must not claim more wakes'; end if;
  select public.terminate_rub_minds_mcp_bridge_session(
    repeat('6',64),null,null,pg_catalog.clock_timestamp()+interval '24 hours'
  ) into v_first;
  if (v_first->>'terminated') <> 'true' or (v_first->>'already_terminated') <> 'true' then
    raise exception 'Repeated MCP Leave must idempotently confirm and preserve revocation';
  end if;

end;
$test$;
