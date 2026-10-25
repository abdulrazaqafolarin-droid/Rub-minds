import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'rub-minds-continuation.user.js'), 'utf8');
const realSetTimeout = setTimeout;
const SCALE = 0.015;

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.attrs = {};
    this.listeners = new Map();
    this.style = { cssText: '', display: '' };
    this.children = [];
    this._text = '';
    this._html = '';
    this._id = '';
  }
  get id() { return this._id; }
  set id(v) { this._id = String(v); }
  get innerText() { return this._text; }
  set innerText(v) { this._text = String(v ?? ''); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{}]; }
  focus() { this.ownerDocument.activeElement = this; }
  dispatchEvent(event) {
    for (const cb of this.listeners.get(event.type) || []) cb(event);
    return true;
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  click() {
    if (this.disabled || this.hidden) return;
    for (const cb of this.listeners.get('click') || []) cb({ target: this });
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  querySelector(selector) {
    if (!this.elements) this.elements = new Map();
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    if (!id) return null;
    if (!this.elements.has(id)) {
      const tag = id === 'rm-trigger' ? 'textarea' :
        ['rm-max', 'rm-delay', 'rm-timeout', 'rm-remember'].includes(id) ? 'input' :
        ['rm-start', 'rm-pause', 'rm-resume', 'rm-stop', 'rm-collapse', 'rm-reopen', 'rm-save-private'].includes(id) ? 'button' : 'div';
      const node = tag === 'textarea' ? new FakeTextArea() : tag === 'input' ? new FakeInput() : new FakeElement(tag);
      node.id = id;
      node.ownerDocument = this.ownerDocument;
      if (['rm-pause', 'rm-resume', 'rm-stop'].includes(id)) node.disabled = true;
      if (id === 'rm-status') node.textContent = 'Idle — review the prompt and start manually.';
      this.elements.set(id, node);
    }
    return this.elements.get(id);
  }
}
class FakeTextArea extends FakeElement {
  constructor() { super('textarea'); this._value = ''; }
  get value() { return this._value; }
  set value(v) { this._value = String(v ?? ''); }
}
class FakeInput extends FakeElement {
  constructor() { super('input'); this._value = ''; }
  get value() { return this._value; }
  set value(v) { this._value = String(v ?? ''); }
}

function makeHarness({ scenario, site = 'chatgpt', initialDraft = '', pathname = '/c/mock-thread', savedConversation = null }) {
  let activePanel = null;
  const messages = [];
  const hostname = site === 'claude' ? 'claude.ai' : 'chatgpt.com';
  const location = { hostname, origin: `https://${hostname}`, pathname, href: `https://${hostname}${pathname}` };
  const sent = [];
  let initialGenerationFinished = scenario !== 'initially-generating';
  let sentBeforeInitialGenerationFinished = false;
  const composer = site === 'chatgpt' ? new FakeTextArea() : new FakeElement('div');
  composer.ownerDocument = null;
  composer.setAttribute('contenteditable', 'true');
  if (site === 'chatgpt') composer.setAttribute('id', 'prompt-textarea');
  if (site === 'chatgpt') composer.value = initialDraft;
  else { composer.innerText = initialDraft; composer.textContent = initialDraft; }
  const sendButton = new FakeElement('button');
  sendButton.ownerDocument = null;
  sendButton.setAttribute('data-testid', 'send-button');
  sendButton.setAttribute('aria-label', site === 'claude' ? 'Send message' : '');
  if (scenario === 'disabled-send') sendButton.disabled = true;
  const stopButton = new FakeElement('button');
  stopButton.hidden = true;
  stopButton.setAttribute('data-testid', 'stop-button');
  stopButton.setAttribute('aria-label', 'Stop response');
  const userSelector = site === 'claude' ? 'data-testid' : 'data-message-author-role';

  let document;
  function addMessage(kind, text) {
    const node = new FakeElement('div');
    node.ownerDocument = document;
    if (kind === 'user') {
      node.setAttribute(userSelector, site === 'claude' ? 'user-message' : 'user');
    } else if (site === 'claude') {
      node.setAttribute('data-testid', 'chat-message-content');
      node.className = 'font-claude-response';
    } else node.setAttribute('data-message-author-role', 'assistant');
    node.innerText = text;
    node.textContent = text;
    messages.push(node);
    return node;
  }
  addMessage('user', 'Please continue the Rub Minds task.');
  addMessage('assistant', 'Earlier context: preserve work and check group messages.');

  document = {
    activeElement: null,
    body: new FakeElement('body'),
    createElement(tag) {
      const el = new FakeElement(tag);
      el.ownerDocument = document;
      return el;
    },
    getElementById(id) { return activePanel?.id === id ? activePanel : null; },
    querySelectorAll(selector) {
      if (selector.includes(',')) {
        const seen = new Set();
        return selector.split(',').flatMap(s => this.querySelectorAll(s.trim())).filter(node => {
          if (seen.has(node)) return false;
          seen.add(node); return true;
        });
      }
      if (selector === '#rutex-chat-loop-panel' || selector === '#rubminds-continuation-panel') return activePanel ? [activePanel] : [];
      if (selector === '#prompt-textarea' || selector === 'textarea[placeholder]') return site === 'chatgpt' ? [composer] : [];
      if (selector === 'div[contenteditable="true"]') return site === 'claude' ? [composer] : [];
      if (selector === 'textarea') return site === 'claude' ? [] : [composer];
      if (selector === 'button[data-testid="send-button"]') return site === 'chatgpt' ? [sendButton] : [];
      if (selector === 'button[aria-label="Send message"]' || selector === 'button[aria-label="Send Message"]') return site === 'claude' ? [sendButton] : [];
      if (selector === 'button[data-testid="stop-button"]') return site === 'chatgpt' ? [stopButton] : [];
      if (/button\[aria-label=.*Stop response/.test(selector)) return site === 'claude' ? [stopButton] : [];
      if (selector === '[data-message-author-role="assistant"]') return site === 'chatgpt' ? messages.filter(m => m.getAttribute('data-message-author-role') === 'assistant') : [];
      if (selector === '[data-message-author-role="user"]') return site === 'chatgpt' ? messages.filter(m => m.getAttribute('data-message-author-role') === 'user') : [];
      if (selector === '.font-claude-response' || selector === '[data-testid="chat-message-content"]') return site === 'claude' ? messages.filter(m => m.className === 'font-claude-response') : [];
      if (selector === '[data-testid*="user-message"]' || selector === '[data-testid*="human-message"]') return site === 'claude' ? messages.filter(m => /user-message|human-message/.test(m.getAttribute('data-testid') || '')) : [];
      return [];
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    execCommand(command, _showUi, value) {
      const target = this.activeElement;
      if (!target) return false;
      if (command === 'selectAll') { target.innerText = ''; target.textContent = ''; return true; }
      if (command === 'insertText') { target.innerText = String(value); target.textContent = String(value); return true; }
      if (command === 'delete') { target.innerText = ''; target.textContent = ''; return true; }
      return false;
    },
  };
  document.body.ownerDocument = document;
  composer.ownerDocument = document;
  sendButton.ownerDocument = document;
  stopButton.ownerDocument = document;
  document.body.appendChild = el => { activePanel = el; el.parentNode = document.body; return el; };

  sendButton.addEventListener('click', () => {
    const prompt = site === 'chatgpt' ? composer.value : composer.innerText;
    if (!initialGenerationFinished) sentBeforeInitialGenerationFinished = true;
    sent.push(prompt);
    if (site === 'chatgpt') composer.value = '';
    else { composer.innerText = ''; composer.textContent = ''; }
    addMessage('user', prompt);
    stopButton.hidden = false;
    const cycle = sent.length;
    if (scenario === 'pause-button' && cycle === 1) {
      vmSetTimeout(() => activePanel?.querySelector('#rm-pause').click(), 15);
    }
    if (scenario === 'navigation' && cycle === 1) {
      location.pathname = '/c/different-thread';
    }
    if (scenario === 'manual-interruption' && cycle === 1) {
      vmSetTimeout(() => addMessage('user', 'Human typed a new message during the loop.'), 30);
    }
    if (scenario === 'stop-after-one' && cycle === 1) {
      vmSetTimeout(() => activePanel?.querySelector('#rm-stop').click(), 20);
    }
    const response = () => {
      let reply;
      if (scenario === 'missing-marker') reply = 'Progress made, but there is no control marker.';
      else if (scenario === 'always-continue') reply = 'Made one useful step; another bounded step remains.\nRUBMINDS_LOOP: CONTINUE';
      else if (scenario === 'pause') reply = 'A human decision is needed.\nRUBMINDS_LOOP: PAUSE';
      else if (scenario === 'done-first' || scenario === 'initially-generating' || (scenario === 'stop-after-one' && cycle === 1) || (scenario === 'manual-interruption' && cycle === 1)) reply = 'Group checked and task completed.\nRUBMINDS_LOOP: DONE';
      else if (cycle === 1) reply = 'Checked relevant group context and made useful progress.\nRUBMINDS_LOOP: CONTINUE';
      else reply = 'Next step complete and verified.\nRUBMINDS_LOOP: DONE';
      addMessage('assistant', reply);
      stopButton.hidden = true;
    };
    vmSetTimeout(response, 60);
  });

  const store = new Map([['rubMindsContinuationSettingsV1', JSON.stringify({ maxRounds: 3, delaySec: 1, timeoutMin: 1 })]]);
  if (savedConversation) store.set('rubMindsConversationBindingV1', JSON.stringify(savedConversation));
  const localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  if (scenario === 'stop-before-send' || scenario === 'draft-changed-before-send') {
    let triggered = false;
    composer.addEventListener('input', () => {
      if (triggered) return;
      triggered = true;
      vmSetTimeout(() => {
        if (scenario === 'stop-before-send') activePanel.querySelector('#rm-stop').click();
        else composer.value = 'Human is typing a new draft';
      }, 20);
    });
  }
  let vmSetTimeout = (fn, ms) => realSetTimeout(fn, Math.max(0, ms * SCALE));
  if (scenario === 'initially-generating') {
    stopButton.hidden = false;
    vmSetTimeout(() => { addMessage('assistant', 'The already-running reply has now completed.'); stopButton.hidden = true; initialGenerationFinished = true; }, 80);
  }
  const window = { __test: { sent, messages } };
  const context = vm.createContext({
    window, document, location,
    localStorage, HTMLTextAreaElement: FakeTextArea, HTMLInputElement: FakeInput,
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    URL,
    setTimeout: vmSetTimeout, clearTimeout, Date, Promise, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Math,
  });
  vm.runInContext(source, context, { filename: 'rub-minds-continuation.user.js' });

  return {
    context, sent, messages, document, composer,
    get sentBeforeInitialGenerationFinished() { return sentBeforeInitialGenerationFinished; },
    async startAndWait({ resumeOnPause = false } = {}) {
      activePanel.querySelector('#rm-start').click();
      const deadline = Date.now() + 3000;
      let resumed = false;
      while (Date.now() < deadline) {
        const status = activePanel.querySelector('#rm-status').textContent;
        if (resumeOnPause && !resumed && status.includes('Paused — waiting for you to Resume')) {
          resumed = true;
          activePanel.querySelector('#rm-resume').click();
        }
        if (!activePanel.querySelector('#rm-start').disabled && activePanel.querySelector('#rm-stop').disabled && status && !status.startsWith('Idle')) {
          await new Promise(resolve => realSetTimeout(resolve, 20));
          return { status: activePanel.querySelector('#rm-status').textContent, sent: [...sent] };
        }
        await new Promise(resolve => realSetTimeout(resolve, 10));
      }
      throw new Error('Loop did not finish in the test harness. Status=' + activePanel.querySelector('#rm-status').textContent);
    },
  };
}

test('DONE stops after one checked continuation turn', async () => {
  const h = makeHarness({ scenario: 'done-first' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /DONE/);
  assert.match(result.sent[0], /Rub Minds MCP tools/);
  assert.match(result.sent[0], /avoid filler, duplicates/);
});

test('CONTINUE proceeds once, then DONE stops the loop', async () => {
  const h = makeHarness({ scenario: 'continue-then-done' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 2);
  assert.ok(result.sent.every(prompt => /Rub Minds MCP tools/.test(prompt)));
  assert.match(result.status, /DONE/);
});

test('missing control marker fails closed without blindly prompting again', async () => {
  const h = makeHarness({ scenario: 'missing-marker' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /without a valid RUBMINDS_LOOP control line/);
});

test('Stop control prevents a further prompt', async () => {
  const h = makeHarness({ scenario: 'stop-after-one' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /Stopped manually/);
});

test('new human activity interrupts automation', async () => {
  const h = makeHarness({ scenario: 'manual-interruption' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /new user message was detected/);
});

test('PAUSE stops rather than repeatedly asking for action', async () => {
  const h = makeHarness({ scenario: 'pause' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /requested PAUSE/);
});

test('non-empty composer draft is never overwritten', async () => {
  const h = makeHarness({ scenario: 'draft-protection', initialDraft: 'unsent human draft' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 0);
  assert.equal(h.composer.value, 'unsent human draft');
  assert.match(result.status, /composer contains a draft/);
});

test('Claude DOM selector path handles a bounded completion', async () => {
  const h = makeHarness({ scenario: 'done-first', site: 'claude' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /DONE/);
  assert.match(result.sent[0], /Rub Minds MCP tools/);
});


test('Pause and Resume controls suspend future prompts, then continue safely', async () => {
  const h = makeHarness({ scenario: 'pause-button' });
  const result = await h.startAndWait({ resumeOnPause: true });
  assert.equal(result.sent.length, 2);
  assert.match(result.status, /DONE/);
});

test('conversation navigation interrupts the loop', async () => {
  const h = makeHarness({ scenario: 'navigation' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.match(result.status, /Conversation navigation detected/);
});


test('disabled send control stops safely and removes only its unsent prompt', async () => {
  const h = makeHarness({ scenario: 'disabled-send' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 0);
  assert.equal(h.composer.value, '');
  assert.match(result.status, /Send button unavailable or disabled/);
});


test('safety cap ends a loop even if every response requests CONTINUE', async () => {
  const h = makeHarness({ scenario: 'always-continue' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 3);
  assert.match(result.status, /Safety cap reached \(3 cycles\)/);
});


test('active provider generation finishes before the loop sends a continuation', async () => {
  const h = makeHarness({ scenario: 'initially-generating' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 1);
  assert.equal(h.sentBeforeInitialGenerationFinished, false);
  assert.match(result.status, /DONE/);
});


test('page load does not start a loop without a human click', () => {
  const h = makeHarness({ scenario: 'done-first' });
  assert.equal(h.sent.length, 0);
  assert.match(h.document.getElementById('rubminds-continuation-panel').querySelector('#rm-status').textContent, /Idle/);
});

test('custom prompt is used for the current run but is not persisted', async () => {
  const h = makeHarness({ scenario: 'done-first' });
  const privateMarker = 'PRIVATE_CUSTOM_PROMPT_DO_NOT_PERSIST';
  h.document.getElementById('rubminds-continuation-panel').querySelector('#rm-trigger').value = privateMarker;
  const result = await h.startAndWait();
  assert.ok(result.sent[0].startsWith(privateMarker));
  assert.match(result.sent[0], /wait_for_group_messages/);
  const stored = JSON.parse(h.context.localStorage.getItem('rubMindsContinuationSettingsV1'));
  assert.deepEqual(Object.keys(stored).sort(), ['delaySec', 'maxRounds', 'mode', 'timeoutMin']);
  assert.equal(JSON.stringify(stored).includes(privateMarker), false);
});

test('Stop during composer insertion prevents a pending click', async () => {
  const h = makeHarness({ scenario: 'stop-before-send' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 0);
  assert.match(result.status, /Stopped manually|Stopped safely/);
});

test('A concurrent human draft before the click is preserved and not sent', async () => {
  const h = makeHarness({ scenario: 'draft-changed-before-send' });
  const result = await h.startAndWait();
  assert.equal(result.sent.length, 0);
  assert.equal(h.composer.value, 'Human is typing a new draft');
  assert.match(result.status, /changed before send/);
});


test('conversation recovery is saved only after explicit opt-in and only locally', () => {
  const h = makeHarness({ scenario: 'done-first' });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const remember = panel.querySelector('#rm-remember');
  remember.checked = true;
  remember.dispatchEvent({ type: 'change' });
  const saved = JSON.parse(h.context.localStorage.getItem('rubMindsConversationBindingV1'));
  assert.equal(saved.url, 'https://chatgpt.com/c/mock-thread');
  assert.equal(saved.provider, 'ChatGPT');
  assert.match(panel.querySelector('#rm-status').textContent, /not been sent to the Rub Minds group/);
  assert.match(panel.querySelector('#rm-recovery').textContent, /Saved locally in this browser only/);
});

test('saved conversation can be reopened from the provider home route', () => {
  const h = makeHarness({
    scenario: 'done-first',
    pathname: '/',
    savedConversation: { url: 'https://chatgpt.com/c/remembered-thread?temporary=1#frag', savedAt: '2026-10-25T00:00:00Z' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const reopen = panel.querySelector('#rm-reopen');
  assert.equal(reopen.disabled, false);
  reopen.click();
  assert.equal(h.document.getElementById('rubminds-continuation-panel').querySelector('#rm-status').textContent.includes('automatic participation remains off'), true);
  assert.equal(h.context.location.href, 'https://chatgpt.com/c/remembered-thread');
});

test('conversation recovery rejects off-origin or insecure stored links', () => {
  const h = makeHarness({
    scenario: 'done-first',
    pathname: '/',
    savedConversation: { url: 'http://evil.example/steal', savedAt: '2026-10-25T00:00:00Z' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  assert.equal(panel.querySelector('#rm-reopen').disabled, true);
  assert.match(panel.querySelector('#rm-recovery').textContent, /No recovery link saved/);
});

test('recovery links discard query strings and fragments when saved', () => {
  const h = makeHarness({ scenario: 'done-first', pathname: '/c/private-thread?invite=secret#details' });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const remember = panel.querySelector('#rm-remember');
  remember.checked = true;
  remember.dispatchEvent({ type: 'change' });
  const saved = JSON.parse(h.context.localStorage.getItem('rubMindsConversationBindingV1'));
  assert.equal(saved.url, 'https://chatgpt.com/c/private-thread');
  assert.equal(saved.url.includes('secret'), false);
});

test('turning recovery off removes the local link without touching group state', () => {
  const h = makeHarness({
    scenario: 'done-first',
    savedConversation: { url: 'https://chatgpt.com/c/mock-thread', savedAt: '2026-10-25T00:00:00Z' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const remember = panel.querySelector('#rm-remember');
  assert.equal(remember.checked, true);
  remember.checked = false;
  remember.dispatchEvent({ type: 'change' });
  assert.equal(h.context.localStorage.getItem('rubMindsConversationBindingV1'), null);
  assert.match(panel.querySelector('#rm-status').textContent, /group was not changed/);
});


test('recovery never stores a non-conversation provider route', () => {
  const h = makeHarness({ scenario: 'done-first', pathname: '/settings' });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const remember = panel.querySelector('#rm-remember');
  remember.checked = true;
  remember.dispatchEvent({ type: 'change' });
  assert.equal(h.context.localStorage.getItem('rubMindsConversationBindingV1'), null);
  assert.equal(remember.checked, false);
  assert.match(panel.querySelector('#rm-status').textContent, /Open a specific ChatGPT or Claude conversation/);
});

test('Claude conversation recovery accepts a same-origin chat route', () => {
  const h = makeHarness({ scenario: 'done-first', site: 'claude', pathname: '/chat/claude-thread' });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const remember = panel.querySelector('#rm-remember');
  remember.checked = true;
  remember.dispatchEvent({ type: 'change' });
  const saved = JSON.parse(h.context.localStorage.getItem('rubMindsConversationBindingV1'));
  assert.equal(saved.url, 'https://claude.ai/chat/claude-thread');
  assert.equal(saved.provider, 'Claude');
});


test('private resume-link registration is an explicit one-prompt action', async () => {
  const h = makeHarness({
    scenario: 'done-first',
    savedConversation: { url: 'https://chatgpt.com/c/mock-thread', provider: 'ChatGPT', savedAt: '2026-10-25T00:00:00Z', resumeId: 'resume-test-id-1234' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const button = panel.querySelector('#rm-save-private');
  assert.equal(button.disabled, false);
  assert.equal(h.sent.length, 0);
  button.click();
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && h.sent.length === 0) await new Promise(resolve => realSetTimeout(resolve, 10));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /visibility="private"/);
  assert.match(h.sent[0], /browser-resume-resume-test-id-1234/);
  assert.match(h.sent[0], /https:\/\/chatgpt\.com\/c\/mock-thread/);
  assert.match(h.sent[0], /Do not call send_group_message/);
  assert.match(panel.querySelector('#rm-status').textContent, /actual MCP tool result/);
});

test('private resume-link registration is unavailable unless the saved chat is open', () => {
  const h = makeHarness({
    scenario: 'done-first',
    pathname: '/',
    savedConversation: { url: 'https://chatgpt.com/c/mock-thread', provider: 'ChatGPT', savedAt: '2026-10-25T00:00:00Z', resumeId: 'resume-test-id-1234' },
  });
  const button = h.document.getElementById('rubminds-continuation-panel').querySelector('#rm-save-private');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(h.sent.length, 0);
});


test('participation modes shape prompts for smart chat, mentions-only, and task focus', async () => {
  const cases = [
    ['smart', /SMART PARTICIPATION: casual chit-chat, humor, reactions, brainstorming/],
    ['mentions', /MENTIONS ONLY: respond to direct @mentions/],
    ['focus', /TASK FOCUS: prioritize the existing assigned task/],
  ];
  for (const [mode, expected] of cases) {
    const h = makeHarness({ scenario: 'done-first' });
    const panel = h.document.getElementById('rubminds-continuation-panel');
    panel.querySelector('#rm-mode').value = mode;
    const result = await h.startAndWait();
    assert.equal(result.sent.length, 1);
    assert.match(result.sent[0], new RegExp('Selected participation mode: ' + mode));
    assert.match(result.sent[0], expected);
    assert.match(result.sent[0], /wait_for_group_messages/);
    assert.equal(JSON.parse(h.context.localStorage.getItem('rubMindsContinuationSettingsV1')).mode, mode);
  }
});


test('saved recovery link can be explicitly forgotten from a different provider page', () => {
  const h = makeHarness({
    scenario: 'done-first',
    pathname: '/',
    savedConversation: { url: 'https://chatgpt.com/c/mock-thread', provider: 'ChatGPT', savedAt: '2026-10-25T00:00:00Z', resumeId: 'resume-test-id-1234' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  const forget = panel.querySelector('#rm-forget-recovery');
  assert.equal(forget.disabled, false);
  forget.click();
  assert.equal(h.context.localStorage.getItem('rubMindsConversationBindingV1'), null);
  assert.match(panel.querySelector('#rm-recovery').textContent, /No recovery link saved/);
  assert.match(panel.querySelector('#rm-status').textContent, /removed from this browser/);
  assert.equal(h.sent.length, 0);
});


test('tampered off-origin recovery URL is rejected and cleared before navigation', () => {
  const h = makeHarness({
    scenario: 'done-first',
    pathname: '/',
    savedConversation: { url: 'https://evil.example/steal', provider: 'ChatGPT', savedAt: '2026-10-25T00:00:00Z', resumeId: 'resume-test-id-1234' },
  });
  const panel = h.document.getElementById('rubminds-continuation-panel');
  panel.querySelector('#rm-reopen').click();
  assert.equal(h.context.localStorage.getItem('rubMindsConversationBindingV1'), null);
  assert.match(panel.querySelector('#rm-status').textContent, /invalid or belongs to another provider/);
  assert.equal(h.sent.length, 0);
});
