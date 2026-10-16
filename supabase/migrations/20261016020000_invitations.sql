-- Secure invitations: hashed tokens, owner issuance, authenticated redemption.
create table public.room_invites (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 created_by uuid not null references auth.users(id) on delete cascade,
 token_hash text not null unique,
 expires_at timestamptz not null,
 max_uses integer not null default 10 check (max_uses between 1 and 100),
 uses integer not null default 0 check (uses >= 0),
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create index room_invites_room_idx on public.room_invites(room_id);
alter table public.room_invites enable row level security;
create policy "owner reads invite metadata" on public.room_invites for select to authenticated
 using (exists (select 1 from public.rooms r where r.id=room_id and r.owner_id=(select auth.uid())));
create or replace function public.create_room_invite(target_room uuid, valid_hours integer default 24, allowed_uses integer default 10)
returns text language plpgsql security definer set search_path = ''
as $$
declare token text;
begin
 if auth.uid() is null or not exists (select 1 from public.rooms r where r.id=target_room and r.owner_id=auth.uid()) then
   raise exception 'Only room owners can invite';
 end if;
 if valid_hours not between 1 and 168 or allowed_uses not between 1 and 100 then
   raise exception 'Invalid invite limits';
 end if;
 token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 insert into public.room_invites(room_id,created_by,token_hash,expires_at,max_uses)
 values(target_room,auth.uid(),encode(sha256(convert_to(token,'UTF8')),'hex'),now()+make_interval(hours=>valid_hours),allowed_uses);
 return token;
end;
$$;
revoke all on function public.create_room_invite(uuid,integer,integer) from public;
grant execute on function public.create_room_invite(uuid,integer,integer) to authenticated;
create or replace function public.redeem_room_invite(invite_token text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare invite_row public.room_invites%rowtype;
begin
 if auth.uid() is null then raise exception 'Sign in to join'; end if;
 if invite_token is null or invite_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation'; end if;
 select * into invite_row from public.room_invites
 where token_hash=encode(sha256(convert_to(invite_token,'UTF8')),'hex')
 for update;
 if not found or invite_row.revoked_at is not null or invite_row.expires_at<=now() or invite_row.uses>=invite_row.max_uses then
   raise exception 'Invitation expired or unavailable';
 end if;
 if exists (select 1 from public.participants p where p.room_id=invite_row.room_id and p.user_id=auth.uid()) then
   return invite_row.room_id;
 end if;
 insert into public.participants(room_id,user_id,display_name,kind,status)
 values(invite_row.room_id,auth.uid(),'Member','human','connected');
 update public.room_invites set uses=uses+1 where id=invite_row.id;
 return invite_row.room_id;
end;
$$;
revoke all on function public.redeem_room_invite(text) from public;
grant execute on function public.redeem_room_invite(text) to authenticated;
