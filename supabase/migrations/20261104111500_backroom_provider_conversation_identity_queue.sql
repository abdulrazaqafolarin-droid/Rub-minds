-- Persist an opaque provider-conversation digest with each native wake binding/job.
-- Never store raw provider chat IDs, titles, cookies, conversation content or histories.
alter table public.backroom_input_bindings
  add column if not exists provider_conversation_identity_digest text;
alter table public.backroom_wake_jobs
  add column if not exists provider_conversation_identity_digest text;

-- Reconcile only from the exact server-owned binding that created the job.
update public.backroom_wake_jobs j
set provider_conversation_identity_digest=b.provider_conversation_identity_digest
from public.backroom_input_bindings b
where b.id=j.binding_id
  and b.owner_id=j.owner_id and b.room_id=j.room_id
  and b.participant_id=j.participant_id and b.host_id=j.host_id
  and b.session_digest=j.session_digest and b.space_id=j.space_id
  and b.session_id=j.session_id and b.target_id=j.target_id
  and b.target_identity_fingerprint=j.target_identity_fingerprint
  and b.target_revision=j.target_revision
  and j.provider_conversation_identity_digest is distinct from b.provider_conversation_identity_digest;

-- Old native work without a verifiable provider conversation is not safe to replay.
update public.backroom_wake_jobs j
set state='cancelled',lease_owner=null,lease_token_hash=null,lease_expires_at=null,
    last_error_code='authorization_denied',updated_at=pg_catalog.clock_timestamp()
from public.backroom_input_bindings b
where b.id=j.binding_id and b.surface in ('desktop_app','windows_app','android_app')
  and j.provider_conversation_identity_digest is null
  and j.state in ('pending','leased');

-- Existing native bindings without a digest lose wake consent and need explicit rebind.
update public.backroom_input_bindings
set wake_last_revoked_grant_id=wake_grant_id,wake_enabled=false,wake_grant_id=null,
    confirmed_at=null,wake_expires_at=null,updated_at=pg_catalog.clock_timestamp()
where surface in ('desktop_app','windows_app','android_app')
  and wake_enabled=true and provider_conversation_identity_digest is null;

do $constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.backroom_input_bindings'::regclass
        and conname='backroom_binding_provider_conversation_digest_check') then
    alter table public.backroom_input_bindings
      add constraint backroom_binding_provider_conversation_digest_check
      check (provider_conversation_identity_digest is null
        or provider_conversation_identity_digest ~ '^[a-f0-9]{64}$');
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.backroom_input_bindings'::regclass
        and conname='backroom_native_binding_requires_provider_conversation_check') then
    alter table public.backroom_input_bindings
      add constraint backroom_native_binding_requires_provider_conversation_check
      check (surface not in ('desktop_app','windows_app','android_app')
        or wake_enabled=false or provider_conversation_identity_digest is not null);
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.backroom_wake_jobs'::regclass
        and conname='backroom_wake_job_provider_conversation_digest_check') then
    alter table public.backroom_wake_jobs
      add constraint backroom_wake_job_provider_conversation_digest_check
      check (provider_conversation_identity_digest is null
        or provider_conversation_identity_digest ~ '^[a-f0-9]{64}$');
  end if;
end;
$constraints$;

create or replace function public.sync_backroom_wake_job_provider_identity()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
begin
  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=new.binding_id and b.owner_id=new.owner_id
    and b.room_id=new.room_id and b.participant_id=new.participant_id
    and b.host_id=new.host_id and b.session_digest=new.session_digest
    and b.space_id=new.space_id and b.session_id=new.session_id
    and b.target_id=new.target_id
    and b.target_identity_fingerprint=new.target_identity_fingerprint
    and b.target_revision=new.target_revision;

  if not found then
    raise exception 'Backroom wake job does not match an exact registered input binding';
  end if;
  if new.provider_conversation_identity_digest is not null
    and new.provider_conversation_identity_digest is distinct from v_binding.provider_conversation_identity_digest then
    raise exception 'Backroom wake provider-conversation digest does not match its binding';
  end if;
  if v_binding.surface in ('desktop_app','windows_app','android_app')
    and v_binding.provider_conversation_identity_digest is null then
    raise exception 'Native wake requires a registered provider-conversation identity digest';
  end if;
  new.provider_conversation_identity_digest:=v_binding.provider_conversation_identity_digest;
  return new;
end;
$function$;

revoke all on function public.sync_backroom_wake_job_provider_identity()
  from public,anon,authenticated;
grant execute on function public.sync_backroom_wake_job_provider_identity() to service_role;

drop trigger if exists backroom_wake_job_provider_identity_trigger on public.backroom_wake_jobs;
create trigger backroom_wake_job_provider_identity_trigger
before insert or update on public.backroom_wake_jobs
for each row execute function public.sync_backroom_wake_job_provider_identity();

-- Backwards-compatible claim response extension. Existing managed-browser workers
-- may keep calling claim_backroom_wake_jobs; the provider-aware Edge worker opts in.
create or replace function public.claim_backroom_wake_jobs_with_provider_identity(
  p_host_id text,p_session_digest text,p_binding_id uuid,
  p_limit integer default 5,p_lease_seconds integer default 30
)
returns table (
  out_job_id uuid,out_job_key text,out_event_id text,out_owner_id uuid,
  out_room_id uuid,out_participant_id uuid,out_space_id text,out_session_id text,
  out_binding_id text,out_target_id text,out_target_identity_fingerprint text,
  out_target_revision integer,out_prompt text,out_prompt_digest text,
  out_attempt_count integer,out_expires_at timestamptz,out_lease_token text,
  out_provider_conversation_identity_digest text
)
language sql
security definer
set search_path=''
as $function$
  select c.out_job_id,c.out_job_key,c.out_event_id,c.out_owner_id,
    c.out_room_id,c.out_participant_id,c.out_space_id,c.out_session_id,
    c.out_binding_id,c.out_target_id,c.out_target_identity_fingerprint,
    c.out_target_revision,c.out_prompt,c.out_prompt_digest,c.out_attempt_count,
    c.out_expires_at,c.out_lease_token,j.provider_conversation_identity_digest
  from public.claim_backroom_wake_jobs(
    p_host_id,p_session_digest,p_binding_id,p_limit,p_lease_seconds
  ) c
  join public.backroom_wake_jobs j on j.id=c.out_job_id;
$function$;

revoke all on function public.claim_backroom_wake_jobs_with_provider_identity(text,text,uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function public.claim_backroom_wake_jobs_with_provider_identity(text,text,uuid,integer,integer)
  to service_role;

comment on column public.backroom_input_bindings.provider_conversation_identity_digest is
  'Opaque SHA-256 identity of the exact provider conversation selected locally; not a raw provider identifier.';
comment on column public.backroom_wake_jobs.provider_conversation_identity_digest is
  'Provider-conversation digest copied from the exact server-owned binding at queue insertion.';
