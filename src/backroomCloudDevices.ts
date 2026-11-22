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
  desktopApps?: BackroomDesktopApp[];
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

export type AndroidNativeBindingCandidate = {
  bindingId: string;
  participantId: string;
  displayName: string;
};
export type AndroidNativeBindingChallenge = {
  challengeId: string;
  nonce: string;
  expiresAt: string;
};

export async function listAndroidNativeBindingCandidates(roomId: string) {
  const data = await invoke<{ candidates: AndroidNativeBindingCandidate[] }>(
    'android/native-binding-candidates', { roomId }
  );
  return data.candidates;
}

export function createAndroidNativeBindingChallenge(args: {
  deviceId: string;
  roomId: string;
  sessionId: string;
  appPackageName: string;
  bindingId: string;
}) {
  return invoke<AndroidNativeBindingChallenge>('android/native-binding-challenge', {
    ...args,
    requestId: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
}

export function revokeAndroidNativeBinding(args: {
  deviceId: string;
  roomId: string;
  sessionId: string;
  bindingId: string;
}) {
  return invoke<{ revoked: boolean }>('android/native-binding-revoke', args);
}


export type BackroomFrameAICandidate = {
  participantId: string;
  displayName: string;
  kind: 'original_session' | 'model' | 'external_agent';
};
export type BackroomFrameSurface = 'android_app' | 'desktop_app' | 'terminal';
export type BackroomFrameBinding = {
  id: string;
  participant_id: string;
  surface: BackroomFrameSurface;
  target_app_id: string | null;
  expires_at: string;
  created_at: string;
};
export type BackroomFrameBindingChallenge = {
  challengeId: string;
  nonce: string;
  expiresAt: string;
  participantId: string;
  surface: BackroomFrameSurface;
};

export async function listBackroomFrameAICandidates(roomId: string) {
  const data = await invoke<{ candidates: BackroomFrameAICandidate[] }>('device-frame/ai-candidates', { roomId });
  return data.candidates;
}
export function createBackroomFrameBindingChallenge(args: {
  deviceId: string; roomId: string; runtimeSessionId: string;
  participantId: string; surface: BackroomFrameSurface;
}) {
  return invoke<BackroomFrameBindingChallenge>('device-frame/binding-challenge', {
    ...args, requestId: crypto.randomUUID(), issuedAt: Date.now(),
  });
}
export async function getBackroomFrameBindingStatus(args: {
  deviceId: string; roomId: string; runtimeSessionId: string;
}) {
  const data = await invoke<{ binding: BackroomFrameBinding | null }>('device-frame/binding-status', args);
  return data.binding;
}
export function revokeBackroomFrameBinding(args: {
  deviceId: string; roomId: string; runtimeSessionId: string; bindingId: string;
}) {
  return invoke<{ revoked: boolean }>('device-frame/binding-revoke', args);
}
