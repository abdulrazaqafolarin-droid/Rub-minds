import { supabase } from './supabase';

export type BackroomDeviceApp = {
  package_name: string;
  app_label: string;
  version_name: string;
  draft_insertion_allowed: boolean;
  discovered_at: string;
};
export type BackroomDesktopApp = {
  app_id: string;
  app_label: string;
  executable_sha256: string;
  discovered_at: string;
};
export type BackroomDevice = {
  device_id: string;
  device_label: string;
  platform: string;
  os_version: string;
  app_version: string;
  status: 'pending' | 'active' | 'revoked';
  capabilities: Record<string, boolean>;
  created_at: string;
  approved_at: string | null;
  last_seen_at: string | null;
  apps: BackroomDeviceApp[];
  desktopApps: BackroomDesktopApp[];
};
export type BackroomDeviceEvent = {
  id: string;
  device_id: string;
  actor_type: 'owner' | 'device' | 'ai' | 'system';
  actor_id: string;
  event_type: string;
  package_name: string | null;
  created_at: string;
};

async function invoke<T>(action: string, fields: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Rub Minds cloud is not configured.');
  const { data, error } = await supabase.functions.invoke('backroom-device', {
    body: { action, ...fields },
  });
  if (error) throw new Error(error.message || 'Backroom device request failed.');
  if (!data || data.ok !== true) {
    const reason = typeof data?.reason === 'string' ? data.reason : 'device_request_failed';
    throw new Error(reason.replaceAll('_', ' '));
  }
  return data as T;
}

export function createBackroomDevicePairing(roomId: string, deviceLabel = 'Android phone') {
  return invoke<{ ok: true; pairingCode: string; expiresAt: string }>('pair/create', { roomId, deviceLabel });
}
export async function listBackroomDevices(roomId: string) {
  const data = await invoke<{ devices: BackroomDevice[] }>('room/devices', { roomId });
  return data.devices;
}
export async function listBackroomDeviceEvents(roomId: string) {
  const data = await invoke<{ events: BackroomDeviceEvent[] }>('room/events', { roomId });
  return data.events;
}
export function approveBackroomDevice(deviceId: string, roomId: string) {
  return invoke<{ deviceId: string; status: string }>('owner/approve', { deviceId, roomId });
}
export function revokeBackroomDevice(deviceId: string, roomId: string) {
  return invoke<{ deviceId: string; status: string }>('owner/revoke', { deviceId, roomId });
}
