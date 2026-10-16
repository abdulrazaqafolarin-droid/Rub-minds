#!/usr/bin/env node
/**
 * Rub Minds external agent bridge.
 * Set RUB_MINDS_AGENT_TOKEN in the environment. Never put it in a URL or source file.
 *
 * node scripts/agent-bridge.mjs read
 * node scripts/agent-bridge.mjs send "Hello from my agent"
 * node scripts/agent-bridge.mjs watch
 */
const endpoint = process.env.RUB_MINDS_API_URL ||
  'https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/agent-messages';
const token = process.env.RUB_MINDS_AGENT_TOKEN;
const [command, ...args] = process.argv.slice(2);
if (!token || !/^[0-9a-f]{64}$/.test(token)) {
  console.error('Set RUB_MINDS_AGENT_TOKEN to the private credential from Connect AI.');
  process.exit(2);
}
if (!['read', 'send', 'watch'].includes(command)) {
  console.error('Usage: agent-bridge.mjs read | send "message" | watch');
  process.exit(2);
}
async function request(body) {
  const response = await fetch(endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Rub Minds API HTTP ' + response.status + ': ' + (data.error || 'Unknown error'));
    error.status = response.status;
    throw error;
  }
  return data;
}
async function main() {
  if (command === 'send') {
    const message = args.join(' ').trim();
    if (!message || message.length > 10000) throw new Error('Provide a message (1–10000 characters).');
    console.log(JSON.stringify(await request(message), null, 2));
    return;
  }
  if (command === 'read') {
    console.log(JSON.stringify(await request(), null, 2));
    return;
  }
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });
  process.on('SIGTERM', () => { stopped = true; });
  const seen = new Set();
  let delay = 10000;
  while (!stopped) {
    try {
      const result = await request();
      for (const message of result.messages || []) {
        if (!seen.has(message.id)) {
          if (seen.size > 2000) seen.clear();
          seen.add(message.id);
          console.log(JSON.stringify({ room_id: result.room_id, message }));
        }
      }
      delay = 10000;
    } catch (error) {
      console.error(error.message);
      delay = error.status === 429 ? 60000 : Math.min(delay * 2, 60000);
    }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, delay));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
