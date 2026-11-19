import { useEffect, useState } from 'react';
import CloudApp from './CloudApp';
import BackroomDevicesApp from './BackroomDevicesApp';
import { supabase } from './supabase';

/**
 * Backroom has one product workspace: the real paired-device frames.
 * Authentication remains shared with Rub Minds. No demo/simulator or
 * alternate browser-runtime workspace is exposed here.
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
  return <BackroomDevicesApp />;
}
