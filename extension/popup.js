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

async function refresh() {
  activeTabId = null;
  providerReady = false;
  setControls(false);
  try {
    const { provider } = await getActiveTab();
    setMessage(provider + ' tab detected. Checking helper…');
    const result = await chrome.tabs.sendMessage(activeTabId, {
      type: 'RUB_MINDS_EXTENSION_CONTROL',
      action: 'status',
    });
    if (!result?.ok || !result.state) throw new Error('Extension helper is not responding. Reload this tab, then reopen the popup.');
    setControls(true, result.state);
    setMessage(provider + ' helper ready. MCP connection must be configured separately.', result.state.status);
  } catch (error) {
    activeTabId = null;
    setControls(false);
    setMessage(error?.message || 'Open a supported AI conversation tab.');
  }
}

for (const action of ['start', 'pause', 'resume', 'stop']) {
  $(action).addEventListener('click', () => { void sendAction(action); });
}
void refresh();
