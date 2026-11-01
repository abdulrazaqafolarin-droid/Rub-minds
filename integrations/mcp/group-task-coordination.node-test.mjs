import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261101040000_group_task_coordination.sql", import.meta.url), "utf8");
const reviewEvidenceMigration = await readFile(new URL("../../supabase/migrations/20261101210000_group_task_review_criterion_evidence.sql", import.meta.url), "utf8");
const vaultKeyMigration = await readFile(new URL("../../supabase/migrations/20261101165353_rub_minds_mcp_vault_encryption_key.sql", import.meta.url), "utf8");
const vaultKeyAcceptance = await readFile(new URL("../../supabase/tests/rub_minds_mcp_vault_encryption_key.sql", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const wakeQueueWorkflow = await readFile(new URL("../../.github/workflows/backroom-wake-queue.yml", import.meta.url), "utf8");
const fkIndexesMigration = await readFile(new URL("../../supabase/migrations/20261101164016_group_task_fk_indexes.sql", import.meta.url), "utf8");
const wakeMigration = await readFile(new URL("../../supabase/migrations/20261029090000_backroom_wake_queue.sql", import.meta.url), "utf8");
const mcpProtocol = await readFile(new URL("./protocol.mjs", import.meta.url), "utf8");
const mcpEdge = await readFile(new URL("../../supabase/functions/rub-minds-mcp/index.ts", import.meta.url), "utf8");
const cloudApp = await readFile(new URL("../../src/CloudApp.tsx", import.meta.url), "utf8");
const taskBoard = await readFile(new URL("../../src/GroupTaskBoard.tsx", import.meta.url), "utf8");
const cloudRooms = await readFile(new URL("../../src/cloudRooms.ts", import.meta.url), "utf8");
const taskAcceptance = await readFile(new URL("../../supabase/tests/group_task_coordination.sql", import.meta.url), "utf8");
const sdkTaskE2e = await readFile(new URL("../../scripts/local-mcp-sdk-e2e.mjs", import.meta.url), "utf8");
const supabaseConfig = await readFile(new URL("../../src/supabase.ts", import.meta.url), "utf8");

test("MCP session encryption key uses a service-role-only Vault fallback", () => {
  assert.ok(vaultKeyMigration.includes("create extension if not exists supabase_vault with schema vault"));
  assert.ok(vaultKeyMigration.includes("create extension if not exists pgcrypto with schema extensions"));
  assert.ok(vaultKeyMigration.includes("vault.create_secret("));
  assert.ok(vaultKeyMigration.includes("extensions.gen_random_bytes(32)"));
  assert.ok(vaultKeyMigration.includes("create or replace function public.get_rub_minds_mcp_session_encryption_key()"));
  assert.match(vaultKeyMigration, /security definer[\s\S]*set search_path to ''/i);
  assert.ok(vaultKeyMigration.includes("from public, anon, authenticated"));
  assert.ok(vaultKeyMigration.includes("to service_role"));
  assert.ok(vaultKeyAcceptance.includes("'authenticated'"));
  assert.ok(vaultKeyAcceptance.includes("set local role service_role"));
  assert.ok(vaultKeyAcceptance.includes("length"));
  assert.ok(mcpEdge.includes("async function loadVaultCredentialEncryptionKey()"));
  assert.ok(mcpEdge.includes('db.rpc("get_rub_minds_mcp_session_encryption_key")'));
  assert.ok(mcpEdge.includes('Deno.env.get("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY") || await loadVaultCredentialEncryptionKey()'));
  assert.ok(ciWorkflow.includes("Install PostgreSQL client for Vault acceptance"));
  assert.ok(ciWorkflow.includes("Verify local Supabase Vault key access boundary"));
  assert.ok(ciWorkflow.includes('psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rub_minds_mcp_vault_encryption_key.sql'));
  assert.ok(ciWorkflow.includes("Start MCP Edge Function with Vault-only local credentials"));
  assert.doesNotMatch(ciWorkflow, /RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY=a{64}/);
});

test("external-agent endpoint follows the same Supabase environment as the browser client", () => {
  assert.match(supabaseConfig, /const url = import\.meta\.env\.VITE_SUPABASE_URL/);
  assert.match(supabaseConfig, /export const supabaseUrl = url \|\| ''/);
  assert.match(supabaseConfig, /createClient\(url, key/);
  assert.match(cloudApp, /import \{ supabase, supabaseUrl \} from '\.\/supabase'/);
  assert.match(cloudApp, /const agentMessagesEndpoint = supabaseUrl/);
  assert.match(cloudApp, /API endpoint: \{agentMessagesEndpoint\}/);
  assert.doesNotMatch(cloudApp, /https:\/\/zucaeevlbwhcvjwbhwmq\.supabase\.co\/functions\/v1\/agent-messages/);
});

test("every group-task foreign key is indexed in both fresh and upgraded databases", () => {
  const indexes = [
    "room_task_dependencies_room_task_fk_idx",
    "room_task_dependencies_creator_fk_idx",
    "room_task_submissions_room_task_fk_idx",
    "room_task_submissions_submitter_fk_idx",
    "room_task_reviews_room_task_fk_idx",
    "room_task_reviews_reviewer_fk_idx",
  ];
  for (const index of indexes) {
    assert.match(migration, new RegExp("create index if not exists " + index));
    assert.match(fkIndexesMigration, new RegExp("create index if not exists " + index));
    assert.match(taskAcceptance, new RegExp(index));
  }
});

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
  assert.match(migration, /revoke all on table public\.room_tasks, public\.room_task_dependencies,[\s\S]*?from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|truncate)[\s\S]*?to authenticated/);
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
  assert.match(migration, /idempotency_initial_assignee_id uuid/);
  assert.match(migration, /v_existing\.idempotency_initial_assignee_id is distinct from p_assigned_to_participant_id/);
  const fingerprint = migration.slice(migration.indexOf("v_request_fingerprint :="), migration.indexOf("v_request_fingerprint :=") + 700);
  assert.doesNotMatch(fingerprint, /p_assigned_to_participant_id::text/);
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


test("humans can revise a blocked dependency plan only through the scoped graph-locked RPC", () => {
  assert.ok(migration.includes("create or replace function public.replace_room_task_dependencies("));
  assert.ok(migration.includes("pg_advisory_xact_lock(") && migration.includes("room-task-dependency-graph"));
  assert.ok(migration.includes("Only the task creator or group owner may revise task prerequisites"));
  assert.ok(migration.includes("Prerequisites cannot change after task work starts or enters review"));
  assert.ok(migration.includes("grant execute on function public.replace_room_task_dependencies(uuid,uuid,uuid[]) to authenticated"));
  assert.ok(taskAcceptance.includes("Removing the failed prerequisite must make the assigned dependent task ready"));
  assert.ok(taskAcceptance.includes("A repaired and ready task must reuse the existing Backroom wake queue"));
});


test("AI task claiming requires an explicit human assignment before work begins", () => {
  assert.match(mcpProtocol, /Claim a task that a human group member has assigned to this participant/);
  assert.match(migration, /A human group member must assign this task before an AI can claim it/);
  assert.match(migration, /v_task\.assigned_to_participant_id <> p_participant_id/);
  assert.match(taskAcceptance, /An AI task claim must not cancel its still-leased canonical wake/);
});

test("official MCP SDK integration exercises the human-governed task lifecycle end to end", () => {
  assert.match(sdkTaskE2e, /propose_group_task/);
  assert.match(sdkTaskE2e, /assign_room_task/);
  assert.match(sdkTaskE2e, /claim_group_task/);
  assert.match(sdkTaskE2e, /submit_group_task_result/);
  assert.match(sdkTaskE2e, /review_room_task/);
  assert.match(sdkTaskE2e, /human-governed task lifecycle/);
  assert.match(sdkTaskE2e, /unassigned proposal/);
  assert.match(sdkTaskE2e, /different AI must not claim work assigned to AI one/);
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
  assert.match(cloudApp, /<GroupTaskBoard[\s\S]*?key=\{room\.id\}[\s\S]*?roomId=\{room\.id\}/);
  assert.match(taskBoard, /onSaveDependencies/);
  assert.match(taskBoard, /Revise prerequisites/);
  for (const operation of ["listGroupTasks", "createGroupTask", "assignGroupTask", "replaceGroupTaskDependencies", "reviewGroupTask", "cancelGroupTask", "claimGroupTaskAsHuman", "submitGroupTaskResultAsHuman"]) {
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


test("human task approvals require persisted evidence for every acceptance criterion", () => {
  assert.match(reviewEvidenceMigration, /add column if not exists criterion_evidence jsonb not null default '\[\]'::jsonb/);
  assert.match(reviewEvidenceMigration, /drop function if exists public\.review_room_task\(uuid, uuid, text, text\)/);
  assert.match(reviewEvidenceMigration, /create function public\.review_room_task\([\s\S]*?p_criterion_evidence jsonb/);
  assert.match(reviewEvidenceMigration, /Evidence must cover every acceptance criterion exactly once and in order/);
  assert.match(reviewEvidenceMigration, /jsonb_typeof\(evidence\.item->'criterion'\) is distinct from 'string'/i);
  assert.match(reviewEvidenceMigration, /jsonb_typeof\(evidence\.item->'met'\) is distinct from 'boolean'/i);
  assert.match(reviewEvidenceMigration, /jsonb_typeof\(evidence\.item->'evidence'\) is distinct from 'string'/i);
  assert.match(reviewEvidenceMigration, /evidence\.item->>'met' is distinct from 'true'/);
  assert.match(reviewEvidenceMigration, /A task cannot be approved while any acceptance criterion is unmet/);
  assert.match(reviewEvidenceMigration, /criterion_evidence=p_criterion_evidence/);
  assert.match(reviewEvidenceMigration, /revoke all on function public\.review_room_task\(uuid,uuid,text,text,jsonb\) from public, anon/);
  assert.match(reviewEvidenceMigration, /grant execute on function public\.review_room_task\(uuid,uuid,text,text,jsonb\) to authenticated/);
  assert.doesNotMatch(reviewEvidenceMigration, /grant execute on function public\.review_room_task\(uuid,uuid,text,text\) to authenticated/);
  assert.match(cloudRooms, /criterion_evidence,created_at/);
  assert.match(cloudRooms, /p_criterion_evidence:/);
  assert.match(taskBoard, /Acceptance criteria evidence/);
  assert.match(taskBoard, /Every acceptance criterion must be marked met before approval/);
  assert.match(taskAcceptance, /Review must include evidence for every criterion/);
  assert.match(taskAcceptance, /Unmet acceptance criteria must block approval/);
  assert.match(taskAcceptance, /Missing criterion met decision must be rejected/);
  assert.match(taskAcceptance, /Null criterion met decision must be rejected/);
  assert.match(taskAcceptance, /Non-text criterion evidence must be rejected/);
  assert.match(taskAcceptance, /Non-text criterion labels must be rejected/);
  assert.match(taskAcceptance, /Anonymous and service roles must not be granted the human review RPC/);
  assert.match(taskAcceptance, /The old review RPC signature must not remain callable/);
  assert.match(taskAcceptance, /Criterion-level review evidence must be persisted with the decision/);
  assert.match(sdkTaskE2e, /p_criterion_evidence/);
  assert.match(sdkTaskE2e, /all task criteria must retain review evidence/);
  assert.match(wakeQueueWorkflow, /20261101210000_group_task_review_criterion_evidence\.sql/);
});

test("Realtime task refreshes reject stale snapshots and stale errors", () => {
  assert.match(taskBoard, /const refreshGeneration = useRef\(0\)/);
  assert.match(taskBoard, /requestId !== refreshGeneration\.current/);
  assert.match(taskBoard, /refreshGeneration\.current \+= 1/);
  assert.match(taskBoard, /sequence === loadSequence/);
  assert.match(taskBoard, /Only the newest complete snapshot/);
});
