import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRubMindsTheme, toggleRubMindsTheme } from './themePreference';
import { canSendGroupMessage, participantKindLabel, roomPanelFlags } from './uiFlow';

describe('Rub Minds theme preference', () => {
  it('preserves explicit light mode', () => expect(resolveRubMindsTheme('light', true)).toBe('light'));
  it('preserves explicit dark mode', () => expect(resolveRubMindsTheme('dark', false)).toBe('dark'));
  it('follows system preference when unset', () => {
    expect(resolveRubMindsTheme(null, true)).toBe('dark');
    expect(resolveRubMindsTheme(null, false)).toBe('light');
  });
  it('falls back to system preference for invalid values', () => expect(resolveRubMindsTheme('blue', true)).toBe('dark'));
  it('toggles both supported modes', () => {
    expect(toggleRubMindsTheme('light')).toBe('dark');
    expect(toggleRubMindsTheme('dark')).toBe('light');
  });
});
describe('Rub Minds visual design contract', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/rub-minds-redesign.css'), 'utf8');
  it('uses the same exact primary blue in light and dark modes', () => {
    const light = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const dark = css.match(/:root\[data-rm-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(light).toMatch(/--rm-primary:\s*#2464EB/i);
    expect(dark).toMatch(/--rm-primary:\s*#2464EB/i);
    expect(light).toMatch(/--accent:\s*#2464EB/i);
    expect(dark).toMatch(/--accent:\s*#2464EB/i);
  });
  it('includes the approved light and dark surface tokens', () => {
    expect(css).toContain('--rm-bg:#F9FAFB');
    expect(css).toContain('--rm-panel:#FFFFFF');
    expect(css).toContain('--rm-bg:#0C1018');
    expect(css).toContain('--rm-panel:#121721');
  });
  it('respects reduced-motion preferences', () => expect(css).toMatch(/prefers-reduced-motion:\s*reduce/));

  it('keeps room switching, invitation entry and Backroom reachable on phones', () => {
    expect(css).toContain('.rm-join-shortcut{grid-column:2;grid-row:2;display:flex');
    expect(css).toContain('.room-list{grid-column:1/-1;grid-row:3;display:flex');
    expect(css).toContain('.rm-backroom-link{grid-column:1/-1;grid-row:4;display:flex');
  });
  it('applies brand tokens to Backroom native and browser surfaces', () => {
    expect(css).toContain('.rm-backroom-shell .br-android-stream{background:var(--rm-surface)');
    expect(css).toContain('.rm-backroom-shell .br-desktop-live,.rm-backroom-shell .br-desktop-empty{background:var(--rm-surface)');
  });
});
describe('Rub Minds workspace journey', () => {
  it('keeps secondary sections mutually exclusive', () => {
    for (const panel of ['conversation', 'tasks', 'participants', 'private-context', 'shared-memory', 'connections'] as const) {
      const flags = roomPanelFlags(panel);
      expect(Object.values(flags).filter(Boolean)).toHaveLength(panel === 'conversation' ? 0 : 1);
    }
  });
  it('only enables the message composer in Conversation', () => {
    expect(canSendGroupMessage('conversation')).toBe(true);
    expect(canSendGroupMessage('tasks')).toBe(false);
    expect(canSendGroupMessage('participants')).toBe(false);
  });
  it('distinguishes an existing AI session from an external runtime', () => {
    expect(participantKindLabel('original_session')).toBe('Existing AI conversation');
    expect(participantKindLabel('external_agent')).toBe('External AI runtime');
  });
});
