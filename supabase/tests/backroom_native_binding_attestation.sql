-- Device-attested Android native binding integration contract.
-- Run after the durable wake queue, provider-identity queue and native attestation migrations.
do $test$
declare
  v_owner uuid := '90000000-0000-4000-8000-000000000001';
  v_room uuid := '90000000-0000-4000-8000-000000000001';
  v_participant uuid := '90000000-0000-4000-8000-000000000001';
  v_host text := '90000000-0000-4000-8000-000000000001';
  v_device uuid := '90000000-0000-4000-8000-000000000001';
  v_screen uuid := '90000000-0000-4000-8000-000000000001';
  v_intent uuid := '90000000-0000-4000-8000-000000000002';
  v_session_digest text := repeat('d',64);
  v_signer text := repeat('f',64);
  v_composer text := repeat('a',64);
  v_send text := repeat('b',64);
  v_provider text := repeat('c',64);
  v_binding uuid;
  v_conflict boolean := false;
  v_row record;
begin
  insert into auth.users(id) values (v_owner);
  insert into public.rooms(id,owner_id,title) values (v_room,v_owner,'Native binding attestation test room');
  insert into public.participants(id,room_id,display_name,kind,status)
    values (v_participant,v_room,'Native test AI','external_agent','active');
  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at)
    values (v_room,v_participant,v_owner,repeat('e',64),pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(
    session_digest,agent_credential_ciphertext,room_id,participant_id,expires_at,terminated_at
  ) values (
    v_session_digest,'native-test-ciphertext',v_room,v_participant,
    pg_catalog.clock_timestamp()+interval '1 hour',null
  );
  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at,revoked_at)
    values (v_host,v_owner,repeat('9',64),pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.backroom_devices(device_id,owner_id,platform,status,revoked_at)
    values (v_device,v_owner,'android','active',null);
  insert into public.backroom_device_room_bindings(device_id,room_id,owner_id,revoked_at)
    values (v_device,v_room,v_owner,null);
  insert into public.backroom_desktop_sessions(
    session_id,device_id,room_id,session_type,status,expires_at
  ) values (
    v_screen,v_device,v_room,'screen','active',pg_catalog.clock_timestamp()+interval '2 minutes'
  );
  insert into public.backroom_device_apps(device_id,package_name,signing_certificate_sha256)
    values (v_device,'com.example.ai',v_signer);
  insert into public.backroom_native_binding_intents(
    id,owner_id,room_id,participant_id,host_id,session_digest,device_id,screen_session_id,
    app_package_name,signing_certificate_sha256,participation_mode,max_wakes_per_minute,expires_at
  ) values (
    v_intent,v_owner,v_room,v_participant,v_host,v_session_digest,v_device,v_screen,
    'com.example.ai',v_signer,'mentions',6,pg_catalog.clock_timestamp()+interval '2 minutes'
  );

  if not (select relrowsecurity from pg_catalog.pg_class
      where oid='public.backroom_native_binding_intents'::regclass) then
    raise exception 'Native binding intents must have RLS enabled';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class
      where oid='public.backroom_native_input_targets'::regclass) then
    raise exception 'Native input target evidence must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.backroom_native_binding_intents','SELECT')
    or has_table_privilege('authenticated','public.backroom_native_binding_intents','SELECT')
    or has_table_privilege('anon','public.backroom_native_input_targets','SELECT')
    or has_table_privilege('authenticated','public.backroom_native_input_targets','SELECT') then
    raise exception 'Client roles must not read native binding intent or target evidence';
  end if;
  if has_function_privilege('anon',
      'public.register_backroom_native_input_binding_from_device(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated',
      'public.register_backroom_native_input_binding_from_device(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
    or not has_function_privilege('service_role',
      'public.register_backroom_native_input_binding_from_device(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE') then
    raise exception 'Device binding registration RPC grants are unsafe';
  end if;

  v_binding := public.register_backroom_native_input_binding_from_device(
    v_intent,v_device,v_screen,'com.example.ai',v_signer,v_composer,v_send,v_provider
  );

  select * into v_row from public.backroom_input_bindings where id=v_binding;
  if not found or v_row.owner_id<>v_owner or v_row.room_id<>v_room
    or v_row.participant_id<>v_participant or v_row.host_id<>v_host
    or v_row.session_digest<>v_session_digest or v_row.surface<>'android_app'
    or v_row.participation_mode<>'mentions'
    or v_row.provider_conversation_identity_digest<>v_provider
    or v_row.wake_enabled is distinct from false
    or v_row.wake_grant_id is not null or v_row.confirmed_at is not null
    or v_row.wake_expires_at is not null then
    raise exception 'Device-attested binding must retain exact AI/device identity and remain wake-disabled';
  end if;

  if not exists (
    select 1 from public.backroom_native_input_targets t
    where t.binding_id=v_binding and t.device_id=v_device
      and t.screen_session_id=v_screen and t.app_package_name='com.example.ai'
      and t.signing_certificate_sha256=v_signer
      and t.composer_target_id=v_composer and t.send_control_target_id=v_send
      and t.provider_conversation_identity_digest=v_provider
  ) then
    raise exception 'Private native target record must retain all phone-attested identity digests';
  end if;
  if not exists(select 1 from public.backroom_native_binding_intents
      where id=v_intent and consumed_at is not null) then
    raise exception 'Successful device attestation must consume the one-time owner intent';
  end if;

  -- The same intent cannot create another native binding after it was consumed.
  begin
    perform public.register_backroom_native_input_binding_from_device(
      v_intent,v_device,v_screen,'com.example.ai',v_signer,v_composer,v_send,v_provider
    );
    raise exception 'A consumed native binding intent was reused';
  exception when others then
    if sqlerrm='A consumed native binding intent was reused' then raise; end if;
  end;

  -- Provider conversation identity is immutable. Switching chats requires a
  -- new owner intent and a new binding, never an in-place retarget.
  begin
    update public.backroom_input_bindings
      set provider_conversation_identity_digest=repeat('1',64)
      where id=v_binding;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then
    raise exception 'A device-attested provider conversation digest must be immutable';
  end if;
end;
$test$;
