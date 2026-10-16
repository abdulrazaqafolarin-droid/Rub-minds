-- Rub Minds initial authenticated group schema.
-- Apply using Supabase SQL editor or migrations after creating a project.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  objective text not null default '' check (char_length(objective) <= 500),
  created_at timestamptz not null default now()
);
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  kind text not null check (kind in ('human','original_session','model','external_agent')),
  status text not null default 'waiting' check (status in ('waiting','connected','active','autonomous','disconnected','failed')),
  created_at timestamptz not null default now(),
  unique (room_id,user_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references public.participants(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 10000),
  source_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists participants_room_idx on public.participants(room_id);
create index if not exists messages_room_time_idx on public.messages(room_id,created_at,id);
create unique index if not exists messages_source_dedupe_idx on public.messages(sender_id,source_message_id) where source_message_id is not null;

alter table public.rooms enable row level security;
alter table public.participants enable row level security;
alter table public.messages enable row level security;

-- Security definer helper avoids recursive membership RLS policy evaluation.
create or replace function public.is_room_member(target_room uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.participants p where p.room_id = target_room and p.user_id = (select auth.uid())) $$;
revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;

create policy "read joined rooms" on public.rooms for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_room_member(id));
create policy "create owned rooms" on public.rooms for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "update owned rooms" on public.rooms for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "delete owned rooms" on public.rooms for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "read joined participants" on public.participants for select to authenticated
  using (public.is_room_member(room_id) or exists (select 1 from public.rooms r where r.id = room_id and r.owner_id = (select auth.uid())));
-- Membership creation must go through trusted server-side onboarding / invitation redemption.
-- No direct participant INSERT policy is granted to clients.

create policy "read joined messages" on public.messages for select to authenticated
  using (public.is_room_member(room_id));
create policy "post as self" on public.messages for insert to authenticated
  with check (
    public.is_room_member(room_id)
    and exists (
      select 1 from public.participants p
      where p.id = sender_id and p.room_id = messages.room_id
        and p.user_id = (select auth.uid()) and p.kind = 'human'
    )
  );

-- Atomically creates a room and owner membership. This is the only MVP membership creation path.
create or replace function public.create_room_with_owner(room_title text, room_objective text default '')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(btrim(room_title)) not between 1 and 80 or char_length(room_objective) > 500 then
    raise exception 'Invalid room data';
  end if;
  insert into public.rooms(owner_id,title,objective)
    values (auth.uid(),btrim(room_title),coalesce(room_objective,'')) returning id into new_id;
  insert into public.participants(room_id,user_id,display_name,kind,status)
    values (new_id,auth.uid(),'Owner','human','connected');
  return new_id;
end;
$$;
revoke all on function public.create_room_with_owner(text,text) from public;
grant execute on function public.create_room_with_owner(text,text) to authenticated;

-- Future migration: hashed, expiring invitations and server-authorized agent credentials.
-- Never publish a service_role key to browser code.
