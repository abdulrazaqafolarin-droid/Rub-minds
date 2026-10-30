import BackroomDevicesApp from './BackroomDevicesApp';

/**
 * The cloud-connected Device Frame is the only user-facing Backroom route.
 * Legacy loopback-host experiments remain unreferenced and cannot be reached
 * through the normal Backroom entry point.
 */
export default function BackroomApp() {
  return <BackroomDevicesApp />;
}
