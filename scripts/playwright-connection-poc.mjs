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
      <label><input type="checkbox" id="authorize" /> I authorize this test agent to accept this invitation and send messages in this mock room.</label>
      <button id="accept" disabled>Accept invitation</button>
      <p id="status" role="status">Waiting for explicit authorization</p>
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
        authorize.addEventListener('change', () => { accept.disabled = !authorize.checked; });
        accept.addEventListener('click', () => {
          if (!authorize.checked) return;
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

  // No consent: joining must remain impossible.
  assert.equal(await roomPage.getByRole('button', { name: 'Accept invitation' }).isDisabled(), true);
  await roomPage.getByRole('heading', { name: 'Mock Rub Minds invitation' }).waitFor();
  await roomPage.getByRole('heading', { name: 'Room messages' }).waitFor({ state: 'detached' });

  // Explicit consent enables the action. Then verify a bounded room exchange.
  await roomPage.getByRole('checkbox', { name: /I authorize this test agent/ }).check();
  await roomPage.getByRole('button', { name: 'Accept invitation' }).click();
  await roomPage.getByRole('heading', { name: 'Room messages' }).waitFor();
  await roomPage.getByLabel('Message').fill('I joined the controlled room and can send a message.');
  await roomPage.getByRole('button', { name: 'Send message' }).click();
  await roomPage.getByText('Mock AI: I joined the controlled room and can send a message.').waitFor();

  // Original conversation context remains intact and separate from the room.
  assert.equal(await aiPage.locator('#prior-decision').textContent(),
    'Prior decision: use a bounded, opt-in test.');
  assert.match(await roomPage.locator('#messages').innerText(), /Owner: Welcome/);
  assert.match(await roomPage.locator('#messages').innerText(), /Mock AI: I joined/);
  assert.match(await roomPage.getByRole('status').innerText(), /explicit authorization/);

  console.log('PASS: non-allowlisted destination blocked; no consent means no join; explicit consent enables acceptance; room message sent; prior context retained.');
  console.log('SCOPE: controlled mock pages only. This is not production authentication or proof of real AI-provider session control.');
  await context.close();
} finally {
  await browser.close();
}
