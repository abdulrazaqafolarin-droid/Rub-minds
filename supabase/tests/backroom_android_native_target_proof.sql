-- Integration contract for 20261104133000_backroom_android_native_target_proofs.sql.
-- This file is exercised by the local Supabase/PostgreSQL test workflow.
do $test$
declare
  v_owner uuid := '20000000-0000-4000-8000-000000000099';
  v_room uuid := '10000000-0000-4000-8000-000000000099';
  v_other_room uuid := '10000000-0000-4000-8000-000000000098';
  v_participant uuid := '30000000-0000-4000-8000-000000000099';
  v_device uuid := '40000000-0000-4000-8000-000000000099';
  v_host text := '50000000-0000-4000-8000-000000000099';
  v_screen_session uuid := '60000000-0000-4000-8000-000000000099';
  v_mcp_digest text := repeat('a',64);
  v_signer text := repeat('e',64);
  v_composer text := repeat('b',64);
  v_send text := repeat('c',64);
  v_provider text := repeat('d',64);
  v_proof_id uuid;
  v_bad_room_proof_id uuid;
  v_bad_signer_proof_id uuid;
  v_binding_id uuid;
  v_conflict boolean := false;
begin
  insert into auth.users(id) values (v_owner);
  insert into public.rooms(id,owner_id,title)
  values (v_room,v_owner,'Android native proof test room'),
         (v_other_room,v_owner,'Android native proof other room');
  insert into public.participants(id,room_id,display_name,kind,status)
  values (v_participant,v_room,'Native Proof AI','original_session','active');
  insert into public.agent_connections(
    room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at
  ) values (
    v_room,v_participant,v_owner,repeat('f',64),
    pg_catalog.clock_timestamp()+interval '48 hours',null
  );
  insert into public.rub_minds_mcp_sessions(
    session_digest,agent_credential_ciphertext,agent_credential_digest,
    room_id,participant_id,expires_at,terminated_at
  ) values (
    v_mcp_digest,'proof-test-ciphertext',repeat('f',64),
    v_room,v_participant,pg_catalog.clock_timestamp()+interval '2 hours',null
  );
  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at,revoked_at)
  values (
    v_host,v_owner,repeat('1',64),pg_catalog.clock_timestamp()+interval '48 hours',null
  );
  insert into public.backroom_devices(
    device_id,owner_id,token_digest,device_label,platform,status,approved_at
  ) values (
    v_device,v_owner,repeat('2',64),'Android proof test phone','android','active',
    pg_catalog.clock_timestamp()
  );
  insert into public.backroom_device_room_bindings(device_id,room_id,owner_id)
  values(v_device,v_room,v_owner);
  insert into public.backroom_device_apps(
    device_id,package_name,app_label,signing_certificate_sha256,draft_insertion_allowed
  ) values(v_device,'com.example.chat','Example Chat',v_signer,true);
  insert into public.backroom_desktop_sessions(
    session_id,device_id,room_id,requested_by,session_type,status,expires_at
  ) values (
    v_screen_session,v_device,v_room,v_owner,'screen','active',
    pg_catalog.clock_timestamp()+interval '10 minutes'
  );

  if has_function_privilege(
      'anon',
      'public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer)',
      'EXECUTE'
    ) then
    raise exception 'Android proof binding RPC privileges are unsafe';
  end if;

  insert into public.backroom_android_native_target_proofs(
    device_id,room_id,screen_session_id,request_id,app_package_name,
    app_signer_sha256,target_id,target_revision,composer_identity_digest,
    send_control_identity_digest,provider_conversation_identity_digest,expires_at
  ) values (
    v_device,v_room,v_screen_session,'70000000-0000-4000-8000-000000000099',
    'com.example.chat',v_signer,v_composer,7,v_composer,v_send,v_provider,
    pg_catalog.clock_timestamp()+interval '5 minutes'
  ) returning proof_id into v_proof_id;

  v_binding_id := public.register_backroom_android_native_binding(
    v_proof_id,v_owner,v_room,v_participant,v_host,v_mcp_digest,
    'android-'||v_device::text,'mentions',6
  );

  if not exists (
    select 1 from public.backroom_input_bindings b
    where b.id=v_binding_id and b.owner_id=v_owner and b.room_id=v_room
      and b.participant_id=v_participant and b.host_id=v_host
      and b.session_digest=v_mcp_digest and b.session_id=v_screen_session::text
      and b.space_id='android-'||v_device::text and b.surface='android_app'
      and b.target_id=v_composer and b.target_revision=7
      and b.target_identity_fingerprint=v_signer
      and b.provider_conversation_identity_digest=v_provider
      and b.native_target_proof_id=v_proof_id and b.native_device_id=v_device
      and b.native_screen_session_id=v_screen_session
      and b.native_app_package_name='com.example.chat'
      and b.native_app_signer_sha256=v_signer
      and b.native_composer_identity_digest=v_composer
      and b.native_send_control_identity_digest=v_send
      and b.wake_enabled=false and b.wake_grant_id is null
      and b.confirmed_at is null and b.wake_expires_at is null
  ) then
    raise exception 'Proof consumption must create the exact inactive native binding';
  end if;

  if not exists (
    select 1 from public.backroom_android_native_target_proofs p
    where p.proof_id=v_proof_id and p.consumed_at is not null
      and p.consumed_by_owner_id=v_owner and p.consumed_binding_id=v_binding_id
  ) then
    raise exception 'Successful native binding must consume the proof atomically';
  end if;

  -- The same proof cannot be consumed twice.
  v_conflict := false;
  begin
    perform public.register_backroom_android_native_binding(
      v_proof_id,v_owner,v_room,v_participant,v_host,v_mcp_digest,
      'android-'||v_device::text,'mentions',6
    );
  exception when others then
    if sqlerrm <> 'Android native target proof is missing, expired or already consumed' then
      raise;
    end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'A consumed Android target proof must not create a second binding'; end if;

  -- The room selected by the owner must match the phone proof's actual room.
  insert into public.backroom_android_native_target_proofs(
    device_id,room_id,screen_session_id,request_id,app_package_name,
    app_signer_sha256,target_id,target_revision,composer_identity_digest,
    send_control_identity_digest,provider_conversation_identity_digest,expires_at
  ) values (
    v_device,v_room,v_screen_session,'70000000-0000-4000-8000-000000000098',
    'com.example.chat',v_signer,repeat('8',64),8,repeat('8',64),v_send,v_provider,
    pg_catalog.clock_timestamp()+interval '5 minutes'
  ) returning proof_id into v_bad_room_proof_id;

  v_conflict := false;
  begin
    perform public.register_backroom_android_native_binding(
      v_bad_room_proof_id,v_owner,v_other_room,v_participant,v_host,v_mcp_digest,
      'android-'||v_device::text,'mentions',6
    );
  exception when others then
    if sqlerrm <> 'Android target proof belongs to a different room' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'A target proof must not be consumed for another room'; end if;
  if not exists(select 1 from public.backroom_android_native_target_proofs
      where proof_id=v_bad_room_proof_id and consumed_at is null) then
    raise exception 'Wrong-room proof rejection must leave the proof unconsumed';
  end if;

  -- A signer not present in the paired phone's approved app inventory cannot bind.
  insert into public.backroom_android_native_target_proofs(
    device_id,room_id,screen_session_id,request_id,app_package_name,
    app_signer_sha256,target_id,target_revision,composer_identity_digest,
    send_control_identity_digest,provider_conversation_identity_digest,expires_at
  ) values (
    v_device,v_room,v_screen_session,'70000000-0000-4000-8000-000000000097',
    'com.example.chat',repeat('9',64),repeat('7',64),9,repeat('7',64),v_send,v_provider,
    pg_catalog.clock_timestamp()+interval '5 minutes'
  ) returning proof_id into v_bad_signer_proof_id;

  v_conflict := false;
  begin
    perform public.register_backroom_android_native_binding(
      v_bad_signer_proof_id,v_owner,v_room,v_participant,v_host,v_mcp_digest,
      'android-'||v_device::text,'mentions',6
    );
  exception when others then
    if sqlerrm <> 'Android app signer is not in the approved device inventory' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Unapproved app signer must not create a native binding'; end if;
  if not exists(select 1 from public.backroom_android_native_target_proofs
      where proof_id=v_bad_signer_proof_id and consumed_at is null) then
    raise exception 'Signer mismatch must leave the proof unconsumed';
  end if;

  -- The native proof binding is immutable after creation; it must be revoked/recreated to retarget.
  v_conflict := false;
  begin
    update public.backroom_input_bindings
    set native_screen_session_id='60000000-0000-4000-8000-000000000098'
    where id=v_binding_id;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Native target proof identity must be immutable'; end if;

  -- An Android composer can still be registered without a proof for manual draft use,
  -- but its consent check blocks enabling autonomous wake.
  insert into public.backroom_input_bindings(
    owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,
    target_id,target_identity_fingerprint,target_revision,surface,locator_kind,
    locator_value,participation_mode,max_wakes_per_minute,wake_enabled
  ) values (
    v_owner,v_room,v_participant,v_host,v_mcp_digest,'android-draft-'||v_device::text,
    'screen-draft-only','draft-target','draft-fingerprint',1,'android_app',
    'accessibility','draft-locator','mentions',6,false
  );

  v_conflict := false;
  begin
    update public.backroom_input_bindings
    set wake_enabled=true,wake_grant_id='70000000-0000-4000-8000-000000000096'::uuid,
        confirmed_at=pg_catalog.clock_timestamp(),
        wake_expires_at=pg_catalog.clock_timestamp()+interval '1 hour'
    where owner_id=v_owner and space_id='android-draft-'||v_device::text;
  exception when check_violation then
    v_conflict := true;
  end;
  if not v_conflict then
    raise exception 'Native draft binding without a device proof must not enable autonomous wake';
  end if;
end;
$test$;
