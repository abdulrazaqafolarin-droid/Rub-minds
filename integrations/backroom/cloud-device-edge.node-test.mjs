import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("device Edge Function uses server-only credentials and verifies owners through Supabase Auth", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  assert.match(edge, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edge, /resolveOwnerFromJwt\(req, token => db\.auth\.getUser\(token\)\)/);
  assert.match(edge, /const digest = await sha256\(token\)/);
  assert.doesNotMatch(edge, /localStorage|localhost|127\.0\.0\.1|ServerSocket|HttpServer/);
  assert.doesNotMatch(edge, /SUPABASE_SERVICE_ROLE_KEY.{0,100}json|serviceKey.{0,100}return json/s);
});

test("pairing is owner-scoped, one-use, time-limited and device credentials stay out of JSON", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  const sql = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  assert.match(edge, /owner\('pair\/create'\)|pair\/create/);
  assert.match(edge, /5 \* 60 \* 1000/);
  assert.match(edge, /p_code_digest: await sha256\(input\.pairingCode\)/);
  assert.match(edge, /p_token_digest: await sha256\(token\)/);
  assert.match(edge, /validatePairClaim\([\s\S]*?\}, token\)/);
  assert.doesNotMatch(edge.slice(edge.indexOf("if (action === 'pair/claim')"), edge.indexOf("if (action === 'device/status')")), /input\.deviceToken/);
  assert.match(sql, /for update/i);
  assert.match(sql, /claimed_at is null/i);
  assert.match(sql, /expires_at > pg_catalog\.clock_timestamp\(\)/i);
  assert.match(sql, /pg_advisory_xact_lock/);
  const android = await read("android-companion/app/src/main/java/app/rubminds/companion/MainActivity.kt");
  assert.ok(android.indexOf("vault.save(deviceToken, deviceId)") < android.indexOf("cloudClient().claim(code, deviceToken, deviceId, label)"),
    "Persist the token before the one-use pairing call so a lost response can recover via status.");
});

test("device and app tables are isolated from direct client table access", async () => {
  const sql = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  for (const table of ["backroom_devices","backroom_device_pairings","backroom_device_room_bindings","backroom_device_apps","backroom_device_events"]) {
    const block = sql.slice(sql.indexOf("create table if not exists public." + table));
    assert.ok(block.length > 0, "Missing " + table);
    const next = block.slice(0, block.indexOf("create table if not exists public.", 20) > 0 ? block.indexOf("create table if not exists public.", 20) : 1500);
    assert.match(next, new RegExp("alter table public\\." + table + " enable row level security"));
    assert.match(next, new RegExp("revoke all on table public\\." + table + " from public, anon, authenticated"));
    const serviceGrant = ({
      backroom_devices: "grant select, update(last_seen_at) on table public.backroom_devices to service_role;",
      backroom_device_pairings: "grant select, insert, delete on table public.backroom_device_pairings to service_role;",
      backroom_device_room_bindings: "grant select on table public.backroom_device_room_bindings to service_role;",
      backroom_device_apps: "grant select on table public.backroom_device_apps to service_role;",
      backroom_device_events: "grant select, insert on table public.backroom_device_events to service_role;"
    })[table];
    assert.ok(next.includes(serviceGrant), "Unexpected service-role grant for " + table);
  }
});

test("app inventory only accepts bounded selected metadata and logs add/remove atomically", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  const protocol = await read("supabase/functions/backroom-device/cloud-device-protocol.mjs");
  const sql = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  assert.match(edge, /validateSelectedApps\(input\.apps\)/);
  assert.match(edge, /sync_backroom_device_apps/);
  assert.match(protocol, /value\.length > 100/);
  assert.match(protocol, /signingCertificateSha256/);
  assert.match(protocol, /Object\.keys\(app\)\.some\(key => !keys\.includes\(key\)\)/);
  assert.match(sql, /status='active'/);
  assert.match(sql, /'app_added'/);
  assert.match(sql, /'app_removed'/);
  assert.match(sql, /jsonb_to_recordset/);
});

test("owner approval and revocation are transactional, scoped and auditable", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  const sql = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  assert.match(edge, /approve_backroom_device/);
  assert.match(edge, /revoke_backroom_device/);
  assert.match(sql, /function public\.approve_backroom_device/);
  assert.match(sql, /function public\.revoke_backroom_device/);
  assert.match(sql, /where id=p_room_id and owner_id=p_owner_id/);
  assert.match(sql, /device_approved/);
  assert.match(sql, /device_revoked/);
});

test("group members can view device inventory and history; device management stays owner-scoped", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  const sql = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  assert.match(edge, /action === 'room\/devices' \|\| action === 'room\/events'/);
  assert.match(edge, /from\('participants'\)\.select\('id'\)/);
  assert.match(edge, /room_member_required/);
  assert.match(edge, /\.eq\('room_id', input\.roomId\)\.eq\('user_id', ownerId\)/);
  assert.match(sql, /approve_backroom_device/);
  assert.match(sql, /revoke_backroom_device/);
  assert.match(sql, /where device_id=p_device_id and owner_id=p_owner_id and status='pending'/);
});

test("no native or web localhost bridge exists in the cloud Device Frame path", async () => {
  const ui = await read("src/BackroomApp.tsx");
  const api = await read("android-companion/app/src/main/java/app/rubminds/companion/CloudDeviceApi.kt");
  assert.doesNotMatch(ui, /http:\/\/(?:localhost|127\.0\.0\.1)|createBackroomHostServer|\/v1\/browser\//);
  assert.doesNotMatch(api, /localhost|127\.0\.0\.1|ServerSocket|HttpServer/);
  assert.match(api, /HttpsURLConnection/);
  assert.match(api, /instanceFollowRedirects = false/);
});


test("Supabase config declares the device Edge Function exactly once with manual JWT verification", async () => {
  // Git's Windows checkout may preserve CRLF; configuration semantics are line-ending agnostic.
  // Git for Windows may produce CRLF or lone-CR checkout line endings.
  // Parse the section semantically instead of comparing a raw newline sequence.
  const config = (await read("supabase/config.toml")).replace(/\r/g, "");
  const section = "[functions.backroom-device]";
  assert.equal(config.split(section).length - 1, 1);
  const sectionMatch = config.match(/^\[functions\.backroom-device\]\s*\n([\s\S]*?)(?=^\[|$)/m);
  assert.ok(sectionMatch, "backroom-device function section must exist");
  assert.match(sectionMatch[1], /^\s*verify_jwt\s*=\s*false\s*$/m);
});


test("local Supabase CI exercises the complete cloud device lifecycle", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const script = await read("scripts/local-backroom-device-e2e.mjs");
  const requiredActions = ["pair/create","pair/claim","device/status","owner/approve","device/inventory","device/event","room/devices","room/events","owner/revoke"];
  console.log("SAFE_CLOUD_DEVICE_CI_DIAG", JSON.stringify({
    startEdgeFunctionStep: workflow.includes("Start local Supabase Edge Functions (MCP + Backroom device)"),
    deviceE2eCommand: workflow.includes("node scripts/local-backroom-device-e2e.mjs"),
    stopSupabaseStep: workflow.includes("Stop isolated Supabase services"),
    requiredActions: requiredActions.map(action => script.includes('"' + action + '"') || script.includes("'" + action + "'")),
    pairingReplay: script.includes("pairing replay"),
    revokedInventoryDenial: script.includes("revoked device inventory denial"),
    groupMemberRead: script.includes("group members must be able to view")
  }));
  assert.match(workflow, /Start local Supabase Edge Functions \(MCP \+ Backroom device\)/);
  assert.match(workflow, /node scripts\/local-backroom-device-e2e\.mjs/);
  assert.match(workflow, /Stop isolated Supabase services/);
  for (const action of ["pair/create","pair/claim","device/status","owner/approve","device/inventory","device/event","room/devices","room/events","owner/revoke"]) {
    assert.ok(script.includes('"' + action + '"') || script.includes("'" + action + "'"), "missing E2E action: " + action);
  }
  assert.match(script, /pairing replay/);
  assert.match(script, /revoked device inventory denial/);
  assert.match(script, /group members must be able to view/);
});

test("device revocation removes live app metadata without deleting group action history", async () => {
  const migration = await read("supabase/migrations/20261030110000_backroom_cloud_devices.sql");
  const e2e = await read("scripts/local-backroom-device-e2e.mjs");
  assert.match(migration, /device_revoked[\s\S]*?delete from public\.backroom_device_apps where device_id=p_device_id/);
  assert.match(e2e, /revocation must remove the live app inventory/);
  assert.match(e2e, /app_added/);
  assert.match(e2e, /app_open_requested/);
  assert.match(e2e, /post-revoke group history/);
});

test("device Edge Function bundles all relative dependencies inside its function directory", async () => {
  const edge = await read("supabase/functions/backroom-device/index.ts");
  const ownerJwt = await read("supabase/functions/backroom-device/owner-jwt.mjs");
  const protocol = await read("supabase/functions/backroom-device/cloud-device-protocol.mjs");
  assert.match(edge, /from '\.\/owner-jwt\.mjs'/);
  assert.match(edge, /from '\.\/cloud-device-protocol\.mjs'/);
  assert.match(ownerJwt, /export async function resolveOwnerFromJwt/);
  assert.match(protocol, /export function validatePairClaim/);
  assert.match(protocol, /export function validateSelectedApps/);
});
