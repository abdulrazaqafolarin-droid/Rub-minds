export type RubMindsTheme = 'light' | 'dark';
export const RUB_MINDS_THEME_KEY = 'rub-minds-theme';
export function resolveRubMindsTheme(saved: string | null, prefersDark: boolean): RubMindsTheme {
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersDark ? 'dark' : 'light';
}
export function toggleRubMindsTheme(theme: RubMindsTheme): RubMindsTheme {
  return theme === 'dark' ? 'light' : 'dark';
}
