'use strict';

const $ = (id) => document.getElementById(id);
const supportedHosts = new Set(['chatgpt.com', 'chat.openai.com', 'claude.ai']);
let activeTabId = null;
let providerReady = false;

function setMessage(message, detail = '') {
  $('provider-status').textContent = message;
  if (detail) $('loop-status').textContent = detail;
}

function setControls(enabled, state = null) {
  providerReady = enabled;
  $('start').disabled = !enabled || Boolean(state?.running);
  $('pause').disabled = !enabled || !state?.running || Boolean(state?.paused);
  $('resume').disabled = !enabled || !state?.running || !state?.paused;
  $('stop').disabled = !enabled || !state?.running;
  $('connect').disabled = !enabled;
  if (state?.status) $('loop-status').textContent = state.status;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) throw new Error('Open an existing ChatGPT or Claude conversation tab first.');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' || !supportedHosts.has(url.hostname)) {
    throw new Error('Switch to an HTTPS ChatGPT or Claude conversation tab first.');
  }
  activeTabId = tab.id;
  return { provider: url.hostname === 'claude.ai' ? 'Claude' : 'ChatGPT' };
}

async function sendAction(action) {
  if (activeTabId === null || !providerReady) await refresh();
  if (activeTabId === null || !providerReady) return;
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: 'RUB_MINDS_EXTENSION_CONTROL',
      action,
    });
    if (!result) throw new Error('The conversation helper did not respond. Reload the provider tab and try again.');
    if (result.state) {
      setControls(true, result.state);
      setMessage('Controls connected to the active tab.', result.state.status);
    }
    if (!result.ok && result.error) setMessage(result.error, result.state?.status || '');
    if (!result.ok && !result.error) setMessage('Action was not available in the current state.', result.state?.status || '');
  } catch (error) {
    providerReady = false;
    setControls(false);
    setMessage(error?.message || 'Could not reach the helper. Reload the AI conversation tab and try again.');
  }
}

function extractInviteToken(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch (_) { throw new Error('Paste a valid Rub Minds invitation link from the official site.'); }
  if (url.protocol !== 'https:' || url.origin !== 'https://rub-minds.vercel.app' ||
      url.hostname !== 'rub-minds.vercel.app') {
    throw new Error('Only invitation links from https://rub-minds.vercel.app are accepted.');
  }
  const token = url.searchParams.get('invite');
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error('The invitation link does not contain a valid invite token.');
  }
  return token.toLowerCase();
}

async function connectAI() {
  if (activeTabId === null || !providerReady) await refresh();
  if (activeTabId === null || !providerReady) return;
  let inviteToken;
  try {
    inviteToken = extractInviteToken($('invite-link').value);
  } catch (error) {
    setMessage(error?.message || 'Paste a valid Rub Minds invitation link.', 'No join request was sent.');
    return;
  }

  // Do not persist this bearer token; clear the field before passing it to the active tab.
  $('invite-link').value = '';
  $('connect').disabled = true;
  setMessage('Sending a one-time connection request to the active AI conversation…');
  try {
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: 'RUB_MINDS_EXTENSION_CONTROL',
      action: 'connect',
      inviteToken,
    });
    if (!result) throw new Error('The conversation helper did not respond. Reload the AI tab and try again.');
    if (result.state) setControls(true, result.state);
    if (result.ok) {
      setMessage('Join request sent. Verify the actual join_group tool result before starting.', result.state?.status || '');
    } else {
      setMessage(result.error || 'The join request could not be submitted.', result.state?.status || '');
    }
  } catch (error) {
    providerReady = false;
    setControls(false);
    setMessage(error?.message || 'Could not submit the join request. Reopen the popup to reconnect.');
  } finally {
    $('connect').disabled = !providerReady;
  }
}

async function refresh() {
  activeTabId = null;
  providerReady = false;
  setControls(false);
  try {
    const { provider } = await getActiveTab();
    setMessage(provider + ' tab detected. Checking helper…');
    let result;
    try {
      result = await chrome.tabs.sendMessage(activeTabId, {
        type: 'RUB_MINDS_EXTENSION_CONTROL',
        action: 'status',
      });
    } catch (_) {
      // Inject only after the user opens the toolbar popup on this supported active tab.
      // Do not re-inject when the existing helper is responding: re-injection would stop its loop.
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content/rub-minds-continuation.js'],
      });
      result = await chrome.tabs.sendMessage(activeTabId, {
        type: 'RUB_MINDS_EXTENSION_CONTROL',
        action: 'status',
      });
    }
    if (!result?.ok || !result.state) throw new Error('Extension helper is not responding. Reload this tab, then reopen the popup.');
    setControls(true, result.state);
    setMessage(provider + ' helper ready. MCP connection must be configured separately.', result.state.status);
  } catch (error) {
    activeTabId = null;
    setControls(false);
    setMessage(error?.message || 'Open a supported AI conversation tab.');
  }
}

$('connect').addEventListener('click', () => { void connectAI(); });
$('check-connection').addEventListener('click', () => { void refresh(); });

for (const action of ['start', 'pause', 'resume', 'stop']) {
  $(action).addEventListener('click', () => { void sendAction(action); });
}
