-- Atomic queue claiming and lease transitions for the autonomous responder worker.
-- These RPCs only manage jobs. The worker must re-check policy/authorization
-- immediately before model invocation and send replies idempotently using
-- source_message_id = 'auto-job:' || job.id.

create or replace function private.claim_ai_response_jobs(
  p_limit integer default 5,
  p_lease_seconds integer default 60,
  p_max_attempts integer default 5
)
returns setof private.ai_response_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  take_count integer := greatest(1, least(coalesce(p_limit, 5), 10));
  lease_seconds integer := greatest(10, least(coalesce(p_lease_seconds, 60), 300));
  max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 5), 10));
begin
  -- Expired jobs that have exhausted their retry budget must not remain leased.
  update private.ai_response_jobs j
     set status = 'dead_letter',
         lease_token = null,
         leased_until = null,
         last_error_code = coalesce(j.last_error_code, 'lease_expired_max_attempts'),
         updated_at = now()
   where j.status = 'leased'
     and j.leased_until <= now()
     and j.attempts >= max_attempts;

  -- Cancel work made ineligible while it was waiting or leased. This is a
  -- defensive queue-level check; workers must re-check again before model use.
  update private.ai_response_jobs j
     set status = 'cancelled',
         lease_token = null,
         leased_until = null,
         last_error_code = 'responder_not_eligible',
         updated_at = now()
   where (j.status = 'pending' or (j.status = 'leased' and j.leased_until <= now()))
     and not exists (
       select 1
       from private.room_ai_responders r
       join public.participants p
         on p.id = r.participant_id and p.room_id = r.room_id
       join public.messages trigger_message
         on trigger_message.id = j.triggering_message_id
        and trigger_message.room_id = j.room_id
       join public.participants sender
         on sender.id = trigger_message.sender_id
        and sender.room_id = trigger_message.room_id
       where r.room_id = j.room_id
         and r.participant_id = j.target_participant_id
         and r.enabled = true
         and r.policy_version = j.policy_version
         and p.kind in ('model', 'external_agent')
         and p.status = 'autonomous'
         and sender.kind = 'human'
     );

  return query
  with candidates as (
    select j.id
    from private.ai_response_jobs j
    where j.attempts < max_attempts
      and (
        (j.status = 'pending' and j.available_at <= now())
        or (j.status = 'leased' and j.leased_until <= now())
      )
      and exists (
        select 1
        from private.room_ai_responders r
        join public.participants p
          on p.id = r.participant_id and p.room_id = r.room_id
        join public.messages trigger_message
          on trigger_message.id = j.triggering_message_id
         and trigger_message.room_id = j.room_id
        join public.participants sender
          on sender.id = trigger_message.sender_id
         and sender.room_id = trigger_message.room_id
        where r.room_id = j.room_id
          and r.participant_id = j.target_participant_id
          and r.enabled = true
          and r.policy_version = j.policy_version
          and p.kind in ('model', 'external_agent')
          and p.status = 'autonomous'
          and sender.kind = 'human'
      )
    order by j.available_at, j.id
    for update skip locked
    limit take_count
  ),
  claimed as (
    update private.ai_response_jobs j
       set status = 'leased',
           attempts = j.attempts + 1,
           lease_token = gen_random_uuid(),
           leased_until = now() + make_interval(secs => lease_seconds),
           updated_at = now()
      from candidates c
     where j.id = c.id
    returning j.*
  )
  select * from claimed;
end;
$function$;

create or replace function private.finish_ai_response_job(
  p_job_id bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed integer;
begin
  update private.ai_response_jobs
     set status = 'completed',
         lease_token = null,
         leased_until = null,
         completed_at = now(),
         updated_at = now(),
         last_error_code = null
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;

create or replace function private.retry_ai_response_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_error_code text,
  p_max_attempts integer default 5
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed integer;
  max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 5), 10));
  safe_error_code text := case
    when p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code
    else 'worker_error'
  end;
begin
  update private.ai_response_jobs
     set status = case when attempts >= max_attempts then 'dead_letter' else 'pending' end,
         available_at = case
           when attempts >= max_attempts then available_at
           else now() + make_interval(secs => least(300, 5 * (2 ^ least(attempts, 6))::integer))
         end,
         lease_token = null,
         leased_until = null,
         last_error_code = safe_error_code,
         updated_at = now()
   where id = p_job_id
     and status = 'leased'
     and lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$function$;

revoke all on function private.claim_ai_response_jobs(integer, integer, integer) from public, anon, authenticated;
revoke all on function private.finish_ai_response_job(bigint, uuid) from public, anon, authenticated;
revoke all on function private.retry_ai_response_job(bigint, uuid, text, integer) from public, anon, authenticated;
grant execute on function private.claim_ai_response_jobs(integer, integer, integer) to service_role;
grant execute on function private.finish_ai_response_job(bigint, uuid) to service_role;
grant execute on function private.retry_ai_response_job(bigint, uuid, text, integer) to service_role;

comment on function private.claim_ai_response_jobs(integer, integer, integer) is
  'Atomically claims eligible jobs using row locks and expiring leases; service_role only.';
comment on function private.finish_ai_response_job(bigint, uuid) is
  'Completes a job only when the supplied lease token still owns it.';
comment on function private.retry_ai_response_job(bigint, uuid, text, integer) is
  'Retries with bounded exponential backoff or dead-letters after the attempt budget.';
