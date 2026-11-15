import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { resolveRubMindsTheme, RUB_MINDS_THEME_KEY, toggleRubMindsTheme, type RubMindsTheme } from './themePreference';
type Preferences = { theme: RubMindsTheme; toggleTheme: () => void };
const PreferencesContext = createContext<Preferences | null>(null);
function readTheme(): RubMindsTheme {
  try {
    return resolveRubMindsTheme(window.localStorage.getItem(RUB_MINDS_THEME_KEY), window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  } catch { return 'light'; }
}
export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<RubMindsTheme>(readTheme);
  const toggleTheme = useCallback(() => setTheme(current => toggleRubMindsTheme(current)), []);
  useEffect(() => {
    document.documentElement.dataset.rmTheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0C1018' : '#F9FAFB');
    try { window.localStorage.setItem(RUB_MINDS_THEME_KEY, theme); } catch { /* Current-session theme remains active. */ }
  }, [theme]);
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
export function useUiPreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('useUiPreferences must be used inside UiPreferencesProvider.');
  return value;
}
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useUiPreferences();
  const next = theme === 'dark' ? 'light' : 'dark';
  return <button className={'rm-theme-toggle' + (compact ? ' compact' : '')} type="button"
    onClick={toggleTheme} aria-label={'Switch to ' + next + ' mode'} title={'Switch to ' + next + ' mode'}>
    {theme === 'dark' ? <Sun size={16} aria-hidden="true"/> : <Moon size={16} aria-hidden="true"/>}
    {!compact && <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
  </button>;
}
