/**
 * Cloud-connected Backroom device registration and selected-app inventory.
 * Android calls this function over outbound HTTPS; no phone or desktop port
 * listener is created. This endpoint intentionally does not execute OS actions.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolveOwnerFromJwt } from '../../../integrations/backroom/owner-jwt.mjs';
import { sanitizeDeviceEvent, validatePairClaim, validateSelectedApps } from '../../../integrations/backroom/cloud-device-protocol.mjs';

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

    if (action.startsWith('owner/')) {
      const ownerId = await owner(req);
      if (!ownerId) return json(401, fail('owner_auth_required'), origin);
      if (action === 'owner/list' || action === 'owner/events') {
        if (!exactKeys(input, ['action','roomId']) || typeof input.roomId !== 'string' || !UUID.test(input.roomId)) {
          return json(400, fail('invalid_room_scope'), origin);
        }
        const { data: room, error: roomError } = await db.from('rooms').select('id')
          .eq('id', input.roomId).eq('owner_id', ownerId).maybeSingle();
        if (roomError) return json(503, fail('device_service_unavailable'), origin);
        if (action === 'owner/events' && !room) {
          const { data: member, error: memberError } = await db.from('participants').select('id')
            .eq('room_id', input.roomId).eq('user_id', ownerId).maybeSingle();
          if (memberError) return json(503, fail('device_events_unavailable'), origin);
          if (!member) return json(403, fail('room_member_required'), origin);
        } else if (!room) return json(403, fail('room_owner_required'), origin);
        if (action === 'owner/events') {
          const { data, error } = await db.from('backroom_device_events').select('id,device_id,actor_type,actor_id,event_type,package_name,created_at')
            .eq('room_id', input.roomId).order('created_at', { ascending: false }).limit(100);
          if (error) return json(503, fail('device_events_unavailable'), origin);
          return json(200, { ok: true, events: data ?? [] }, origin);
        }
        const { data: bindings, error: bindingError } = await db.from('backroom_device_room_bindings')
          .select('device_id').eq('room_id', input.roomId).is('revoked_at', null);
        if (bindingError) return json(503, fail('device_list_unavailable'), origin);
        const ids = [...new Set((bindings ?? []).map((item: any) => item.device_id))];
        if (!ids.length) return json(200, { ok: true, devices: [] }, origin);
        const [devices, apps] = await Promise.all([
          db.from('backroom_devices').select('device_id,device_label,platform,os_version,app_version,status,capabilities,created_at,approved_at,last_seen_at')
            .eq('owner_id', ownerId).in('device_id', ids).order('created_at', { ascending: false }),
          db.from('backroom_device_apps').select('device_id,package_name,app_label,version_name,draft_insertion_allowed,discovered_at')
            .in('device_id', ids).order('app_label', { ascending: true })
        ]);
        if (devices.error || apps.error) return json(503, fail('device_list_unavailable'), origin);
        return json(200, { ok: true, devices: (devices.data ?? []).map((d: any) => ({
          ...d, apps: (apps.data ?? []).filter((app: any) => app.device_id === d.device_id)
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
        return json(200, { ok: true, deviceId: input.deviceId, status: 'revoked' }, origin);
      }
    }
    return json(404, fail('unknown_action'), origin);
  } catch {
    return json(503, fail('device_service_unavailable'), origin);
  }
});
