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
import { broadcastPrivateDeviceEvent } from './realtime-broadcast.mjs';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('Backroom device backend configuration missing');
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const allowedOrigins = new Set((Deno.env.get('BACKROOM_DEVICE_ALLOWED_ORIGINS') ?? 'https://rub-minds.vercel.app')
  .split(',').map(value => value.trim()).filter(Boolean));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}
async function owner(req: Request) {
  return await resolveOwnerFromJwt(req, token => db.auth.getUser(token));
}
async function device(req: Request, allowPending = false, allowRevoked = false) {
  const token = bearerPattern.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  const digest = await sha256(token);
  const { data, error } = await db.from('backroom_devices')
    .select('device_id,owner_id,device_label,status,capabilities')
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
    ? participant.display_name.replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, '').trim().slice(0, 80)
    : '';
  return { ok: true as const, userId, displayName: displayName || 'Group member' };
}
async function verifyActiveDeviceRoomBinding(deviceId: string, roomId: string) {
  const [{ data: deviceRow, error: deviceError }, { data: binding, error: bindingError }] = await Promise.all([
    db.from('backroom_devices').select('device_id,status').eq('device_id', deviceId).eq('status', 'active').maybeSingle(),
    db.from('backroom_device_room_bindings').select('device_id,room_id')
      .eq('device_id', deviceId).eq('room_id', roomId).is('revoked_at', null).maybeSingle(),
  ]);
  if (deviceError || bindingError) return { ok: false as const, status: 503, reason: 'device_authorization_unavailable' };
  if (!deviceRow || !binding) return { ok: false as const, status: 404, reason: 'active_device_binding_not_found' };
  return { ok: true as const };
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
        if (command.command === 'stop_session') {
          const { error } = await db.from('backroom_desktop_sessions')
            .update({ status: 'stopped', stopped_at: new Date().toISOString() })
            .eq('session_id', command.details.sessionId).eq('device_id', command.deviceId)
            .eq('room_id', command.roomId).eq('status', 'active');
          if (error) return json(503, fail('desktop_session_stop_failed'), origin);
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
