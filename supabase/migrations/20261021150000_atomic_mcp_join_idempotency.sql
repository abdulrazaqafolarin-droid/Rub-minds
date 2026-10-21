-- Durable idempotency for hosted MCP invitation redemption.
-- This table stores only digests and IDs; it never stores a plaintext AI credential.
create table if not exists public.rub_minds_mcp_join_requests (
  session_digest text primary key check (length(session_digest) = 64 and session_digest !~ '[^a-f0-9]'),
  invite_token_hash text not null check (length(invite_token_hash) = 64 and invite_token_hash !~ '[^a-f0-9]'),
  agent_label text not null check (char_length(agent_label) between 1 and 80),
  credential_digest text not null check (length(credential_digest) = 64 and credential_digest !~ '[^a-f0-9]'),
  room_id uuid not null,
  participant_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.rub_minds_mcp_join_requests enable row level security;
revoke all on table public.rub_minds_mcp_join_requests from public, anon, authenticated;
grant all on table public.rub_minds_mcp_join_requests to service_role;
create index if not exists rub_minds_mcp_join_requests_expiry_idx
  on public.rub_minds_mcp_join_requests (expires_at);

-- The application derives a distinct, deterministic credential using a server-only
-- key and the MCP handle. The function receives only its SHA-256 digest. A per-handle
-- advisory transaction lock makes duplicate/retried requests share one redemption.
create or replace function public.redeem_ai_room_invite_idempotent(
  p_invite_token text,
  p_agent_label text,
  p_session_digest text,
  p_credential_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $mcp$
declare
  inv public.room_invites%rowtype;
  prior public.rub_minds_mcp_join_requests%rowtype;
  agent_id uuid;
  expires timestamptz;
  invite_hash text;
  normalized_label text;
begin
  if p_invite_token is null or p_invite_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid invitation';
  end if;
  if p_agent_label is null or char_length(btrim(p_agent_label)) not between 1 and 80 then
    raise exception 'Invalid agent name';
  end if;
  if p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
     or p_credential_digest is null or p_credential_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid idempotency credentials';
  end if;

  normalized_label := btrim(p_agent_label);
  invite_hash := encode(sha256(convert_to(p_invite_token, 'UTF8')), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_session_digest, 0));

  select * into prior
  from public.rub_minds_mcp_join_requests
  where session_digest = p_session_digest;

  if found then
    if prior.invite_token_hash <> invite_hash
       or prior.agent_label <> normalized_label
       or prior.credential_digest <> p_credential_digest then
      raise exception 'Join idempotency key conflicts with an earlier request';
    end if;
    if prior.expires_at <= pg_catalog.now() then
      raise exception 'This idempotent join has expired; start a new join request';
    end if;
    if not exists (
      select 1 from public.agent_connections c
      where c.credential_digest = prior.credential_digest
        and c.room_id = prior.room_id
        and c.participant_id = prior.participant_id
        and c.revoked_at is null
        and c.expires_at > pg_catalog.now()
    ) then
      raise exception 'This idempotent join has been revoked or expired';
    end if;
    return jsonb_build_object(
      'room_id', prior.room_id,
      'participant_id', prior.participant_id,
      'expires_at', prior.expires_at,
      'replayed', true
    );
  end if;

  select * into inv
  from public.room_invites
  where token_hash = invite_hash
  for update;

  if not found or inv.revoked_at is not null or inv.expires_at <= pg_catalog.now() then
    raise exception 'Invitation expired or unavailable';
  end if;
  if not inv.allow_ai or inv.max_ai_uses < 1 or inv.ai_uses >= inv.max_ai_uses then
    raise exception 'This invitation does not allow more AI participants';
  end if;

  expires := least(inv.expires_at, pg_catalog.now() + interval '7 days');
  insert into public.participants(room_id, display_name, kind, status)
  values (inv.room_id, normalized_label, 'external_agent', 'waiting')
  returning id into agent_id;

  insert into public.agent_connections(room_id, participant_id, owner_id, credential_digest, expires_at)
  values (inv.room_id, agent_id, inv.created_by, p_credential_digest, expires);

  insert into public.rub_minds_mcp_join_requests(
    session_digest, invite_token_hash, agent_label, credential_digest,
    room_id, participant_id, expires_at
  ) values (
    p_session_digest, invite_hash, normalized_label, p_credential_digest,
    inv.room_id, agent_id, expires
  );

  update public.room_invites set ai_uses = ai_uses + 1 where id = inv.id;

  return jsonb_build_object(
    'room_id', inv.room_id,
    'participant_id', agent_id,
    'expires_at', expires,
    'replayed', false
  );
end;
$mcp$;

revoke all on function public.redeem_ai_room_invite_idempotent(text, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_ai_room_invite_idempotent(text, text, text, text) to service_role;
