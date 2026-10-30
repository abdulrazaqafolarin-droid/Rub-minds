import { Monitor, Smartphone } from 'lucide-react';
import BackroomSimulatorApp from './BackroomSimulatorApp';
import BackroomDevicesApp from './BackroomDevicesApp';
import './backroom-mode-nav.css';

function routeHref(devices: boolean) {
  const params = new URLSearchParams(window.location.search);
  params.set('backroom', '1');
  if (devices) params.set('devices', '1');
  else params.delete('devices');
  return window.location.pathname + '?' + params.toString();
}

/**
 * Backroom stays a single workspace. The original managed-browser simulator
 * remains the default; connected native devices are a peer view, not a replacement.
 */
export default function BackroomApp() {
  const showDevices = new URLSearchParams(window.location.search).get('devices') === '1';
  return <div className="br-workspace-root">
    <nav className="br-mode-nav" aria-label="Backroom workspace views">
      <a className={!showDevices ? 'active' : ''} href={routeHref(false)} aria-current={!showDevices ? 'page' : undefined}>
        <Monitor size={15}/> Simulator
      </a>
      <a className={showDevices ? 'active' : ''} href={routeHref(true)} aria-current={showDevices ? 'page' : undefined}>
        <Smartphone size={15}/> Connected devices
      </a>
    </nav>
    {showDevices ? <BackroomDevicesApp/> : <BackroomSimulatorApp/>}
  </div>;
}
