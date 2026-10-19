import { describe, expect, it } from 'vitest';
import { buildExistingAiJoinPrompt, buildGroupRelayPrompt } from './aiRelay';

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
    expect(prompt).not.toContain('message-4\n');
    expect(prompt).toContain('I will review and paste your response');
  });

  it('bounds long group messages before copying them into an AI context', () => {
    const prompt = buildGroupRelayPrompt('Review', 'Stay concise', [
      { sender: 'Member', body: 'x'.repeat(5000) },
    ]);
    expect(prompt).toContain('[message truncated]');
    expect(prompt.length).toBeLessThan(5000);
  });

  it('handles an empty room and objective', () => {
    const prompt = buildGroupRelayPrompt('Ideas', '', []);
    expect(prompt).toContain('Collaborate on the group\'s current goal.');
    expect(prompt).toContain('(No messages included.)');
  });
});
