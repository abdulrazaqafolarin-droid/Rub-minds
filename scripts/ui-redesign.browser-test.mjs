import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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

  check(pageErrors.length === 0, 'Browser runtime errors: ' + pageErrors.join(' | '));
  console.log('PASS: desktop welcome, sign-in and sign-up');
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
