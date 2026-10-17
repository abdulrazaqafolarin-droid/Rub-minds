#!/usr/bin/env node
/**
 * Bounded Rub Minds agent runtime for any OpenAI-compatible chat-completions API.
 *
 * Required environment:
 *   RUB_MINDS_AGENT_TOKEN  private room-scoped credential from Connect AI
 *   AI_API_BASE_URL        provider base URL, e.g. https://provider.example/v1
 *   AI_API_KEY             provider API key (never logged or committed)
 *   AI_MODEL               model name at that provider
 *
 * Optional:
 *   RUB_MINDS_API_URL, AI_AGENT_NAME, AI_GROUP_OBJECTIVE,
 *   RUB_MINDS_POLL_INTERVAL_MS (3000-60000), AI_MAX_REPLIES (1-500),
 *   AI_MAX_RUNTIME_MINUTES (1-1440), AI_MAX_OUTPUT_TOKENS (64-4096)
 */
import {
  assistantTextFromResponse,
  buildChatMessages,
  markExistingMessagesSeen,
  takeNewHumanMessages,
  validateRuntimeConfig,
} from './agent-runtime-core.mjs';

const config = validateRuntimeConfig(process.env);
const seenIds = new Set();
const startedAt = Date.now();
const deadline = startedAt + config.maxRuntimeMinutes * 60_000;
let stopped = false;
let replyCount = 0;
let initialized = false;
let participantId = '';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiRequest(method, body) {
  const response = await fetch(config.rubMindsApiUrl, {
    method,
    headers: {
      Authorization: 'Bearer ' + config.agentToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Rub Minds API HTTP ' + response.status + ': ' + (data.error || 'request failed'));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function generateReply(messages) {
  const url = config.aiApiBaseUrl.replace(/\/$/, '') + '/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.aiApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages: buildChatMessages({
        agentName: config.agentName,
        objective: config.objective,
        messages,
        ownParticipantId: participantId,
        maxHistory: 12,
      }),
      max_tokens: config.maxOutputTokens,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    // Do not print provider response bodies: they may contain request details.
    throw new Error('AI provider HTTP ' + response.status);
  }
  const reply = assistantTextFromResponse(await response.json());
  if (!reply) throw new Error('AI provider returned an empty response.');
  return reply.slice(0, 10000);
}

function trimSeenIds() {
  if (seenIds.size <= 2000) return;
  const keep = [...seenIds].slice(-1000);
  seenIds.clear();
  for (const id of keep) seenIds.add(id);
}

async function main() {
  console.log('Starting bounded Rub Minds agent runtime.');
  console.log(JSON.stringify({
    agent: config.agentName,
    model: config.aiModel,
    pollIntervalMs: config.pollIntervalMs,
    maxReplies: config.maxReplies,
    maxRuntimeMinutes: config.maxRuntimeMinutes,
    note: 'Provider keys and room credentials are not logged.',
  }));

  while (!stopped && Date.now() < deadline && replyCount < config.maxReplies) {
    try {
      const room = await apiRequest('GET');
      participantId = room.participant_id || participantId;
      if (!participantId) throw new Error('Rub Minds response did not include participant_id.');

      if (!initialized) {
        markExistingMessagesSeen(room.messages, seenIds);
        initialized = true;
        console.log('Connected. Existing history will not trigger retroactive replies.');
      } else {
        const incoming = takeNewHumanMessages(room.messages, participantId, seenIds);
        trimSeenIds();
        for (const message of incoming) {
          if (stopped || Date.now() >= deadline || replyCount >= config.maxReplies) break;
          try {
            const history = room.messages || [];
            const messageIndex = history.findIndex(item => item.id === message.id);
            const context = messageIndex >= 0 ? history.slice(0, messageIndex + 1) : [message];
            const reply = await generateReply(context);
            await apiRequest('POST', { operation: 'send', body: reply });
            replyCount += 1;
            console.log(JSON.stringify({
              event: 'reply_sent',
              replyCount,
              sourceMessageId: message.id,
              replyLength: reply.length,
            }));
          } catch (error) {
            console.error('Could not process incoming message:', error.message);
          }
        }
      }
    } catch (error) {
      console.error('Rub Minds polling failed:', error.message);
      await sleep(error.status === 429 ? 60000 : config.pollIntervalMs);
      continue;
    }
    if (!stopped && Date.now() < deadline && replyCount < config.maxReplies) {
      await sleep(config.pollIntervalMs);
    }
  }
  console.log(JSON.stringify({
    event: 'runtime_stopped',
    reason: stopped ? 'signal' : Date.now() >= deadline ? 'time_limit' : 'reply_limit',
    replies: replyCount,
  }));
}

async function disconnect() {
  try {
    await apiRequest('POST', { operation: 'disconnect' });
    console.log('Agent marked disconnected.');
  } catch (error) {
    console.error('Could not mark agent disconnected:', error.message);
  }
}

process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(disconnect);
