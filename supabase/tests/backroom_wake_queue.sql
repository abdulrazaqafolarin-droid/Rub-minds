-- Integration contract for supabase/migrations/20261029090000_backroom_wake_queue.sql.
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
begin
  insert into auth.users(id) values (v_owner);
  insert into public.rooms(id,owner_id,title) values (v_room,v_owner,'Backroom wake queue test room');
  insert into public.participants(id,room_id,display_name,kind,status) values (v_participant,v_room,'Test Backroom Agent','external_agent','active');
  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at)
  values (v_room,v_participant,v_owner,repeat('a',64),pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,room_id,participant_id,expires_at,terminated_at)
  values
    (repeat('b',64),'ci-ciphertext-b',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('c',64),'ci-ciphertext-c',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('d',64),'ci-ciphertext-d',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('e',64),'ci-ciphertext-e',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (repeat('f',64),'ci-ciphertext-f',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',pg_catalog.clock_timestamp()),
    (repeat('6',64),'ci-ciphertext-6',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,room_id,participant_id,expires_at,terminated_at)
    values (repeat('7',64),'ci-ciphertext-7',v_room,v_participant,pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at,revoked_at)
  values (v_host_test,v_owner,repeat('1',64),pg_catalog.clock_timestamp()+interval '1 hour',null),
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
  update public.rub_minds_mcp_sessions set terminated_at=pg_catalog.clock_timestamp() where session_digest=repeat('6',64);

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
  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,room_id,participant_id,expires_at,terminated_at)
  values (repeat('8',64),'ci-ciphertext-trigger',v_trigger_room,v_trigger_ai,pg_catalog.clock_timestamp()+interval '1 hour',null);
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

end;
$test$;
