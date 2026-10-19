import { describe, expect, it } from 'vitest';
import { buildExistingAiJoinPrompt, buildGroupRelayPrompt, parseSessionMemoryDocument } from './aiRelay';

describe('existing AI conversation relay prompts', () => {
  it('preserves the invitation and avoids claiming a direct connection', () => {
    const url = 'https://rub-minds.vercel.app/?invite=' + 'a'.repeat(64);
    const prompt = buildExistingAiJoinPrompt(url);
    expect(prompt).toContain(url);
    expect(prompt).toContain('does not automatically connect');
    expect(prompt).toContain('Do not claim you have joined');
    expect(prompt).toContain('passwords, API keys, credentials');
    expect(prompt).toContain('Context Packet');
  });

  it('builds a bounded group transcript and tells the AI not to claim it posted', () => {
    const messages = Array.from({ length: 35 }, (_, i) => ({ sender: 'Member', body: 'message-' + i }));
    const prompt = buildGroupRelayPrompt('Launch team', 'Ship the MVP', messages);
    expect(prompt).toContain('GROUP: Launch team');
    expect(prompt).toContain('OBJECTIVE: Ship the MVP');
    expect(prompt).toContain('message-34');
    expect(prompt).toContain('message-15');
    expect(prompt).not.toContain('message-14\n');
    expect(prompt).toContain('I will review and paste your response');
    expect(prompt).toContain('do not repeat credentials or sensitive personal data');
  });

  it('bounds long group messages before copying them into an AI context', () => {
    const prompt = buildGroupRelayPrompt('Review', 'Stay concise', [
      { sender: 'Member', body: 'x'.repeat(5000) },
    ]);
    expect(prompt).toContain('[message truncated]');
    expect(prompt.length).toBeLessThan(5000);
  });

  it('parses a private structured session-memory packet, including fenced JSON', () => {
    const packet = {
      schema: 'rub-minds.session-memory', version: 1,
      summary: 'Working on the Rub Minds invite flow.',
      current_goal: 'Finish the guided relay.',
      source: { platform: 'ChatGPT', session_label: 'Rub Minds build' },
      sharing: { raw_history_visibility: 'private' },
    };
    expect(parseSessionMemoryDocument(JSON.stringify(packet))).toEqual(packet);
    const fence = String.fromCharCode(96).repeat(3);\n    expect(parseSessionMemoryDocument(fence + 'json\\n' + JSON.stringify(packet) + '\\n' + fence)).toEqual(packet);
  });

  it('rejects invalid, oversized, or group-visible raw session history', () => {
    const packet = {
      schema: 'rub-minds.session-memory', version: 1,
      summary: 'summary', current_goal: 'goal',
      source: { platform: 'Claude' },
      sharing: { raw_history_visibility: 'private' },
    };
    expect(() => parseSessionMemoryDocument('not json')).toThrow(/valid JSON/);
    expect(() => parseSessionMemoryDocument(JSON.stringify({ ...packet, version: 2 }))).toThrow(/schema\/version/);
    expect(() => parseSessionMemoryDocument(JSON.stringify({ ...packet, summary: 'x'.repeat(20001) }))).toThrow(/20,000/);
    expect(() => parseSessionMemoryDocument(JSON.stringify({ ...packet, sharing: { raw_history_visibility: 'group' } }))).toThrow(/must remain private/);
  });

  it('handles an empty room and objective', () => {
    const prompt = buildGroupRelayPrompt('Ideas', '', []);
    expect(prompt).toContain('Collaborate on the group\'s current goal.');
    expect(prompt).toContain('(No messages included.)');
  });
});
