-- Persistent original-session imports and evolving room memory.
-- Imported conversation context is private by default; only explicitly promoted
-- memory entries become visible to other room participants.

create table if not exists public.room_session_imports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_version integer not null default 1 check (document_version = 1),
  source_platform text not null check (char_length(source_platform) between 1 and 80),
  title text not null default 'Imported AI session' check (char_length(title) between 1 and 160),
  context_summary text not null default '' check (char_length(context_summary) <= 20000),
  imported_context jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(imported_context::text) <= 1048576)
);

create index if not exists room_session_imports_room_participant_idx
  on public.room_session_imports(room_id, participant_id, created_at desc);

create table if not exists public.room_memory_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  source_import_id uuid references public.room_session_imports(id) on delete set null,
  created_by_participant_id uuid references public.participants(id) on delete set null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  entry_type text not null check (entry_type in ('goal','insight','decision','open_question','progress','summary')),
  visibility text not null default 'private' check (visibility in ('private','group')),
  content text not null check (char_length(content) between 1 and 12000),
  source_message_ids uuid[] not null default '{}'::uuid[],
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists room_memory_entries_room_visibility_updated_idx
  on public.room_memory_entries(room_id, visibility, updated_at desc);

create unique index if not exists room_memory_entries_participant_idempotency_idx
  on public.room_memory_entries(created_by_participant_id, idempotency_key)
  where idempotency_key is not null;

alter table public.room_session_imports enable row level security;
alter table public.room_memory_entries enable row level security;

-- Raw imported history is private to the importing account. Do not make an
-- entire original conversation visible to the group by default.
drop policy if exists "session_import_owner_select" on public.room_session_imports;
create policy "session_import_owner_select"
  on public.room_session_imports for select to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_session_imports.participant_id
        and p.room_id = room_session_imports.room_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "session_import_owner_insert" on public.room_session_imports;
create policy "session_import_owner_insert"
  on public.room_session_imports for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = participant_id
        and p.room_id = room_session_imports.room_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "session_import_owner_update" on public.room_session_imports;
create policy "session_import_owner_update"
  on public.room_session_imports for update to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_session_imports.participant_id
        and p.room_id = room_session_imports.room_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_session_imports.participant_id
        and p.room_id = room_session_imports.room_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "session_import_owner_delete" on public.room_session_imports;
create policy "session_import_owner_delete"
  on public.room_session_imports for delete to authenticated
  using (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_session_imports.participant_id
        and p.room_id = room_session_imports.room_id
        and p.user_id = (select auth.uid())
    )
  );

-- All authenticated participants in a room may read group-visible memory.
-- Private memory remains visible only to its owner. Service-role Edge Functions
-- can maintain entries after authenticating a scoped AI connection.
drop policy if exists "room_memory_participant_select" on public.room_memory_entries;
create policy "room_memory_participant_select"
  on public.room_memory_entries for select to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = room_memory_entries.created_by_participant_id
        and p.room_id = room_memory_entries.room_id
        and p.user_id = (select auth.uid())
    )
    or (
      visibility = 'group'
      and exists (
        select 1 from public.participants p
        where p.room_id = room_memory_entries.room_id
          and p.user_id = (select auth.uid())
          and p.status in ('connected','active','autonomous')
      )
    )
  );

drop policy if exists "room_memory_owner_insert" on public.room_memory_entries;
create policy "room_memory_owner_insert"
  on public.room_memory_entries for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_memory_entries.created_by_participant_id
        and p.room_id = room_memory_entries.room_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "room_memory_owner_update" on public.room_memory_entries;
create policy "room_memory_owner_update"
  on public.room_memory_entries for update to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = room_memory_entries.created_by_participant_id
        and p.room_id = room_memory_entries.room_id
        and p.user_id = (select auth.uid())
    )
  )
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from public.participants p
      where p.id = room_memory_entries.created_by_participant_id
        and p.room_id = room_memory_entries.room_id
        and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "room_memory_owner_delete" on public.room_memory_entries;
create policy "room_memory_owner_delete"
  on public.room_memory_entries for delete to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = room_memory_entries.created_by_participant_id
        and p.room_id = room_memory_entries.room_id
        and p.user_id = (select auth.uid())
    )
  );

comment on table public.room_session_imports is
  'Private-by-default, versioned import of an AI original-session memory document.';
comment on column public.room_session_imports.imported_context is
  'Bounded JSON document. Never group-visible by default; promote only selected insights to room_memory_entries.';
comment on table public.room_memory_entries is
  'Structured evolving room memory; group visibility must be explicitly chosen.';
