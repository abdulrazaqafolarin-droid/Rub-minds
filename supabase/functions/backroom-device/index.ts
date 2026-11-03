/**
 * Cloud-connected Backroom device registration and selected-app inventory.
 * Android calls this function over outbound HTTPS; no phone or desktop port
 * listener is created. This endpoint intentionally does not execute OS actions.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolveOwnerFromJwt } from './owner-jwt.mjs';
import { sanitizeDeviceEvent, validatePairClaim, validateSelectedApps } from './cloud-device-protocol.mjs';
import { validateDesktopRegistration } from './desktop-device-protocol.mjs';
import { validateDesktopApps } from './desktop-app-protocol.mjs';
import { validateDesktopCommand, validateDesktopSignal } from './desktop-command-protocol.mjs';
import { validateDesktopSessionClose } from './desktop-session-close-protocol.mjs';
import { validateDesktopSessionAbandon } from './desktop-session-abandon-protocol.mjs';
import { validateAndroidSessionStart, validateAndroidDeviceCommand, validateAndroidSignal, validateAndroidCommandAck, validateAndroidNativeWakeHandoff, validateAndroidNativeWakeResult, validateAndroidSessionClose, mapAndroidQueuedCommand } from './android-streaming-protocol.mjs';
import { broadcastPrivateDeviceEvent } from './realtime-broadcast.mjs';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('Backroom device backend configuration missing');
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const allowedOrigins = new Set((Deno.env.get('BACKROOM_DEVICE_ALLOWED_ORIGINS') ?? 'https://rub-minds.vercel.app')
  .split(',').map(value => value.trim()).filter(Boolean));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANDROID_SESSION_LEASE_MS = 2 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/;
const bearerPattern = /^Bearer ([A-Za-z0-9_.-]{32,4096})$/;
const MAX_BYTES = 96 * 1024;
const json = (status: number, payload: unknown, origin: string | null) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin', ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) }
});
async function readBody(req: Request) {
  const declared = req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('too-large');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error('too-large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomHex(size: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function exactKeys(value: Record<string, unknown>, allowedKeys: string[], requiredKeys: string[] = []) {
  return Object.keys(value).every(key => allowedKeys.includes(key)) &&
    requiredKeys.every(key => Object.hasOwn(value, key));
}
async function owner(req: Request) {
  return await resolveOwnerFromJwt(req, token => db.auth.getUser(token));
}
async function device(req: Request, allowPending = false, allowRevoked = false) {
  const token = bearerPattern.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  const digest = await sha256(token);
  const { data, error } = await db.from('backroom_devices')
    .select('device_id,owner_id,device_label,status,capabilities,platform')
    .eq('token_digest', digest).maybeSingle();
  if (error || !data || (!allowRevoked && data.status === 'revoked') || (!allowPending && data.status !== 'active')) return null;
  return data;
}
function fail(reason: string) { return { ok: false, reason }; }

function strictKeys(value: Record<string, unknown>, keys: string[]) {
  return exactKeys(value, keys) && keys.every(key => Object.hasOwn(value, key));
}
async function authorizeRoomActor(roomId: string, userId: string) {
  const { data: room, error: roomError } = await db.from('rooms').select('id')
    .eq('id', roomId).eq('owner_id', userId).maybeSingle();
  if (roomError) return { ok: false as const, status: 503, reason: 'room_authorization_unavailable' };
  if (room) return { ok: true as const, userId, displayName: 'Group owner' };
  const { data: participant, error } = await db.from('participants')
    .select('id,display_name,kind,status')
    .eq('room_id', roomId).eq('user_id', userId).eq('kind', 'human')
    .in('status', ['active', 'connected', 'autonomous']).maybeSingle();
  if (error) return { ok: false as const, status: 503, reason: 'room_authorization_unavailable' };
  if (!participant) return { ok: false as const, status: 403, reason: 'active_human_membership_required' };
  const displayName = typeof participant.display_name === 'string'
    ? participant.display_name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 80)
    : '';
  return { ok: true as const, userId, displayName: displayName || 'Group member' };
}
async function verifyActiveDeviceRoomBinding(deviceId: string, roomId: string) {
  const [{ data: deviceRow, error: deviceError }, { data: binding, error: bindingError }] = await Promise.all([
    db.from('backroom_devices').select('device_id,status,platform').eq('device_id', deviceId).eq('status', 'active').maybeSingle(),
    db.from('backroom_device_room_bindings').select('device_id,room_id')
      .eq('device_id', deviceId).eq('room_id', roomId).is('revoked_at', null).maybeSingle(),
  ]);
  if (deviceError || bindingError) return { ok: false as const, status: 503, reason: 'device_authorization_unavailable' };
  if (!deviceRow || !binding) return { ok: false as const, status: 404, reason: 'active_device_binding_not_found' };
  return { ok: true as const, platform: deviceRow.platform as string };
}
async function activeDesktopSession(sessionId: string, deviceId: string, roomId: string) {
  const { data, error } = await db.from('backroom_desktop_sessions')
    .select('session_id,session_type,status,expires_at')
    .eq('session_id', sessionId).eq('device_id', deviceId).eq('room_id', roomId)
    .eq('status', 'active').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (error) return { ok: false as const, status: 503, reason: 'desktop_session_unavailable' };
  if (!data) return { ok: false as const, status: 404, reason: 'desktop_session_not_active' };
  return { ok: true as const, session: data };
}

Deno.serve(async req => {
  const origin = req.headers.get('origin');
  if (origin && !allowedOrigins.has(origin)) return json(403, fail('origin_not_allowed'), null);
  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return json(403, fail('origin_not_allowed'), null);
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
      'Access-Control-Max-Age': '300', 'Vary': 'Origin', 'Cache-Control': 'no-store'
    }});
  }
  if (req.method !== 'POST') return json(405, fail('method_not_allowed'), origin);
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json(415, fail('application_json_required'), origin);
  }
  let input: any;
  try { input = await readBody(req); } catch (error) {
    return json(error instanceof Error && error.message === 'too-large' ? 413 : 400, fail('invalid_request_body'), origin);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string') {
    return json(400, fail('invalid_action'), origin);
  }
  const action = input.action;
  try {
    if (action === 'desktop/register') {
      const ownerId = await owner(req);
      if (!ownerId) return json(401, fail('owner_auth_required'), origin);
      if (!exactKeys(input, ['action','deviceId','deviceLabel','platform','osVersion','appVersion','roomId','devicePublicKey'])) {
        return json(400, fail('invalid_desktop_registration'), origin);
      }
      const registration = validateDesktopRegistration({
        deviceId: input.deviceId,
        deviceLabel: input.deviceLabel,
        platform: input.platform,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        roomId: input.roomId,
        devicePublicKey: input.devicePublicKey
      });
      if (!registration) return json(400, fail('invalid_desktop_registration'), origin);
      const { data: room, error: roomError } = await db.from('rooms').select('id')
        .eq('id', registration.roomId).eq('owner_id', ownerId).maybeSingle();
      if (roomError) return json(503, fail('device_service_unavailable'), origin);
      if (!room) return json(403, fail('room_owner_required'), origin);

      // Generated once, returned once, and persisted only as a SHA-256 digest.
      // The native app must save it in the OS credential store before it starts
      // polling/connecting. Never log this value or return it from status APIs.
      const deviceToken = randomHex(32);
      const { data, error } = await db.rpc('register_backroom_desktop_device', {
        p_device_id: registration.deviceId,
        p_owner_id: ownerId,
        p_room_id: registration.roomId,
        p_token_digest: await sha256(deviceToken),
        p_device_public_key: registration.devicePublicKey,
        p_device_label: registration.deviceLabel,
        p_platform: registration.platform,
        p_os_version: registration.osVersion,
        p_app_version: registration.appVersion
      });
      if (error) return json(409, fail('desktop_registration_failed'), origin);
      if (!Array.isArray(data) || data.length !== 1 ||
          data[0]?.device_id !== registration.deviceId || data[0]?.status !== 'active') {
        return json(409, fail('desktop_registration_conflict'), origin);
      }
      return json(201, {
        ok: true, deviceId: registration.deviceId, status: 'active',
        deviceToken, roomId: registration.roomId,
        capabilities: {
          appDiscovery: true, separateAppData: false, embeddedVirtualApp: false,
          liveScreen: false, touchControl: false, desktopControl: false, terminalControl: false
        }
      }, origin);
    }




    if (action === 'desktop/session-abandon') {
      const userId = await owner(req);
      if (!userId) return json(401, fail('owner_auth_required'), origin);
      const abandonRequest = validateDesktopSessionAbandon(input);
      if (!abandonRequest) return json(400, fail('invalid_desktop_session_abandon'), origin);
      const [actor, binding] = await Promise.all([
        authorizeRoomActor(abandonRequest.roomId, userId),
        verifyActiveDeviceRoomBinding(abandonRequest.deviceId, abandonRequest.roomId),
      ]);
      if (!actor.ok) return json(actor.status, fail(actor.reason), origin);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      const { data: existing, error: lookupError } = await db.from('backroom_desktop_sessions')
        .select('session_id,status')
        .eq('session_id', abandonRequest.sessionId).eq('device_id', abandonRequest.deviceId)
        .eq('room_id', abandonRequest.roomId).eq('requested_by', userId).maybeSingle();
      if (lookupError) return json(503, fail('desktop_session_lookup_failed'), origin);
      if (!existing) return json(404, fail('desktop_session_not_found'), origin);
      if (existing.status === 'revoked' || existing.status === 'expired') {
        return json(409, fail('desktop_session_no_longer_controllable'), origin);
      }
      let closed = false;
      if (existing.status === 'active') {
        const { data, error } = await db.from('backroom_desktop_sessions')
          .update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', abandonRequest.sessionId).eq('device_id', abandonRequest.deviceId)
          .eq('room_id', abandonRequest.roomId).eq('requested_by', userId).eq('status', 'active')
          .select('session_id');
        if (error) return json(503, fail('desktop_session_abandon_failed'), origin);
        closed = Array.isArray(data) && data.length === 1;
      } else if (existing.status !== 'stopped') {
        return json(409, fail('desktop_session_no_longer_controllable'), origin);
      }
      try {
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: abandonRequest.deviceId,
          event: 'command',
          payload: {
            deviceId: abandonRequest.deviceId, roomId: abandonRequest.roomId,
            requestId: abandonRequest.requestId, issuedAt: abandonRequest.issuedAt,
            action: 'stop_session', sessionId: abandonRequest.sessionId,
            actorUserId: actor.userId, actorDisplayName: actor.displayName,
          },
        });
      } catch {
        return json(503, fail('desktop_session_abandon_delivery_failed'), origin);
      }
      return json(200, { ok: true, sessionId: abandonRequest.sessionId, status: 'stopped', closed }, origin);
    }

    if (action === 'desktop/session-close') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      const closeRequest = validateDesktopSessionClose(input);
      if (!closeRequest) return json(400, fail('invalid_desktop_session_close'), origin);
      const binding = await verifyActiveDeviceRoomBinding(current.device_id, closeRequest.roomId);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      const { data, error } = await db.from('backroom_desktop_sessions')
        .update({ status: 'stopped', stopped_at: new Date().toISOString() })
        .eq('session_id', closeRequest.sessionId).eq('device_id', current.device_id)
        .eq('room_id', closeRequest.roomId).eq('status', 'active')
        .select('session_id');
      if (error) return json(503, fail('desktop_session_close_failed'), origin);
      return json(200, {
        ok: true, sessionId: closeRequest.sessionId,
        status: data?.length ? 'stopped' : 'unchanged',
        closed: Array.isArray(data) && data.length === 1,
      }, origin);
    }

    if (action === 'desktop/command') {
      const userId = await owner(req);
      if (!userId) return json(401, fail('owner_auth_required'), origin);
      if (!strictKeys(input, ['action','deviceId','roomId','requestId','issuedAt','command','details'])) {
        return json(400, fail('invalid_desktop_command'), origin);
      }
      const command = validateDesktopCommand({
        deviceId: input.deviceId, roomId: input.roomId, requestId: input.requestId,
        issuedAt: input.issuedAt, command: input.command, details: input.details,
      });
      if (!command) return json(400, fail('invalid_desktop_command'), origin);
      const [actor, binding] = await Promise.all([
        authorizeRoomActor(command.roomId, userId),
        verifyActiveDeviceRoomBinding(command.deviceId, command.roomId),
      ]);
      if (!actor.ok) return json(actor.status, fail(actor.reason), origin);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);

      if (command.command === 'launch_app') {
        const { data: app } = await db.from('backroom_desktop_apps').select('app_id')
          .eq('device_id', command.deviceId).eq('app_id', command.details.appId).maybeSingle();
        if (!app) return json(403, fail('app_not_registered_on_device'), origin);
      }

      let sessionType: 'screen' | 'terminal' | null = null;
      if (command.command === 'view_offer') sessionType = 'screen';
      if (command.command === 'terminal_start') sessionType = 'terminal';
      if (sessionType) {
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        const { error } = await db.from('backroom_desktop_sessions').insert({
          session_id: command.details.sessionId,
          device_id: command.deviceId, room_id: command.roomId,
          requested_by: userId, session_type: sessionType, status: 'active', expires_at: expiresAt,
        });
        if (error) return json(409, fail('desktop_session_id_conflict'), origin);
      } else if (command.command === 'stop_session') {
        const { data: existing, error: lookupError } = await db.from('backroom_desktop_sessions')
          .select('session_id,status,expires_at')
          .eq('session_id', command.details.sessionId).eq('device_id', command.deviceId)
          .eq('room_id', command.roomId).maybeSingle();
        if (lookupError) return json(503, fail('desktop_session_lookup_failed'), origin);
        if (!existing) return json(404, fail('desktop_session_not_found'), origin);
        if (existing.status === 'revoked' || existing.status === 'expired') {
          return json(409, fail('desktop_session_no_longer_controllable'), origin);
        }
        if (existing.status === 'active') {
          const { error } = await db.from('backroom_desktop_sessions')
            .update({ status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('session_id', command.details.sessionId).eq('device_id', command.deviceId)
            .eq('room_id', command.roomId).eq('status', 'active');
          if (error) return json(503, fail('desktop_session_stop_failed'), origin);
        } else if (existing.status !== 'stopped') {
          return json(409, fail('desktop_session_no_longer_controllable'), origin);
        }
      } else {
        const authorizationSessionId = command.command === 'request_control' && command.details.peerSessionId
          ? command.details.peerSessionId : command.details.sessionId;
        const session = await activeDesktopSession(authorizationSessionId, command.deviceId, command.roomId);
        if (!session.ok) return json(session.status, fail(session.reason), origin);
        if (command.command === 'request_control' && command.details.peerSessionId &&
            session.session.session_type !== 'terminal') {
          return json(409, fail('peer_session_must_be_terminal'), origin);
        }
        if (command.command === 'request_draft_permission' && session.session.session_type !== 'screen') {
          return json(409, fail('draft_permission_requires_screen_session'), origin);
        }
      }

      const eventPayload = {
        deviceId: command.deviceId, roomId: command.roomId,
        requestId: command.requestId, issuedAt: command.issuedAt,
        action: command.command, ...command.details,
        actorUserId: actor.userId, actorDisplayName: actor.displayName,
      };
      try {
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: command.deviceId,
          event: 'command', payload: eventPayload,
        });
      } catch {
        if (sessionType) await db.from('backroom_desktop_sessions')
          .update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', command.details.sessionId).eq('device_id', command.deviceId);
        return json(503, fail('device_command_delivery_failed'), origin);
      }
      return json(202, { ok: true, requestId: command.requestId, command: command.command }, origin);
    }

    if (action === 'desktop/signal') {
      const userId = await owner(req);
      if (!userId) return json(401, fail('owner_auth_required'), origin);
      if (!strictKeys(input, ['action','deviceId','roomId','sessionId','issuedAt','candidate'])) {
        return json(400, fail('invalid_desktop_signal'), origin);
      }
      const signal = validateDesktopSignal({
        deviceId: input.deviceId, roomId: input.roomId, sessionId: input.sessionId,
        issuedAt: input.issuedAt, candidate: input.candidate,
      });
      if (!signal) return json(400, fail('invalid_desktop_signal'), origin);
      const [actor, binding, session] = await Promise.all([
        authorizeRoomActor(signal.roomId, userId),
        verifyActiveDeviceRoomBinding(signal.deviceId, signal.roomId),
        activeDesktopSession(signal.sessionId, signal.deviceId, signal.roomId),
      ]);
      if (!actor.ok) return json(actor.status, fail(actor.reason), origin);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      if (!session.ok) return json(session.status, fail(session.reason), origin);
      try {
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: signal.deviceId,
          event: 'signal',
          payload: {
            deviceId: signal.deviceId, roomId: signal.roomId,
            sessionId: signal.sessionId, issuedAt: signal.issuedAt,
            candidate: signal.candidate, actorUserId: actor.userId,
            actorDisplayName: actor.displayName,
          },
        });
      } catch {
        return json(503, fail('device_signal_delivery_failed'), origin);
      }
      return json(202, { ok: true, sessionId: signal.sessionId }, origin);
    }

    if (action === 'pair/create') {
      const ownerId = await owner(req);
      if (!ownerId) return json(401, fail('owner_auth_required'), origin);
      if (!exactKeys(input, ['action','roomId','deviceLabel']) || typeof input.roomId !== 'string' || !UUID.test(input.roomId) ||
        typeof input.deviceLabel !== 'string' || !input.deviceLabel.trim() || input.deviceLabel.length > 80) {
        return json(400, fail('invalid_pair_request'), origin);
      }
      const { data: room, error: roomError } = await db.from('rooms').select('id')
        .eq('id', input.roomId).eq('owner_id', ownerId).maybeSingle();
      if (roomError) return json(503, fail('device_service_unavailable'), origin);
      if (!room) return json(403, fail('room_owner_required'), origin);
      const now = new Date().toISOString();
      const { count: pendingCount, error: pendingError } = await db.from('backroom_device_pairings')
        .select('id', { count: 'exact', head: true }).eq('owner_id', ownerId)
        .is('claimed_at', null).gt('expires_at', now);
      if (pendingError) return json(503, fail('device_service_unavailable'), origin);
      if ((pendingCount ?? 0) >= 5) return json(429, fail('too_many_pending_pairings'), origin);
      await db.from('backroom_device_pairings').delete().eq('owner_id', ownerId)
        .lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const code = randomHex(32);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { error } = await db.from('backroom_device_pairings').insert({
        owner_id: ownerId, room_id: input.roomId, code_digest: await sha256(code),
        device_label: input.deviceLabel.trim(), expires_at: expiresAt
      });
      if (error) return json(503, fail('pairing_creation_failed'), origin);
      return json(201, { ok: true, pairingCode: code, expiresAt }, origin);
    }

    if (action === 'pair/claim') {
      const token = bearerPattern.exec(req.headers.get('authorization') ?? '')?.[1];
      if (!token || !HEX.test(token) || !validatePairClaim({
        pairingCode: input.pairingCode, deviceId: input.deviceId,
        deviceLabel: input.deviceLabel, osVersion: input.osVersion, appVersion: input.appVersion
      }, token) || !exactKeys(input, ['action','pairingCode','deviceId','deviceLabel','osVersion','appVersion'])) {
        return json(400, fail('invalid_pair_claim'), origin);
      }
      const { data, error } = await db.rpc('claim_backroom_device_pairing', {
        p_code_digest: await sha256(input.pairingCode), p_device_id: input.deviceId,
        p_token_digest: await sha256(token), p_device_label: input.deviceLabel.trim(),
        p_os_version: input.osVersion, p_app_version: input.appVersion
      });
      if (error) return json(503, fail('pairing_unavailable'), origin);
      if (!Array.isArray(data) || data.length !== 1) return json(409, fail('pairing_expired_or_used'), origin);
      return json(201, { ok: true, deviceId: input.deviceId, status: 'pending', ownerApprovalRequired: true }, origin);
    }

    if (action === 'device/status') {
      if (!exactKeys(input, ['action'])) return json(400, fail('invalid_status_request'), origin);
      const current = await device(req, true, true);
      if (!current) return json(401, fail('device_auth_invalid'), origin);
      await db.from('backroom_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', current.device_id);
      return json(200, { ok: true, deviceId: current.device_id, status: current.status,
        capabilities: current.capabilities }, origin);
    }

    if (action === 'android/session-start') {
      const userId = await owner(req);
      if (!userId) return json(401, fail('owner_auth_required'), origin);
      const start = validateAndroidSessionStart({
        deviceId: input.deviceId, roomId: input.roomId, requestId: input.requestId,
        issuedAt: input.issuedAt, sessionId: input.sessionId,
        appPackageName: input.appPackageName, offer: input.offer,
      });
      if (!start || !exactKeys(input, ['action','deviceId','roomId','requestId','issuedAt','sessionId','appPackageName','offer'])) {
        return json(400, fail('invalid_android_session_start'), origin);
      }
      const [actor, binding] = await Promise.all([
        authorizeRoomActor(start.roomId, userId),
        verifyActiveDeviceRoomBinding(start.deviceId, start.roomId),
      ]);
      if (!actor.ok) return json(actor.status, fail(actor.reason), origin);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      if (binding.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const { data: app, error: appError } = await db.from('backroom_device_apps')
        .select('package_name').eq('device_id', start.deviceId)
        .eq('package_name', start.appPackageName).maybeSingle();
      if (appError) return json(503, fail('android_app_inventory_unavailable'), origin);
      if (!app) return json(403, fail('app_not_selected_on_device'), origin);

      const now = new Date().toISOString();
      const { error: expireError } = await db.from('backroom_desktop_sessions')
        .update({ status: 'expired', stopped_at: now })
        .eq('device_id', start.deviceId).eq('session_type', 'screen')
        .eq('status', 'active').lt('expires_at', now);
      if (expireError) return json(503, fail('android_expired_session_cleanup_failed'), origin);
      const { data: existingSession, error: existingSessionError } = await db.from('backroom_desktop_sessions')
        .select('session_id').eq('device_id', start.deviceId)
        .eq('session_type', 'screen').eq('status', 'active')
        .gt('expires_at', now).limit(1);
      if (existingSessionError) return json(503, fail('android_session_lookup_failed'), origin);
      if (Array.isArray(existingSession) && existingSession.length > 0) {
        return json(409, fail('android_screen_session_already_active'), origin);
      }

      const expiresAt = new Date(Date.now() + ANDROID_SESSION_LEASE_MS).toISOString();
      const { error: sessionError } = await db.from('backroom_desktop_sessions').insert({
        session_id: start.sessionId, device_id: start.deviceId, room_id: start.roomId,
        requested_by: userId, session_type: 'screen', status: 'active', expires_at: expiresAt,
      });
      if (sessionError) return json(409, fail('android_session_id_conflict'), origin);
      const command = {
        action: 'view_offer', deviceId: start.deviceId, roomId: start.roomId,
        requestId: start.requestId, issuedAt: start.issuedAt, sessionId: start.sessionId,
        appPackageName: start.appPackageName, offer: start.offer,
      };
      const { error: queueError } = await db.from('backroom_android_commands').insert({
        device_id: start.deviceId, room_id: start.roomId, session_id: start.sessionId,
        request_id: start.requestId, command,
        status: 'pending', expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });
      if (queueError) {
        await db.from('backroom_desktop_sessions').update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', start.sessionId).eq('device_id', start.deviceId);
        return json(503, fail('android_command_queue_unavailable'), origin);
      }
      return json(202, { ok: true, sessionId: start.sessionId, status: 'queued' }, origin);
    }

    if (action === 'android/command') {
      const userId = await owner(req);
      if (!userId) return json(401, fail('owner_auth_required'), origin);
      const command = validateAndroidDeviceCommand({
        deviceId: input.deviceId, roomId: input.roomId, requestId: input.requestId,
        issuedAt: input.issuedAt, sessionId: input.sessionId,
        command: input.command, appPackageName: input.appPackageName,
      });
      if (!command || !exactKeys(input, ['action','deviceId','roomId','requestId','issuedAt','sessionId','command','appPackageName'])) {
        return json(400, fail('invalid_android_command'), origin);
      }
      const [actor, binding, session] = await Promise.all([
        authorizeRoomActor(command.roomId, userId),
        verifyActiveDeviceRoomBinding(command.deviceId, command.roomId),
        activeDesktopSession(command.sessionId, command.deviceId, command.roomId),
      ]);
      if (!actor.ok) return json(actor.status, fail(actor.reason), origin);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      if (binding.platform !== 'android') return json(409, fail('android_device_required'), origin);
      if (!session.ok) return json(session.status, fail(session.reason), origin);
      if (session.session.session_type !== 'screen') return json(409, fail('android_screen_session_required'), origin);
      // Any current human group member may request control of an existing active
      // screen session; the session's originating actor remains recorded in DB.
      // A removed/revoked member fails authorizeRoomActor above.
      const { data: app } = await db.from('backroom_device_apps').select('package_name')
        .eq('device_id', command.deviceId).eq('package_name', command.appPackageName).maybeSingle();
      if (!app) return json(403, fail('app_not_selected_on_device'), origin);

      const { error: queueError } = await db.from('backroom_android_commands').insert({
        device_id: command.deviceId, room_id: command.roomId, session_id: command.sessionId,
        request_id: command.requestId,
        command: { ...command, action: command.command }, status: 'pending',
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });
      if (queueError) return json(409, fail('android_command_id_conflict'), origin);
      if (command.command === 'stop_session') {
        const { error: stopError } = await db.from('backroom_desktop_sessions')
          .update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', command.sessionId).eq('device_id', command.deviceId)
          .eq('room_id', command.roomId).eq('status', 'active');
        if (stopError) return json(503, fail('android_session_stop_failed'), origin);
        try {
          await broadcastPrivateDeviceEvent({
            projectUrl: url, apiKey: serviceKey, deviceId: command.deviceId, event: 'android_signal',
            payload: { deviceId: command.deviceId, roomId: command.roomId,
              sessionId: command.sessionId, issuedAt: Date.now(), stop: true,
              actorUserId: actor.userId, actorDisplayName: actor.displayName },
          });
        } catch { /* device queue and local timeout remain authoritative */ }
      }
      return json(202, { ok: true, requestId: command.requestId, command: command.command }, origin);
    }

    if (action === 'android/commands') {
      const hasSessionId = Object.hasOwn(input, 'sessionId');
      const hasRoomId = Object.hasOwn(input, 'roomId');
      if (hasSessionId !== hasRoomId ||
          !exactKeys(input, hasSessionId ? ['action','sessionId','roomId'] : ['action']) ||
          (hasSessionId && (!UUID.test(input.sessionId) || !UUID.test(input.roomId)))) {
        return json(400, fail('invalid_android_command_poll'), origin);
      }
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (current.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const now = new Date().toISOString();
      const nextSessionExpiry = new Date(Date.now() + ANDROID_SESSION_LEASE_MS).toISOString();
      const stopSessionIds: string[] = [];

      // Heartbeat only the exact session the handset says it currently owns.
      // This prevents an otherwise-active device from renewing a different room's
      // session after that room binding has been revoked or its session was stopped.
      if (hasSessionId) {
        const { data: activeSessionRow, error: activeSessionError } = await db.from('backroom_desktop_sessions')
          .select('session_id,room_id,session_type,status,expires_at')
          .eq('session_id', input.sessionId).eq('device_id', current.device_id)
          .eq('room_id', input.roomId).maybeSingle();
        if (activeSessionError) return json(503, fail('android_session_heartbeat_lookup_failed'), origin);
        if (!activeSessionRow || activeSessionRow.session_type !== 'screen' ||
            activeSessionRow.status !== 'active' || Date.parse(activeSessionRow.expires_at) <= Date.now()) {
          if (activeSessionRow?.session_type === 'screen' && activeSessionRow.status === 'active') {
            const status = Date.parse(activeSessionRow.expires_at) <= Date.now() ? 'expired' : 'revoked';
            const { error } = await db.from('backroom_desktop_sessions')
              .update({ status, stopped_at: new Date().toISOString() })
              .eq('session_id', input.sessionId).eq('device_id', current.device_id)
              .eq('room_id', input.roomId).eq('status', 'active');
            if (error) return json(503, fail('android_session_revoke_failed'), origin);
          }
          stopSessionIds.push(input.sessionId);
        } else {
          const binding = await verifyActiveDeviceRoomBinding(current.device_id, input.roomId);
          if (!binding.ok && binding.status === 503) {
            return json(503, fail('android_session_binding_check_failed'), origin);
          }
          if (!binding.ok || binding.platform !== 'android') {
            const { error: revokeError } = await db.from('backroom_desktop_sessions')
              .update({ status: 'revoked', stopped_at: new Date().toISOString() })
              .eq('session_id', input.sessionId).eq('device_id', current.device_id)
              .eq('room_id', input.roomId).eq('status', 'active');
            if (revokeError) return json(503, fail('android_session_revoke_failed'), origin);
            const { error: commandRevokeError } = await db.from('backroom_android_commands')
              .update({ status: 'rejected', result: 'device_room_binding_revoked', lease_until: null })
              .eq('device_id', current.device_id).eq('room_id', input.roomId)
              .eq('session_id', input.sessionId).in('status', ['pending','leased']);
            if (commandRevokeError) return json(503, fail('android_session_command_revoke_failed'), origin);
            stopSessionIds.push(input.sessionId);
          } else {
            const { error: heartbeatError } = await db.from('backroom_desktop_sessions')
              .update({ expires_at: nextSessionExpiry })
              .eq('session_id', input.sessionId).eq('device_id', current.device_id)
              .eq('room_id', input.roomId).eq('status', 'active').gt('expires_at', now);
            if (heartbeatError) return json(503, fail('android_session_heartbeat_failed'), origin);
          }
        }
      }

      const retentionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { error: cleanupError } = await db.from('backroom_android_commands').delete()
        .eq('device_id', current.device_id).lt('created_at', retentionCutoff);
      if (cleanupError) return json(503, fail('android_command_cleanup_failed'), origin);
      await db.from('backroom_android_commands').delete()
        .eq('device_id', current.device_id).lt('expires_at', now).in('status', ['pending','leased']);
      const leased = [];
      const { data: pending, error: pendingError } = await db.from('backroom_android_commands')
        .select('id,request_id,session_id,room_id,command,status')
        .eq('device_id', current.device_id).eq('status', 'pending')
        .gt('expires_at', now).order('created_at', { ascending: true }).limit(8);
      if (pendingError) return json(503, fail('android_command_poll_failed'), origin);
      for (const row of pending ?? []) {
        if (row.command?.command !== 'stop_session') {
          const binding = await verifyActiveDeviceRoomBinding(current.device_id, row.room_id);
          if (!binding.ok && binding.status === 503) return json(503, fail('android_command_binding_check_failed'), origin);
          if (!binding.ok || binding.platform !== 'android') {
            await db.from('backroom_android_commands').update({ status: 'rejected', result: 'device_room_binding_revoked', lease_until: null })
              .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'pending');
            continue;
          }
          const session = await activeDesktopSession(row.session_id, current.device_id, row.room_id);
          if (!session.ok) {
            await db.from('backroom_android_commands').update({ status: 'expired', result: 'session_not_active' })
              .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'pending');
            continue;
          }
        }
        const leaseUntil = new Date(Date.now() + 60_000).toISOString();
        const { data, error } = await db.from('backroom_android_commands')
          .update({ status: 'leased', lease_until: leaseUntil })
          .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'pending')
          .is('lease_until', null).gt('expires_at', new Date().toISOString()).select('id');
        if (error) return json(503, fail('android_command_lease_failed'), origin);
        if (Array.isArray(data) && data.length === 1) {
          const mapped = mapAndroidQueuedCommand(row);
          if (mapped) leased.push(mapped);
          else await db.from('backroom_android_commands').update({ status: 'rejected', result: 'invalid_command_payload' })
            .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'leased');
        }
      }
      const { data: expiredLeases, error: leaseError } = await db.from('backroom_android_commands')
        .select('id,request_id,session_id,room_id,command,lease_until')
        .eq('device_id', current.device_id).eq('status', 'leased')
        .lt('lease_until', now).gt('expires_at', now).order('created_at', { ascending: true }).limit(8 - leased.length);
      if (leaseError) return json(503, fail('android_command_poll_failed'), origin);
      for (const row of expiredLeases ?? []) {
        if (row.command?.command !== 'stop_session') {
          const binding = await verifyActiveDeviceRoomBinding(current.device_id, row.room_id);
          if (!binding.ok && binding.status === 503) return json(503, fail('android_command_binding_check_failed'), origin);
          if (!binding.ok || binding.platform !== 'android') {
            await db.from('backroom_android_commands').update({ status: 'rejected', result: 'device_room_binding_revoked', lease_until: null })
              .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'leased');
            continue;
          }
          const session = await activeDesktopSession(row.session_id, current.device_id, row.room_id);
          if (!session.ok) {
            await db.from('backroom_android_commands').update({ status: 'expired', result: 'session_not_active', lease_until: null })
              .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'leased');
            continue;
          }
        }
        const leaseUntil = new Date(Date.now() + 60_000).toISOString();
        const { data, error } = await db.from('backroom_android_commands')
          .update({ lease_until: leaseUntil })
          .eq('id', row.id).eq('device_id', current.device_id)
          .eq('status', 'leased').eq('lease_until', row.lease_until)
          .gt('expires_at', new Date().toISOString()).select('id');
        if (error) return json(503, fail('android_command_lease_failed'), origin);
        if (Array.isArray(data) && data.length === 1) {
          const mapped = mapAndroidQueuedCommand(row);
          if (mapped) leased.push(mapped);
          else await db.from('backroom_android_commands').update({ status: 'rejected', result: 'invalid_command_payload', lease_until: null })
            .eq('id', row.id).eq('device_id', current.device_id).eq('status', 'leased');
        }
      }
      await db.from('backroom_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', current.device_id);
      return json(200, { ok: true, commands: leased, stopSessionIds }, origin);
    }

    if (action === 'android/signal') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (current.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const signal = validateAndroidSignal({
        sessionId: input.sessionId, answer: input.answer, canControl: input.canControl,
      });
      if (!signal || !exactKeys(input, ['action','sessionId','roomId','answer','canControl']) ||
          typeof input.roomId !== 'string' || !UUID.test(input.roomId)) {
        return json(400, fail('invalid_android_signal'), origin);
      }
      const binding = await verifyActiveDeviceRoomBinding(current.device_id, input.roomId);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      if (binding.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const session = await activeDesktopSession(signal.sessionId, current.device_id, input.roomId);
      if (!session.ok) return json(session.status, fail(session.reason), origin);
      if (session.session.session_type !== 'screen') return json(409, fail('android_screen_session_required'), origin);
      try {
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: current.device_id, event: 'android_signal',
          payload: { deviceId: current.device_id, roomId: input.roomId,
            sessionId: signal.sessionId, issuedAt: Date.now(),
            answer: signal.answer, canControl: signal.canControl },
        });
      } catch {
        return json(503, fail('android_signal_delivery_failed'), origin);
      }
      return json(202, { ok: true, sessionId: signal.sessionId }, origin);
    }


    if (action === 'android/session-close') {
      if (!exactKeys(input, ['action','roomId','sessionId'])) return json(400, fail('invalid_android_session_close'), origin);
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (current.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const closeRequest = validateAndroidSessionClose({ roomId: input.roomId, sessionId: input.sessionId });
      if (!closeRequest) return json(400, fail('invalid_android_session_close'), origin);
      const binding = await verifyActiveDeviceRoomBinding(current.device_id, closeRequest.roomId);
      if (!binding.ok) return json(binding.status, fail(binding.reason), origin);
      if (binding.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const { data: existing, error: lookupError } = await db.from('backroom_desktop_sessions')
        .select('session_id,status,session_type')
        .eq('session_id', closeRequest.sessionId).eq('device_id', current.device_id)
        .eq('room_id', closeRequest.roomId).maybeSingle();
      if (lookupError) return json(503, fail('android_session_close_lookup_failed'), origin);
      if (!existing || existing.session_type !== 'screen') return json(404, fail('android_screen_session_not_found'), origin);
      if (existing.status === 'active') {
        const { error } = await db.from('backroom_desktop_sessions')
          .update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', closeRequest.sessionId).eq('device_id', current.device_id)
          .eq('room_id', closeRequest.roomId).eq('status', 'active');
        if (error) return json(503, fail('android_session_close_failed'), origin);
      }
      try {
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: current.device_id, event: 'android_signal',
          payload: { deviceId: current.device_id, roomId: closeRequest.roomId,
            sessionId: closeRequest.sessionId, issuedAt: Date.now(), stop: true },
        });
      } catch { /* Session state is already stopped; the browser will also see peer closure. */ }
      return json(200, { ok: true, sessionId: closeRequest.sessionId, status: 'stopped' }, origin);
    }

    if (action === 'android/ack') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (current.platform !== 'android') return json(409, fail('android_device_required'), origin);
      const ack = validateAndroidCommandAck({
        commandId: input.commandId, requestId: input.requestId, sessionId: input.sessionId,
        result: input.result,
        ...(input.canControl !== undefined ? { canControl: input.canControl } : {}),
        ...(input.nativeWakeResult !== undefined ? { nativeWakeResult: input.nativeWakeResult } : {}),
      });
      if (!ack || !exactKeys(input, ['action','commandId','requestId','sessionId','result','canControl','nativeWakeResult'], ['action','commandId','requestId','sessionId','result'])) {
        return json(400, fail('invalid_android_ack'), origin);
      }
      const { data: row, error: lookupError } = await db.from('backroom_android_commands')
        .select('id,device_id,room_id,session_id,request_id,command,status,lease_until,expires_at,result,result_payload')
        .eq('id', ack.commandId).eq('device_id', current.device_id)
        .eq('session_id', ack.sessionId).eq('request_id', ack.requestId).maybeSingle();
      if (lookupError) return json(503, fail('android_ack_lookup_failed'), origin);
      if (!row) return json(404, fail('android_command_not_found'), origin);
      const ackBinding = await verifyActiveDeviceRoomBinding(current.device_id, row.room_id);
      if (!ackBinding.ok || ackBinding.platform !== 'android') {
        if (!ackBinding.ok && ackBinding.status === 503) return json(503, fail('android_ack_binding_check_failed'), origin);
        await db.from('backroom_android_commands')
          .update({ status: 'rejected', result: 'device_room_binding_revoked', lease_until: null })
          .eq('id', ack.commandId).eq('device_id', current.device_id)
          .in('status', ['pending','leased']);
        return json(403, fail('android_ack_room_binding_revoked'), origin);
      }

      const isControlCommand = row.command?.action === 'request_control';
      const isNativeWakeCommand = row.command?.action === 'native_wake_trigger';
      if (isNativeWakeCommand) {
        // Re-validate the immutable handoff at its issue time. The device
        // checked its 20-second expiry before execution; the independent DB
        // command lease bounds how late its completion ACK may arrive.
        const handoffIssuedAt = row.command.nativeWakeHandoff?.issuedAt;
        const handoff = validateAndroidNativeWakeHandoff(row.command.nativeWakeHandoff, {
          now: Number.isSafeInteger(handoffIssuedAt) ? handoffIssuedAt : Date.now(),
          clockSkewMs: 0,
        });
        if (!handoff || !ack.nativeWakeResult ||
            row.command.deviceId !== current.device_id ||
            row.command.roomId !== row.room_id ||
            row.command.sessionId !== row.session_id ||
            row.command.requestId !== row.request_id ||
            row.command.issuedAt !== handoff.issuedAt ||
            row.command.appPackageName !== handoff.appId ||
            ack.sessionId !== handoff.screenSessionId ||
            handoff.deviceId !== current.device_id || handoff.roomId !== row.room_id ||
            handoff.screenSessionId !== row.session_id ||
            !validateAndroidNativeWakeResult(ack.nativeWakeResult, handoff)) {
          return json(400, fail('invalid_android_native_wake_result'), origin);
        }
        const expectedResult = ack.nativeWakeResult.state === 'submitted'
          ? 'native_wake_submitted'
          : ack.nativeWakeResult.state === 'preflight_denied'
            ? 'native_wake_preflight_denied' : 'native_wake_needs_review';
        if (ack.result !== expectedResult || ack.canControl !== undefined) {
          return json(400, fail('invalid_android_native_wake_ack_state'), origin);
        }
      } else if (ack.nativeWakeResult !== undefined) {
        return json(400, fail('native_wake_result_for_non_wake_command'), origin);
      }
      const controlGranted = isControlCommand && ack.canControl === true && ack.result === 'control_granted';
      const broadcastControlResult = async () => {
        if (!isControlCommand) return;
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: current.device_id, event: 'android_response',
          payload: { deviceId: current.device_id, roomId: row.room_id,
            requestId: ack.requestId, sessionId: ack.sessionId, ok: controlGranted,
            capability: 'control', ...(controlGranted ? {} : { reason: 'local_touch_permission_missing' }) },
        });
      };
      const broadcastNativeWakeResult = async () => {
        if (!isNativeWakeCommand || !nativeWakeHandoff || !ack.nativeWakeResult) return;
        // The room Realtime event carries outcome metadata only. Exact composer /
        // Send digests remain in the service-role-only result_payload receipt.
        await broadcastPrivateDeviceEvent({
          projectUrl: url, apiKey: serviceKey, deviceId: current.device_id,
          event: 'android_native_wake_result',
          payload: {
            deviceId: current.device_id, roomId: row.room_id,
            requestId: ack.requestId, sessionId: ack.sessionId,
            handoffId: nativeWakeHandoff.handoffId, jobId: nativeWakeHandoff.jobId,
            state: ack.nativeWakeResult.state,
            ok: ack.nativeWakeResult.state === 'submitted',
            ...(ack.nativeWakeResult.reason ? { reason: ack.nativeWakeResult.reason } : {}),
          },
        });
      };
      const stableJson = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') {
          const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right));
          return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
        }
        return JSON.stringify(value) ?? 'undefined';
      };
      const sameNativeWakeResult = (left: unknown, right: unknown) =>
        stableJson(left ?? null) === stableJson(right ?? null);

      // The phone may retry an ACK after a transient HTTP/Realtime failure. Do not
      // reject a duplicate ACK: repeat the room-scoped result broadcast idempotently.
      if (row.status === 'acked') {
        if (row.result !== ack.result ||
            !sameNativeWakeResult(row.result_payload, ack.nativeWakeResult ?? null)) {
          return json(409, fail('android_ack_result_conflict'), origin);
        }
        try {
          await broadcastControlResult();
          await broadcastNativeWakeResult();
        } catch {
          return json(503, fail('android_ack_result_delivery_failed'), origin);
        }
        return json(200, { ok: true, acked: true, replayed: true }, origin);
      }
      if (row.status !== 'leased' || !row.lease_until || Date.parse(row.lease_until) <= Date.now() ||
          Date.parse(row.expires_at) <= Date.now()) {
        return json(409, fail('android_command_lease_expired'), origin);
      }

      // Publish before committing the ACK. If Realtime is temporarily unavailable,
      // the device keeps the command leased and will retry it after lease expiry.
      try {
        await broadcastControlResult();
        await broadcastNativeWakeResult();
      } catch {
        return json(503, fail(isNativeWakeCommand
          ? 'android_native_wake_result_delivery_failed'
          : 'android_control_result_delivery_failed'), origin);
      }

      const ackedAt = new Date().toISOString();
      const { data, error } = await db.from('backroom_android_commands')
        .update({
          status: 'acked', result: ack.result,
          result_payload: ack.nativeWakeResult ?? null,
          acked_at: ackedAt, lease_until: null
        })
        .eq('id', ack.commandId).eq('device_id', current.device_id)
        .eq('status', 'leased').gt('lease_until', ackedAt)
        .gt('expires_at', ackedAt).select('id');
      if (error) return json(503, fail('android_ack_failed'), origin);
      if (!Array.isArray(data) || data.length !== 1) {
        // A second delivery can win the compare-and-swap after the broadcast.
        const { data: latest } = await db.from('backroom_android_commands')
          .select('status,result').eq('id', ack.commandId).eq('device_id', current.device_id).maybeSingle();
        if (latest?.status === 'acked' && latest.result === ack.result) {
          return json(200, { ok: true, acked: true, replayed: true }, origin);
        }
        return json(409, fail('android_command_lease_expired'), origin);
      }
      if (row.command?.action === 'stop_session') {
        await db.from('backroom_desktop_sessions').update({ status: 'stopped', stopped_at: new Date().toISOString() })
          .eq('session_id', ack.sessionId).eq('device_id', current.device_id)
          .eq('room_id', row.room_id).eq('status', 'active');
      }
      return json(200, {
        ok: true, acked: true,
        ...(isNativeWakeCommand ? { nativeWakeResultStored: true } : {}),
      }, origin);
    }

    if (action === 'desktop/inventory') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (!exactKeys(input, ['action','apps']) || !validateDesktopApps(input.apps)) {
        return json(400, fail('invalid_desktop_inventory'), origin);
      }
      const { data, error } = await db.rpc('sync_backroom_desktop_apps', {
        p_device_id: current.device_id,
        p_apps: input.apps.map((app: any) => ({ app_id: app.appId, app_label: app.label.trim(), executable_sha256: app.sha256 }))
      });
      if (error) return json(409, fail('desktop_inventory_sync_failed'), origin);
      await db.from('backroom_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', current.device_id);
      return json(200, { ok: true, synced: Number(data) || 0 }, origin);
    }
    if (action === 'device/inventory') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      if (!exactKeys(input, ['action','apps']) || !validateSelectedApps(input.apps)) return json(400, fail('invalid_app_inventory'), origin);
      const { error } = await db.rpc('sync_backroom_device_apps', {
        p_device_id: current.device_id,
        p_apps: input.apps.map((app: any) => ({
          package_name: app.packageName, app_label: app.label,
          signing_certificate_sha256: app.signingCertificateSha256,
          version_name: app.versionName, draft_insertion_allowed: app.draftInsertionAllowed
        }))
      });
      if (error) return json(409, fail('inventory_sync_failed'), origin);
      await db.from('backroom_devices').update({ last_seen_at: new Date().toISOString() }).eq('device_id', current.device_id);
      return json(200, { ok: true, synced: input.apps.length }, origin);
    }

    if (action === 'device/event') {
      const current = await device(req);
      if (!current) return json(401, fail('device_not_approved'), origin);
      const event = sanitizeDeviceEvent(input);
      if (!event) return json(400, fail('invalid_device_event'), origin);
      const { data: binding, error: bindingError } = await db.from('backroom_device_room_bindings')
        .select('room_id').eq('device_id', current.device_id).is('revoked_at', null).limit(1).maybeSingle();
      if (bindingError || !binding) return json(403, fail('device_room_binding_missing'), origin);
      if (event.packageName) {
        const { data: app } = await db.from('backroom_device_apps').select('package_name')
          .eq('device_id', current.device_id).eq('package_name', event.packageName).maybeSingle();
        if (!app) return json(403, fail('app_not_selected'), origin);
      }
      const { error } = await db.from('backroom_device_events').insert({
        room_id: binding.room_id, device_id: current.device_id, actor_type: 'device',
        actor_id: current.device_id, event_type: event.eventType, package_name: event.packageName ?? null
      });
      if (error) return json(503, fail('event_write_failed'), origin);
      return json(201, { ok: true }, origin);
    }

    if (action.startsWith('owner/') || action.startsWith('room/')) {
      const ownerId = await owner(req);
      if (!ownerId) return json(401, fail('owner_auth_required'), origin);
      if (action === 'room/devices' || action === 'room/events') {
        if (!exactKeys(input, ['action','roomId']) || typeof input.roomId !== 'string' || !UUID.test(input.roomId)) {
          return json(400, fail('invalid_room_scope'), origin);
        }
        const { data: room, error: roomError } = await db.from('rooms').select('id')
          .eq('id', input.roomId).eq('owner_id', ownerId).maybeSingle();
        if (roomError) return json(503, fail('device_service_unavailable'), origin);
        if (!room) {
          const { data: member, error: memberError } = await db.from('participants').select('id')
            .eq('room_id', input.roomId).eq('user_id', ownerId).eq('kind', 'human')
            .in('status', ['active', 'connected', 'autonomous']).maybeSingle();
          if (memberError) return json(503, fail('device_membership_unavailable'), origin);
          if (!member) return json(403, fail('room_member_required'), origin);
        }
        if (action === 'room/events') {
          const { data, error } = await db.from('backroom_device_events').select('id,device_id,actor_type,actor_id,event_type,package_name,created_at')
            .eq('room_id', input.roomId).order('created_at', { ascending: false }).limit(100);
          if (error) return json(503, fail('device_events_unavailable'), origin);
          return json(200, { ok: true, events: data ?? [] }, origin);
        }
        const { data: bindings, error: bindingError } = await db.from('backroom_device_room_bindings')
          .select('device_id').eq('room_id', input.roomId);
        if (bindingError) return json(503, fail('device_list_unavailable'), origin);
        const ids = [...new Set((bindings ?? []).map((item: any) => item.device_id))];
        if (!ids.length) return json(200, { ok: true, devices: [] }, origin);
        const [devices, apps, desktopApps] = await Promise.all([
          db.from('backroom_devices').select('device_id,device_label,platform,os_version,app_version,status,capabilities,created_at,approved_at,last_seen_at')
            .in('device_id', ids).order('created_at', { ascending: false }),
          db.from('backroom_device_apps').select('device_id,package_name,app_label,version_name,draft_insertion_allowed,discovered_at')
            .in('device_id', ids).order('app_label', { ascending: true }),
          db.from('backroom_desktop_apps').select('device_id,app_id,app_label,executable_sha256,discovered_at')
            .in('device_id', ids).order('app_label', { ascending: true })
        ]);
        if (devices.error || apps.error || desktopApps.error) return json(503, fail('device_list_unavailable'), origin);
        return json(200, { ok: true, devices: (devices.data ?? []).map((d: any) => ({
          ...d,
          apps: (apps.data ?? []).filter((app: any) => app.device_id === d.device_id),
          desktopApps: (desktopApps.data ?? []).filter((app: any) => app.device_id === d.device_id)
        })) }, origin);
      }
      if (action === 'owner/approve' || action === 'owner/revoke') {
        if (!exactKeys(input, ['action','deviceId','roomId']) || typeof input.deviceId !== 'string' || !UUID.test(input.deviceId) ||
          typeof input.roomId !== 'string' || !UUID.test(input.roomId)) return json(400, fail('invalid_device_scope'), origin);
        const { data: binding, error: bindingError } = await db.from('backroom_device_room_bindings')
          .select('device_id,room_id,owner_id').eq('device_id', input.deviceId).eq('room_id', input.roomId).eq('owner_id', ownerId).is('revoked_at', null).maybeSingle();
        if (bindingError || !binding) return json(404, fail('device_binding_not_found'), origin);
        const now = new Date().toISOString();
        if (action === 'owner/approve') {
          const { data, error } = await db.rpc('approve_backroom_device', {
            p_device_id: input.deviceId, p_room_id: input.roomId, p_owner_id: ownerId
          });
          if (error) return json(503, fail('device_approval_failed'), origin);
          if (data !== true) return json(409, fail('device_not_pending_or_owner_scope_invalid'), origin);
          return json(200, { ok: true, deviceId: input.deviceId, status: 'active' }, origin);
        }
        const { data, error } = await db.rpc('revoke_backroom_device', {
          p_device_id: input.deviceId, p_room_id: input.roomId, p_owner_id: ownerId
        });
        if (error) return json(503, fail('device_revocation_failed'), origin);
        if (data !== true) return json(404, fail('device_not_found_or_owner_scope_invalid'), origin);
        const revokedAt = new Date().toISOString();
        await db.from('backroom_desktop_sessions').update({ status: 'revoked', stopped_at: revokedAt })
          .eq('device_id', input.deviceId).eq('room_id', input.roomId).eq('status', 'active');
        let notificationSent = false;
        try {
          await broadcastPrivateDeviceEvent({
            projectUrl: url, apiKey: serviceKey, deviceId: input.deviceId,
            event: 'device_revoked',
            payload: { deviceId: input.deviceId, roomId: input.roomId, status: 'revoked', issuedAt: Date.now() },
          });
          notificationSent = true;
        } catch { /* The companion's low-frequency status fallback remains authoritative. */ }
        return json(200, { ok: true, deviceId: input.deviceId, status: 'revoked', notificationSent }, origin);
      }
    }
    return json(404, fail('unknown_action'), origin);
  } catch {
    return json(503, fail('device_service_unavailable'), origin);
  }
});
