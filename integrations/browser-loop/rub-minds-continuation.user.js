// ==UserScript==
// @name         Rub Minds Conversation Continuation
// @namespace    https://rub-minds.vercel.app/
// @version      1.0.0
// @description  Manually started, bounded continuation loop for an existing ChatGPT or Claude conversation.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const SITES = {
    'chatgpt.com': {
      input: ['#prompt-textarea', 'textarea[placeholder]', '[contenteditable="true"]'],
      send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]'],
      replies: ['[data-message-author-role="assistant"]'],
      userMessages: ['[data-message-author-role="user"]'],
    },
    'chat.openai.com': {
      input: ['#prompt-textarea', 'textarea[placeholder]', '[contenteditable="true"]'],
      send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]'],
      replies: ['[data-message-author-role="assistant"]'],
      userMessages: ['[data-message-author-role="user"]'],
    },
    'claude.ai': {
      input: ['div[contenteditable="true"]', 'textarea'],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop Response"]', 'button[aria-label*="Stop response"]'],
      replies: ['.font-claude-response', '[data-testid="chat-message-content"]'],
      userMessages: ['[data-testid*="user-message"]', '[data-testid*="human-message"]'],
    },
  };
  const site = SITES[location.hostname];
  if (!site) return;

  // Re-running the userscript must stop the old instance before replacing its UI.
  try { window.__RUBMINDS_CONTINUATION_LOOP__?.stop('Replaced by a new script instance.'); } catch (_) {}

  const STORAGE_KEY = 'rubMindsContinuationSettingsV1';
  const RECOVERY_KEY = 'rubMindsConversationBindingV1';
  const defaults = {
    maxRounds: 5,
    delaySec: 3,
    timeoutMin: 5,
    mode: 'smart',
    trigger: [
      'Continue the work in this same conversation, preserving its existing context and working style.',
      'Before acting, use the Rub Minds MCP tools connected to this conversation, if available, to check relevant new group messages and context since your last processed point.',
      'Participate like a considerate group member: casual conversation, humor, and brief natural exchanges are welcome, not just tasks. Answer when directly addressed or when you can add something worthwhile; do not interrupt every exchange, manufacture messages, or start AI-to-AI reply loops.',
      'Decide naturally whether a group reply is useful: answer direct questions and relevant requests, contribute meaningful progress, avoid filler, duplicates, or replying to every message, and stay quiet in the group when no response is warranted.',
      'When there is assigned work, advance it by one concrete, useful step. Otherwise, follow the selected participation mode and respond naturally without inventing a task. Never claim you checked messages, sent something, or completed work unless the relevant tool/result verifies it.',
      'If the Rub Minds tools are unavailable, the group state cannot be checked, a human decision is needed, or you are blocked, stop this loop and explain the blocker rather than pretending.',
      'Keep control markers outside any deliverable, code block, or copy-ready artifact. At the very end of your response, write exactly one standalone control line: RUBMINDS_LOOP: CONTINUE if another bounded useful step is appropriate; RUBMINDS_LOOP: DONE only when the assigned work is complete and verified; or RUBMINDS_LOOP: PAUSE when human input or authorization is required. Do not use these control lines anywhere else.',
    ].join('\n\n'),
  };

  const clampInteger = (value, min, max, fallback) => {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  let settings = { ...defaults };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    settings = {
      ...defaults,
      maxRounds: clampInteger(stored.maxRounds, 1, 20, defaults.maxRounds),
      delaySec: clampInteger(stored.delaySec, 1, 120, defaults.delaySec),
      timeoutMin: clampInteger(stored.timeoutMin, 1, 20, defaults.timeoutMin),
      mode: ['smart', 'mentions', 'focus'].includes(stored.mode) ? stored.mode : defaults.mode,
      // Free-form prompt text stays in memory only; do not persist possible private context.
      trigger: defaults.trigger,
    };
  } catch (_) { /* keep defaults */ }
  const persistSettings = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        maxRounds: settings.maxRounds,
        delaySec: settings.delaySec,
        timeoutMin: settings.timeoutMin,
        mode: settings.mode,
      }));
    } catch (_) { /* storage may be disabled; loop still works for this page */ }
  };

  // Recovery URLs stay in this provider origin's localStorage. They are never
  // sent to Rub Minds, MCP, or other group members by this userscript.
  const providerLabel = location.hostname === 'claude.ai' ? 'Claude' : 'ChatGPT';
  const makeResumeId = () => {
    try { return crypto.randomUUID(); }
    catch (_) { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
  };
  const safeConversationUrl = (value) => {
    try {
      if (typeof value !== 'string' || !value) return null;
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.hostname !== location.hostname ||
          !Object.prototype.hasOwnProperty.call(SITES, parsed.hostname)) return null;
      const isConversationRoute = parsed.hostname === 'claude.ai'
        ? /^\/(?:project\/[^/]+\/)?chat\/[^/]+(?:\/.*)?$/.test(parsed.pathname)
        : /^\/(?:g\/[^/]+\/)?c\/[^/]+(?:\/.*)?$/.test(parsed.pathname);
      if (!isConversationRoute) return null;
      // Strip query/hash so unrelated transient state or invite parameters are not retained.
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) { return null; }
  };
  const currentConversationUrl = () => {
    const origin = location.origin || `https://${location.hostname}`;
    return safeConversationUrl(`${origin}${location.pathname}`);
  };
  const getSavedConversation = () => {
    try {
      const record = JSON.parse(localStorage.getItem(RECOVERY_KEY) || 'null');
      const url = safeConversationUrl(record?.url);
      if (!url) return null;
      const resumeId = typeof record.resumeId === 'string' && record.resumeId.length >= 8 && record.resumeId.length <= 100
        ? record.resumeId : makeResumeId();
      const normalized = { url, provider: providerLabel, savedAt: typeof record.savedAt === 'string' ? record.savedAt : '', resumeId };
      if (record.url !== url || record.provider !== providerLabel || record.resumeId !== resumeId) {
        try { localStorage.setItem(RECOVERY_KEY, JSON.stringify(normalized)); } catch (_) {}
      }
      return normalized;
    } catch (_) { return null; }
  };
  let savedConversation = getSavedConversation();

  const rememberCurrentConversation = () => {
    const url = currentConversationUrl();
    if (!url) return false;
    const resumeId = savedConversation?.url === url && savedConversation.resumeId
      ? savedConversation.resumeId : makeResumeId();
    const record = { url, provider: providerLabel, savedAt: new Date().toISOString(), resumeId };
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(record));
      savedConversation = record;
      updateRecoveryUi();
      return true;
    } catch (_) {
      savedConversation = null;
      updateRecoveryUi();
      return false;
    }
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const firstVisible = (selectors) => {
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (node && !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0) return node;
      }
    }
    return null;
  };
  const allMatching = (selectors) => {
    const out = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!seen.has(node)) { seen.add(node); out.push(node); }
      }
    }
    return out;
  };
  const inputNode = () => firstVisible(site.input);
  const sendNode = () => firstVisible(site.send);
  const isGenerating = () => Boolean(firstVisible(site.stop));
  const readText = (node) => String(node?.innerText ?? node?.textContent ?? '').trim();
  const replyNodes = () => allMatching(site.replies);
  const userNodes = () => allMatching(site.userMessages);
  const snapshot = () => {
    const replies = replyNodes();
    return {
      assistantCount: replies.length,
      lastAssistant: replies.length ? readText(replies[replies.length - 1]) : '',
      userCount: userNodes().length,
      path: location.pathname,
    };
  };
  const composerText = (input) => String(input?.value ?? input?.innerText ?? input?.textContent ?? '').trim();

  function setInput(text) {
    const input = inputNode();
    if (!input) throw new Error('Composer not found. The provider UI may have changed.');
    if (composerText(input)) throw new Error('Composer contains a draft. Clear or send it manually before starting the loop.');
    input.focus();

    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('Could not safely set composer value.');
      setter.call(input, text);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      // Keep selection inside the provider's focused editable element.
      input.focus();
      if (!document.execCommand('selectAll', false, null) || !document.execCommand('insertText', false, text)) {
        throw new Error('Could not insert text into the provider composer.');
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return input;
  }

  function clearInsertedText(input, expectedText) {
    // Restore only the text this loop inserted; never erase a concurrent human edit.
    if (!input || composerText(input) !== expectedText.trim()) return;
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, '');
    } else {
      input.focus();
      if (document.execCommand('selectAll', false, null)) document.execCommand('delete', false, null);
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }

  function ensureReadyToSend(expectedPath, expectedUserCount, manualAction = false) {
    if (manualAction ? (running || paused) : (!running || paused)) {
      throw new Error(manualAction
        ? 'A continuation run is active; stop it before submitting the private-memory request.'
        : 'Loop stopped or paused before sending; no message was sent.');
    }
    if (expectedPath && location.pathname !== expectedPath) throw new Error('Conversation changed before sending; no message was sent.');
    if (userNodes().length !== expectedUserCount) throw new Error('Human conversation activity detected before sending; no message was sent.');
    if (isGenerating()) throw new Error('Provider is generating a reply; no continuation was sent.');
    const input = inputNode();
    if (!input || composerText(input)) throw new Error('Composer draft or unavailable input detected before sending.');
  }

  async function sendMessage(text, expectedPath, expectedUserCount, manualAction = false) {
    ensureReadyToSend(expectedPath, expectedUserCount, manualAction);
    const input = setInput(text);
    await sleep(350);
    try {
      if ((manualAction ? (running || paused) : (!running || paused)) || (expectedPath && location.pathname !== expectedPath) ||
          userNodes().length !== expectedUserCount || isGenerating() || inputNode() !== input ||
          composerText(input) !== text.trim()) {
        throw new Error('Page, conversation, draft, or loop state changed before send. Nothing was sent.');
      }
    } catch (error) {
      clearInsertedText(input, text);
      throw error;
    }
    const button = sendNode();
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      clearInsertedText(input, text);
      throw new Error('Send button unavailable or disabled. Nothing was sent by the loop.');
    }
    button.click();
  }

  function readDirective(reply) {
    const lines = String(reply || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const last = lines.length ? lines[lines.length - 1] : '';
    const match = /^RUBMINDS_LOOP:\s*(CONTINUE|DONE|PAUSE)$/.exec(last);
    return match ? match[1] : null;
  }

  let running = false;
  let paused = false;
  let rounds = 0;
  let stopReason = '';
  let threadPath = null;
  let pauseWaiters = [];
  let privateMemoryRequested = false;

  const panel = document.createElement('section');
  panel.id = 'rubminds-continuation-panel';
  panel.setAttribute('aria-label', 'Rub Minds conversation continuation controls');
  panel.style.cssText = [
    'position:fixed', 'right:10px', 'bottom:76px', 'z-index:2147483647',
    'width:290px', 'max-width:calc(100vw - 24px)', 'max-height:70vh', 'overflow:auto',
    'padding:10px', 'background:#171717', 'color:#f5f5f5', 'border:1px solid #555',
    'border-radius:10px', 'box-shadow:0 4px 18px #0008', 'font:12px/1.4 system-ui,sans-serif',
  ].join(';');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <strong>Rub Minds · Continuation</strong>
      <button type="button" id="rm-collapse" aria-label="Collapse panel">−</button>
    </div>
    <div id="rm-controls" style="margin-top:8px">
      <label style="display:block;margin:6px 0">Participation mode
        <select id="rm-mode" style="display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:5px">
          <option value="smart">Smart participation — casual chat and work</option>
          <option value="mentions">Mentions and assigned tasks only</option>
          <option value="focus">Focus on current task</option>
        </select>
      </label>
      <label style="display:block;margin:6px 0">Cycle prompt
        <textarea id="rm-trigger" rows="5" style="display:block;width:100%;box-sizing:border-box;margin-top:3px"></textarea>
      </label>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Max cycles (1–20)
          <input id="rm-max" type="number" min="1" max="20" style="display:block;width:100%;box-sizing:border-box">
        </label>
        <label style="flex:1">Delay seconds (1–120)
          <input id="rm-delay" type="number" min="1" max="120" style="display:block;width:100%;box-sizing:border-box">
        </label>
      </div>
      <label style="display:block;margin:6px 0">Reply timeout minutes (1–20)
        <input id="rm-timeout" type="number" min="1" max="20" style="display:block;width:100%;box-sizing:border-box">
      </label>
      <div style="margin-top:8px;padding:7px;border:1px solid #555;border-radius:6px">
        <label style="display:flex;align-items:flex-start;gap:6px">
          <input id="rm-remember" type="checkbox">
          <span>Remember this conversation on this browser for recovery</span>
        </label>
        <div id="rm-recovery" role="status" style="margin-top:5px;color:#c9c9c9">No saved conversation.</div>
        <button type="button" id="rm-reopen" style="width:100%;margin-top:5px;padding:6px" disabled>Reopen saved conversation</button>
        <button type="button" id="rm-forget-recovery" style="width:100%;margin-top:5px;padding:6px" disabled>Forget saved recovery link</button>
        <button type="button" id="rm-save-private" style="width:100%;margin-top:5px;padding:6px" disabled>Save link privately in Rub Minds</button>
        <div style="margin-top:4px;color:#c9c9c9">Optional: sends one prompt asking the connected MCP session to save only this link as private participant memory. Verify the actual tool result.</div>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button type="button" id="rm-start" style="flex:1;padding:7px;font-weight:700">Start</button>
        <button type="button" id="rm-pause" style="flex:1;padding:7px" disabled>Pause</button>
        <button type="button" id="rm-resume" style="flex:1;padding:7px" disabled>Resume</button>
        <button type="button" id="rm-stop" style="flex:1;padding:7px" disabled>Stop</button>
      </div>
      <div id="rm-status" role="status" aria-live="polite" style="margin-top:8px;overflow-wrap:anywhere">Idle — review the prompt and start manually.</div>
      <div style="margin-top:6px;color:#c9c9c9">Manual opt-in only. Pause waits for the current reply to finish. Stop prevents further automatic prompts. Never leave unattended.</div>
    </div>`;
  document.getElementById('rubminds-continuation-panel')?.remove();
  document.body.appendChild(panel);

  const el = (id) => panel.querySelector(`#${id}`);
  el('rm-trigger').value = settings.trigger;
  el('rm-mode').value = settings.mode;
  el('rm-max').value = String(settings.maxRounds);
  el('rm-delay').value = String(settings.delaySec);
  el('rm-timeout').value = String(settings.timeoutMin);
  el('rm-remember').checked = Boolean(savedConversation && new URL(savedConversation.url).pathname === location.pathname);
  const status = (text) => { el('rm-status').textContent = text; };
  function updateRecoveryUi() {
    const message = el('rm-recovery');
    const reopen = el('rm-reopen');
    if (!savedConversation) {
      message.textContent = 'No recovery link saved. Opt in while viewing a specific conversation.';
      reopen.disabled = true;
      reopen.textContent = 'Reopen saved conversation';
      el('rm-forget-recovery').disabled = true;
      el('rm-save-private').disabled = true;
      el('rm-save-private').textContent = 'Save link privately in Rub Minds';
      return;
    }
    const savedPath = new URL(savedConversation.url).pathname;
    const isCurrent = location.pathname === savedPath;
    message.textContent = privateMemoryRequested
      ? 'Saved locally. A private-memory request was submitted; verify the assistant tool result. It was not posted as a group message.'
      : `Saved locally in this browser only (${savedConversation.provider}). It is not shared with Rub Minds or the group.`;
    reopen.disabled = isCurrent;
    reopen.textContent = isCurrent ? 'Saved conversation is already open' : 'Reopen saved conversation';
    el('rm-forget-recovery').disabled = false;
    el('rm-save-private').disabled = !isCurrent || !el('rm-remember').checked || running || paused || isGenerating() || privateMemoryRequested;
    el('rm-save-private').textContent = privateMemoryRequested
      ? 'Private-memory request submitted'
      : 'Save link privately in Rub Minds';
  }
  updateRecoveryUi();

  el('rm-remember').addEventListener('change', () => {
    if (el('rm-remember').checked) {
      if (!rememberCurrentConversation()) {
        el('rm-remember').checked = false;
        status('Open a specific ChatGPT or Claude conversation before saving a recovery link.');
        return;
      }
      status('Conversation link saved locally on this browser. It has not been sent to the Rub Minds group.');
    } else {
      try { localStorage.removeItem(RECOVERY_KEY); } catch (_) {}
      savedConversation = null;
      privateMemoryRequested = false;
      updateRecoveryUi();
      status('Local recovery link removed. The Rub Minds group was not changed.');
    }
  });
  el('rm-forget-recovery').addEventListener('click', () => {
    try { localStorage.removeItem(RECOVERY_KEY); } catch (_) {}
    savedConversation = null;
    privateMemoryRequested = false;
    el('rm-remember').checked = false;
    updateRecoveryUi();
    status('Saved recovery link removed from this browser. Any private Rub Minds memory must be managed separately; the group was not changed.');
  });

  el('rm-reopen').addEventListener('click', () => {
    const url = safeConversationUrl(savedConversation?.url);
    if (!url) {
      savedConversation = null;
      updateRecoveryUi();
      status('Saved recovery link is invalid or belongs to another provider. Save it again from the original conversation.');
      return;
    }
    if (location.pathname === new URL(url).pathname) {
      status('The saved conversation is already open.');
      return;
    }
    status('Opening the saved conversation. You may need to sign in; automatic participation remains off until you press Start.');
    location.href = url;
  });

  el('rm-save-private').addEventListener('click', async () => {
    try {
      const url = safeConversationUrl(savedConversation?.url);
      if (!url || location.pathname !== new URL(url).pathname || !el('rm-remember').checked) {
        throw new Error('Open the saved conversation and enable local recovery before registering its link.');
      }
      if (running || paused || isGenerating()) throw new Error('Wait until the current assistant reply and continuation run have stopped.');
      if (privateMemoryRequested) throw new Error('A private-memory request was already submitted in this page. Verify its tool result before retrying.');
      if (composerText(inputNode())) throw new Error('The composer contains a human draft. Send or clear it before requesting private link storage.');
      const before = snapshot();
      const idempotencyKey = `browser-resume-${savedConversation.resumeId}`;
      const content = `Original AI conversation recovery URL (private; do not post to group messages): ${url}. This is only a locator, not an authentication credential.`;
      const prompt = [
        'Use the Rub Minds MCP tools already connected to this existing conversation.',
        'The user explicitly asked to save this conversation recovery locator privately. Call remember_memory with entry_type="insight", visibility="private", idempotency_key=' + JSON.stringify(idempotencyKey) + ', and content=' + JSON.stringify(content) + '.',
        'Do not call send_group_message. Do not save this as group-visible memory. Do not read, import, or share unrelated conversation history.',
        'If remember_memory is unavailable or the private visibility cannot be confirmed, do not claim the link was saved. Report the actual tool result only.',
      ].join('\n\n');
      el('rm-save-private').disabled = true;
      await sendMessage(prompt, location.pathname, before.userCount, true);
      privateMemoryRequested = true;
      updateRecoveryUi();
      status('Private-memory request submitted. Check the assistant reply for the actual MCP tool result; the prompt itself is not proof of storage.');
    } catch (error) {
      updateRecoveryUi();
      status(`Private link storage was not submitted: ${error?.message || String(error)}`);
    }
  });

  function buildContinuationPrompt() {
    const modeInstructions = {
      smart: 'SMART PARTICIPATION: casual chit-chat, humor, reactions, brainstorming, and serious tasks are all welcome. Respond naturally when addressed or when you can add something worthwhile. Do not manufacture activity, interrupt every exchange, or keep two AIs replying endlessly to one another.',
      mentions: 'MENTIONS ONLY: respond to direct @mentions, questions clearly addressed to you, tasks assigned to you, or messages needed to unblock your owned work. Usually stay quiet during general chit-chat not addressed to you.',
      focus: 'TASK FOCUS: prioritize the existing assigned task. Check group activity for direct mentions, task dependencies, and blocking updates, but do not join casual banter unless asked or a reply is needed to unblock collaboration.',
    }[settings.mode];

    return [
      settings.trigger,
      `Selected participation mode: ${settings.mode}. The following mode-specific instruction takes priority over conflicting generic wording above. ${modeInstructions}`,
      'For natural low-latency group conversation, use the Rub Minds MCP wait_for_group_messages tool when it is available and it makes sense to remain attentive. Use after_message_id and after_created_at for the newest group message you have actually processed, plus timeout_ms no greater than 15000. If the tool returns new messages, address them naturally in this same assistant turn. If it times out, do useful assigned work or return CONTINUE for another bounded watch cycle when Smart participation is selected and the loop cap permits it. Do not invent messages or claim to be always-on. The wait is bounded; this browser loop remains subject to its visible cycle cap.',
    ].join('\n\n');
  }

  const updateButtons = () => {
    el('rm-start').disabled = running;
    el('rm-pause').disabled = !running || paused;
    el('rm-resume').disabled = !running || !paused;
    el('rm-stop').disabled = !running;
    updateRecoveryUi();
  };

  const control = {
    stop(reason = 'Stopped manually.') {
      stopReason = reason;
      running = false;
      paused = false;
      for (const resolve of pauseWaiters.splice(0)) resolve();
      status(reason);
      updateButtons();
    },
  };
  window.__RUBMINDS_CONTINUATION_LOOP__ = control;

  el('rm-collapse').addEventListener('click', () => {
    const controls = el('rm-controls');
    const hidden = controls.style.display === 'none';
    controls.style.display = hidden ? 'block' : 'none';
    el('rm-collapse').textContent = hidden ? '−' : '+';
  });
  el('rm-start').addEventListener('click', () => { if (!running) runLoop(); });
  el('rm-pause').addEventListener('click', () => {
    if (!running || paused) return;
    paused = true;
    status('Paused. The current provider reply, if any, will finish; no next prompt will be sent.');
    updateButtons();
  });
  el('rm-resume').addEventListener('click', () => {
    if (!running || !paused) return;
    paused = false;
    status('Resuming…');
    for (const resolve of pauseWaiters.splice(0)) resolve();
    updateButtons();
  });
  el('rm-stop').addEventListener('click', () => control.stop('Stopped manually. No further prompts will be sent.'));

  async function waitWhilePaused() {
    while (running && paused) {
      status('Paused — waiting for you to Resume. The current reply is not cancelled.');
      await new Promise(resolve => pauseWaiters.push(resolve));
    }
  }

  async function waitForCurrentReply() {
    if (!isGenerating()) return;
    status('Waiting for the reply already in progress…');
    const deadline = Date.now() + settings.timeoutMin * 60_000;
    let stableChecks = 0;
    let previous = snapshot().lastAssistant;
    while (running && isGenerating()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for the current reply; no continuation was sent.');
      const current = snapshot().lastAssistant;
      if (current === previous) stableChecks++;
      else { previous = current; stableChecks = 0; }
      await sleep(700);
    }
    if (running) await sleep(900);
  }

  async function waitForNewReply(previous) {
    const deadline = Date.now() + settings.timeoutMin * 60_000;
    let sawOutput = false;
    let lastObserved = '';
    let stableChecks = 0;
    const expectedUserCount = Math.max(previous.userCount + 1, userNodes().length);

    while (running) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for a completed new reply. Stopped to avoid sending blindly.');
      if (threadPath && location.pathname !== threadPath) throw new Error('Conversation navigation detected. Loop stopped to avoid acting in another chat.');
      const now = snapshot();
      if (now.userCount > expectedUserCount) {
        throw new Error('A new user message was detected during the loop. Stopped to avoid interrupting you.');
      }
      const changed = now.assistantCount > previous.assistantCount || now.lastAssistant !== previous.lastAssistant;
      if (changed && now.lastAssistant) {
        sawOutput = true;
        if (now.lastAssistant === lastObserved) stableChecks++;
        else { lastObserved = now.lastAssistant; stableChecks = 0; }
      }
      if (isGenerating()) sawOutput = sawOutput || changed;
      if (sawOutput && !isGenerating() && stableChecks >= 2) {
        await sleep(700);
        const finalSnapshot = snapshot();
        if (!isGenerating() && finalSnapshot.lastAssistant === lastObserved) return finalSnapshot.lastAssistant;
        stableChecks = 0;
      }
      await sleep(800);
    }
    return null;
  }

  async function runLoop() {
    settings = {
      maxRounds: clampInteger(el('rm-max').value, 1, 20, defaults.maxRounds),
      delaySec: clampInteger(el('rm-delay').value, 1, 120, defaults.delaySec),
      timeoutMin: clampInteger(el('rm-timeout').value, 1, 20, defaults.timeoutMin),
      mode: ['smart', 'mentions', 'focus'].includes(el('rm-mode').value) ? el('rm-mode').value : defaults.mode,
      trigger: el('rm-trigger').value.trim() || defaults.trigger,
    };
    if (!inputNode()) { status('Stopped: provider composer not found. Check that this is an open chat.'); return; }
    if (composerText(inputNode())) { status('Stopped: the composer contains a draft. Send or clear it before starting.'); return; }
    persistSettings();
    if (el('rm-remember').checked) rememberCurrentConversation();
    running = true;
    paused = false;
    rounds = 0;
    stopReason = '';
    threadPath = (location.pathname === '/' || location.pathname === '/new') ? null : location.pathname;
    updateButtons();

    try {
      await waitForCurrentReply();
      // Establish the conversation identity after the first response, allowing a new chat URL to be assigned.
      while (running && rounds < settings.maxRounds) {
        await waitWhilePaused();
        if (!running) break;
        if (threadPath && location.pathname !== threadPath) throw new Error('Conversation changed. Loop stopped.');
        if (composerText(inputNode())) throw new Error('A draft appeared in the composer. Loop stopped without overwriting it.');

        for (let remaining = settings.delaySec; remaining > 0 && running && !paused; remaining--) {
          status(`Ready for cycle ${rounds + 1}/${settings.maxRounds} in ${remaining}s…`);
          await sleep(1000);
        }
        if (!running) break;
        await waitWhilePaused();
        if (!running) break;

        // Recheck after the countdown, because a human may have typed, navigated,
        // or paused during the delay. Guard again after inserting the prompt.
        const before = snapshot();
        ensureReadyToSend(threadPath, before.userCount);
        rounds++;
        status(`Cycle ${rounds}/${settings.maxRounds}: sending continuation prompt…`);
        await sendMessage(buildContinuationPrompt(), threadPath, before.userCount);
        if (!running) break;
        status(`Cycle ${rounds}/${settings.maxRounds}: waiting for the reply to finish…`);
        const reply = await waitForNewReply(before);
        if (!running) break;
        if (!reply) throw new Error('No completed assistant reply was detected.');
        if (!threadPath) {
          threadPath = location.pathname;
          if (el('rm-remember').checked) rememberCurrentConversation();
        }

        const directive = readDirective(reply);
        if (!directive) throw new Error('Reply ended without a valid RUBMINDS_LOOP control line. Stopped fail-closed; review the reply before restarting.');
        if (directive === 'DONE') { stopReason = 'Assistant marked the assigned work DONE. Verify the result before relying on it.'; break; }
        if (directive === 'PAUSE') { stopReason = 'Assistant requested PAUSE for a blocker or human decision.'; break; }
        status(`Cycle ${rounds}/${settings.maxRounds} completed. Continuing only after the next delay…`);
      }
      if (!stopReason) stopReason = rounds >= settings.maxRounds
        ? `Safety cap reached (${settings.maxRounds} cycles). Start again manually after reviewing progress.`
        : 'Stopped manually.';
      status(stopReason);
    } catch (error) {
      stopReason = `Stopped safely: ${error?.message || String(error)}`;
      status(stopReason);
    } finally {
      running = false;
      paused = false;
      for (const resolve of pauseWaiters.splice(0)) resolve();
      updateButtons();
    }
  }
})();