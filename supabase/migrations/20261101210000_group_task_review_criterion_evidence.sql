-- Require durable, criterion-by-criterion evidence for human task reviews.
-- This is forward-only so already-upgraded staging databases receive the same
-- contract as clean installs. Browser roles still have no direct write access.

alter table public.room_task_reviews
  add column if not exists criterion_evidence jsonb not null default '[]'::jsonb;

do $criterion_evidence_constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.room_task_reviews'::regclass
      and conname = 'room_task_reviews_criterion_evidence_shape'
  ) then
    alter table public.room_task_reviews
      add constraint room_task_reviews_criterion_evidence_shape
      check (
        jsonb_typeof(criterion_evidence) = 'array'
        and octet_length(criterion_evidence::text) <= 32768
      );
  end if;
end;
$criterion_evidence_constraint$;

-- Remove the previous overload so old four-argument calls cannot bypass the
-- criterion evidence contract through PostgREST's default-argument resolution.
drop function if exists public.review_room_task(uuid, uuid, text, text);

create function public.review_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_outcome text,
  p_feedback text,
  p_criterion_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $review_room_task$
declare
  v_task public.room_tasks%rowtype;
  v_actor_id uuid;
  v_owner boolean;
  v_submission public.room_task_submissions%rowtype;
  v_next_status text;
  v_existing public.room_task_reviews%rowtype;
  v_incomplete integer;
  v_criteria_count integer;
  v_evidence_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_outcome is null or p_outcome not in ('approved','revision_requested')
     or coalesce(char_length(p_feedback),0) > 12000
     or p_criterion_evidence is null
     or jsonb_typeof(p_criterion_evidence) <> 'array'
     or octet_length(p_criterion_evidence::text) > 32768 then
    raise exception 'Invalid task review';
  end if;

  select p.id into v_actor_id
  from public.participants p
  where p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  limit 1;
  if v_actor_id is null then raise exception 'Human group membership required'; end if;

  -- Lock the task while its current criteria and submission are evaluated.
  select t.* into v_task
  from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id
  for update;
  if not found then raise exception 'Task not found'; end if;

  select exists(
    select 1 from public.rooms r where r.id=p_room_id and r.owner_id=auth.uid()
  ) into v_owner;
  if not v_owner and v_task.created_by_participant_id <> v_actor_id then
    raise exception 'Only the task creator or group owner may review this task';
  end if;

  v_criteria_count := jsonb_array_length(v_task.acceptance_criteria);
  v_evidence_count := jsonb_array_length(p_criterion_evidence);
  if v_evidence_count <> v_criteria_count then
    raise exception 'Evidence must cover every acceptance criterion exactly once and in order';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_criterion_evidence) with ordinality as evidence(item, ordinal)
    left join jsonb_array_elements_text(v_task.acceptance_criteria)
      with ordinality as criterion(value, ordinal)
      on criterion.ordinal=evidence.ordinal
    where jsonb_typeof(evidence.item) <> 'object'
       or evidence.item->>'criterion' is distinct from criterion.value
       or jsonb_typeof(evidence.item->'met') <> 'boolean'
       or coalesce(char_length(btrim(evidence.item->>'evidence')),0) not between 1 and 2000
  ) then
    raise exception 'Each criterion requires its exact text, a met/not-met decision, and 1-2000 characters of evidence';
  end if;

  if p_outcome='approved' and exists (
    select 1
    from jsonb_array_elements(p_criterion_evidence) as evidence(item)
    where evidence.item->>'met' <> 'true'
  ) then
    raise exception 'A task cannot be approved while any acceptance criterion is unmet';
  end if;

  select s.* into v_submission
  from public.room_task_submissions s
  where s.task_id=p_task_id and s.room_id=p_room_id
  order by s.created_at desc, s.id desc
  limit 1;
  if not found then raise exception 'Task has no submitted result to review'; end if;
  if v_submission.submitted_by_participant_id=v_actor_id then
    raise exception 'A participant cannot review its own task submission';
  end if;

  select r.* into v_existing
  from public.room_task_reviews r
  where r.submission_id=v_submission.id
    and r.reviewer_participant_id=v_actor_id;
  if found then
    if v_existing.outcome=p_outcome
       and v_existing.feedback=coalesce(p_feedback,'')
       and v_existing.criterion_evidence=p_criterion_evidence then
      return jsonb_build_object(
        'reviewed',true,'replayed',true,'task_id',p_task_id,'status',v_task.status
      );
    end if;
    raise exception 'This submission has already been reviewed; a new submission is required';
  end if;
  if v_task.status <> 'review' then raise exception 'Task is not awaiting review'; end if;

  insert into public.room_task_reviews(
    room_id,task_id,submission_id,reviewer_participant_id,outcome,feedback,criterion_evidence
  ) values (
    p_room_id,p_task_id,v_submission.id,v_actor_id,p_outcome,
    coalesce(p_feedback,''),p_criterion_evidence
  );

  if p_outcome='approved' then
    v_next_status := 'completed';
  else
    select count(*) into v_incomplete
    from public.room_task_dependencies d
    join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
    where d.task_id=p_task_id and prerequisite.status <> 'completed';
    v_next_status := case
      when v_task.assigned_to_participant_id is not null and v_incomplete=0 then 'assigned'
      else 'backlog'
    end;
  end if;

  update public.room_tasks
  set status=v_next_status,blocked_reason=null
  where id=p_task_id and room_id=p_room_id;

  return jsonb_build_object(
    'reviewed',true,'replayed',false,'task_id',p_task_id,'status',v_next_status
  );
end;
$review_room_task$;

revoke all on function public.review_room_task(uuid,uuid,text,text,jsonb) from public, anon;
grant execute on function public.review_room_task(uuid,uuid,text,text,jsonb) to authenticated;
