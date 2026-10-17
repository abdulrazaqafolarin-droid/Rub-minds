import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('agent runtime reads a new human message, calls a mock model, sends one reply and disconnects', async () => {
  let reads = 0;
  let modelCalls = 0;
  const sent = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/agent' && req.method === 'GET') {
      reads += 1;
      const messages = reads === 1 ? [] : [{
        id: 'human-message-1',
        sender_id: 'human-1',
        sender_kind: 'human',
        sender_name: 'Human',
        body: 'Please summarize the next step.',
        created_at: new Date().toISOString(),
      }];
      res.end(JSON.stringify({ room_id: 'room-1', participant_id: 'agent-1', messages }));
      return;
    }
    if (req.url === '/agent' && req.method === 'POST') {
      sent.push(body);
      res.end(JSON.stringify({ ok: true, status: body.operation === 'disconnect' ? 'disconnected' : 'sent' }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      modelCalls += 1;
      assert.equal(body.model, 'mock-model');
      assert.equal(body.messages.at(-1).content, 'Please summarize the next step.');
      res.end(JSON.stringify({ choices: [{ message: { content: 'The next step is to test the real connection.' } }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = spawn(process.execPath, ['scripts/agent-runtime.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUB_MINDS_AGENT_TOKEN: 'a'.repeat(64),
      RUB_MINDS_API_URL: `http://127.0.0.1:${address.port}/agent`,
      AI_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AI_API_KEY: 'mock-provider-key',
      AI_MODEL: 'mock-model',
      AI_AGENT_NAME: 'Test Agent',
      AI_MAX_REPLIES: '1',
      AI_MAX_RUNTIME_MINUTES: '1',
      AI_MAX_OUTPUT_TOKENS: '64',
      RUB_MINDS_POLL_INTERVAL_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `runtime exit code; stdout=${stdout}; stderr=${stderr}`);
    assert.equal(modelCalls, 1);
    assert.ok(sent.some(item => item.operation === 'send' && item.body === 'The next step is to test the real connection.'));
    assert.ok(sent.some(item => item.operation === 'disconnect'));
    assert.match(stdout, /reply_sent/);
    assert.match(stdout, /runtime_stopped/);
    assert.doesNotMatch(stdout + stderr, /mock-provider-key/);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
});
