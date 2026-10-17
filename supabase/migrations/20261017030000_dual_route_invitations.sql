-- Dual-route invitations: human auth remains account-bound; AI joins are explicit,
-- separately capped, and receive an independent room-scoped credential.
alter table public.room_invites
  add column if not exists allow_ai boolean not null default false,
  add column if not exists max_ai_uses integer not null default 0 check (max_ai_uses between 0 and 20),
  add column if not exists ai_uses integer not null default 0 check (ai_uses >= 0);

create or replace function public.create_dual_room_invite(
  target_room uuid,
  valid_hours integer default 24,
  allowed_uses integer default 10,
  allow_ai_participants boolean default false,
  allowed_ai_uses integer default 0
)
returns text language plpgsql security definer set search_path = ''
as $$
declare token text;
begin
 if auth.uid() is null or not exists (
   select 1 from public.rooms r where r.id=target_room and r.owner_id=auth.uid()
 ) then raise exception 'Only room owners can invite'; end if;
 if valid_hours not between 1 and 168 or allowed_uses not between 1 and 100 then
   raise exception 'Invalid human invitation limits';
 end if;
 if allowed_ai_uses not between 0 and 20 or (not allow_ai_participants and allowed_ai_uses <> 0)
   or (allow_ai_participants and allowed_ai_uses < 1) then
   raise exception 'Invalid AI invitation limits';
 end if;
 token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 insert into public.room_invites(room_id,created_by,token_hash,expires_at,max_uses,allow_ai,max_ai_uses)
 values(target_room,auth.uid(),encode(sha256(convert_to(token,'UTF8')),'hex'),
        now()+make_interval(hours=>valid_hours),allowed_uses,allow_ai_participants,allowed_ai_uses);
 return token;
end;
$$;
revoke all on function public.create_dual_room_invite(uuid,integer,integer,boolean,integer) from public, anon;
grant execute on function public.create_dual_room_invite(uuid,integer,integer,boolean,integer) to authenticated;

create or replace function public.redeem_ai_room_invite(invite_token text, agent_label text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare inv public.room_invites%rowtype; agent_id uuid; secret text; expires timestamptz;
begin
 if invite_token is null or invite_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation'; end if;
 if agent_label is null or char_length(btrim(agent_label)) not between 1 and 80 then raise exception 'Invalid agent name'; end if;
 select * into inv from public.room_invites
 where token_hash=encode(sha256(convert_to(invite_token,'UTF8')),'hex')
 for update;
 if not found or inv.revoked_at is not null or inv.expires_at<=now() then
   raise exception 'Invitation expired or unavailable';
 end if;
 if not inv.allow_ai or inv.max_ai_uses < 1 or inv.ai_uses >= inv.max_ai_uses then
   raise exception 'This invitation does not allow more AI participants';
 end if;
 secret := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 expires := least(inv.expires_at, now()+interval '7 days');
 insert into public.participants(room_id,display_name,kind,status)
 values(inv.room_id,btrim(agent_label),'external_agent','waiting') returning id into agent_id;
 insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at)
 values(inv.room_id,agent_id,inv.created_by,encode(sha256(convert_to(secret,'UTF8')),'hex'),expires);
 update public.room_invites set ai_uses=ai_uses+1 where id=inv.id;
 return jsonb_build_object('room_id',inv.room_id,'participant_id',agent_id,'agent_secret',secret,'expires_at',expires);
end;
$$;
revoke all on function public.redeem_ai_room_invite(text,text) from public;
grant execute on function public.redeem_ai_room_invite(text,text) to anon, authenticated, service_role;

create or replace function public.revoke_dual_room_invite(invite_token text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare affected integer;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if invite_token is null or invite_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation'; end if;
 update public.room_invites i set revoked_at=now()
 where i.token_hash=encode(sha256(convert_to(invite_token,'UTF8')),'hex')
   and i.revoked_at is null
   and exists (select 1 from public.rooms r where r.id=i.room_id and r.owner_id=auth.uid());
 get diagnostics affected = row_count;
 return affected > 0;
end;
$$;
revoke all on function public.revoke_dual_room_invite(text) from public, anon;
grant execute on function public.revoke_dual_room_invite(text) to authenticated;
