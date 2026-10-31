export type DeviceScope = { deviceId: string; roomId: string };
export type DeviceCommandAction =
  | 'launch_app' | 'terminal_start' | 'request_control'
  | 'request_draft_permission' | 'view_offer' | 'stop_session';
export type DeviceCommand = {
  requestId: string;
  action: DeviceCommandAction;
  issuedAt: number;
  deviceId: string;
  roomId: string;
  [key: string]: unknown;
};
export type DeviceCapability = 'launch' | 'terminal' | 'view' | 'control' | 'draft' | 'stop';
export function isUuid(value: unknown): value is string;
export function buildScopedDeviceMessage<T extends Record<string, unknown>>(
  payload: T, scope: DeviceScope
): Readonly<T & DeviceScope>;
export function createDeviceCommand(
  action: DeviceCommandAction,
  details: Record<string, unknown>,
  options: DeviceScope & { now?: number; requestId?: string }
): Readonly<DeviceCommand>;
export function validateDeviceCommand(
  payload: unknown,
  options: DeviceScope & { now?: number; maxAgeMs?: number }
): payload is DeviceCommand;
export function classifyDeviceResponse(payload: unknown): DeviceCapability | 'error' | null;
export type DeviceSignal = {
  deviceId: string; roomId: string; sessionId: string; issuedAt: number;
  answer?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit;
  stop?: boolean; canControl?: boolean; actorUserId?: string; actorDisplayName?: string;
};
export function validateDeviceSignal(
  payload: unknown,
  options: DeviceScope & { now?: number; maxAgeMs?: number }
): Readonly<DeviceSignal> | null;
export function queueIceCandidate(
  queue: Map<string, RTCIceCandidateInit[]>,
  sessionId: string,
  candidate: RTCIceCandidateInit,
  limits?: { maxSessions?: number; maxPerSession?: number }
): boolean;
export function takeIceCandidates(
  queue: Map<string, RTCIceCandidateInit[]>,
  sessionId: string
): RTCIceCandidateInit[];
