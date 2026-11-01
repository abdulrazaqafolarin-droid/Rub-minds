-- Group task coordination extends the existing rooms, participants, messages,
-- shared-memory, MCP-session and Backroom wake infrastructure.
-- It deliberately does not create another group/member/message/queue system.

create table if not exists public.room_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  created_by_participant_id uuid not null references public.participants(id) on delete restrict,
  assigned_to_participant_id uuid references public.participants(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 12000),
  expected_output text not null default '' check (char_length(expected_output) <= 4000),
  acceptance_criteria jsonb not null default '[]'::jsonb
    check (jsonb_typeof(acceptance_criteria) = 'array' and octet_length(acceptance_criteria::text) <= 8192),
  priority smallint not null default 3 check (priority between 1 and 5),
  status text not null default 'backlog' check (
    status in ('backlog','assigned','in_progress','blocked','review','completed','failed','cancelled')
  ),
  due_at timestamptz,
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 2000),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  -- Snapshot the requested initial assignee so a network retry can be checked
  -- after assigned_to_participant_id has legitimately changed.
  idempotency_initial_assignee_id uuid,
  idempotency_fingerprint text check (idempotency_fingerprint is null or idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  version integer not null default 1 check (version > 0)
);

create index if not exists room_tasks_room_status_priority_idx
  on public.room_tasks(room_id, status, priority, created_at);
create index if not exists room_tasks_assignee_status_idx
  on public.room_tasks(assigned_to_participant_id, status, updated_at desc);
create unique index if not exists room_tasks_creator_idempotency_idx
  on public.room_tasks(created_by_participant_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.room_task_dependencies (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.room_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.room_tasks(id) on delete cascade,
  created_by_participant_id uuid not null references public.participants(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint room_task_dependency_not_self check (task_id <> depends_on_task_id),
  constraint room_task_dependency_unique unique (task_id, depends_on_task_id)
);
create index if not exists room_task_dependencies_prerequisite_idx
  on public.room_task_dependencies(depends_on_task_id, task_id);

create table if not exists public.room_task_submissions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.room_tasks(id) on delete cascade,
  submitted_by_participant_id uuid not null references public.participants(id) on delete restrict,
  result_content text not null check (char_length(btrim(result_content)) between 1 and 20000),
  source_message_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(source_message_ids) <= 50),
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint room_task_submission_idempotency unique (task_id, submitted_by_participant_id, idempotency_key)
);
create index if not exists room_task_submissions_task_created_idx
  on public.room_task_submissions(task_id, created_at desc);

create table if not exists public.room_task_reviews (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.room_tasks(id) on delete cascade,
  submission_id uuid not null references public.room_task_submissions(id) on delete cascade,
  reviewer_participant_id uuid not null references public.participants(id) on delete restrict,
  outcome text not null check (outcome in ('approved','revision_requested')),
  feedback text not null default '' check (char_length(feedback) <= 12000),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint room_task_review_once_per_submission unique (submission_id, reviewer_participant_id)
);
create index if not exists room_task_reviews_task_created_idx
  on public.room_task_reviews(task_id, created_at desc);

-- Exposed tables are protected by RLS. AI operations use the already trusted
-- MCP Edge Function; service_role is never exposed to browser clients.
alter table public.room_tasks enable row level security;
alter table public.room_task_dependencies enable row level security;
alter table public.room_task_submissions enable row level security;
alter table public.room_task_reviews enable row level security;

revoke all on table public.room_tasks, public.room_task_dependencies,
  public.room_task_submissions, public.room_task_reviews from public, anon;
grant select on table public.room_tasks, public.room_task_dependencies to authenticated;
-- Human lifecycle transitions are exposed only through narrowly scoped RPCs.
-- Clients cannot set status, assignee, review outcome or submission rows directly.
grant select on table public.room_task_submissions, public.room_task_reviews to authenticated;
grant all on table public.room_tasks, public.room_task_dependencies,
  public.room_task_submissions, public.room_task_reviews to service_role;

-- The existing Group workspace listens through Supabase Realtime. Publish the
-- task records so the board refreshes on changes without introducing polling.
do $task_realtime$
declare
  v_table text;
begin
  foreach v_table in array array[
    'room_tasks',
    'room_task_dependencies',
    'room_task_submissions',
    'room_task_reviews'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname='supabase_realtime'
        and schemaname='public'
        and tablename=v_table
    ) then
      execute 'alter publication supabase_realtime add table public.' || pg_catalog.quote_ident(v_table);
    end if;
  end loop;
end;
$task_realtime$;

drop policy if exists room_tasks_member_select on public.room_tasks;
create policy room_tasks_member_select on public.room_tasks
  for select to authenticated
  using (exists (
    select 1 from public.participants p
    where p.room_id = room_tasks.room_id and p.user_id = (select auth.uid())
  ));

drop policy if exists room_tasks_human_insert on public.room_tasks;
create policy room_tasks_human_insert on public.room_tasks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.participants p
      where p.id = room_tasks.created_by_participant_id
        and p.room_id = room_tasks.room_id
        and p.user_id = (select auth.uid())
        and p.kind = 'human'
    )
    and room_tasks.status in ('backlog','assigned')
    and room_tasks.version=1
    and (
      room_tasks.assigned_to_participant_id is null
      or exists (
        select 1 from public.participants a
        where a.id = room_tasks.assigned_to_participant_id and a.room_id = room_tasks.room_id
      )
    )
  );

drop policy if exists room_tasks_owner_or_creator_update on public.room_tasks;
create policy room_tasks_owner_or_creator_update on public.room_tasks
  for update to authenticated
  using (
    exists (select 1 from public.rooms r where r.id = room_tasks.room_id and r.owner_id = (select auth.uid()))
    or exists (
      select 1 from public.participants p
      where p.id = room_tasks.created_by_participant_id
        and p.room_id = room_tasks.room_id
        and p.user_id = (select auth.uid())
        and p.kind = 'human'
    )
    or exists (
      select 1 from public.participants assignee
      where assignee.id = room_tasks.assigned_to_participant_id
        and assignee.room_id = room_tasks.room_id
        and assignee.user_id = (select auth.uid())
        and assignee.kind = 'human'
    )
  )
  with check (
    exists (select 1 from public.rooms r where r.id = room_tasks.room_id and r.owner_id = (select auth.uid()))
    or exists (
      select 1 from public.participants p
      where p.id = room_tasks.created_by_participant_id
        and p.room_id = room_tasks.room_id
        and p.user_id = (select auth.uid())
        and p.kind = 'human'
    )
    or exists (
      select 1 from public.participants assignee
      where assignee.id = room_tasks.assigned_to_participant_id
        and assignee.room_id = room_tasks.room_id
        and assignee.user_id = (select auth.uid())
        and assignee.kind = 'human'
    )
  );

drop policy if exists room_task_dependencies_member_select on public.room_task_dependencies;
create policy room_task_dependencies_member_select on public.room_task_dependencies
  for select to authenticated
  using (exists (
    select 1 from public.participants p
    where p.room_id = room_task_dependencies.room_id and p.user_id = (select auth.uid())
  ));

drop policy if exists room_task_dependencies_human_insert on public.room_task_dependencies;
create policy room_task_dependencies_human_insert on public.room_task_dependencies
  for insert to authenticated
  with check (
    exists (
      select 1 from public.participants p
      where p.id = room_task_dependencies.created_by_participant_id
        and p.room_id = room_task_dependencies.room_id
        and p.user_id = (select auth.uid())
        and p.kind = 'human'
    )
    and exists (
      select 1 from public.room_tasks t
      where t.id = room_task_dependencies.task_id and t.room_id = room_task_dependencies.room_id
    )
    and exists (
      select 1 from public.room_tasks prerequisite
      where prerequisite.id = room_task_dependencies.depends_on_task_id
        and prerequisite.room_id = room_task_dependencies.room_id
    )
  );

drop policy if exists room_task_submissions_member_select on public.room_task_submissions;
create policy room_task_submissions_member_select on public.room_task_submissions
  for select to authenticated
  using (exists (
    select 1 from public.participants p
    where p.room_id = room_task_submissions.room_id and p.user_id = (select auth.uid())
  ));

drop policy if exists room_task_reviews_member_select on public.room_task_reviews;
create policy room_task_reviews_member_select on public.room_task_reviews
  for select to authenticated
  using (exists (
    select 1 from public.participants p
    where p.room_id = room_task_reviews.room_id and p.user_id = (select auth.uid())
  ));


drop policy if exists room_task_submissions_human_insert on public.room_task_submissions;
create policy room_task_submissions_human_insert on public.room_task_submissions
  for insert to authenticated
  with check (
    exists (
      select 1 from public.participants p
      where p.id=room_task_submissions.submitted_by_participant_id
        and p.room_id=room_task_submissions.room_id
        and p.user_id=(select auth.uid())
        and p.kind='human'
    )
    and exists (
      select 1 from public.room_tasks t
      where t.id=room_task_submissions.task_id and t.room_id=room_task_submissions.room_id
        and t.assigned_to_participant_id=room_task_submissions.submitted_by_participant_id
        and t.status='in_progress'
    )
  );

drop policy if exists room_task_reviews_human_insert on public.room_task_reviews;
create policy room_task_reviews_human_insert on public.room_task_reviews
  for insert to authenticated
  with check (
    (
      exists (
        select 1 from public.participants reviewer
        where reviewer.id=room_task_reviews.reviewer_participant_id
          and reviewer.room_id=room_task_reviews.room_id
          and reviewer.user_id=(select auth.uid())
          and reviewer.kind='human'
      )
      and (
        exists (
          select 1 from public.rooms r
          where r.id=room_task_reviews.room_id and r.owner_id=(select auth.uid())
        )
        or exists (
          select 1 from public.room_tasks t
          where t.id=room_task_reviews.task_id and t.room_id=room_task_reviews.room_id
            and t.created_by_participant_id=room_task_reviews.reviewer_participant_id
        )
      )
      and exists (
        select 1
        from public.room_task_submissions submission
        join public.room_tasks task on task.id=submission.task_id and task.room_id=submission.room_id
        where submission.id=room_task_reviews.submission_id
          and submission.task_id=room_task_reviews.task_id
          and submission.room_id=room_task_reviews.room_id
          and submission.submitted_by_participant_id<>room_task_reviews.reviewer_participant_id
          and task.status='review'
      )
    )
  );


-- Enforce participant-to-room integrity for trusted service_role inserts too.
create or replace function public.guard_room_task_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $task_identity_guard$
begin
  if not exists (
    select 1 from public.participants p
    where p.id=new.created_by_participant_id and p.room_id=new.room_id
  ) then raise exception 'Task creator must belong to the same group'; end if;
  if new.assigned_to_participant_id is not null and not exists (
    select 1 from public.participants p
    where p.id=new.assigned_to_participant_id and p.room_id=new.room_id
  ) then raise exception 'Task assignee must belong to the same group'; end if;
  return new;
end;
$task_identity_guard$;
revoke all on function public.guard_room_task_identity() from public, anon, authenticated;

drop trigger if exists room_tasks_guard_identity on public.room_tasks;
create trigger room_tasks_guard_identity
before insert or update of room_id, created_by_participant_id, assigned_to_participant_id on public.room_tasks
for each row execute function public.guard_room_task_identity();

-- Keep updated_at/version consistent regardless of whether an update came
-- from the authenticated UI, a trusted MCP operation, or a dependency release.
create or replace function public.touch_room_task()
returns trigger
language plpgsql
set search_path = ''
as $task_touch$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  new.version := old.version + 1;
  return new;
end;
$task_touch$;
revoke all on function public.touch_room_task() from public, anon, authenticated;

drop trigger if exists room_tasks_touch_updated_at on public.room_tasks;
create trigger room_tasks_touch_updated_at
before update on public.room_tasks
for each row execute function public.touch_room_task();

-- A dependency must connect tasks from the same group and must not introduce
-- a cycle. The creation RPC below is the normal write path, but the trigger is
-- defense in depth for trusted backend maintenance and future code.
create or replace function public.guard_room_task_dependency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $task_dependency_guard$
declare
  v_task_room uuid;
  v_prerequisite_room uuid;
  v_cycle boolean;
begin
  select t.room_id into v_task_room from public.room_tasks t where t.id = new.task_id;
  select t.room_id into v_prerequisite_room from public.room_tasks t where t.id = new.depends_on_task_id;
  if v_task_room is null or v_prerequisite_room is null
     or v_task_room <> v_prerequisite_room or new.room_id <> v_task_room then
    raise exception 'Task dependencies must stay inside the same group';
  end if;

  -- Serialize graph mutations within a room so two concurrent edge inserts
  -- cannot each pass cycle detection against a pre-commit snapshot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.room_id::text || ':room-task-dependency-graph',0)
  );

  with recursive dependency_path(task_id) as (
    select new.depends_on_task_id
    union
    select d.depends_on_task_id
    from public.room_task_dependencies d
    join dependency_path p on d.task_id = p.task_id
    where d.room_id = new.room_id
  )
  select exists(select 1 from dependency_path p where p.task_id = new.task_id) into v_cycle;
  if v_cycle then raise exception 'Task dependency would create a cycle'; end if;
  return new;
end;
$task_dependency_guard$;
revoke all on function public.guard_room_task_dependency() from public, anon, authenticated;

drop trigger if exists room_task_dependencies_guard on public.room_task_dependencies;
create trigger room_task_dependencies_guard
before insert or update on public.room_task_dependencies
for each row execute function public.guard_room_task_dependency();

-- Authenticated humans create a task and its prerequisites in one transaction.
-- The existing room, participant and RLS model remains authoritative.
create or replace function public.create_room_task(
  p_room_id uuid,
  p_created_by_participant_id uuid,
  p_title text,
  p_description text default '',
  p_expected_output text default '',
  p_assigned_to_participant_id uuid default null,
  p_dependency_ids uuid[] default '{}'::uuid[],
  p_priority smallint default 3,
  p_due_at timestamptz default null,
  p_acceptance_criteria jsonb default '[]'::jsonb,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $create_room_task$
declare
  v_task_id uuid;
  v_dependency_id uuid;
  v_status text;
  v_dependency_count integer;
  v_incomplete_count integer;
  v_failed_count integer;
  v_existing public.room_tasks%rowtype;
  v_requested_dependencies uuid[];
  v_request_fingerprint text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_room_id is null or p_created_by_participant_id is null
     or p_title is null or char_length(btrim(p_title)) not between 1 and 160
     or coalesce(char_length(p_description),0) > 12000
     or coalesce(char_length(p_expected_output),0) > 4000
     or p_priority is null or p_priority not between 1 and 5
     or p_idempotency_key is null then
    raise exception 'Invalid task details or idempotency key';
  end if;
  if p_acceptance_criteria is null
     or pg_catalog.jsonb_typeof(p_acceptance_criteria) <> 'array' then
    raise exception 'Acceptance criteria must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(p_acceptance_criteria) > 20 then
    raise exception 'A task may have at most 20 acceptance criteria';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_acceptance_criteria) as criteria(value)
    where pg_catalog.jsonb_typeof(criteria.value) <> 'string'
      or char_length(btrim(criteria.value #>> '{}')) not between 1 and 500
  ) then
    raise exception 'Each acceptance criterion must contain 1-500 characters';
  end if;

  if not exists (
    select 1 from public.participants p
    where p.id = p_created_by_participant_id and p.room_id = p_room_id
      and p.user_id = auth.uid() and p.kind = 'human'
  ) then
    raise exception 'A human group participant is required to create a task';
  end if;

  if p_assigned_to_participant_id is not null and not exists (
    select 1 from public.participants p
    where p.id = p_assigned_to_participant_id and p.room_id = p_room_id
  ) then
    raise exception 'Task assignee must belong to the same group';
  end if;

  if coalesce(cardinality(p_dependency_ids),0) > 20 then
    raise exception 'A task may have at most 20 prerequisites';
  end if;
  select count(*), count(distinct x.id)
    into v_dependency_count, v_incomplete_count
  from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) as x(id);
  if v_dependency_count <> v_incomplete_count then
    raise exception 'Task prerequisites must be unique';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) as x(id)
    where x.id is null
  ) then
    -- Null prerequisite IDs are invalid.
    raise exception 'Invalid task prerequisite';
  end if;

  select coalesce(array_agg(x.id order by x.id),'{}'::uuid[])
    into v_requested_dependencies
  from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) as x(id);

  v_request_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      p_room_id::text,
      p_created_by_participant_id::text,
      btrim(p_title),
      coalesce(p_description,''),
      coalesce(p_expected_output,''),
      v_requested_dependencies,
      p_priority,
      case when p_due_at is null then null
        else pg_catalog.to_char(p_due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
      p_acceptance_criteria
    )::text,
    'UTF8'
  )),'hex');

  -- Serialize retries using the same group/creator/key before the lookup,
  -- including when the first transaction has not yet committed its row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_room_id::text || ':' || p_created_by_participant_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  -- Compare immutable task requirements and the original requested assignee.
  -- The live assignee is mutable, so it must not make a safe create retry conflict.
  select t.* into v_existing
  from public.room_tasks t
  where t.room_id=p_room_id
    and t.created_by_participant_id=p_created_by_participant_id
    and t.idempotency_key=p_idempotency_key::text
  for update;
  if found then
    if v_existing.idempotency_fingerprint is distinct from v_request_fingerprint
       or v_existing.idempotency_initial_assignee_id is distinct from p_assigned_to_participant_id then
      raise exception 'Task idempotency key was reused with different creation input';
    end if;
    return v_existing.id;
  end if;

  select count(*) into v_dependency_count
  from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) as x(id)
  join public.room_tasks t on t.id = x.id and t.room_id = p_room_id;
  if v_dependency_count <> coalesce(cardinality(p_dependency_ids),0) then
    raise exception 'Every task prerequisite must belong to the same group';
  end if;

  select
    count(*) filter (where t.status <> 'completed'),
    count(*) filter (where t.status in ('failed','cancelled'))
  into v_incomplete_count,v_failed_count
  from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) as x(id)
  join public.room_tasks t on t.id = x.id and t.room_id = p_room_id;

  v_status := case
    when v_failed_count > 0 then 'blocked'
    when p_assigned_to_participant_id is not null and v_incomplete_count = 0 then 'assigned'
    else 'backlog'
  end;

  insert into public.room_tasks(
    room_id, created_by_participant_id, assigned_to_participant_id,
    title, description, expected_output, acceptance_criteria, priority, status, blocked_reason, due_at,
    idempotency_key, idempotency_initial_assignee_id, idempotency_fingerprint
  ) values (
    p_room_id, p_created_by_participant_id, p_assigned_to_participant_id,
    btrim(p_title), coalesce(p_description,''), coalesce(p_expected_output,''),
    p_acceptance_criteria, p_priority, v_status,
    case when v_failed_count > 0
      then 'One or more prerequisite tasks had already failed or been cancelled; revise the dependency plan.'
      else null end,
    p_due_at, p_idempotency_key::text, p_assigned_to_participant_id, v_request_fingerprint
  ) returning id into v_task_id;

  foreach v_dependency_id in array coalesce(p_dependency_ids,'{}'::uuid[]) loop
    insert into public.room_task_dependencies(
      room_id, task_id, depends_on_task_id, created_by_participant_id
    ) values (p_room_id, v_task_id, v_dependency_id, p_created_by_participant_id);
  end loop;

  return v_task_id;
end;
$create_room_task$;
revoke all on function public.create_room_task(uuid,uuid,text,text,text,uuid,uuid[],smallint,timestamptz,jsonb,uuid) from public, anon;
grant execute on function public.create_room_task(uuid,uuid,text,text,text,uuid,uuid[],smallint,timestamptz,jsonb,uuid) to authenticated;

-- Reassignment is available only to the group owner or the task's human creator.
-- Prerequisites control whether the new assignment is immediately executable.
create or replace function public.assign_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_assigned_to_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $assign_room_task$
declare
  v_task public.room_tasks%rowtype;
  v_actor_id uuid;
  v_owner boolean;
  v_incomplete integer;
  v_failed_prerequisites integer;
  v_status text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select p.id into v_actor_id from public.participants p
  where p.room_id = p_room_id and p.user_id = auth.uid() and p.kind = 'human'
  limit 1;
  if v_actor_id is null then raise exception 'Human group membership required'; end if;

  select t.* into v_task from public.room_tasks t
  where t.id = p_task_id and t.room_id = p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  select exists(select 1 from public.rooms r where r.id=p_room_id and r.owner_id=auth.uid())
    into v_owner;
  if not v_owner and v_task.created_by_participant_id <> v_actor_id then
    raise exception 'Only the task creator or group owner may reassign this task';
  end if;
  if v_task.status not in ('backlog','assigned','blocked') then
    raise exception 'Only backlog, assigned or blocked tasks can be reassigned';
  end if;
  if p_assigned_to_participant_id is not null and not exists (
    select 1 from public.participants p
    where p.id=p_assigned_to_participant_id and p.room_id=p_room_id
  ) then
    raise exception 'Task assignee must belong to the same group';
  end if;

  select
    count(*) filter (where prerequisite.status <> 'completed'),
    count(*) filter (where prerequisite.status in ('failed','cancelled'))
  into v_incomplete,v_failed_prerequisites
  from public.room_task_dependencies d
  join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
  where d.task_id=p_task_id;

  v_status := case
    when v_failed_prerequisites > 0 then 'blocked'
    when p_assigned_to_participant_id is not null and v_incomplete = 0 then 'assigned'
    else 'backlog'
  end;
  update public.room_tasks
  set assigned_to_participant_id=p_assigned_to_participant_id,
      status=v_status,
      blocked_reason=case when v_failed_prerequisites > 0
        then 'One or more prerequisite tasks failed or were cancelled; revise the dependency plan.'
        else null end
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('assigned',p_assigned_to_participant_id is not null,'task_id',p_task_id,'status',v_status);
end;
$assign_room_task$;
revoke all on function public.assign_room_task(uuid,uuid,uuid) from public, anon;
grant execute on function public.assign_room_task(uuid,uuid,uuid) to authenticated;


-- A blocked/backlog task can have its prerequisite plan repaired by its
-- human creator or group owner. The dependency graph lock serializes edits
-- with creation and other replacements; the row trigger remains the cycle guard.
create or replace function public.replace_room_task_dependencies(
  p_room_id uuid,
  p_task_id uuid,
  p_dependency_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $replace_room_task_dependencies$
declare
  v_task public.room_tasks%rowtype;
  v_actor_id uuid;
  v_owner boolean;
  v_total integer;
  v_unique integer;
  v_valid integer;
  v_incomplete integer;
  v_failed integer;
  v_status text;
  v_existing_dependencies uuid[];
  v_requested_dependencies uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_room_id is null or p_task_id is null or p_dependency_ids is null
     or cardinality(p_dependency_ids) > 20 then
    raise exception 'Invalid task dependency update';
  end if;

  select p.id into v_actor_id from public.participants p
  where p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  limit 1;
  if v_actor_id is null then raise exception 'Human group membership required'; end if;

  -- Serialize all graph edits in this room before inspecting or replacing edges.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_room_id::text || ':room-task-dependency-graph',0)
  );

  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;

  select exists(select 1 from public.rooms r where r.id=p_room_id and r.owner_id=auth.uid())
    into v_owner;
  if not v_owner and v_task.created_by_participant_id<>v_actor_id then
    raise exception 'Only the task creator or group owner may revise task prerequisites';
  end if;
  if v_task.status not in ('backlog','assigned','blocked') then
    raise exception 'Prerequisites cannot change after task work starts or enters review';
  end if;

  select count(*),count(distinct x.id)
  into v_total,v_unique
  from unnest(p_dependency_ids) as x(id);
  if v_total<>v_unique then raise exception 'Task prerequisites must be unique and non-null'; end if;
  if exists(select 1 from unnest(p_dependency_ids) as x(id) where x.id=p_task_id) then
    raise exception 'A task cannot depend on itself';
  end if;

  select count(*) into v_valid
  from unnest(p_dependency_ids) as x(id)
  join public.room_tasks prerequisite on prerequisite.id=x.id and prerequisite.room_id=p_room_id;
  if v_valid<>cardinality(p_dependency_ids) then
    raise exception 'Every task prerequisite must belong to the same group';
  end if;

  -- Compare canonical sorted sets before touching edges or the task row.
  -- A retry after an ambiguous network response must not bump version or
  -- produce a second Backroom task wake for an unchanged dependency plan.
  select coalesce(pg_catalog.array_agg(d.depends_on_task_id order by d.depends_on_task_id),'{}'::uuid[])
    into v_existing_dependencies
  from public.room_task_dependencies d
  where d.room_id=p_room_id and d.task_id=p_task_id;

  select coalesce(pg_catalog.array_agg(x.id order by x.id),'{}'::uuid[])
    into v_requested_dependencies
  from unnest(p_dependency_ids) as x(id);

  if v_existing_dependencies=v_requested_dependencies then
    select
      count(*) filter (where prerequisite.status<>'completed'),
      count(*) filter (where prerequisite.status in ('failed','cancelled'))
    into v_incomplete,v_failed
    from public.room_task_dependencies d
    join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
    where d.room_id=p_room_id and d.task_id=p_task_id;

    return jsonb_build_object(
      'updated',false,
      'replayed',true,
      'task_id',p_task_id,
      'status',v_task.status,
      'dependency_count',cardinality(v_existing_dependencies),
      'incomplete_prerequisites',v_incomplete,
      'failed_prerequisites',v_failed
    );
  end if;

  delete from public.room_task_dependencies
  where room_id=p_room_id and task_id=p_task_id;

  insert into public.room_task_dependencies(room_id,task_id,depends_on_task_id,created_by_participant_id)
  select p_room_id,p_task_id,x.id,v_actor_id
  from unnest(v_requested_dependencies) as x(id);

  select
    count(*) filter (where prerequisite.status<>'completed'),
    count(*) filter (where prerequisite.status in ('failed','cancelled'))
  into v_incomplete,v_failed
  from public.room_task_dependencies d
  join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
  where d.room_id=p_room_id and d.task_id=p_task_id;

  v_status := case
    when v_failed>0 then 'blocked'
    when v_incomplete>0 then 'backlog'
    when v_task.assigned_to_participant_id is not null then 'assigned'
    else 'backlog'
  end;

  update public.room_tasks
  set status=v_status,
      blocked_reason=case when v_failed>0
        then 'One or more prerequisite tasks failed or were cancelled; revise the dependency plan.'
        else null end
  where id=p_task_id and room_id=p_room_id;

  return jsonb_build_object(
    'updated',true,
    'task_id',p_task_id,
    'status',v_status,
    'dependency_count',cardinality(p_dependency_ids),
    'incomplete_prerequisites',v_incomplete,
    'failed_prerequisites',v_failed
  );
end;
$replace_room_task_dependencies$;
revoke all on function public.replace_room_task_dependencies(uuid,uuid,uuid[]) from public, anon;
grant execute on function public.replace_room_task_dependencies(uuid,uuid,uuid[]) to authenticated;

create or replace function public.cancel_room_task(
  p_room_id uuid,
  p_task_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $cancel_room_task$
declare
  v_task public.room_tasks%rowtype;
  v_actor_id uuid;
  v_owner boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select p.id into v_actor_id from public.participants p
  where p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  limit 1;
  if v_actor_id is null then raise exception 'Human group membership required'; end if;
  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  select exists(select 1 from public.rooms r where r.id=p_room_id and r.owner_id=auth.uid())
    into v_owner;
  if not v_owner and v_task.created_by_participant_id<>v_actor_id then
    raise exception 'Only the task creator or group owner may cancel this task';
  end if;
  if v_task.status='cancelled' then
    return jsonb_build_object('cancelled',true,'replayed',true,'task_id',p_task_id,'status','cancelled');
  end if;
  if v_task.status in ('completed','failed') then
    raise exception 'A completed or failed task cannot be cancelled';
  end if;
  update public.room_tasks set status='cancelled',blocked_reason=null
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('cancelled',true,'replayed',false,'task_id',p_task_id,'status','cancelled');
end;
$cancel_room_task$;
revoke all on function public.cancel_room_task(uuid,uuid) from public, anon;
grant execute on function public.cancel_room_task(uuid,uuid) to authenticated;

-- Human review is explicit. An AI cannot mark its own work completed.
create or replace function public.review_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_outcome text,
  p_feedback text default ''
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
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_outcome is null or p_outcome not in ('approved','revision_requested')
     or coalesce(char_length(p_feedback),0) > 12000 then
    raise exception 'Invalid task review';
  end if;
  select p.id into v_actor_id from public.participants p
  where p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  limit 1;
  if v_actor_id is null then raise exception 'Human group membership required'; end if;
  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  select exists(select 1 from public.rooms r where r.id=p_room_id and r.owner_id=auth.uid())
    into v_owner;
  if not v_owner and v_task.created_by_participant_id <> v_actor_id then
    raise exception 'Only the task creator or group owner may review this task';
  end if;
  select s.* into v_submission from public.room_task_submissions s
  where s.task_id=p_task_id and s.room_id=p_room_id
  order by s.created_at desc, s.id desc limit 1;
  if not found then raise exception 'Task has no submitted result to review'; end if;
  if v_submission.submitted_by_participant_id=v_actor_id then
    raise exception 'A participant cannot review its own task submission';
  end if;

  select r.* into v_existing from public.room_task_reviews r
  where r.submission_id=v_submission.id and r.reviewer_participant_id=v_actor_id;
  if found then
    if v_existing.outcome=p_outcome and v_existing.feedback=coalesce(p_feedback,'') then
      return jsonb_build_object('reviewed',true,'replayed',true,'task_id',p_task_id,'status',v_task.status);
    end if;
    raise exception 'This submission has already been reviewed; a new submission is required';
  end if;
  if v_task.status <> 'review' then raise exception 'Task is not awaiting review'; end if;

  insert into public.room_task_reviews(
    room_id,task_id,submission_id,reviewer_participant_id,outcome,feedback
  ) values (p_room_id,p_task_id,v_submission.id,v_actor_id,p_outcome,coalesce(p_feedback,''));

  if p_outcome='approved' then
    v_next_status := 'completed';
  else
    select count(*) into v_incomplete
    from public.room_task_dependencies d
    join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
    where d.task_id=p_task_id and prerequisite.status <> 'completed';
    v_next_status := case when v_task.assigned_to_participant_id is not null and v_incomplete=0
      then 'assigned' else 'backlog' end;
  end if;
  update public.room_tasks set status=v_next_status, blocked_reason=null
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('reviewed',true,'replayed',false,'task_id',p_task_id,'status',v_next_status);
end;
$review_room_task$;
revoke all on function public.review_room_task(uuid,uuid,text,text) from public, anon;
grant execute on function public.review_room_task(uuid,uuid,text,text) to authenticated;


-- Human assignees participate in the same task lifecycle without receiving an
-- AI service credential. These invoker functions rely on the caller's JWT/RLS.
create or replace function public.claim_room_task_human(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $claim_room_task_human$
declare
  v_task public.room_tasks%rowtype;
  v_incomplete integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  ) then raise exception 'Authenticated human participant required'; end if;
  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  if v_task.assigned_to_participant_id is not null and v_task.assigned_to_participant_id<>p_participant_id then
    raise exception 'Task is assigned to another participant';
  end if;
  if v_task.status='in_progress' and v_task.assigned_to_participant_id=p_participant_id then
    return jsonb_build_object('claimed',true,'replayed',true,'task_id',p_task_id,'status','in_progress');
  end if;
  if v_task.status not in ('backlog','assigned') then raise exception 'Task is not available to claim'; end if;
  select count(*) into v_incomplete from public.room_task_dependencies d
    join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
    where d.task_id=p_task_id and prerequisite.status<>'completed';
  if v_incomplete>0 then return jsonb_build_object('claimed',false,'reason','dependencies_incomplete'); end if;
  update public.room_tasks set assigned_to_participant_id=p_participant_id,status='in_progress',blocked_reason=null
    where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('claimed',true,'replayed',false,'task_id',p_task_id,'status','in_progress');
end;
$claim_room_task_human$;
revoke all on function public.claim_room_task_human(uuid,uuid,uuid) from public, anon;
grant execute on function public.claim_room_task_human(uuid,uuid,uuid) to authenticated;

create or replace function public.submit_room_task_result_human(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid,
  p_result_content text,
  p_source_message_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $submit_room_task_result_human$
declare
  v_task public.room_tasks%rowtype;
  v_submission public.room_task_submissions%rowtype;
  v_count integer;
  v_unique integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.user_id=auth.uid() and p.kind='human'
  ) then raise exception 'Authenticated human participant required'; end if;
  if p_result_content is null or char_length(btrim(p_result_content)) not between 1 and 20000
    or p_idempotency_key is null then raise exception 'Invalid task result'; end if;
  if coalesce(cardinality(p_source_message_ids),0)>50 then raise exception 'At most 50 source messages may be attached'; end if;
  select count(*),count(distinct x.id) into v_count,v_unique
    from unnest(coalesce(p_source_message_ids,'{}'::uuid[])) as x(id);
  if v_count<>v_unique then raise exception 'Source message IDs must be unique'; end if;
  if exists (
    select 1 from unnest(coalesce(p_source_message_ids,'{}'::uuid[])) as x(id)
    where not exists (select 1 from public.messages m where m.id=x.id and m.room_id=p_room_id)
  ) then raise exception 'Every source message must belong to this group'; end if;

  select t.* into v_task from public.room_tasks t
    where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_task_id::text || ':' || p_participant_id::text || ':' || p_idempotency_key::text,0)
  );
  select s.* into v_submission from public.room_task_submissions s
    where s.task_id=p_task_id and s.submitted_by_participant_id=p_participant_id
      and s.idempotency_key=p_idempotency_key;
  if found then
    if v_submission.result_content<>p_result_content then raise exception 'Task result idempotency key conflict'; end if;
    return jsonb_build_object('submitted',true,'replayed',true,'submission_id',v_submission.id,'task_id',p_task_id,'status',v_task.status);
  end if;
  if v_task.assigned_to_participant_id<>p_participant_id or v_task.status<>'in_progress' then
    raise exception 'Only the assigned participant can submit a result for an in-progress task';
  end if;
  insert into public.room_task_submissions(
    room_id,task_id,submitted_by_participant_id,result_content,source_message_ids,idempotency_key
  ) values (
    p_room_id,p_task_id,p_participant_id,btrim(p_result_content),coalesce(p_source_message_ids,'{}'::uuid[]),p_idempotency_key
  ) returning * into v_submission;
  update public.room_tasks set status='review',blocked_reason=null where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('submitted',true,'replayed',false,'submission_id',v_submission.id,'task_id',p_task_id,'status','review');
end;
$submit_room_task_result_human$;
revoke all on function public.submit_room_task_result_human(uuid,uuid,uuid,text,uuid[],uuid) from public, anon;
grant execute on function public.submit_room_task_result_human(uuid,uuid,uuid,text,uuid[],uuid) to authenticated;

-- Trusted MCP task operations. The MCP Edge Function has already verified the
-- opaque session handle, live participant credential, group and expiry before
-- calling these service_role-only operations.
create or replace function public.claim_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $claim_room_task$
declare
  v_task public.room_tasks%rowtype;
  v_incomplete integer;
begin
  if p_room_id is null or p_task_id is null or p_participant_id is null then
    raise exception 'Room, task and participant are required';
  end if;
  if not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then raise exception 'Active AI group participant required'; end if;

  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  if v_task.assigned_to_participant_id is null then
    raise exception 'A human group member must assign this task before an AI can claim it';
  end if;
  if v_task.assigned_to_participant_id <> p_participant_id then
    raise exception 'Task is assigned to another participant';
  end if;
  if v_task.status='in_progress' and v_task.assigned_to_participant_id=p_participant_id then
    return jsonb_build_object('claimed',true,'replayed',true,'task_id',p_task_id,'status','in_progress');
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

  update public.room_tasks
  set assigned_to_participant_id=p_participant_id,status='in_progress',blocked_reason=null
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('claimed',true,'replayed',false,'task_id',p_task_id,'status','in_progress');
end;
$claim_room_task$;


create or replace function public.fail_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fail_room_task$
declare
  v_task public.room_tasks%rowtype;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 2000 then
    raise exception 'A 1-2000 character failure reason is required';
  end if;
  if not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then raise exception 'Active AI group participant required'; end if;
  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;
  if v_task.status='failed' and v_task.assigned_to_participant_id=p_participant_id
     and v_task.blocked_reason=btrim(p_reason) then
    return jsonb_build_object('failed',true,'replayed',true,'task_id',p_task_id,'status','failed');
  end if;
  if v_task.assigned_to_participant_id<>p_participant_id or v_task.status not in ('assigned','in_progress','blocked') then
    raise exception 'Only the assigned participant can fail an active task';
  end if;
  update public.room_tasks set status='failed',blocked_reason=btrim(p_reason)
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('failed',true,'replayed',false,'task_id',p_task_id,'status','failed');
end;
$fail_room_task$;
revoke all on function public.fail_room_task(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.fail_room_task(uuid,uuid,uuid,text) to service_role;

create or replace function public.block_room_task(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $block_room_task$
declare v_changed integer;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 2000 then
    raise exception 'A 1-2000 character blocking reason is required';
  end if;
  if not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then raise exception 'Active AI group participant required'; end if;
  update public.room_tasks
  set status='blocked',blocked_reason=btrim(p_reason)
  where id=p_task_id and room_id=p_room_id
    and assigned_to_participant_id=p_participant_id
    and status in ('assigned','in_progress');
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then raise exception 'Only the assigned participant can block an active task'; end if;
  return jsonb_build_object('blocked',true,'task_id',p_task_id,'status','blocked');
end;
$block_room_task$;

create or replace function public.submit_room_task_result(
  p_room_id uuid,
  p_task_id uuid,
  p_participant_id uuid,
  p_result_content text,
  p_source_message_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $submit_room_task_result$
declare
  v_task public.room_tasks%rowtype;
  v_submission public.room_task_submissions%rowtype;
  v_count integer;
  v_unique integer;
begin
  if p_result_content is null or char_length(btrim(p_result_content)) not between 1 and 20000
     or p_idempotency_key is null then raise exception 'Invalid task result'; end if;
  if not exists (
    select 1 from public.participants p where p.id=p_participant_id
      and p.room_id=p_room_id and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then raise exception 'Active AI group participant required'; end if;
  if coalesce(cardinality(p_source_message_ids),0) > 50 then raise exception 'At most 50 source messages may be attached'; end if;
  select count(*),count(distinct x.id) into v_count,v_unique
  from unnest(coalesce(p_source_message_ids,'{}'::uuid[])) as x(id);
  if v_count <> v_unique then raise exception 'Source message IDs must be unique'; end if;
  if exists (
    select 1 from unnest(coalesce(p_source_message_ids,'{}'::uuid[])) as x(id)
    where not exists (select 1 from public.messages m where m.id=x.id and m.room_id=p_room_id)
  ) then raise exception 'Every source message must belong to this group'; end if;

  select t.* into v_task from public.room_tasks t
  where t.id=p_task_id and t.room_id=p_room_id for update;
  if not found then raise exception 'Task not found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_task_id::text || ':' || p_participant_id::text || ':' || p_idempotency_key::text,0)
  );
  select s.* into v_submission from public.room_task_submissions s
  where s.task_id=p_task_id and s.submitted_by_participant_id=p_participant_id
    and s.idempotency_key=p_idempotency_key;
  if found then
    if v_submission.result_content<>p_result_content then
      raise exception 'Task result idempotency key was reused with different content';
    end if;
    return jsonb_build_object('submitted',true,'replayed',true,'submission_id',v_submission.id,'task_id',p_task_id,'status',v_task.status);
  end if;

  if v_task.assigned_to_participant_id<>p_participant_id or v_task.status<>'in_progress' then
    raise exception 'Only the assigned participant can submit a result for an in-progress task';
  end if;
  insert into public.room_task_submissions(
    room_id,task_id,submitted_by_participant_id,result_content,source_message_ids,idempotency_key
  ) values (
    p_room_id,p_task_id,p_participant_id,btrim(p_result_content),
    coalesce(p_source_message_ids,'{}'::uuid[]),p_idempotency_key
  ) returning * into v_submission;

  update public.room_tasks set status='review',blocked_reason=null
  where id=p_task_id and room_id=p_room_id;
  return jsonb_build_object('submitted',true,'replayed',false,'submission_id',v_submission.id,'task_id',p_task_id,'status','review');
end;
$submit_room_task_result$;

revoke all on function public.claim_room_task(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.block_room_task(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.submit_room_task_result(uuid,uuid,uuid,text,uuid[],uuid) from public, anon, authenticated;
grant execute on function public.claim_room_task(uuid,uuid,uuid) to service_role;
grant execute on function public.block_room_task(uuid,uuid,uuid,text) to service_role;
grant execute on function public.submit_room_task_result(uuid,uuid,uuid,text,uuid[],uuid) to service_role;

-- When a prerequisite is approved, make dependent assigned tasks ready. The
-- ordinary task assignment trigger below then uses the existing durable queue.
create or replace function public.release_room_task_dependents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $release_task_dependents$
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    update public.room_tasks t
    set status='assigned',blocked_reason=null
    where t.status='backlog'
      and t.assigned_to_participant_id is not null
      and exists (
        select 1 from public.room_task_dependencies d
        where d.task_id=t.id and d.depends_on_task_id=new.id
      )
      and not exists (
        select 1 from public.room_task_dependencies d
        join public.room_tasks prerequisite on prerequisite.id=d.depends_on_task_id
        where d.task_id=t.id and prerequisite.status<>'completed'
      );
  elsif new.status in ('failed','cancelled') and old.status is distinct from new.status then
    update public.room_tasks t
    set status='blocked',
        blocked_reason='Prerequisite task '||new.id::text||' was '||new.status||'; review the dependency plan before continuing.'
    where t.status in ('backlog','assigned')
      and exists (
        select 1 from public.room_task_dependencies d
        where d.task_id=t.id and d.depends_on_task_id=new.id
      );
  end if;
  return new;
end;
$release_task_dependents$;
revoke all on function public.release_room_task_dependents() from public, anon, authenticated;

drop trigger if exists room_tasks_release_dependents on public.room_tasks;
create trigger room_tasks_release_dependents
after update of status on public.room_tasks
for each row execute function public.release_room_task_dependents();

-- Task-mode wake is a task event source, not a message-mode extension. It
-- enqueues the same fixed @RMconnects prompt into the existing private queue.
-- No task description, deliverable, or message body is copied into the prompt.
create or replace function public.enqueue_backroom_wake_for_assigned_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $task_wake$
declare
  v_binding record;
  v_stale_job record;
  v_event_id text;
  v_event_prefix text;
  v_prompt text;
  v_job_key text;
begin
  if tg_op='UPDATE' then
    -- A successful claim is the AI's acknowledgement of the task wake; do not
    -- cancel the currently leased @RMconnects delivery while that wake is in
    -- flight. Submission/review or terminal state changes still clean it up.
    if old.status='assigned' and new.status='in_progress'
      and old.assigned_to_participant_id is not distinct from new.assigned_to_participant_id
      and old.title is not distinct from new.title
      and old.description is not distinct from new.description
      and old.expected_output is not distinct from new.expected_output
      and old.acceptance_criteria is not distinct from new.acceptance_criteria
      and old.priority is not distinct from new.priority
      and old.due_at is not distinct from new.due_at then
      return new;
    end if;
    if old.status is not distinct from new.status
      and old.assigned_to_participant_id is not distinct from new.assigned_to_participant_id
      and old.title is not distinct from new.title
      and old.description is not distinct from new.description
      and old.expected_output is not distinct from new.expected_output
      and old.acceptance_criteria is not distinct from new.acceptance_criteria
      and old.priority is not distinct from new.priority
      and old.due_at is not distinct from new.due_at then
      return new;
    end if;

    -- Assignment, content or lifecycle changed: cancel every still-pending
    -- wake for the previous task version/assignee before considering a new one.
    if old.assigned_to_participant_id is not null then
      v_event_prefix := 'task_'||new.id::text||'_v';
      for v_stale_job in
        select j.id,j.owner_id
        from public.backroom_wake_jobs j
        where j.room_id=new.room_id
          and j.participant_id=old.assigned_to_participant_id
          and pg_catalog.left(j.event_id,pg_catalog.char_length(v_event_prefix))=v_event_prefix
          and j.state in ('pending','leased')
      loop
        perform public.cancel_backroom_wake_job(v_stale_job.id,v_stale_job.owner_id);
      end loop;
    end if;
  end if;

  if new.status<>'assigned' or new.assigned_to_participant_id is null then return new; end if;

  v_event_id := 'task_'||new.id::text||'_v'||new.version::text;
  v_prompt := '@RMconnects'||pg_catalog.chr(10)||'Event: '||v_event_id||pg_catalog.chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.';

  for v_binding in
    select b.*
    from public.backroom_input_bindings b
    join public.participants p on p.id=b.participant_id and p.room_id=b.room_id
    join public.rooms r on r.id=b.room_id and r.owner_id=b.owner_id
    join public.agent_connections a on a.room_id=r.id and a.participant_id=p.id
      and a.owner_id=r.owner_id and a.revoked_at is null
      and a.expires_at>pg_catalog.clock_timestamp()
    join public.rub_minds_mcp_sessions s on s.session_digest=b.session_digest
      and s.room_id=b.room_id and s.participant_id=p.id
      and s.agent_credential_ciphertext is not null and s.terminated_at is null
      and s.expires_at>pg_catalog.clock_timestamp()
    where b.room_id=new.room_id
      and b.participant_id=new.assigned_to_participant_id
      and b.participation_mode='task'
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
      and b.wake_enabled=true and b.confirmed_at is not null
      and b.wake_expires_at>pg_catalog.clock_timestamp()
      and b.revoked_at is null
  loop
    v_job_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        new.room_id::text,new.id::text,new.version::text,
        v_binding.participant_id::text,v_binding.id::text
      )::text,'UTF8')),'hex');
    begin
      perform public.enqueue_backroom_wake_job(
        v_job_key,v_binding.owner_id,new.room_id,v_binding.participant_id,
        v_binding.host_id,v_binding.space_id,v_binding.session_id,v_binding.session_digest,
        v_binding.id,v_binding.target_id,v_binding.target_identity_fingerprint,v_binding.target_revision,
        v_event_id,v_prompt,3600
      );
    exception when others then
      -- A task remains assigned even if its optional host wake cannot be queued.
      -- The participant can still read the task through MCP when it reconnects.
      raise warning 'Backroom task wake skipped: sqlstate %, task id %, binding id %',
        SQLSTATE,new.id,v_binding.id;
    end;
  end loop;
  return new;
end;
$task_wake$;
revoke all on function public.enqueue_backroom_wake_for_assigned_task() from public, anon, authenticated;

drop trigger if exists room_tasks_enqueue_backroom_wake_after_assignment on public.room_tasks;
create trigger room_tasks_enqueue_backroom_wake_after_assignment
after insert or update on public.room_tasks
for each row execute function public.enqueue_backroom_wake_for_assigned_task();

comment on table public.room_tasks is
  'Durable group tasks linked to existing rooms and participants; task assignments may wake an authorized original AI session through the existing Backroom queue.';
comment on table public.room_task_dependencies is
  'Directed prerequisite edges between tasks in the same room; cycles are rejected.';
comment on table public.room_task_submissions is
  'Versioned task deliverables submitted by the assigned participant through the authenticated MCP service.';
comment on table public.room_task_reviews is
  'Human approval or revision decisions for a specific task submission.';
