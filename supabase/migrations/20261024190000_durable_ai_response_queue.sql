-- Durable, opt-in job queue for independent Rub Minds responders.
-- This migration does not call a model or enable any responder by default.
-- Original ChatGPT/Claude sessions remain on the MCP path; this queue is for
-- explicitly configured autonomous model/external-agent participants only.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.room_ai_responders (
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  enabled boolean not null default false,
  policy_version integer not null default 1 check (policy_version > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_id, participant_id),
  constraint room_ai_responders_participant_room_unique unique (room_id, participant_id)
);

create table if not exists private.ai_response_jobs (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  triggering_message_id uuid not null references public.messages(id) on delete cascade,
  target_participant_id uuid not null references public.participants(id) on delete cascade,
  policy_version integer not null check (policy_version > 0),
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'dead_letter', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (room_id, triggering_message_id, target_participant_id, policy_version),
  constraint ai_response_jobs_lease_consistency check (
    (status = 'leased' and lease_token is not null and leased_until is not null)
    or (status <> 'leased' and lease_token is null and leased_until is null)
  )
);

create index if not exists ai_response_jobs_pending_idx
  on private.ai_response_jobs (available_at, id)
  where status = 'pending';

create index if not exists ai_response_jobs_expired_lease_idx
  on private.ai_response_jobs (leased_until, id)
  where status = 'leased';

revoke all on table private.room_ai_responders from public, anon, authenticated;
revoke all on table private.ai_response_jobs from public, anon, authenticated;
grant select, insert, update, delete on table private.room_ai_responders to service_role;
grant select, insert, update, delete on table private.ai_response_jobs to service_role;
grant usage, select on sequence private.ai_response_jobs_id_seq to service_role;

create or replace function private.enqueue_ai_response_jobs_for_human_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  sender_kind text;
begin
  select p.kind into sender_kind
  from public.participants p
  where p.id = new.sender_id
    and p.room_id = new.room_id;

  -- Fail closed: an unknown or mismatched sender creates no autonomous work.
  if sender_kind is distinct from 'human' then
    return new;
  end if;

  insert into private.ai_response_jobs (
    room_id,
    triggering_message_id,
    target_participant_id,
    policy_version
  )
  select
    new.room_id,
    new.id,
    responder.participant_id,
    responder.policy_version
  from private.room_ai_responders responder
  join public.participants target
    on target.id = responder.participant_id
   and target.room_id = responder.room_id
  where responder.room_id = new.room_id
    and responder.enabled = true
    and target.kind in ('model', 'external_agent')
    and target.status = 'autonomous'
    and target.id <> new.sender_id
  on conflict (room_id, triggering_message_id, target_participant_id, policy_version)
  do nothing;

  return new;
end;
$function$;

revoke all on function private.enqueue_ai_response_jobs_for_human_message() from public, anon, authenticated;

drop trigger if exists enqueue_ai_response_jobs_after_message_insert on public.messages;
create trigger enqueue_ai_response_jobs_after_message_insert
  after insert on public.messages
  for each row
  execute function private.enqueue_ai_response_jobs_for_human_message();

comment on schema private is
  'Internal Rub Minds data; not exposed through the Supabase Data API.';
comment on table private.room_ai_responders is
  'Explicit opt-in list for independent autonomous responders. Empty by default.';
comment on table private.ai_response_jobs is
  'Durable references-only work queue. Claiming, lease recovery, and processing are implemented by the worker layer.';
