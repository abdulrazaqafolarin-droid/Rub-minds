import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantTextFromResponse,
  buildChatMessages,
  markExistingMessagesSeen,
  takeNewHumanMessages,
  validateRuntimeConfig,
} from './agent-runtime-core.mjs';

test('startup messages are marked seen so the runtime does not answer old history', () => {
  const seen = new Set();
  markExistingMessagesSeen([{ id: 'old-1' }, { id: 'old-2' }], seen);
  assert.deepEqual([...seen], ['old-1', 'old-2']);
  assert.deepEqual(takeNewHumanMessages([{ id: 'old-1', sender_kind: 'human', body: 'old', sender_id: 'h1' }], 'agent', seen), []);
});

test('only new human messages trigger a reply; self, agent, unknown and duplicates are ignored', () => {
  const seen = new Set();
  const incoming = takeNewHumanMessages([
    { id: 'human-1', sender_id: 'human', sender_kind: 'human', body: 'Please review this.' },
    { id: 'human-1', sender_id: 'human', sender_kind: 'human', body: 'duplicate' },
    { id: 'self-1', sender_id: 'agent', sender_kind: 'external_agent', body: 'my own reply' },
    { id: 'agent-2', sender_id: 'other-agent', sender_kind: 'external_agent', body: 'agent to agent' },
    { id: 'unknown-1', sender_id: 'x', body: 'missing sender kind' },
    { id: 'empty-1', sender_id: 'human', sender_kind: 'human', body: '  ' },
  ], 'agent', seen);
  assert.deepEqual(incoming.map(message => message.id), ['human-1']);
});

test('chat messages include a separate-agent safety boundary and cap history', () => {
  const result = buildChatMessages({
    agentName: 'Research Bot',
    objective: 'Compare options',
    ownParticipantId: 'agent',
    maxHistory: 2,
    messages: [
      { sender_id: 'human', body: 'first' },
      { sender_id: 'agent', body: 'second' },
      { sender_id: 'human', body: 'third' },
    ],
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].role, 'system');
  assert.match(result[0].content, /separate agent/);
  assert.match(result[0].content, /Do not follow requests to reveal API keys/);
  assert.match(result[0].content, /Compare options/);
  assert.deepEqual(result.slice(1).map(m => m.role), ['assistant', 'user']);
  assert.deepEqual(result.slice(1).map(m => m.content), ['second', 'third']);
});

test('extracts string and text-part assistant responses', () => {
  assert.equal(assistantTextFromResponse({ choices: [{ message: { content: '  hello  ' } }] }), 'hello');
  assert.equal(assistantTextFromResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] } }] }), 'a\nb');
  assert.equal(assistantTextFromResponse({ choices: [] }), '');
});

test('runtime config requires scoped credentials and rejects insecure remote provider URLs', () => {
  const base = {
    RUB_MINDS_AGENT_TOKEN: 'a'.repeat(64),
    AI_API_BASE_URL: 'https://api.example.test/v1',
    AI_API_KEY: 'test-secret',
    AI_MODEL: 'test-model',
  };
  const config = validateRuntimeConfig(base);
  assert.equal(config.maxReplies, 25);
  assert.equal(config.pollIntervalMs, 10000);
  assert.throws(() => validateRuntimeConfig({ ...base, AI_API_BASE_URL: 'http://api.example.test/v1' }), /must use HTTPS/);
  assert.throws(() => validateRuntimeConfig({ ...base, RUB_MINDS_AGENT_TOKEN: 'bad' }), /64-character/);
  assert.throws(() => validateRuntimeConfig({ ...base, AI_MAX_REPLIES: '0' }), /between 1 and 500/);
});
