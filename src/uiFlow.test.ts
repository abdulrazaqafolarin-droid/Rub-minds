import { describe, expect, it } from 'vitest';
import { canSendGroupMessage, participantKindLabel, roomPanelFlags } from './uiFlow';

describe('Rub Minds room navigation', () => {
  it('keeps secondary tabs mutually exclusive', () => {
    for (const panel of ['conversation', 'tasks', 'participants', 'private-context', 'shared-memory', 'connections'] as const) {
      const flags = roomPanelFlags(panel);
      expect(Object.values(flags).filter(Boolean)).toHaveLength(panel === 'conversation' ? 0 : 1);
    }
  });
  it('shows the composer only in the conversation tab', () => {
    expect(canSendGroupMessage('conversation')).toBe(true);
    expect(canSendGroupMessage('tasks')).toBe(false);
    expect(canSendGroupMessage('participants')).toBe(false);
  });
  it('labels native original-session participants distinctly', () => {
    expect(participantKindLabel('original_session')).toBe('Existing AI conversation');
    expect(participantKindLabel('external_agent')).toBe('External AI runtime');
  });
});
