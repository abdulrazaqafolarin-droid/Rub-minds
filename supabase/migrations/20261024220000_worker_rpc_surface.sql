-- Service-role-only API surface for the Edge worker.
-- PostgREST does not expose the private schema by default. These thin public
-- wrappers are callable ONLY by service_role, never anon/authenticated.
-- They intentionally do not accept room or participant identities from clients.

create or replace function public.worker_claim_ai_response_jobs(
  p_limit integer default 5,
  p_lease_seconds integer default 60,
  p_max_attempts integer default 5
)
returns setof private.ai_response_jobs
language sql
security definer
set search_path = ''
as $$
  select * from private.claim_ai_response_jobs(p_limit, p_lease_seconds, p_max_attempts);
$$;

create or replace function public.worker_commit_ai_response_job(
  p_job_id bigint, p_lease_token uuid, p_body text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.commit_ai_response_job(p_job_id, p_lease_token, p_body);
$$;

create or replace function public.worker_retry_ai_response_job(
  p_job_id bigint, p_lease_token uuid, p_error_code text,
  p_max_attempts integer default 5
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.retry_ai_response_job(p_job_id, p_lease_token, p_error_code, p_max_attempts);
$$;

-- The worker needs only the triggering message and bounded room context.
-- Re-check authorization against the currently leased job.
create or replace function public.worker_ai_response_context(
  p_job_id bigint, p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j private.ai_response_jobs%rowtype;
  context jsonb;
begin
  select * into j from private.ai_response_jobs
  where id = p_job_id and status = 'leased'
    and lease_token = p_lease_token and leased_until > now();
  if not found then raise exception 'Invalid worker lease'; end if;
  if not exists (
    select 1 from private.room_ai_responders r
    join public.participants p on p.id = r.participant_id and p.room_id = r.room_id
    join public.messages m on m.id = j.triggering_message_id and m.room_id = j.room_id
    join public.participants sender on sender.id = m.sender_id and sender.room_id = m.room_id
    where r.room_id = j.room_id and r.participant_id = j.target_participant_id
      and r.enabled and r.policy_version = j.policy_version
      and p.kind in ('model', 'external_agent') and p.status = 'autonomous'
      and sender.kind = 'human'
  ) then raise exception 'Worker authorization revoked'; end if;

  select jsonb_build_object(
    'job_id', j.id,
    'room_id', j.room_id,
    'participant_id', j.target_participant_id,
    'room_title', room.title,
    'room_objective', room.objective,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'body', recent.body,
        'sender_name', recent.display_name, 'sender_kind', recent.kind
      ) order by recent.created_at, recent.id)
      from (
        select m.id, m.body, m.created_at, p.display_name, p.kind
        from public.messages m
        join public.participants p on p.id = m.sender_id and p.room_id = m.room_id
        where m.room_id = j.room_id and m.created_at <= (
          select t.created_at from public.messages t where t.id = j.triggering_message_id
        )
        order by m.created_at desc, m.id desc
        limit 20
      ) recent
    ), '[]'::jsonb)
  ) into context
  from public.rooms room where room.id = j.room_id;
  return context;
end;
$$;

revoke all on function public.worker_claim_ai_response_jobs(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.worker_commit_ai_response_job(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.worker_retry_ai_response_job(bigint, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.worker_ai_response_context(bigint, uuid) from public, anon, authenticated;
grant execute on function public.worker_claim_ai_response_jobs(integer, integer, integer) to service_role;
grant execute on function public.worker_commit_ai_response_job(bigint, uuid, text) to service_role;
grant execute on function public.worker_retry_ai_response_job(bigint, uuid, text, integer) to service_role;
grant execute on function public.worker_ai_response_context(bigint, uuid) to service_role;
