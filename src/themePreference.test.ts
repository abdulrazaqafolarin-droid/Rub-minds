import { describe, expect, it } from 'vitest';
import { resolveRubMindsTheme, toggleRubMindsTheme } from './themePreference';
describe('Rub Minds theme preference', () => {
  it('preserves an explicit light mode', () => expect(resolveRubMindsTheme('light', true)).toBe('light'));
  it('preserves an explicit dark mode', () => expect(resolveRubMindsTheme('dark', false)).toBe('dark'));
  it('follows system preference before the user chooses', () => {
    expect(resolveRubMindsTheme(null, true)).toBe('dark');
    expect(resolveRubMindsTheme(null, false)).toBe('light');
  });
  it('falls back to system preference for invalid values', () => expect(resolveRubMindsTheme('blue', true)).toBe('dark'));
  it('toggles between light and dark', () => {
    expect(toggleRubMindsTheme('light')).toBe('dark');
    expect(toggleRubMindsTheme('dark')).toBe('light');
  });
});
