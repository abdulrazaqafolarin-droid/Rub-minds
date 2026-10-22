#!/usr/bin/env node
/**
 * Real React + Supabase Auth + invitation redemption smoke test.
 * Runs only against the disposable local Supabase stack in CI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
assert.ok(apiUrl && anonKey && serviceKey, 'local Supabase URL, anon key, and service key are required');
process.env.VITE_SUPABASE_URL = apiUrl;
process.env.VITE_SUPABASE_ANON_KEY = anonKey;

const adminHeaders = {
  apikey: serviceKey,
  Authorization: 'Bearer ' + serviceKey,
  'Content-Type': 'application/json',
};
async function request(path, init = {}) {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, path + ' failed (' + response.status + '): ' + JSON.stringify(body));
  return body;
}

const owner = await request('/auth/v1/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: 'rub-minds-human-invite-owner@example.test',
    password: 'Local-CI-Owner-Password-923!x',
    email_confirm: true,
  }),
});
const existingHumanEmail = 'rub-minds-human-existing@example.test';
const existingHumanPassword = 'Local-CI-Existing-Password-923!x';
const existingHuman = await request('/auth/v1/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: existingHumanEmail,
    password: existingHumanPassword,
    email_confirm: true,
  }),
});
const roomRows = await request('/rest/v1/rooms', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    owner_id: owner.id,
    title: 'Local human invitation E2E',
    objective: 'Disposable local-only signup and invite test',
  }),
});
assert.equal(roomRows.length, 1);
const room = roomRows[0];
const inviteToken = 'd'.repeat(64);
const tokenHash = createHash('sha256').update(inviteToken, 'utf8').digest('hex');
await request('/rest/v1/room_invites', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    room_id: room.id,
    created_by: owner.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_uses: 3,
    uses: 0,
    allow_ai: true,
    max_ai_uses: 3,
    ai_uses: 0,
  }),
});

const server = await createServer({
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const email = 'rub-minds-human-ci-joiner@example.test';
  const password = 'Local-CI-Human-Password-923!x';
  await page.goto('http://127.0.0.1:4173/?invite=' + inviteToken, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Join a Rub Minds group' }).waitFor();
  await page.getByRole('button', { name: 'Continue as a human' }).click();
  await page.getByRole('heading', { name: 'You’re invited to Rub Minds' }).waitFor();
  await page.getByRole('status').getByText('Group invitation detected. Your invite will be kept while you sign in.').waitFor();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  // A local-only Auth configuration disables email confirmation so this test can
  // verify the complete post-signup invitation flow without sending real email.
  await page.getByRole('heading', { name: 'Local human invitation E2E', exact: true }).waitFor({ timeout: 15000 });
  const authUser = await request('/auth/v1/admin/users?per_page=100');
  const createdUser = authUser.users?.find(user => user.email === email);
  assert.ok(createdUser, 'signup did not create the human auth user');
  const participantRows = await request(
    '/rest/v1/participants?select=id,room_id,user_id,kind&room_id=eq.' + room.id + '&user_id=eq.' + createdUser.id,
  );
  assert.equal(participantRows.length, 1, 'signup should redeem the preserved invite exactly once');
  assert.equal(participantRows[0].kind, 'human');
  assert.equal(participantRows[0].room_id, room.id);
  assert.equal(await page.getByRole('alert').count(), 0, 'a normal first-time visitor must not see a session-restore error');
  console.log('Local browser human signup, invitation preservation, and automatic room join passed:', room.id, createdUser.id);

  // A pre-existing account must survive invite-page reload, sign in, and auto-join.
  const existingPage = await browser.newPage();
  const inviteUrl = 'http://127.0.0.1:4173/?invite=' + inviteToken;
  await existingPage.goto(inviteUrl, { waitUntil: 'networkidle' });
  await existingPage.getByRole('heading', { name: 'Join a Rub Minds group' }).waitFor();
  await existingPage.reload({ waitUntil: 'networkidle' });
  await existingPage.getByRole('heading', { name: 'Join a Rub Minds group' }).waitFor();
  assert.equal(new URL(existingPage.url()).searchParams.get('invite'), inviteToken, 'invite token must survive reload');
  await existingPage.getByRole('button', { name: 'Continue as a human' }).click();
  await existingPage.getByRole('heading', { name: 'You’re invited to Rub Minds' }).waitFor();
  await existingPage.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await existingPage.getByLabel('Email address').fill(existingHumanEmail);
  await existingPage.getByLabel('Password', { exact: true }).fill(existingHumanPassword);
  await existingPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await existingPage.getByRole('heading', { name: 'Local human invitation E2E', exact: true }).waitFor({ timeout: 15000 });

  const existingParticipants = await request(
    '/rest/v1/participants?select=id,room_id,user_id,kind&room_id=eq.' + room.id + '&user_id=eq.' + existingHuman.id,
  );
  assert.equal(existingParticipants.length, 1, 'an existing account must auto-join the invited room after sign-in');
  assert.equal(existingParticipants[0].kind, 'human');
  const participantCountBeforeReload = await request('/rest/v1/participants?select=id&room_id=eq.' + room.id);
  assert.equal(participantCountBeforeReload.length, 2, 'signup and existing-account sign-in must create two human participants');

  const inviteUseBeforeReload = await request('/rest/v1/room_invites?select=id,uses&token_hash=eq.' + tokenHash);
  assert.equal(inviteUseBeforeReload.length, 1);
  await existingPage.goto(inviteUrl, { waitUntil: 'networkidle' });
  await existingPage.getByRole('heading', { name: 'Local human invitation E2E', exact: true }).waitFor({ timeout: 15000 });
  const inviteUseAfterReload = await request('/rest/v1/room_invites?select=id,uses&token_hash=eq.' + tokenHash);
  assert.equal(inviteUseAfterReload[0].uses, inviteUseBeforeReload[0].uses, 'reopening an already-accepted invite must not consume another use');
  const participantCountAfterReload = await request('/rest/v1/participants?select=id&room_id=eq.' + room.id);
  assert.equal(participantCountAfterReload.length, 2, 'reopening an accepted invite must not create duplicate membership');
  console.log('Existing-account sign-in, invite reload recovery, automatic join, and idempotent re-entry passed:', room.id, existingHuman.id);

  // Revoking an invitation must block a new authenticated human without
  // deleting existing memberships or incrementing the invitation use count.
  const blockedEmail = 'rub-minds-human-revoked@example.test';
  const blockedPassword = 'Local-CI-Revoked-Password-923!x';
  const blockedUser = await request('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: blockedEmail,
      password: blockedPassword,
      email_confirm: true,
    }),
  });
  const revokeRows = await request('/rest/v1/room_invites?token_hash=eq.' + tokenHash, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  assert.equal(revokeRows.length, 1, 'local invitation must be revocable');
  const revokedUseCount = revokeRows[0].uses;
  const blockedPage = await browser.newPage();
  await blockedPage.goto(inviteUrl, { waitUntil: 'networkidle' });
  await blockedPage.getByRole('button', { name: 'Continue as a human' }).click();
  await blockedPage.getByLabel('Email address').fill(blockedEmail);
  await blockedPage.getByLabel('Password', { exact: true }).fill(blockedPassword);
  await blockedPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Prove the test account authenticated before attributing the result to invite revocation.
  await blockedPage.getByText('YOUR GROUPS', { exact: true }).waitFor({ timeout: 15000 });
  const browserAccessToken = await blockedPage.evaluate(() => {
    const key = Object.keys(localStorage).find(candidate => candidate.endsWith('-auth-token'));
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key) || 'null')?.access_token || null; }
    catch { return null; }
  });
  assert.ok(browserAccessToken, 'sign-in should persist a Supabase session in the browser');
  // Isolate the backend's revocation guarantee from any browser-rendering issue.
  const rejectedRedemption = await fetch(apiUrl + '/rest/v1/rpc/redeem_room_invite', {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: 'Bearer ' + browserAccessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ invite_token: inviteToken }),
  });
  const rejectedBody = await rejectedRedemption.text();
  assert.notEqual(rejectedRedemption.status, 200,
    'revoked human invitation must be rejected by the authenticated database RPC');
  assert.match(rejectedBody, /Invitation expired or unavailable/i,
    'database should explain that the revoked invitation is unavailable: ' + rejectedBody);
  await blockedPage.getByRole('alert').waitFor({ timeout: 15000 });
  const blockedAlertText = (await blockedPage.getByRole('alert').innerText()).trim();
  assert.match(blockedAlertText, /Invitation expired or unavailable/i,
    'browser should display the invitation rejection, not a different auth/UI error: ' + blockedAlertText);
  const blockedMembership = await request(
    '/rest/v1/participants?select=id&room_id=eq.' + room.id + '&user_id=eq.' + blockedUser.id,
  );
  assert.equal(blockedMembership.length, 0, 'revoked invite must never create a human membership');
  const afterRevocation = await request('/rest/v1/room_invites?select=uses&token_hash=eq.' + tokenHash);
  assert.equal(afterRevocation[0].uses, revokedUseCount, 'failed revoked invite must not consume a use');
  const retainedMembers = await request('/rest/v1/participants?select=id&room_id=eq.' + room.id);
  assert.equal(retainedMembers.length, 2, 'revocation must not evict existing members');
  console.log('Revoked human invite fails closed; memberships and invite usage remain unchanged:', room.id);
} finally {
  if (browser) await browser.close();
  await server.close();
}
