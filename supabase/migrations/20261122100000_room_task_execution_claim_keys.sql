-- Bind each AI task claim to one durable execution attempt.
-- Replaying the same key recovers a lost acknowledgement; another runner for
-- the same participant cannot silently inherit the in-progress provider turn.
begin;

create table if not exists public.room_task_execution_claims (
  task_id uuid primary key references public.room_tasks(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  claim_key uuid not null,
  claimed_at timestamptz not null default pg_catalog.clock_timestamp()
);

create index if not exists room_task_execution_claims_participant_fk_idx
  on public.room_task_execution_claims(participant_id);

alter table public.room_task_execution_claims enable row level security;
revoke all on table public.room_task_execution_claims from public, anon, authenticated;
grant all on table public.room_task_execution_claims to service_role;

comment on table public.room_task_execution_claims is
  'Private per-execution ownership proof for an AI task claim. Never expose claim_key through participant task reads.';

drop function if exists public.claim_room_task(uuid,uuid,uuid);

create function public.claim_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid,
  p_claim_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $claim_room_task$
declare
  v_task public.room_tasks%rowtype;
  v_claim public.room_task_execution_claims%rowtype;
  v_incomplete integer;
begin
  if p_room_id is null or p_task_id is null or p_participant_id is null or p_claim_key is null then
    raise exception 'Room, task, participant and claim key are required';
  end if;
  if not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then raise exception 'Active AI group participant required'; end if;

  -- The task row lock serializes fresh claims and recovery checks.
  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  if v_task.assigned_to_participant_id is null then
    raise exception 'A human group member must assign this task before an AI can claim it';
  end if;
  if v_task.assigned_to_participant_id <> p_participant_id then
    raise exception 'Task is assigned to another participant';
  end if;

  if v_task.status='in_progress' then
    select c.* into v_claim from public.room_task_execution_claims c
    where c.task_id=p_task_id;
    if not found then
      -- Older in-progress claims have no proof of which local runner owns the
      -- provider turn. They require explicit human recovery, never auto-adopt.
      return jsonb_build_object(
        'claimed',false,'reason','claim_recovery_required',
        'task_id',p_task_id,'status','in_progress'
      );
    end if;
    if v_claim.participant_id=p_participant_id and v_claim.claim_key=p_claim_key then
      return jsonb_build_object(
        'claimed',true,'replayed',true,'task_id',p_task_id,'status','in_progress'
      );
    end if;
    return jsonb_build_object(
      'claimed',false,'reason','claim_owned_by_another_runner',
      'task_id',p_task_id,'status','in_progress'
    );
  end if;

  if v_task.status not in ('backlog','assigned') then
    raise exception 'Task is not available to claim';
  end if;

  select count(*) into v_incomplete
  from public.room_task_dependencies d
  join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
  where d.task_id=p_task_id and prerequisite.status <> 'completed';
  if v_incomplete > 0 then
    return jsonb_build_object('claimed',false,'reason','dependencies_incomplete','task_id',p_task_id);
  end if;

  -- A task can return to assigned after a human requests revision or
  -- reassigns it. Replace only the old completed/retired execution proof.
  delete from public.room_task_execution_claims where task_id=p_task_id;
  update public.room_tasks
  set assigned_to_participant_id=p_participant_id,status='in_progress',blocked_reason=null
  where id=p_task_id and room_id=p_room_id;
  insert into public.room_task_execution_claims(task_id,participant_id,claim_key)
  values (p_task_id,p_participant_id,p_claim_key);

  return jsonb_build_object('claimed',true,'replayed',false,'task_id',p_task_id,'status','in_progress');
end;
$claim_room_task$;

revoke all on function public.claim_room_task(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_room_task(uuid,uuid,uuid,uuid) to service_role;

commit;
