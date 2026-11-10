import { useEffect, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import CloudApp from './CloudApp';
import BackroomDevicesApp from './BackroomDevicesApp';
import BackroomSimulatorApp from './BackroomSimulatorApp';
import './backroom-mode-nav.css';
import { supabase } from './supabase';
import { ThemeToggle } from './UiPreferences';

function backroomViewHref(browser: boolean) {
  const params = new URLSearchParams(window.location.search);
  params.set('backroom', '1');
  if (browser) params.set('browser', '1');
  else params.delete('browser');
  return window.location.pathname + '?' + params.toString();
}

/**
 * Backroom uses one sign-in gate for both workspaces. The cloud Device Frame is
 * the default route; the managed browser remains a peer workspace until its
 * screenshot/target adapter is rendered directly inside the unified frame.
 */
export default function BackroomApp() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setAuthenticated(Boolean(session));
      setReady(true);
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setAuthenticated(Boolean(data.session));
      setReady(true);
    }).catch(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  if (!ready) return <main className="br-cloud-shell" aria-live="polite">Checking Rub Minds sign-in…</main>;
  if (!authenticated) return <CloudApp />;

  const browserView = new URLSearchParams(window.location.search).get('browser') === '1';
  return <div className="br-workspace-root rm-backroom-shell">
    <header className="rm-backroom-topbar">
      <a className="rm-backroom-brand" href="/" aria-label="Rub Minds collaboration workspace">
        <span className="rm-backroom-mark"><span/></span>
        <span><strong>Rub Minds</strong><small>Backroom workspace</small></span>
      </a>
      <div className="rm-backroom-top-actions">
        <a href="/" className="rm-button-secondary">Collaboration</a>
        <ThemeToggle compact/>
      </div>
    </header>
    <nav className="br-mode-nav" aria-label="Backroom workspaces">
      <a
        className={!browserView ? 'active' : ''}
        href={backroomViewHref(false)}
        aria-current={!browserView ? 'page' : undefined}
      >
        <Smartphone size={15}/> Device Frame
      </a>
      <a
        className={browserView ? 'active' : ''}
        href={backroomViewHref(true)}
        aria-current={browserView ? 'page' : undefined}
      >
        <Monitor size={15}/> Browser runtime
      </a>
    </nav>
    {browserView ? <BackroomSimulatorApp/> : <BackroomDevicesApp/>}
  </div>;
}
