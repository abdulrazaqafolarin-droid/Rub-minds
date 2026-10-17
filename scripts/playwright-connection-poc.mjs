#!/usr/bin/env node
/**
 * Controlled Playwright proof of concept for authorized browser interaction.
 *
 * This deliberately uses a mock AI chat and mock invitation/room pages. It does
 * not sign in to a real provider, access real user sessions, or test production.
 * Run: npm run test:browser
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const aiPage = await context.newPage();

  // Simulated existing AI conversation. The "prior decision" checks that the
  // browser workflow does not replace the source conversation's visible context.
  await aiPage.setContent(`
    <main>
      <h1>Mock AI conversation</h1>
      <p id="prior-decision">Prior decision: use a bounded, opt-in test.</p>
      <label for="invite">Rub Minds invitation</label>
      <input id="invite" />
      <button id="open-invite">Open invitation</button>
      <p id="status">Waiting</p>
    </main>
    <script>
      document.querySelector('#open-invite').addEventListener('click', () => {
        const value = document.querySelector('#invite').value.trim();
        if (!value) { document.querySelector('#status').textContent = 'Invitation required'; return; }
        document.querySelector('#status').textContent = 'Invitation selected: ' + value;
      });
    </script>
  `);

  const mockInviteUrl = 'https://mock.rub-minds.test/?invite=controlled-test-token';
  await aiPage.getByLabel('Rub Minds invitation').fill(mockInviteUrl);
  await aiPage.getByRole('button', { name: 'Open invitation' }).click();
  await assert.doesNotReject(async () => {
    await aiPage.getByText('Invitation selected: ' + mockInviteUrl).waitFor();
  });

  // A second mock page stands in for the invitation landing page and room UI.
  // No network requests or real credentials are used.
  const roomPage = await context.newPage();
  await roomPage.setContent(`
    <main>
      <h1>Mock Rub Minds invitation</h1>
      <p>Room: Controlled Playwright test room</p>
      <button id="accept">Accept invitation</button>
      <section id="room" hidden>
        <h2>Room messages</h2>
        <ol id="messages"><li>Owner: Welcome to the controlled test.</li></ol>
        <label for="message">Message</label>
        <input id="message" />
        <button id="send">Send message</button>
      </section>
      <script>
        document.querySelector('#accept').addEventListener('click', () => {
          document.querySelector('#room').hidden = false;
          document.querySelector('#accept').disabled = true;
        });
        document.querySelector('#send').addEventListener('click', () => {
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

  await roomPage.getByRole('button', { name: 'Accept invitation' }).click();
  await roomPage.getByRole('heading', { name: 'Room messages' }).waitFor();
  await roomPage.getByLabel('Message').fill('I joined the controlled room and can send a message.');
  await roomPage.getByRole('button', { name: 'Send message' }).click();
  await roomPage.getByText('Mock AI: I joined the controlled room and can send a message.').waitFor();

  // Verify the original mock conversation remains intact and distinct.
  assert.equal(await aiPage.locator('#prior-decision').textContent(),
    'Prior decision: use a bounded, opt-in test.');
  assert.match(await roomPage.locator('#messages').innerText(), /Owner: Welcome/);
  assert.match(await roomPage.locator('#messages').innerText(), /Mock AI: I joined/);

  console.log('PASS: invitation selected, Accept invitation clicked, room opened, message sent, prior context retained.');
  console.log('SCOPE: controlled mock pages only; real Rub Minds integration and provider-session access are not tested.');
  await context.close();
} finally {
  await browser.close();
}
