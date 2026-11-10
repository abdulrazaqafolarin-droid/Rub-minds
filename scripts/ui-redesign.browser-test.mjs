import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.RM_BASE_URL || 'http://127.0.0.1:4173';
const screenshotDir = process.env.RM_SCREENSHOT_DIR || '/tmp/rub-minds-ui-screenshots';
mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
const check = (condition, message) => assert.ok(condition, message);

async function noHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  check(metrics.document <= metrics.viewport + 1 && metrics.body <= metrics.viewport + 1,
    label + ' has horizontal overflow: ' + JSON.stringify(metrics));
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://ui-test.supabase.co/**', route => route.abort());
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Welcome to Rub Minds' }).waitFor();
  await page.locator('.rm-auth-story').waitFor();
  check(await page.locator('.rm-auth-story h2').innerText().then(text => text.includes('More perspectives.')),
    'Product-led sign-in story is missing.');
  await noHorizontalOverflow(page, 'Desktop sign-in');
  check(await page.locator('html').getAttribute('data-rm-theme') === 'light',
    'Initial light preference was not applied.');
  await page.screenshot({ path: resolve(screenshotDir, 'desktop-light-sign-in.png'), fullPage: true });

  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  check(await page.locator('html').getAttribute('data-rm-theme') === 'dark',
    'Theme toggle did not switch to dark mode.');
  check(await page.evaluate(() => localStorage.getItem('rub-minds-theme')) === 'dark',
    'Dark theme was not persisted.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Welcome to Rub Minds' }).waitFor();
  check(await page.locator('html').getAttribute('data-rm-theme') === 'dark',
    'Dark preference did not survive reload.');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  check(await page.locator('html').getAttribute('data-rm-theme') === 'light',
    'Theme toggle did not return to light mode.');

  await page.getByRole('button', { name: /Have an invitation\? Join with link/i }).click();
  await page.locator('.modal').waitFor();
  const inviteToken = 'a'.repeat(64);
  const inviteURL = 'https://rub-minds.vercel.app/?invite=' + inviteToken;
  await page.locator('.modal input').fill(inviteURL);
  await page.locator('.modal').getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Join a Rub Minds group' }).waitFor();
  check(new URL(page.url()).searchParams.get('invite') === inviteToken,
    'Pasted invitation was not preserved in the URL.');
  check((await page.locator('body').innerText()).includes('Human participant'),
    'Human invitation route is missing.');
  check((await page.locator('body').innerText()).includes('Use an existing AI conversation'),
    'Existing AI conversation route is missing.');
  await page.screenshot({ path: resolve(screenshotDir, 'invitation-route-selection.png'), fullPage: true });

  await page.getByRole('button', { name: 'Continue with my existing AI conversation' }).click();
  await page.getByRole('heading', { name: 'Bring your existing AI into this group' }).waitFor();
  check((await page.locator('body').innerText()).includes('not automatic two-way sync'),
    'Existing-AI onboarding overpromises native two-way sync.');
  await page.getByRole('button', { name: 'Back to route selection' }).click();
  await page.getByRole('button', { name: 'Set up a separate AI runtime' }).click();
  await page.getByRole('heading', { name: 'AI participant authorization' }).waitFor();
  check((await page.locator('body').innerText()).includes('separate AI participant'),
    'Separate AI runtime is not clearly distinguished.');
  await page.getByRole('button', { name: 'Back to route selection' }).click();
  await page.getByRole('button', { name: 'Continue as a human' }).click();
  await page.getByRole('heading', { name: 'You’re invited to Rub Minds' }).waitFor();
  check((await page.locator('body').innerText()).includes('Group invitation detected. Your invite will be kept while you sign in.'),
    'Invitation context did not survive the human sign-in route.');

  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Welcome to Rub Minds' }).waitFor();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByRole('heading', { name: 'Create your Rub Minds account' }).waitFor();
  check(await page.getByLabel('Confirm password').isVisible(),
    'Sign-up flow is missing the password confirmation field.');
  await page.screenshot({ path: resolve(screenshotDir, 'desktop-sign-up.png'), fullPage: true });
  await noHorizontalOverflow(page, 'Desktop sign-up');
  await context.close();

  // Exercise the signed-in workspace with an isolated local Supabase fixture.
  const signedIn = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const session = {
    access_token: 'ui-test-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'ui-test-refresh-token',
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'ui-tester@example.invalid',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
    },
  };
  await signedIn.addInitScript(value => {
    localStorage.setItem('sb-ui-test-auth-token', JSON.stringify(value));
  }, session);
  const workspace = await signedIn.newPage();
  workspace.on('pageerror', error => pageErrors.push(error.message));
  const fixtureRoom = {
    id: '00000000-0000-4000-8000-000000000002',
    owner_id: session.user.id,
    title: 'Design QA Group',
    objective: 'Verify the group-first collaboration journey.',
    created_at: '2026-11-10T12:00:00.000Z',
  };
  const fixtureParticipant = {
    id: '00000000-0000-4000-8000-000000000003',
    room_id: fixtureRoom.id,
    user_id: session.user.id,
    display_name: 'QA Human',
    kind: 'human',
    status: 'joined',
  };
  await workspace.route('https://ui-test.supabase.co/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    const table = url.pathname.split('/').pop();
    const single = (route.request().headers().accept || '').includes('vnd.pgrst.object');
    let value = [];
    if (table === 'rooms') value = url.searchParams.has('id') ? fixtureRoom : [fixtureRoom];
    if (table === 'participants') value = [fixtureParticipant];
    const payload = single && table === 'rooms' ? fixtureRoom : value;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': '0-0/*' },
      body: JSON.stringify(payload),
    });
  });
  await workspace.route('https://ui-test.supabase.co/auth/v1/**', route => route.abort());
  await workspace.goto(baseURL, { waitUntil: 'networkidle' });
  await workspace.locator('.rm-app-shell').waitFor();
  check(await workspace.locator('.rm-home-hero').isVisible(),
    'Signed-in home dashboard did not render.');
  check(await workspace.getByRole('navigation', { name: 'Your groups' }).isVisible(),
    'Signed-in group navigation is missing.');
  await noHorizontalOverflow(workspace, 'Signed-in desktop home');
  await workspace.screenshot({ path: resolve(screenshotDir, 'desktop-signed-in-home.png'), fullPage: true });

  await workspace.getByRole('button', { name: /Design QA Group/ }).first().click();
  await workspace.getByRole('heading', { name: 'Design QA Group' }).waitFor();
  check(await workspace.locator('.composer').isVisible(),
    'Group conversation composer did not appear.');
  await workspace.screenshot({ path: resolve(screenshotDir, 'desktop-group-conversation.png'), fullPage: true });
  await workspace.getByRole('button', { name: /People/ }).click();
  await workspace.getByText('QA Human', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: /Private context/ }).click();
  await workspace.getByText('Bring context from your existing AI', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: /Shared memory/ }).click();
  await workspace.getByText('What the group should remember', { exact: true }).waitFor();
  await workspace.getByRole('button', { name: /Connections/ }).click();
  await workspace.getByText('Connect more minds', { exact: true }).waitFor();
  await noHorizontalOverflow(workspace, 'Signed-in group workspace');
  await workspace.getByRole('button', { name: /Conversation/ }).click();

  await workspace.getByRole('button', { name: 'Create a group' }).first().click();
  await workspace.getByRole('heading', { name: 'Create a live group' }).waitFor();
  await workspace.getByLabel('Group name').fill('Browser acceptance group');
  await workspace.getByLabel('Objective').fill('Exercise the signed-in group creation flow without writing to Supabase.');
  await workspace.getByRole('button', { name: 'Cancel' }).click();
  check(await workspace.locator('.rm-home-hero').isVisible(),
    'Closing the group creation dialog lost the home dashboard.');

  await workspace.getByRole('button', { name: 'Join with invitation' }).first().click();
  await workspace.getByRole('heading', { name: 'Join a group' }).waitFor();
  await workspace.getByRole('button', { name: 'Cancel' }).click();

  const backroomLink = workspace.getByRole('link', { name: /Backroom device workspace/ });
  check((await backroomLink.getAttribute('href'))?.includes('backroom=1'),
    'Backroom entry is not available from the signed-in workspace.');
  await workspace.goto(baseURL + '?backroom=1', { waitUntil: 'networkidle' });
  await workspace.locator('.br-shell.rm-backroom-shell').waitFor();
  check(await workspace.locator('.br-collaboration-link').isVisible(),
    'Backroom does not provide a return path to Collaboration.');
  check(await workspace.locator('.rm-theme-toggle.compact').isVisible(),
    'Backroom does not share the theme toggle.');
  await noHorizontalOverflow(workspace, 'Signed-in Backroom');
  await workspace.screenshot({ path: resolve(screenshotDir, 'desktop-backroom-workspace.png'), fullPage: true });
  await signedIn.close();

  for (const width of [390, 360]) {
    const mobile = await browser.newContext({
      viewport: { width, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const mobilePage = await mobile.newPage();
    mobilePage.on('pageerror', error => pageErrors.push(error.message));
    await mobilePage.route('https://ui-test.supabase.co/**', route => route.abort());
    await mobilePage.goto(baseURL, { waitUntil: 'networkidle' });
    await mobilePage.getByRole('heading', { name: 'Welcome to Rub Minds' }).waitFor();
    check(await mobilePage.locator('html').getAttribute('data-rm-theme') === 'dark',
      'System dark preference was not applied on mobile.');
    check(await mobilePage.locator('.rm-auth-story').evaluate(el => getComputedStyle(el).display) === 'none',
      'Mobile auth layout did not collapse the illustration.');
    check(await mobilePage.locator('.auth-panel').isVisible(), 'Mobile sign-in panel is not visible.');
    await noHorizontalOverflow(mobilePage, 'Mobile sign-in ' + width + 'px');
    await mobilePage.screenshot({ path: resolve(screenshotDir, 'mobile-' + width + '-dark-sign-in.png'), fullPage: true });
    await mobilePage.getByRole('button', { name: 'Switch to light mode' }).click();
    check(await mobilePage.locator('html').getAttribute('data-rm-theme') === 'light',
      'Mobile theme toggle failed.');
    await mobilePage.getByRole('button', { name: /Have an invitation\? Join with link/i }).click();
    await mobilePage.locator('.modal').waitFor();
    await noHorizontalOverflow(mobilePage, 'Mobile invitation modal ' + width + 'px');
    await mobile.close();
  }

  const backroom = await browser.newPage({ viewport: { width: 390, height: 844 } });
  backroom.on('pageerror', error => pageErrors.push(error.message));
  await backroom.route('https://ui-test.supabase.co/**', route => route.abort());
  await backroom.goto(baseURL + '?backroom=1', { waitUntil: 'networkidle' });
  await backroom.getByRole('heading', { name: 'Backroom access' }).waitFor();
  check((await backroom.locator('body').innerText()).includes('Please sign in.'),
    'Backroom did not preserve its signed-in access gate.');
  await noHorizontalOverflow(backroom, 'Mobile Backroom access gate');
  await backroom.screenshot({ path: resolve(screenshotDir, 'mobile-backroom-access-gate.png'), fullPage: true });

  const expectedScreenshots = [
    'desktop-light-sign-in.png',
    'invitation-route-selection.png',
    'desktop-sign-up.png',
    'desktop-signed-in-home.png',
    'desktop-group-conversation.png',
    'desktop-backroom-workspace.png',
    'mobile-390-dark-sign-in.png',
    'mobile-360-dark-sign-in.png',
    'mobile-backroom-access-gate.png',
  ];
  const screenshotEntries = readdirSync(screenshotDir, { withFileTypes: true });
  const generatedScreenshots = screenshotEntries.filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => entry.name).sort();
  const missingScreenshots = expectedScreenshots.filter(file => !generatedScreenshots.includes(file));
  const nonFileScreenshots = screenshotEntries.filter(entry => entry.name.endsWith('.png') && !entry.isFile()).map(entry => entry.name);
  check(missingScreenshots.length === 0, 'Missing regular visual-review PNG files: ' + missingScreenshots.join(', '));
  check(nonFileScreenshots.length === 0, 'Screenshot paths are not regular files: ' + nonFileScreenshots.join(', '));
  for (const file of expectedScreenshots) {
    check(statSync(resolve(screenshotDir, file)).size > 0, 'Screenshot is empty: ' + file);
  }
  check(pageErrors.length === 0, 'Browser runtime errors: ' + pageErrors.join(' | '));
  console.log('Visual-review screenshots: ' + generatedScreenshots.join(', '));
  console.log('PASS: desktop welcome, sign-in and sign-up');
  console.log('PASS: signed-in home, group conversation, People, Private context, Shared memory and Connections');
  console.log('PASS: create-group dialog, invitation dialog and Backroom return path');
  console.log('PASS: theme toggle and persisted preference');
  console.log('PASS: paste invite before sign-in and preserve invite token');
  console.log('PASS: human, existing-AI and separate-runtime invitation routes');
  console.log('PASS: responsive dark-mode sign-in and invitation modal at 390px and 360px');
  console.log('PASS: original Backroom signed-out access gate');
  console.log('PASS: no horizontal overflow or uncaught browser errors');
  console.log('Screenshots captured for desktop, mobile and Backroom visual review.');
  await backroom.close();
} finally {
  await browser.close();
}
