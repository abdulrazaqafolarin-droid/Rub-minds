#!/usr/bin/env node
/**
 * Controlled Playwright proof of concept for authorized browser interaction.
 *
 * Uses mock pages only. It does not sign in to a real provider, access real
 * user sessions, redeem a production invitation, or use real credentials.
 * Run: npm run test:browser
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const aiPage = await context.newPage();

  // Simulated AI chat: browser automation must retain context and reject
  // destinations outside the explicit test allowlist.
  await aiPage.setContent(`
    <main>
      <h1>Mock AI conversation</h1>
      <p id="prior-decision">Prior decision: use a bounded, opt-in test.</p>
      <label for="invite">Rub Minds invitation</label>
      <input id="invite" />
      <button id="open-invite">Open invitation</button>
      <p id="status" role="status">Waiting</p>
    </main>
    <script>
      document.querySelector('#open-invite').addEventListener('click', () => {
        const value = document.querySelector('#invite').value.trim();
        let parsed;
        try { parsed = new URL(value); } catch {
          document.querySelector('#status').textContent = 'Invalid invitation URL';
          return;
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'mock.rub-minds.test') {
          document.querySelector('#status').textContent = 'Blocked: destination is not allowlisted';
          return;
        }
        if (!parsed.searchParams.get('invite')) {
          document.querySelector('#status').textContent = 'Invitation token required';
          return;
        }
        document.querySelector('#status').textContent = 'Invitation selected: ' + parsed.href;
      });
    </script>
  `);

  // Prove the allowlist blocks a hostile destination before opening it.
  await aiPage.getByLabel('Rub Minds invitation').fill('https://evil.example/?invite=controlled-test-token');
  await aiPage.getByRole('button', { name: 'Open invitation' }).click();
  await aiPage.getByText('Blocked: destination is not allowlisted').waitFor();

  // Missing or malformed invitation links must fail before a join is attempted.
  await aiPage.getByLabel('Rub Minds invitation').fill('not a url');
  await aiPage.getByRole('button', { name: 'Open invitation' }).click();
  await aiPage.getByText('Invalid invitation URL').waitFor();
  await aiPage.getByLabel('Rub Minds invitation').fill('https://mock.rub-minds.test/');
  await aiPage.getByRole('button', { name: 'Open invitation' }).click();
  await aiPage.getByText('Invitation token required').waitFor();

  const mockInviteUrl = 'https://mock.rub-minds.test/?invite=controlled-test-token';
  await aiPage.getByLabel('Rub Minds invitation').fill(mockInviteUrl);
  await aiPage.getByRole('button', { name: 'Open invitation' }).click();
  await aiPage.getByText('Invitation selected: ' + mockInviteUrl).waitFor();

  // Simulated invite landing page. A browser action is not authorized just
  // because an invite URL was supplied: explicit consent is required first.
  const roomPage = await context.newPage();
  await roomPage.setContent(`
    <main>
      <h1>Mock Rub Minds invitation</h1>
      <p>Room: Controlled Playwright test room</p>
      <button id="human-route">Join as a human</button>
      <button id="ai-route">Connect as an AI</button>
      <section id="human-panel" hidden><p>Human route selected: sign-in or sign-up is required.</p></section>
      <section id="ai-panel" hidden>
        <label><input type="checkbox" id="authorize" /> I authorize this test agent to accept this invitation and send messages in this mock room.</label>
        <button id="accept" disabled>Accept invitation</button>
      </section>
      <p id="status" role="status">Choose an authorization route</p>
      <section id="room" hidden>
        <h2>Room messages</h2>
        <ol id="messages"><li>Owner: Welcome to the controlled test.</li></ol>
        <label for="message">Message</label>
        <input id="message" />
        <button id="send">Send message</button>
      </section>
      <script>
        const authorize = document.querySelector('#authorize');
        const accept = document.querySelector('#accept');
        document.querySelector('#human-route').addEventListener('click', () => {
          document.querySelector('#human-panel').hidden = false;
          document.querySelector('#ai-panel').hidden = true;
          document.querySelector('#status').textContent = 'Human route selected: sign-in required';
        });
        document.querySelector('#ai-route').addEventListener('click', () => {
          document.querySelector('#human-panel').hidden = true;
          document.querySelector('#ai-panel').hidden = false;
          document.querySelector('#status').textContent = 'AI route selected: separate credential required';
        });
        authorize.addEventListener('change', () => { accept.disabled = !authorize.checked; });
        accept.addEventListener('click', () => {
          if (!authorize.checked || document.querySelector('#ai-panel').hidden) return;
          document.querySelector('#room').hidden = false;
          document.querySelector('#status').textContent = 'Invitation accepted with explicit authorization';
          accept.disabled = true;
        });
        document.querySelector('#send').addEventListener('click', () => {
          if (!authorize.checked || document.querySelector('#room').hidden) return;
          const input = document.querySelector('#message');
          const body = input.value.trim();
          if (!body) return;
          const item = document.createElement('li');
          item.textContent = 'Mock AI: ' + body;
          document.querySelector('#messages').append(item);
          input.value = '';
        });
      </script>
    </main>
  `);

  // The same invite offers two explicit routes; the human route does not silently become AI auth.
  await roomPage.getByRole('button', { name: 'Join as a human' }).click();
  await roomPage.getByText('Human route selected: sign-in required').waitFor();
  assert.equal(await roomPage.locator('#room').isHidden(), true);
  await roomPage.getByRole('button', { name: 'Connect as an AI' }).click();
  await roomPage.getByText('AI route selected: separate credential required').waitFor();

  // No consent: joining must remain impossible.
  assert.equal(await roomPage.getByRole('button', { name: 'Accept invitation' }).isDisabled(), true);
  await roomPage.getByRole('heading', { name: 'Mock Rub Minds invitation' }).waitFor();
  await roomPage.getByRole('heading', { name: 'Room messages' }).waitFor({ state: 'detached' });

  // Explicit consent enables the action. Then verify a bounded room exchange.
  await roomPage.getByRole('checkbox', { name: /I authorize this test agent/ }).check();
  await roomPage.getByRole('button', { name: 'Accept invitation' }).click();
  await roomPage.getByRole('heading', { name: 'Room messages' }).waitFor();
  await roomPage.getByRole('textbox', { name: 'Message' }).fill('I joined the controlled room and can send a message.');
  await roomPage.getByRole('button', { name: 'Send message' }).click();
  await roomPage.getByText('Mock AI: I joined the controlled room and can send a message.').waitFor();

  // Revoking consent after joining must stop further mock messages.
  const messageCountBeforeRevoke = await roomPage.locator('#messages li').count();
  await roomPage.getByRole('checkbox', { name: /I authorize this test agent/ }).uncheck();
  await roomPage.getByRole('textbox', { name: 'Message' }).fill('This message must not be sent.');
  await roomPage.getByRole('button', { name: 'Send message' }).click();
  assert.equal(await roomPage.locator('#messages li').count(), messageCountBeforeRevoke);
  assert.equal(await roomPage.getByText('Mock AI: This message must not be sent.').count(), 0);

  // Original conversation context remains intact and separate from the room.
  assert.equal(await aiPage.locator('#prior-decision').textContent(),
    'Prior decision: use a bounded, opt-in test.');
  assert.match(await roomPage.locator('#messages').innerText(), /Owner: Welcome/);
  assert.match(await roomPage.locator('#messages').innerText(), /Mock AI: I joined/);
  assert.match(await roomPage.getByRole('status').innerText(), /explicit authorization/);

  // Also exercise the actual Rub Minds frontend in local demo mode. This is
  // a real Vite-served app page, not a setContent mock. No Supabase credentials
  // are supplied, so no real account or production data is touched.
  const vite = await createServer({
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
    appType: 'spa',
  });
  try {
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address === 'object' && address.port, 'Vite test server must bind a port');
    const appPage = await context.newPage();
    await appPage.goto('http://127.0.0.1:' + address.port, { waitUntil: 'domcontentloaded' });
    await appPage.getByRole('heading', { name: /Different minds/i }).waitFor();

    await appPage.getByRole('button', { name: /Create a group/i }).click();
    await appPage.getByRole('heading', { name: 'Create a new group' }).waitFor();
    await appPage.getByLabel('Group name').fill('Playwright authorized browser test');
    await appPage.getByLabel('Objective').fill('Verify the real Rub Minds demo UI with a bounded browser test.');
    await appPage.getByRole('button', { name: /Create group/i }).click();
    await appPage.getByRole('heading', { name: 'Playwright authorized browser test' }).waitFor();

    await appPage.getByRole('textbox', { name: 'Message' }).fill('Please confirm the test room is active.');
    await appPage.getByRole('button', { name: 'Send message' }).click();
    await appPage.getByText('Please confirm the test room is active.').waitFor();
    await appPage.getByRole('button', { name: /Run demo agent/i }).click();
    await appPage.getByText(/simulated response, not a connected ChatGPT or Claude session/i).waitFor();
    assert.match(await appPage.locator('.disclaimer').last().innerText(), /Invitation links are not yet remotely joinable/);
    await appPage.close();
  } finally {
    await vite.close();
  }

  console.log('PASS: mock origin allowlist; malformed/missing invitation rejected; separate human/AI routes; explicit consent and revocation gates; mock room message; original context retained; real Rub Minds demo UI creates a room, sends a message, and clearly labels its simulated agent.');
  console.log('SCOPE: local test server and mock pages only. No production credentials, real invitations, or provider sessions are accessed.');
  await context.close();
} finally {
  await browser.close();
}
