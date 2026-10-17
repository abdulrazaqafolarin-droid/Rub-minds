#!/usr/bin/env node
/**
 * Controlled Playwright POC: owner-authorized guest AI agent without human signup.
 *
 * Runs an isolated localhost mock only. The mock models an owner-issued,
 * single-use invitation and revocable guest session; it does not bypass
 * production authentication or access real Rub Minds rooms.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const ownerInvite = randomBytes(32).toString('hex');
const sessionToken = randomBytes(32).toString('hex');
let inviteUsed = false;
let sessionActive = false;
const messages = [{ sender: 'Owner', body: 'Welcome, authorized guest agent.' }];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rub Minds Guest Agent POC</title></head>
<body>
<main>
  <h1>Join Rub Minds as an AI guest</h1>
  <p id="policy">This connection was authorized by the room owner. No human account is required.</p>
  <label for="agent-name">Agent display name</label><input id="agent-name" value="Playwright AI Guest">
  <button id="join">Join authorized room</button>
  <p id="status" role="status">Not connected</p>
  <section id="room" hidden>
    <h2>Room messages</h2><ol id="messages"></ol>
    <label for="message">Message</label><input id="message">
    <button id="send">Send message</button>
  </section>
</main>
<script>
const token = new URLSearchParams(location.search).get('invite') || '';
let session = '';
const status = document.querySelector('#status');
document.querySelector('#join').addEventListener('click', async () => {
  const response = await fetch('/api/agent/join', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:token,name:document.querySelector('#agent-name').value})});
  const data = await response.json();
  status.textContent = data.error || 'Connected as authorized guest';
  if (!response.ok) return;
  session = data.session;
  document.querySelector('#room').hidden = false;
  document.querySelector('#join').disabled = true;
  await refresh();
});
async function refresh() {
  const response = await fetch('/api/agent/messages', {headers:{Authorization:'Bearer '+session}});
  const data = await response.json();
  if (!response.ok) { status.textContent = data.error; return; }
  document.querySelector('#messages').replaceChildren(...data.messages.map(m => {
    const li = document.createElement('li'); li.textContent = m.sender + ': ' + m.body; return li;
  }));
}
document.querySelector('#send').addEventListener('click', async () => {
  const body = document.querySelector('#message').value;
  const response = await fetch('/api/agent/messages', {method:'POST',headers:{Authorization:'Bearer '+session,'Content-Type':'application/json'},body:JSON.stringify({body})});
  const data = await response.json();
  status.textContent = data.error || 'Message sent';
  if (response.ok) { document.querySelector('#message').value=''; await refresh(); }
});
</script></body></html>`;

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/agent-invite') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(html);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/join') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let input;
    try { input = JSON.parse(raw); } catch { sendJson(response, 400, { error: 'Invalid JSON' }); return; }
    if (typeof input.invite !== 'string' || input.invite !== ownerInvite || inviteUsed) {
      sendJson(response, 401, { error: 'Invitation invalid, expired, or already used' }); return;
    }
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) {
      sendJson(response, 400, { error: 'A valid agent display name is required' }); return;
    }
    inviteUsed = true;
    sessionActive = true;
    sendJson(response, 200, { session: sessionToken, participant: input.name.trim() });
    return;
  }
  if (url.pathname === '/api/agent/messages') {
    if (request.headers.authorization !== 'Bearer ' + sessionToken || !sessionActive) {
      sendJson(response, 401, { error: 'Guest connection is not authorized or has been revoked' }); return;
    }
    if (request.method === 'GET') { sendJson(response, 200, { messages }); return; }
    if (request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      let input;
      try { input = JSON.parse(raw); } catch { sendJson(response, 400, { error: 'Invalid JSON' }); return; }
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 1000) {
        sendJson(response, 400, { error: 'Message must be 1-1000 characters' }); return;
      }
      messages.push({ sender: 'Playwright AI Guest', body: input.body.trim() });
      sendJson(response, 201, { ok: true });
      return;
    }
  }
  sendJson(response, 404, { error: 'Not found' });
});

const browser = await chromium.launch({ headless: true });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const context = await browser.newContext();
  const page = await context.newPage();

  // No invite means no connection; there is deliberately no sign-up screen.
  await page.goto(origin + '/agent-invite');
  assert.equal(await page.getByRole('button', { name: 'Join authorized room' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /sign up|create account/i }).count(), 0);
  await page.getByRole('button', { name: 'Join authorized room' }).click();
  await page.getByText('Invitation invalid, expired, or already used').waitFor();
  assert.equal(await page.locator('#room').isVisible(), false);

  // An invalid token cannot join.
  const invalidPage = await context.newPage();
  await invalidPage.goto(origin + '/agent-invite?invite=not-a-valid-owner-token');
  await invalidPage.getByRole('button', { name: 'Join authorized room' }).click();
  await invalidPage.getByText('Invitation invalid, expired, or already used').waitFor();
  await invalidPage.close();

  // The owner-issued invite authorizes guest joining without human account creation.
  await page.goto(origin + '/agent-invite?invite=' + ownerInvite);
  await page.getByRole('button', { name: 'Join authorized room' }).click();
  await page.getByText('Connected as authorized guest').waitFor();
  await page.getByRole('heading', { name: 'Room messages' }).waitFor();
  await page.getByRole('textbox', { name: 'Message' }).fill('I joined without a human account using the owner-authorized Playwright guest flow.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText(/Playwright AI Guest: I joined without a human account/).waitFor();

  // Invitation replay is rejected even when another browser page retries it.
  const replayPage = await context.newPage();
  await replayPage.goto(origin + '/agent-invite?invite=' + ownerInvite);
  await replayPage.getByRole('button', { name: 'Join authorized room' }).click();
  await replayPage.getByText('Invitation invalid, expired, or already used').waitFor();
  await replayPage.close();

  // Model owner revocation and verify the same session can no longer post.
  sessionActive = false;
  await page.getByRole('textbox', { name: 'Message' }).fill('This must be rejected after revocation.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText('Guest connection is not authorized or has been revoked').waitFor();
  assert.equal(messages.some(m => m.body.includes('This must be rejected after revocation')), false);

  console.log('PASS: Playwright guest agent joins without human signup; invalid invite rejected; owner invite is single-use; message exchange works; revoked guest session is blocked.');
  console.log('SCOPE: isolated localhost mock only. No production room, credentials, or third-party AI account was accessed.');
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
