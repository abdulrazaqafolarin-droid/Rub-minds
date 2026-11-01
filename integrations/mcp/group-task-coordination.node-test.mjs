import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261101040000_group_task_coordination.sql", import.meta.url), "utf8");
const wakeMigration = await readFile(new URL("../../supabase/migrations/20261029090000_backroom_wake_queue.sql", import.meta.url), "utf8");
const mcpProtocol = await readFile(new URL("./protocol.mjs", import.meta.url), "utf8");
const mcpEdge = await readFile(new URL("../../supabase/functions/rub-minds-mcp/index.ts", import.meta.url), "utf8");
const cloudApp = await readFile(new URL("../../src/CloudApp.tsx", import.meta.url), "utf8");
const taskBoard = await readFile(new URL("../../src/GroupTaskBoard.tsx", import.meta.url), "utf8");
const cloudRooms = await readFile(new URL("../../src/cloudRooms.ts", import.meta.url), "utf8");
const taskAcceptance = await readFile(new URL("../../supabase/tests/group_task_coordination.sql", import.meta.url), "utf8");

test("task records extend existing group and participant identities", () => {
  assert.match(migration, /create table if not exists public\.room_tasks[\s\S]*?references public\.rooms\(id\)/);
  assert.match(migration, /created_by_participant_id uuid not null references public\.participants\(id\)/);
  assert.match(migration, /assigned_to_participant_id uuid references public\.participants\(id\)/);
  assert.doesNotMatch(migration, /create table if not exists public\.(rooms|participants|messages)\s*\(/);
  assert.doesNotMatch(migration, /create table if not exists public\.(backroom_wake_jobs|backroom_hosts)\s*\(/);
  for (const fn of ["create_room_task", "assign_room_task", "review_room_task", "cancel_room_task", "claim_room_task_human", "submit_room_task_result_human"]) {
    assert.equal((migration.match(new RegExp("create or replace function public\\." + fn + "\\(", "g")) || []).length, 1, fn + " must be declared exactly once");
  }
});

test("task data is RLS-protected and clients cannot directly alter the lifecycle", () => {
  for (const table of ["room_tasks", "room_task_dependencies", "room_task_submissions", "room_task_reviews"]) {
    assert.match(migration, new RegExp("alter table public\\." + table + " enable row level security"));
  }
  assert.match(migration, /grant select on table public\.room_tasks, public\.room_task_dependencies to authenticated/);
  assert.match(migration, /grant select on table public\.room_task_submissions, public\.room_task_reviews to authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update)[\s\S]*?to authenticated/);
  assert.match(migration, /grant all on table public\.room_tasks[\s\S]*?to service_role/);
  assert.match(migration, /room_tasks_member_select/);
  assert.match(migration, /room_task_submissions_member_select/);
  assert.match(migration, /room_task_reviews_member_select/);
});

test("human lifecycle writes require authenticated scoped RPCs; AI writes are service-role-only", () => {
  for (const fn of ["create_room_task", "assign_room_task", "review_room_task", "cancel_room_task", "claim_room_task_human", "submit_room_task_result_human"]) {
    const start = migration.indexOf("create or replace function public." + fn);
    assert.notEqual(start, -1, "missing " + fn);
    const end = migration.indexOf("$" + fn + "$;", start);
    assert.notEqual(end, -1, "missing function terminator for " + fn);
    const chunk = migration.slice(start, end);
    assert.match(chunk, /security definer/i, fn + " must be a narrowly scoped RPC");
    assert.match(chunk, /auth\.uid\(\) is null/i, fn + " must authenticate the caller");
    assert.match(migration, new RegExp("grant execute on function public\\." + fn + "[^\\n]* to authenticated"));
  }
  assert.match(migration, /grant execute on function public\.create_room_task\(uuid,uuid,text,text,text,uuid,uuid\[\],smallint,timestamptz,jsonb,uuid\) to authenticated/);
  for (const fn of ["claim_room_task", "block_room_task", "fail_room_task", "submit_room_task_result"]) {
    assert.match(migration, new RegExp("revoke all on function public\\." + fn + "[^\\n]* from public, anon, authenticated"));
    assert.match(migration, new RegExp("grant execute on function public\\." + fn + "[^\\n]* to service_role"));
  }
});

test("dependency graph rejects cross-room edges and cycles and releases ready work", () => {
  assert.match(migration, /guard_room_task_dependency[\s\S]*?Task dependencies must stay inside the same group/);
  assert.match(migration, /with recursive dependency_path/);
  assert.match(migration, /Task dependency would create a cycle/);
  assert.match(migration, /release_room_task_dependents[\s\S]*?new\.status='completed'/);
  assert.match(migration, /prerequisite\.status<>'completed'/);
});

test("task-mode assignments use the existing durable wake queue and fixed canonical prompt", () => {
  assert.match(wakeMigration, /create or replace function public\.enqueue_backroom_wake_jobs_for_message/);
  assert.match(wakeMigration, /participation_mode in \('mentions','smart'\)/);
  assert.match(migration, /create or replace function public\.enqueue_backroom_wake_for_assigned_task/);
  assert.match(migration, /b\.participation_mode='task'/);
  assert.match(migration, /public\.enqueue_backroom_wake_job\(/);
  assert.match(migration, /v_prompt := '@RMconnects'/);
  assert.match(migration, /'Retrieve authorized pending events through Rub Minds MCP/);
  const triggerStart = migration.indexOf("create or replace function public.enqueue_backroom_wake_for_assigned_task");
  const promptStart = migration.indexOf("v_prompt :=", triggerStart);
  const promptEnd = migration.indexOf(";", promptStart);
  const promptStatement = migration.slice(promptStart, promptEnd);
  assert.match(promptStatement, /'@RMconnects'[\s\S]*Retrieve authorized pending events through Rub Minds MCP/);
  assert.doesNotMatch(promptStatement, /new\.(description|expected_output|acceptance_criteria|result_content)/);
  assert.match(migration, /agent_connections[\s\S]*?rub_minds_mcp_sessions/);
  assert.match(migration, /wake_enabled=true[\s\S]*?wake_expires_at/);
  assert.match(migration, /cancel_backroom_wake_job\s*\(\s*v_stale_job\.id\s*,\s*v_stale_job\.owner_id\s*\)/);
  assert.match(migration, /old\.assigned_to_participant_id is not null[\s\S]*?cancel_backroom_wake_job/);
});

test("task creation captures acceptance criteria and serializes idempotent retries", () => {
  assert.match(migration, /acceptance_criteria jsonb not null default/);
  assert.match(migration, /idempotency_fingerprint text/);
  assert.match(migration, /v_existing\.idempotency_fingerprint is distinct from v_request_fingerprint/);
  assert.match(taskAcceptance, /A create retry after reassignment must return the same task ID/);
  assert.match(migration, /p_acceptance_criteria jsonb default/);
  assert.match(migration, /p_idempotency_key uuid default null/);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*p_idempotency_key/);
  assert.match(migration, /Task idempotency key was reused with different creation input/);
  assert.match(migration, /create unique index if not exists room_tasks_creator_idempotency_idx/);
  assert.match(migration, /alter publication supabase_realtime add table public\./);
});

test("task cancellation removes stale wakes and blocks dependent work after terminal prerequisite failure", () => {
  assert.match(migration, /create or replace function public\.cancel_room_task\(/);
  assert.match(migration, /create or replace function public\.fail_room_task\(/);
  assert.match(migration, /cancel_backroom_wake_job\s*\(\s*v_stale_job\.id\s*,\s*v_stale_job\.owner_id\s*\)/);
  assert.match(migration, /new\.status in \('failed','cancelled'\)[\s\S]*?set status='blocked'/);
  assert.match(migration, /grant execute on function public\.cancel_room_task\(uuid,uuid\) to authenticated/);
  assert.match(migration, /grant execute on function public\.fail_room_task\(uuid,uuid,uuid,text\) to service_role/);
});

test("task submissions preserve bounded provenance and humans cannot approve their own work", () => {
  assert.match(migration, /room_task_submission_idempotency unique/);
  assert.match(migration, /source_message_ids uuid\[\][\s\S]*?cardinality\(source_message_ids\) <= 50/);
  assert.match(migration, /Every source message must belong to this group/);
  assert.match(migration, /room_task_review_once_per_submission unique/);
  assert.match(migration, /Only the task creator or group owner may review this task/);
  assert.match(migration, /A participant cannot review its own task submission/);
  assert.match(migration, /status',v_task\.status/);
  assert.match(migration, /Only backlog, assigned or blocked tasks can be reassigned/);
});


test("MCP exposes bounded task tools only after its existing participant-session authorization", () => {
  for (const name of ["propose_group_task", "list_group_tasks", "read_group_task", "claim_group_task", "block_group_task", "fail_group_task", "submit_group_task_result"]) {
    assert.match(mcpProtocol, new RegExp('name: "' + name + '"'));
    assert.match(mcpProtocol, new RegExp('case "' + name + '"'));
    assert.match(mcpEdge, new RegExp('name === "' + name + '"'));
  }
  const taskHandler = mcpEdge.indexOf('if (name === "propose_group_task")');
  const liveCredentialCheck = mcpEdge.indexOf('await invokeAgent(credential, "read");', taskHandler - 5000);
  assert.ok(taskHandler > 0 && liveCredentialCheck > 0 && liveCredentialCheck < taskHandler,
    "task operations must remain behind the existing live MCP credential check");
  assert.match(mcpEdge, /connection\.room_id/);
  assert.match(mcpEdge, /connection\.participant_id/);
  assert.match(mcpEdge, /status: existing\.status/);
  assert.match(mcpEdge, /status: raced\.status/);
});

test("the existing cloud group UI owns the task board and uses the current Realtime room channel", () => {
  assert.match(cloudApp, /import GroupTaskBoard from '\.\/GroupTaskBoard'/);
  assert.match(cloudApp, /setShowTasks/);
  assert.match(cloudApp, /<GroupTaskBoard[\s\S]*?roomId=\{room\.id\}/);
  for (const operation of ["listGroupTasks", "createGroupTask", "assignGroupTask", "reviewGroupTask", "cancelGroupTask", "claimGroupTaskAsHuman", "submitGroupTaskResultAsHuman"]) {
    assert.match(taskBoard, new RegExp(operation));
    assert.match(cloudRooms, new RegExp("function " + operation));
  }
  assert.match(cloudRooms, /subscribeToGroupTasks[\s\S]*?postgres_changes/);
  assert.match(taskBoard, /createAttempt/);
  assert.match(taskBoard, /submissionAttempts/);
});


test("dependency graph, wake acknowledgement and in-progress assignment boundaries are enforced", () => {
  assert.match(migration, /room-task-dependency-graph/);
  assert.match(migration, /old\.status='assigned' and new\.status='in_progress'[\s\S]*?return new/);
  assert.match(migration, /Only backlog, assigned or blocked tasks can be reassigned/);
  assert.match(migration, /v_failed_prerequisites/);
  assert.match(migration, /One or more prerequisite tasks had already failed or been cancelled/);
  assert.match(taskAcceptance, /A task created with an already-failed prerequisite must start blocked/);
  assert.match(taskAcceptance, /An AI task claim must not cancel its still-leased canonical wake/);
  assert.match(taskAcceptance, /An in-progress task must not be reassigned to another participant/);
  assert.match(taskAcceptance, /Failure of a prerequisite must block downstream work/);
});
