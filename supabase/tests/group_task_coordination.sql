-- Native PostgreSQL 17 acceptance for the additive group-task migration.
-- Run after 20261029090000_backroom_wake_queue.sql and
-- 20261101040000_group_task_coordination.sql in the isolated CI database.

do $task_test$
declare
  v_owner uuid := '22000000-0000-4000-8000-000000000001';
  v_human uuid := '33000000-0000-4000-8000-000000000001';
  v_human_reviewer uuid := '33000000-0000-4000-8000-000000000002';
  v_ai_one uuid := '33000000-0000-4000-8000-000000000003';
  v_ai_two uuid := '33000000-0000-4000-8000-000000000004';
  v_room uuid := '11000000-0000-4000-8000-000000000001';
  v_ai_host text := '44000000-0000-4000-8000-000000000001';
  v_ai_two_host text := '44000000-0000-4000-8000-000000000002';
  v_ai_session text := repeat('9',64);
  v_ai_two_session text := repeat('0',64);
  v_human_task uuid;
  v_fingerprint_task uuid;
  v_dependent_task uuid;
  v_ai_reassignment_task uuid;
  v_fail_parent uuid;
  v_fail_child uuid;
  v_failed_created_child uuid;
  v_cycle_parent uuid;
  v_cycle_child uuid;
  v_self_review_task uuid;
  v_replay uuid;
  v_submission uuid;
  v_status text;
  v_count integer;
  v_job_old uuid;
  v_job_new uuid;
  v_claimed_task_job uuid;
  v_repaired_job uuid;
  v_dependency_result jsonb;
  v_task_version_before integer;
  v_task_version_after integer;
  v_conflict boolean := false;
  v_claim jsonb;
begin
  insert into auth.users(id) values
    (v_owner),(v_human),(v_human_reviewer)
  on conflict (id) do nothing;

  insert into public.rooms(id,owner_id,title,objective)
  values (v_room,v_owner,'Task coordination CI','Exercise existing group task and Backroom infrastructure');

  insert into public.participants(id,room_id,user_id,display_name,kind,status)
  values
    (v_owner,v_room,v_owner,'Owner','human','connected'),
    (v_human,v_room,v_human,'Human assignee','human','connected'),
    (v_human_reviewer,v_room,v_human_reviewer,'Human reviewer','human','connected'),
    (v_ai_one,v_room,null,'AI one','original_session','active'),
    (v_ai_two,v_room,null,'AI two','original_session','active');

  -- Exact hosted MCP session + agent connection + existing Backroom host/binding.
  insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at,revoked_at)
  values
    (v_room,v_ai_one,v_owner,repeat('c',64),pg_catalog.clock_timestamp()+interval '1 hour',null),
    (v_room,v_ai_two,v_owner,repeat('d',64),pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.rub_minds_mcp_sessions(session_digest,agent_credential_ciphertext,room_id,participant_id,expires_at,terminated_at)
  values
    (v_ai_session,'ci-ai-one',v_room,v_ai_one,pg_catalog.clock_timestamp()+interval '1 hour',null),
    (v_ai_two_session,'ci-ai-two',v_room,v_ai_two,pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at,revoked_at)
  values
    (v_ai_host,v_owner,repeat('e',64),pg_catalog.clock_timestamp()+interval '1 hour',null),
    (v_ai_two_host,v_owner,repeat('f',64),pg_catalog.clock_timestamp()+interval '1 hour',null);

  insert into public.backroom_input_bindings(
    owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,
    target_identity_fingerprint,target_revision,surface,locator_kind,locator_value,
    participation_mode,wake_enabled,wake_grant_id,wake_expires_at,max_wakes_per_minute,
    confirmed_at,revoked_at
  ) values
    (v_owner,v_room,v_ai_one,v_ai_host,v_ai_session,'space-one','session-one','target-one',
     'fingerprint-one',1,'browser_tab','dom','composer-one','task',true,
     '77000000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp()+interval '1 hour',
     6,pg_catalog.clock_timestamp(),null),
    (v_owner,v_room,v_ai_two,v_ai_two_host,v_ai_two_session,'space-two','session-two','target-two',
     'fingerprint-two',1,'browser_tab','dom','composer-two','task',true,
     '77000000-0000-4000-8000-000000000002',pg_catalog.clock_timestamp()+interval '1 hour',
     6,pg_catalog.clock_timestamp(),null);

  -- Human B creates a task; same-key replay returns the same row.
  perform pg_catalog.set_config('request.jwt.claim.sub',v_human::text,true);
  v_human_task := public.create_room_task(
    v_room,v_human,'Implement prerequisite','Do the prerequisite work','A tested prerequisite',
    v_human,'{}'::uuid[],2::smallint,null,'["Tests pass","Evidence attached"]'::jsonb,
    '88000000-0000-4000-8000-000000000001'
  );
  v_replay := public.create_room_task(
    v_room,v_human,'Implement prerequisite','Do the prerequisite work','A tested prerequisite',
    v_human,'{}'::uuid[],2::smallint,null,'["Tests pass","Evidence attached"]'::jsonb,
    '88000000-0000-4000-8000-000000000001'
  );
  if v_replay<>v_human_task then raise exception 'Idempotent task create did not return the same task ID'; end if;
  v_conflict := false;
  begin
    perform public.create_room_task(
      v_room,v_human,'Implement prerequisite','Do the prerequisite work','A tested prerequisite',
      v_ai_one,'{}'::uuid[],2::smallint,null,'["Tests pass","Evidence attached"]'::jsonb,
      '88000000-0000-4000-8000-000000000001'
    );
  exception when others then
    if sqlerrm not like 'Task idempotency key was reused with different creation input%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Reusing a task key with a different initial assignee must fail'; end if;
  v_conflict := false;
  begin
    perform public.create_room_task(
      v_room,v_human,'Different title','Do the prerequisite work','A tested prerequisite',
      v_human,'{}'::uuid[],2::smallint,null,'["Tests pass","Evidence attached"]'::jsonb,
      '88000000-0000-4000-8000-000000000001'
    );
  exception when others then
    if sqlerrm not like 'Task idempotency key was reused with different creation input%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Reusing a task key with different content must fail'; end if;

  -- A create retry must still resolve to the original task after mutable
  -- assignment state has changed.
  v_fingerprint_task := public.create_room_task(
    v_room,v_human,'Retry after reassignment','','',v_human,'{}'::uuid[],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000009'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',v_owner::text,true);
  perform public.assign_room_task(v_room,v_fingerprint_task,v_ai_one);
  perform pg_catalog.set_config('request.jwt.claim.sub',v_human::text,true);
  v_replay := public.create_room_task(
    v_room,v_human,'Retry after reassignment','','',v_human,'{}'::uuid[],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000009'
  );
  if v_replay<>v_fingerprint_task then
    raise exception 'A create retry after reassignment must return the same task ID';
  end if;
  if (select idempotency_initial_assignee_id from public.room_tasks where id=v_fingerprint_task)<>v_human then
    raise exception 'Task idempotency must retain the original assignee request';
  end if;
  if (select assigned_to_participant_id from public.room_tasks where id=v_fingerprint_task)<>v_ai_one then
    raise exception 'A create retry must not revert a subsequent assignee change';
  end if;

  -- A task assigned to AI one waits until the human prerequisite is approved.
  v_dependent_task := public.create_room_task(
    v_room,v_human,'Analyze completed prerequisite','Use the approved prerequisite',
    'An evidence-backed analysis',v_ai_one,array[v_human_task],1::smallint,null,
    '["Cite the prerequisite","Explain limitations"]'::jsonb,
    '88000000-0000-4000-8000-000000000002'
  );
  select status into v_status from public.room_tasks where id=v_dependent_task;
  if v_status<>'backlog' then raise exception 'A task with an incomplete prerequisite must remain in backlog'; end if;
  if exists(select 1 from public.backroom_wake_jobs where room_id=v_room and event_id like 'task_'||v_dependent_task::text||'_%') then
    raise exception 'A task with an incomplete prerequisite must not wake its assignee';
  end if;

  -- Human assignee claims and submits. A different human reviewer requests
  -- revision, the assignee resubmits, and only human review completes it.
  perform pg_catalog.set_config('request.jwt.claim.sub',v_human::text,true);
  perform public.claim_room_task_human(v_room,v_human_task,v_human);
  select public.submit_room_task_result_human(
    v_room,v_human_task,v_human,'First deliverable', '{}'::uuid[],
    '99000000-0000-4000-8000-000000000001'
  )->>'submission_id' into v_submission;
  select status into v_status from public.room_tasks where id=v_human_task;
  if v_status<>'review' then raise exception 'Human submission must enter review'; end if;

  perform pg_catalog.set_config('request.jwt.claim.sub',v_human_reviewer::text,true);
  v_conflict := false;
  begin
    perform public.review_room_task(v_room,v_human_task,'approved','Self-review is not allowed','[]'::jsonb);
  exception when others then
    if sqlerrm not like 'Only the task creator or group owner may review this task%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Unrelated human must not approve a task'; end if;

  -- Database-side review validation must reject incomplete evidence and any
  -- approval that marks a required criterion as unmet.
  perform pg_catalog.set_config('request.jwt.claim.sub',v_owner::text,true);
  v_conflict := false;
  begin
    perform public.review_room_task(v_room,v_human_task,'approved','Missing evidence','[]'::jsonb);
  exception when others then
    if sqlerrm not like 'Evidence must cover every acceptance criterion exactly once and in order%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Review must include evidence for every criterion'; end if;
  v_conflict := false;
  begin
    perform public.review_room_task(
      v_room,v_human_task,'approved','Criterion still unmet',
      '[{"criterion":"Tests pass","met":true,"evidence":"CI run 123 passed"},{"criterion":"Evidence attached","met":false,"evidence":"Source proof is missing"}]'::jsonb
    );
  exception when others then
    if sqlerrm not like 'A task cannot be approved while any acceptance criterion is unmet%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Unmet acceptance criteria must block approval'; end if;
  if (select status from public.room_tasks where id=v_human_task)<>'review' then
    raise exception 'Rejected reviews must leave the task awaiting review';
  end if;

  perform public.review_room_task(
    v_room,v_human_task,'revision_requested','Add the missing evidence',
    '[{"criterion":"Tests pass","met":true,"evidence":"CI run 123 passed"},{"criterion":"Evidence attached","met":false,"evidence":"Source proof is missing"}]'::jsonb
  );
  select status into v_status from public.room_tasks where id=v_human_task;
  if v_status<>'assigned' then raise exception 'Revision request should return the task to assigned'; end if;
  if not exists (
    select 1 from public.room_task_reviews r
    where r.task_id=v_human_task
      and r.criterion_evidence='[{"criterion":"Tests pass","met":true,"evidence":"CI run 123 passed"},{"criterion":"Evidence attached","met":false,"evidence":"Source proof is missing"}]'::jsonb
  ) then raise exception 'Criterion-level review evidence must be persisted with the decision'; end if;

  perform pg_catalog.set_config('request.jwt.claim.sub',v_human::text,true);
  perform public.claim_room_task_human(v_room,v_human_task,v_human);
  perform public.submit_room_task_result_human(
    v_room,v_human_task,v_human,'Revised deliverable with evidence', '{}'::uuid[],
    '99000000-0000-4000-8000-000000000002'
  );
  perform pg_catalog.set_config('request.jwt.claim.sub',v_owner::text,true);
  perform public.review_room_task(
    v_room,v_human_task,'approved','Acceptance criteria met',
    '[{"criterion":"Tests pass","met":true,"evidence":"CI run 124 passed"},{"criterion":"Evidence attached","met":true,"evidence":"Artifact attached to the submission"}]'::jsonb
  );
  select status into v_status from public.room_tasks where id=v_human_task;
  if v_status<>'completed' then raise exception 'Only an approved human review completes a task'; end if;
  if not exists (
    select 1 from public.room_task_reviews r
    where r.task_id=v_human_task and r.outcome='approved'
      and jsonb_array_length(r.criterion_evidence)=2
  ) then raise exception 'Approval must retain evidence for every acceptance criterion'; end if;

  -- A retry with the same complete payload is idempotent; changing evidence
  -- cannot silently rewrite an already recorded review.
  v_claim := public.review_room_task(
    v_room,v_human_task,'approved','Acceptance criteria met',
    '[{"criterion":"Tests pass","met":true,"evidence":"CI run 124 passed"},{"criterion":"Evidence attached","met":true,"evidence":"Artifact attached to the submission"}]'::jsonb
  );
  if v_claim->>'replayed'<>'true' then raise exception 'An identical review retry must be idempotent'; end if;

  -- Completion releases the dependent AI task. The task event trigger calls
  -- the existing durable queue, using the same canonical @RMconnects prompt.
  select status into v_status from public.room_tasks where id=v_dependent_task;
  if v_status<>'assigned' then raise exception 'Completed prerequisite must release its dependent task'; end if;
  select id into v_job_old from public.backroom_wake_jobs
  where room_id=v_room and participant_id=v_ai_one
    and event_id='task_'||v_dependent_task::text||'_v2'
  order by created_at desc limit 1;
  if v_job_old is null then raise exception 'Ready AI task must enqueue through the existing durable wake queue'; end if;
  if (select prompt from public.backroom_wake_jobs where id=v_job_old)
      <> '@RMconnects'||pg_catalog.chr(10)||'Event: task_'||v_dependent_task::text||'_v2'||pg_catalog.chr(10)||
        'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.' then
    raise exception 'Task wake prompt must remain the fixed canonical prompt';
  end if;

  -- Reassignment cancels the previous participant's pending wake and enqueues
  -- the new participant's target. Cancellation of the task cancels that wake.
  perform public.assign_room_task(v_room,v_dependent_task,v_ai_two);
  select state into v_status from public.backroom_wake_jobs where id=v_job_old;
  if v_status<>'cancelled' then raise exception 'Reassignment must cancel the previous participant wake'; end if;
  select id into v_job_new from public.backroom_wake_jobs
  where room_id=v_room and participant_id=v_ai_two
    and event_id like 'task_'||v_dependent_task::text||'_%'
  order by created_at desc limit 1;
  if v_job_new is null then raise exception 'Reassignment must enqueue a wake for the new task assignee'; end if;
  perform public.cancel_room_task(v_room,v_dependent_task);
  select state into v_status from public.backroom_wake_jobs where id=v_job_new;
  if v_status<>'cancelled' then raise exception 'Task cancellation must cancel its pending Backroom wake'; end if;

  -- Dependency cycles are rejected even when a trusted backend attempts a
  -- direct dependency insert.
  v_cycle_parent := public.create_room_task(
    v_room,v_owner,'Cycle parent','','',null,'{}'::uuid[],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000003'
  );
  v_cycle_child := public.create_room_task(
    v_room,v_owner,'Cycle child','','',null,array[v_cycle_parent],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000004'
  );
  v_conflict := false;
  begin
    insert into public.room_task_dependencies(room_id,task_id,depends_on_task_id,created_by_participant_id)
    values(v_room,v_cycle_parent,v_cycle_child,v_owner);
  exception when others then
    if sqlerrm not like 'Task dependency would create a cycle%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Task dependency cycle must be rejected'; end if;

  -- A participant cannot review its own submission, even when it created the task.
  perform pg_catalog.set_config('request.jwt.claim.sub',v_human::text,true);
  v_self_review_task := public.create_room_task(
    v_room,v_human,'No self review','','',v_human,'{}'::uuid[],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000005'
  );
  perform public.claim_room_task_human(v_room,v_self_review_task,v_human);
  perform public.submit_room_task_result_human(
    v_room,v_self_review_task,v_human,'My own submission','{}'::uuid[],
    '99000000-0000-4000-8000-000000000003'
  );
  v_conflict := false;
  begin
    perform public.review_room_task(v_room,v_self_review_task,'approved','Trying to approve my own work');
  exception when others then
    if sqlerrm not like 'A participant cannot review its own task submission%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'Task submitter must not approve their own work'; end if;

  -- A failed AI prerequisite blocks all dependent tasks, and its still-pending
  -- wake is cancelled through the existing queue cancellation RPC.
  perform pg_catalog.set_config('request.jwt.claim.sub',v_owner::text,true);
  v_fail_parent := public.create_room_task(
    v_room,v_owner,'AI task that fails','','',v_ai_one,'{}'::uuid[],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000006'
  );
  v_fail_child := public.create_room_task(
    v_room,v_owner,'Blocked child','','',v_ai_two,array[v_fail_parent],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000007'
  );
  if (select status from public.room_tasks where id=v_fail_child)<>'backlog' then
    raise exception 'Dependent task should begin in backlog';
  end if;
  select id into v_claimed_task_job from public.backroom_wake_jobs
  where room_id=v_room and participant_id=v_ai_one
    and event_id='task_'||v_fail_parent::text||'_v1'
  order by created_at desc limit 1;
  if v_claimed_task_job is null then raise exception 'Assigned AI task must enqueue its wake'; end if;
  perform public.claim_room_task(v_room,v_fail_parent,v_ai_one);
  select state into v_status from public.backroom_wake_jobs where id=v_claimed_task_job;
  if v_status='cancelled' then
    raise exception 'An AI task claim must not cancel its still-leased canonical wake before host acknowledgement';
  end if;
  v_conflict := false;
  begin
    perform public.assign_room_task(v_room,v_fail_parent,v_ai_two);
  exception when others then
    if sqlerrm not like 'Only backlog, assigned or blocked tasks can be reassigned%' then raise; end if;
    v_conflict := true;
  end;
  if not v_conflict then raise exception 'An in-progress task must not be reassigned to another participant'; end if;

  perform public.fail_room_task(v_room,v_fail_parent,v_ai_one,'Provider session became unavailable');
  select state into v_status from public.backroom_wake_jobs where id=v_claimed_task_job;
  if v_status in ('pending','leased') then
    raise exception 'A failed task must cancel any outstanding wake for its previous assignment';
  end if;
  if (select status from public.room_tasks where id=v_fail_child)<>'blocked' then
    raise exception 'Failure of a prerequisite must block downstream work';
  end if;

  -- The human owner repairs a blocked plan. Reintroducing the failed edge
  -- keeps the task blocked; removing it safely reassigns and wakes the AI again.
  v_dependency_result := public.replace_room_task_dependencies(v_room,v_fail_child,array[v_fail_parent]);
  if v_dependency_result->>'status'<>'blocked' then
    raise exception 'Retaining a failed prerequisite must keep the dependent task blocked';
  end if;
  select version into v_task_version_before from public.room_tasks where id=v_fail_child;
  v_dependency_result := public.replace_room_task_dependencies(v_room,v_fail_child,array[v_fail_parent]);
  if v_dependency_result->>'updated'<>'false' or v_dependency_result->>'replayed'<>'true' then
    raise exception 'Repeating the same prerequisite set must be an idempotent no-op';
  end if;
  select version into v_task_version_after from public.room_tasks where id=v_fail_child;
  if v_task_version_after<>v_task_version_before then
    raise exception 'An identical prerequisite retry must not increment the task version';
  end if;
  v_dependency_result := public.replace_room_task_dependencies(v_room,v_fail_child,'{}'::uuid[]);
  if v_dependency_result->>'status'<>'assigned' then
    raise exception 'Removing the failed prerequisite must make the assigned dependent task ready';
  end if;
  select id into v_repaired_job from public.backroom_wake_jobs
  where room_id=v_room and participant_id=v_ai_two
    and event_id like 'task_'||v_fail_child::text||'_%'
    and state in ('pending','leased')
  order by created_at desc limit 1;
  if v_repaired_job is null then
    raise exception 'A repaired and ready task must reuse the existing Backroom wake queue';
  end if;
  perform public.cancel_room_task(v_room,v_fail_child);
  if (select state from public.backroom_wake_jobs where id=v_repaired_job)<>'cancelled' then
    raise exception 'Cancelling the repaired task must clean up its wake';
  end if;
  v_failed_created_child := public.create_room_task(
    v_room,v_owner,'Created after failed prerequisite','','',v_ai_two,array[v_fail_parent],3::smallint,null,'[]'::jsonb,
    '88000000-0000-4000-8000-000000000008'
  );
  if (select status from public.room_tasks where id=v_failed_created_child)<>'blocked' then
    raise exception 'A task created with an already-failed prerequisite must start blocked';
  end if;
  if exists(select 1 from public.backroom_wake_jobs where room_id=v_room
    and participant_id=v_ai_one and event_id like 'task_'||v_fail_parent::text||'_%'
    and state in ('pending','leased')) then
    raise exception 'Failed task must not retain a pending or leased wake';
  end if;

  -- Least privilege: Supabase default table ACLs may grant DML to
  -- authenticated unless they are explicitly revoked per table. RLS alone is
  -- not a substitute for the intended RPC-only lifecycle boundary.
  if has_table_privilege('authenticated','public.room_tasks','INSERT')
     or has_table_privilege('authenticated','public.room_tasks','UPDATE')
     or has_table_privilege('authenticated','public.room_tasks','DELETE')
     or has_table_privilege('authenticated','public.room_tasks','TRUNCATE')
     or has_table_privilege('authenticated','public.room_task_dependencies','INSERT')
     or has_table_privilege('authenticated','public.room_task_dependencies','UPDATE')
     or has_table_privilege('authenticated','public.room_task_dependencies','DELETE')
     or has_table_privilege('authenticated','public.room_task_dependencies','TRUNCATE')
     or has_table_privilege('authenticated','public.room_task_submissions','INSERT')
     or has_table_privilege('authenticated','public.room_task_submissions','UPDATE')
     or has_table_privilege('authenticated','public.room_task_submissions','DELETE')
     or has_table_privilege('authenticated','public.room_task_submissions','TRUNCATE')
     or has_table_privilege('authenticated','public.room_task_reviews','INSERT')
     or has_table_privilege('authenticated','public.room_task_reviews','UPDATE')
     or has_table_privilege('authenticated','public.room_task_reviews','DELETE')
     or has_table_privilege('authenticated','public.room_task_reviews','TRUNCATE') then
    raise exception 'Authenticated clients must use scoped task RPCs rather than direct table writes';
  end if;
  if not has_table_privilege('authenticated','public.room_tasks','SELECT')
     or not has_table_privilege('authenticated','public.room_task_dependencies','SELECT')
     or not has_table_privilege('authenticated','public.room_task_submissions','SELECT')
     or not has_table_privilege('authenticated','public.room_task_reviews','SELECT') then
    raise exception 'Authenticated group members must retain read access protected by RLS';
  end if;
  -- Explicit FK coverage prevents expensive scans when room/member parent
  -- rows are removed and keeps room-scoped task joins indexed.
  if to_regclass('public.room_task_dependencies_room_task_fk_idx') is null
     or to_regclass('public.room_task_dependencies_creator_fk_idx') is null
     or to_regclass('public.room_task_submissions_room_task_fk_idx') is null
     or to_regclass('public.room_task_submissions_submitter_fk_idx') is null
     or to_regclass('public.room_task_reviews_room_task_fk_idx') is null
     or to_regclass('public.room_task_reviews_reviewer_fk_idx') is null then
    raise exception 'Every group-task foreign key must have a supporting index';
  end if;
  if has_function_privilege('authenticated','public.claim_room_task(uuid,uuid,uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.fail_room_task(uuid,uuid,uuid,text)','EXECUTE') then
    raise exception 'AI-only task functions must not be executable by authenticated clients';
  end if;
end;
$task_test$;
