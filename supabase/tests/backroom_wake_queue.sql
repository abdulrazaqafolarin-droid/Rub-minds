-- Integration contract for supabase/migrations/20261029090000_backroom_wake_queue.sql.
do $test$
declare
  v_owner uuid := '20000000-0000-0000-0000-000000000099';
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
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid='public.backroom_wake_jobs'::regclass) then
    raise exception 'Backroom wake jobs must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.backroom_wake_jobs','SELECT')
    or has_table_privilege('authenticated','public.backroom_wake_jobs','SELECT')
    or has_table_privilege('anon','public.backroom_wake_jobs','INSERT')
    or has_table_privilege('authenticated','public.backroom_wake_jobs','INSERT') then
    raise exception 'Client roles must not access the durable wake queue directly';
  end if;
  if has_function_privilege('anon','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text,integer)','EXECUTE') then
    raise exception 'Enqueue RPC grants are unsafe';
  end if;
  if has_function_privilege('anon','public.claim_backroom_wake_jobs(text,text,integer,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.claim_backroom_wake_jobs(text,text,integer,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.claim_backroom_wake_jobs(text,text,integer,integer)','EXECUTE') then
    raise exception 'Claim RPC grants are unsafe';
  end if;

  v_first := public.enqueue_backroom_wake_job(
    repeat('1',64),v_owner,v_room,v_participant,'host-test','space-1','session-1',v_session_digest,
    'binding-1','target-1','fingerprint-1',1,'event-1','@RMconnects'||chr(10)||'Event: event-1',3600);
  v_repeat := public.enqueue_backroom_wake_job(
    repeat('1',64),v_owner,v_room,v_participant,'host-test','space-1','session-1',v_session_digest,
    'binding-1','target-1','fingerprint-1',1,'event-1','@RMconnects'||chr(10)||'Event: event-1',3600);
  if (v_first->>'created') <> 'true' or (v_repeat->>'created') <> 'false'
    or (v_first->>'job_id') <> (v_repeat->>'job_id') then
    raise exception 'Identical enqueue retries must return the same job idempotently';
  end if;
  begin
    perform public.enqueue_backroom_wake_job(
      repeat('1',64),v_owner,v_room,v_participant,'host-test','space-1','session-1',v_session_digest,
      'binding-1','target-1','fingerprint-1',1,'event-1','@RMconnects'||chr(10)||'different prompt',3600);
  exception when others then
      if sqlerrm <> 'Wake idempotency key conflicts with a different request' then raise; end if;
      v_conflict := true;
  end;
  if not v_conflict then raise exception 'Same idempotency key with a different prompt must fail'; end if;

  select * into v_claim from public.claim_backroom_wake_jobs('host-test',v_session_digest,5,30) limit 1;
  if not found or v_claim.out_job_id::text <> (v_first->>'job_id')
    or v_claim.out_attempt_count <> 1 or v_claim.out_lease_token is null then
    raise exception 'Claim must return the job and a one-shot lease token';
  end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs('host-test',v_session_digest,5,30);
  if v_count <> 0 then raise exception 'An active lease must prevent duplicate concurrent claims'; end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs('wrong-host',v_session_digest,5,30);
  if v_count <> 0 then raise exception 'A different host must not claim this job'; end if;
  select count(*) into v_count from public.claim_backroom_wake_jobs('host-test',repeat('c',64),5,30);
  if v_count <> 0 then raise exception 'A different session digest must not claim this job'; end if;

  if public.ack_backroom_wake_job(v_claim.out_job_id,'host-test',v_session_digest,'00000000-0000-0000-0000-000000000000','acknowledged') then
    raise exception 'Incorrect lease token must not acknowledge a job';
  end if;
  if not public.ack_backroom_wake_job(v_claim.out_job_id,'host-test',v_session_digest,v_claim.out_lease_token,'acknowledged') then
    raise exception 'Valid lease token should acknowledge the claimed job';
  end if;
  if public.ack_backroom_wake_job(v_claim.out_job_id,'host-test',v_session_digest,v_claim.out_lease_token,'acknowledged') then
    raise exception 'Acknowledgement replay must fail';
  end if;

  v_retry_job := public.enqueue_backroom_wake_job(
    repeat('2',64),v_owner,v_room,v_participant,'host-test','space-1','session-2',repeat('c',64),
    'binding-2','target-2','fingerprint-2',2,'event-2','@RMconnects'||chr(10)||'Event: event-2',3600);
  select * into v_claim_retry from public.claim_backroom_wake_jobs('host-test',repeat('c',64),1,30) limit 1;
  if not found or v_claim_retry.out_job_id::text <> v_retry_job->>'job_id' then
    raise exception 'Expected the second session job to be claimed';
  end if;
  v_retry_state := public.retry_backroom_wake_job(
    v_claim_retry.out_job_id,'host-test',repeat('c',64),v_claim_retry.out_lease_token,1,'transport_error');
  if v_retry_state <> 'pending' then raise exception 'A retryable failure should return to pending'; end if;
  update public.backroom_wake_jobs set available_at=pg_catalog.clock_timestamp()-interval '1 second' where id=v_claim_retry.out_job_id;
  select * into v_claim_retry from public.claim_backroom_wake_jobs('host-test',repeat('c',64),1,30) limit 1;
  if not found or v_claim_retry.out_attempt_count <> 2 then raise exception 'Retry should be reclaimable and increment attempts'; end if;
  if not public.ack_backroom_wake_job(v_claim_retry.out_job_id,'host-test',repeat('c',64),v_claim_retry.out_lease_token,'ignored') then
    raise exception 'A valid ignored outcome should acknowledge the event cursor';
  end if;

  v_cancel_job := public.enqueue_backroom_wake_job(
    repeat('3',64),v_owner,v_room,v_participant,'host-test','space-1','session-3',repeat('d',64),
    'binding-3','target-3','fingerprint-3',1,'event-3','@RMconnects'||chr(10)||'Event: event-3',3600);
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
    repeat('4',64),v_owner,v_room,v_participant,'host-test','space-1','session-4',repeat('e',64),
    'binding-4','target-4','fingerprint-4',1,'event-4','@RMconnects'||chr(10)||'Event: event-4',3600);
  update public.backroom_wake_jobs set expires_at=pg_catalog.clock_timestamp()-interval '1 second'
    where id=(v_expire_job->>'job_id')::uuid;
  if public.expire_backroom_wake_jobs() < 1 then raise exception 'Expiry function should expire overdue jobs'; end if;
  if (select state from public.backroom_wake_jobs where id=(v_expire_job->>'job_id')::uuid) <> 'expired' then
    raise exception 'Expired job must not remain dispatchable';
  end if;
end;
$test$;
