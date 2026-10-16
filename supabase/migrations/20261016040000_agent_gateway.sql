create table public.agent_connections (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.rooms(id) on delete cascade,
 participant_id uuid not null unique references public.participants(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 credential_digest text not null unique,
 expires_at timestamptz not null,
 revoked_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.agent_connections enable row level security;
create policy "room owner sees agent connections" on public.agent_connections for select to authenticated using (owner_id=(select auth.uid()));
create or replace function public.connect_external_agent(target_room uuid, agent_label text)
returns text language plpgsql security definer set search_path = ''
as $$
declare secret text; agent_id uuid;
begin
 if auth.uid() is null or not exists (select 1 from public.rooms where id=target_room and owner_id=auth.uid()) then raise exception 'Only the room owner may connect an agent'; end if;
 if agent_label is null or char_length(btrim(agent_label)) not between 1 and 80 then raise exception 'Invalid agent name'; end if;
 insert into public.participants(room_id,display_name,kind,status) values(target_room,btrim(agent_label),'external_agent','waiting') returning id into agent_id;
 secret := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
 insert into public.agent_connections(room_id,participant_id,owner_id,credential_digest,expires_at)
 values(target_room,agent_id,auth.uid(),encode(sha256(convert_to(secret,'UTF8')),'hex'),now()+interval '7 days');
 return secret;
end;
$$;
revoke all on function public.connect_external_agent(uuid,text) from public, anon;
grant execute on function public.connect_external_agent(uuid,text) to authenticated;
create or replace function public.agent_exchange(agent_secret text, operation text, payload text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare connection public.agent_connections%rowtype; message_id uuid; result jsonb;
begin
 if agent_secret is null or agent_secret !~ '^[0-9a-f]{64}$' then raise exception 'Invalid credential'; end if;
 select * into connection from public.agent_connections where credential_digest=encode(sha256(convert_to(agent_secret,'UTF8')),'hex') and revoked_at is null and expires_at>now();
 if not found then raise exception 'Invalid credential'; end if;
 if operation='read' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at),'[]'::jsonb) into result
  from (select m.id,m.sender_id,m.body,m.created_at from public.messages m where m.room_id=connection.room_id order by m.created_at desc limit 50) t;
  return jsonb_build_object('room_id',connection.room_id,'participant_id',connection.participant_id,'messages',result);
 elsif operation='send' then
  if payload is null or char_length(btrim(payload)) not between 1 and 10000 then raise exception 'Invalid message'; end if;
  insert into public.messages(room_id,sender_id,body) values(connection.room_id,connection.participant_id,btrim(payload)) returning id into message_id;
  update public.participants set status='active' where id=connection.participant_id;
  return jsonb_build_object('room_id',connection.room_id,'message_id',message_id);
 else raise exception 'Unknown operation'; end if;
end;
$$;
revoke all on function public.agent_exchange(text,text,text) from public, anon, authenticated;
grant execute on function public.agent_exchange(text,text,text) to service_role;
