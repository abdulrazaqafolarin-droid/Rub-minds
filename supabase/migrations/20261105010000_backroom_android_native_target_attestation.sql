-- Device-attest the exact Android app/composer/Send/provider conversation
-- behind an existing native Backroom input binding. This is registration only:
-- it does not enable wake consent, send a prompt, or create a device command.
-- Only opaque digests and the selected app/device identity are persisted.

alter table public.backroom_input_bindings
  add column if not exists android_device_id uuid
    references public.backroom_devices(device_id) on delete restrict,
  add column if not exists android_app_package_name text,
  add column if not exists android_app_signer_sha256 text,
  add column if not exists android_composer_identity_digest text,
  add column if not exists android_send_control_identity_digest text,
  add column if not exists android_attested_at timestamptz;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_attestation_fields_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_attestation_fields_check
      check (
        (
          android_device_id is null
          and android_app_package_name is null
          and android_app_signer_sha256 is null
          and android_composer_identity_digest is null
          and android_send_control_identity_digest is null
          and android_attested_at is null
        )
        or
        (
          surface = 'android_app'
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_wake_requires_attestation_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_attestation_check
      check (
        surface <> 'android_app'
        or wake_enabled = false
        or (
          provider_conversation_identity_digest is not null
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_signer_sha256 is not null
          and android_composer_identity_digest is not null
          and android_send_control_identity_digest is not null
          and android_attested_at is not null
        )
      );
  end if;
end;
$constraints$;

-- A group binding may be created before a provider adapter exists so that
-- ordinary manual drafts remain available. A trusted device may perform the
-- first provider/Android attestation only while wake is off and the binding
-- is not revoked. Once attested, identity can change only through revoke +
-- creation of a new binding; queued work is never silently retargeted.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_changed boolean;
  v_android_changed boolean;
  v_old_android_attested boolean;
  v_new_android_complete boolean;
begin
  v_provider_changed :=
    new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest;

  v_android_changed :=
    row(
      new.android_device_id,
      new.android_app_package_name,
      new.android_app_signer_sha256,
      new.android_composer_identity_digest,
      new.android_send_control_identity_digest,
      new.android_attested_at
    ) is distinct from row(
      old.android_device_id,
      old.android_app_package_name,
      old.android_app_signer_sha256,
      old.android_composer_identity_digest,
      old.android_send_control_identity_digest,
      old.android_attested_at
    );

  v_old_android_attested := old.android_device_id is not null;
  v_new_android_complete :=
    new.android_device_id is not null
    and new.android_app_package_name is not null
    and new.android_app_signer_sha256 is not null
    and new.android_composer_identity_digest is not null
    and new.android_send_control_identity_digest is not null
    and new.android_attested_at is not null;

  if v_provider_changed and old.provider_conversation_identity_digest is not null then
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;

  if v_provider_changed and new.provider_conversation_identity_digest is not null
    and (old.wake_enabled or old.revoked_at is not null) then
    raise check_violation using
      message = 'First provider identity attestation requires an active, wake-disabled binding';
  end if;

  if v_android_changed and v_old_android_attested then
    raise check_violation using
      message = 'Android target attestation is immutable; revoke and register a new binding';
  end if;

  if v_android_changed and not v_old_android_attested then
    if old.wake_enabled or old.revoked_at is not null or not v_new_android_complete then
      raise check_violation using
        message = 'First Android target attestation requires a complete device proof on an active, wake-disabled binding';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public, anon, authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of
  provider_conversation_identity_digest,
  android_device_id,
  android_app_package_name,
  android_app_signer_sha256,
  android_composer_identity_digest,
  android_send_control_identity_digest,
  android_attested_at
on public.backroom_input_bindings
for each row
execute function public.guard_backroom_input_binding_provider_identity();

-- Device-bearer-authenticated Edge Function only. The RPC rechecks every
-- server-owned scope, device-room relation, active screen session and app
-- signer before writing the opaque, locally-produced hashes.
create or replace function public.register_backroom_android_native_wake_target(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select b.* into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.room_id = p_room_id
    and b.surface = 'android_app'
    and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- The handoff policy treats target_identity_fingerprint as the app signer
  -- for an Android native surface. Never silently substitute a different
  -- app identity or a composer hash for it.
  if v_binding.target_identity_fingerprint is distinct from p_app_signer_sha256 then
    return false;
  end if;

  select d.* into v_device
  from public.backroom_devices d
  join public.backroom_device_room_bindings rb
    on rb.device_id = d.device_id
   and rb.room_id = p_room_id
   and rb.owner_id = v_binding.owner_id
   and rb.revoked_at is null
  where d.device_id = p_device_id
    and d.owner_id = v_binding.owner_id
    and d.platform = 'android'
    and d.status = 'active'
    and d.revoked_at is null;

  if not found then return false; end if;

  select s.* into v_session
  from public.backroom_desktop_sessions s
  where s.session_id = p_screen_session_id
    and s.device_id = p_device_id
    and s.room_id = p_room_id
    and s.session_type = 'screen'
    and s.status = 'active'
    and s.expires_at > v_now;

  if not found then return false; end if;

  select a.* into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.signing_certificate_sha256 = p_app_signer_sha256;

  if not found then return false; end if;

  -- Same binding/session can repeat its device proof idempotently, but cannot
  -- switch device, app, composer, Send control or provider conversation.
  if v_binding.android_device_id is not null then
    return v_binding.android_device_id = p_device_id
      and v_binding.android_app_package_name = p_app_package_name
      and v_binding.android_app_signer_sha256 = p_app_signer_sha256
      and v_binding.android_composer_identity_digest = p_composer_identity_digest
      and v_binding.android_send_control_identity_digest = p_send_control_identity_digest
      and v_binding.provider_conversation_identity_digest = p_provider_conversation_identity_digest
      and v_binding.android_attested_at is not null;
  end if;

  -- Existing consent is never upgraded or retargeted by a new device proof.
  if v_binding.wake_enabled or v_binding.revoked_at is not null then
    return false;
  end if;
  if v_binding.provider_conversation_identity_digest is not null
    and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return false;
  end if;

  update public.backroom_input_bindings
  set provider_conversation_identity_digest = p_provider_conversation_identity_digest,
      android_device_id = p_device_id,
      android_app_package_name = p_app_package_name,
      android_app_signer_sha256 = p_app_signer_sha256,
      android_composer_identity_digest = p_composer_identity_digest,
      android_send_control_identity_digest = p_send_control_identity_digest,
      android_attested_at = v_now,
      updated_at = v_now
  where id = p_binding_id
    and revoked_at is null
    and wake_enabled = false;

  if not found then return false; end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

comment on column public.backroom_input_bindings.android_device_id is
  'Device-bearer-attested Android handset selected for this native input binding.';
comment on column public.backroom_input_bindings.android_app_package_name is
  'Exact selected Android package; raw provider conversation identifiers are not stored.';
comment on column public.backroom_input_bindings.android_app_signer_sha256 is
  'Selected app signer digest; must equal target_identity_fingerprint for Android native handoff.';
comment on column public.backroom_input_bindings.android_composer_identity_digest is
  'Locally computed digest for the exact editable composer; never contains editor text.';
comment on column public.backroom_input_bindings.android_send_control_identity_digest is
  'Locally computed digest for the unique Send control; not permission to send by itself.';
comment on column public.backroom_input_bindings.android_attested_at is
  'Time the exact phone, room, active screen session, app signer, composer, Send control and provider conversation were attested.';
comment on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Service-role-only registration of device-attested Android target hashes; never activates autonomous wake consent.';

          and android_app_signer_sha256 is not null
          and android_app_signer_sha256 ~ '^[a-f0-9]{64}
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_wake_requires_attestation_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_attestation_check
      check (
        surface <> 'android_app'
        or wake_enabled = false
        or (
          provider_conversation_identity_digest is not null
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_signer_sha256 is not null
          and android_composer_identity_digest is not null
          and android_send_control_identity_digest is not null
          and android_attested_at is not null
        )
      );
  end if;
end;
$constraints$;

-- A group binding may be created before a provider adapter exists so that
-- ordinary manual drafts remain available. A trusted device may perform the
-- first provider/Android attestation only while wake is off and the binding
-- is not revoked. Once attested, identity can change only through revoke +
-- creation of a new binding; queued work is never silently retargeted.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_changed boolean;
  v_android_changed boolean;
  v_old_android_attested boolean;
  v_new_android_complete boolean;
begin
  v_provider_changed :=
    new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest;

  v_android_changed :=
    row(
      new.android_device_id,
      new.android_app_package_name,
      new.android_app_signer_sha256,
      new.android_composer_identity_digest,
      new.android_send_control_identity_digest,
      new.android_attested_at
    ) is distinct from row(
      old.android_device_id,
      old.android_app_package_name,
      old.android_app_signer_sha256,
      old.android_composer_identity_digest,
      old.android_send_control_identity_digest,
      old.android_attested_at
    );

  v_old_android_attested := old.android_device_id is not null;
  v_new_android_complete :=
    new.android_device_id is not null
    and new.android_app_package_name is not null
    and new.android_app_signer_sha256 is not null
    and new.android_composer_identity_digest is not null
    and new.android_send_control_identity_digest is not null
    and new.android_attested_at is not null;

  if v_provider_changed and old.provider_conversation_identity_digest is not null then
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;

  if v_provider_changed and new.provider_conversation_identity_digest is not null
    and (old.wake_enabled or old.revoked_at is not null) then
    raise check_violation using
      message = 'First provider identity attestation requires an active, wake-disabled binding';
  end if;

  if v_android_changed and v_old_android_attested then
    raise check_violation using
      message = 'Android target attestation is immutable; revoke and register a new binding';
  end if;

  if v_android_changed and not v_old_android_attested then
    if old.wake_enabled or old.revoked_at is not null or not v_new_android_complete then
      raise check_violation using
        message = 'First Android target attestation requires a complete device proof on an active, wake-disabled binding';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public, anon, authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of
  provider_conversation_identity_digest,
  android_device_id,
  android_app_package_name,
  android_app_signer_sha256,
  android_composer_identity_digest,
  android_send_control_identity_digest,
  android_attested_at
on public.backroom_input_bindings
for each row
execute function public.guard_backroom_input_binding_provider_identity();

-- Device-bearer-authenticated Edge Function only. The RPC rechecks every
-- server-owned scope, device-room relation, active screen session and app
-- signer before writing the opaque, locally-produced hashes.
create or replace function public.register_backroom_android_native_wake_target(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select b.* into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.room_id = p_room_id
    and b.surface = 'android_app'
    and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- The handoff policy treats target_identity_fingerprint as the app signer
  -- for an Android native surface. Never silently substitute a different
  -- app identity or a composer hash for it.
  if v_binding.target_identity_fingerprint is distinct from p_app_signer_sha256 then
    return false;
  end if;

  select d.* into v_device
  from public.backroom_devices d
  join public.backroom_device_room_bindings rb
    on rb.device_id = d.device_id
   and rb.room_id = p_room_id
   and rb.owner_id = v_binding.owner_id
   and rb.revoked_at is null
  where d.device_id = p_device_id
    and d.owner_id = v_binding.owner_id
    and d.platform = 'android'
    and d.status = 'active'
    and d.revoked_at is null;

  if not found then return false; end if;

  select s.* into v_session
  from public.backroom_desktop_sessions s
  where s.session_id = p_screen_session_id
    and s.device_id = p_device_id
    and s.room_id = p_room_id
    and s.session_type = 'screen'
    and s.status = 'active'
    and s.expires_at > v_now;

  if not found then return false; end if;

  select a.* into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.signing_certificate_sha256 = p_app_signer_sha256;

  if not found then return false; end if;

  -- Same binding/session can repeat its device proof idempotently, but cannot
  -- switch device, app, composer, Send control or provider conversation.
  if v_binding.android_device_id is not null then
    return v_binding.android_device_id = p_device_id
      and v_binding.android_app_package_name = p_app_package_name
      and v_binding.android_app_signer_sha256 = p_app_signer_sha256
      and v_binding.android_composer_identity_digest = p_composer_identity_digest
      and v_binding.android_send_control_identity_digest = p_send_control_identity_digest
      and v_binding.provider_conversation_identity_digest = p_provider_conversation_identity_digest
      and v_binding.android_attested_at is not null;
  end if;

  -- Existing consent is never upgraded or retargeted by a new device proof.
  if v_binding.wake_enabled or v_binding.revoked_at is not null then
    return false;
  end if;
  if v_binding.provider_conversation_identity_digest is not null
    and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return false;
  end if;

  update public.backroom_input_bindings
  set provider_conversation_identity_digest = p_provider_conversation_identity_digest,
      android_device_id = p_device_id,
      android_app_package_name = p_app_package_name,
      android_app_signer_sha256 = p_app_signer_sha256,
      android_composer_identity_digest = p_composer_identity_digest,
      android_send_control_identity_digest = p_send_control_identity_digest,
      android_attested_at = v_now,
      updated_at = v_now
  where id = p_binding_id
    and revoked_at is null
    and wake_enabled = false;

  if not found then return false; end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

comment on column public.backroom_input_bindings.android_device_id is
  'Device-bearer-attested Android handset selected for this native input binding.';
comment on column public.backroom_input_bindings.android_app_package_name is
  'Exact selected Android package; raw provider conversation identifiers are not stored.';
comment on column public.backroom_input_bindings.android_app_signer_sha256 is
  'Selected app signer digest; must equal target_identity_fingerprint for Android native handoff.';
comment on column public.backroom_input_bindings.android_composer_identity_digest is
  'Locally computed digest for the exact editable composer; never contains editor text.';
comment on column public.backroom_input_bindings.android_send_control_identity_digest is
  'Locally computed digest for the unique Send control; not permission to send by itself.';
comment on column public.backroom_input_bindings.android_attested_at is
  'Time the exact phone, room, active screen session, app signer, composer, Send control and provider conversation were attested.';
comment on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Service-role-only registration of device-attested Android target hashes; never activates autonomous wake consent.';

          and android_composer_identity_digest is not null
          and android_composer_identity_digest ~ '^[a-f0-9]{64}
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_wake_requires_attestation_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_attestation_check
      check (
        surface <> 'android_app'
        or wake_enabled = false
        or (
          provider_conversation_identity_digest is not null
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_signer_sha256 is not null
          and android_composer_identity_digest is not null
          and android_send_control_identity_digest is not null
          and android_attested_at is not null
        )
      );
  end if;
end;
$constraints$;

-- A group binding may be created before a provider adapter exists so that
-- ordinary manual drafts remain available. A trusted device may perform the
-- first provider/Android attestation only while wake is off and the binding
-- is not revoked. Once attested, identity can change only through revoke +
-- creation of a new binding; queued work is never silently retargeted.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_changed boolean;
  v_android_changed boolean;
  v_old_android_attested boolean;
  v_new_android_complete boolean;
begin
  v_provider_changed :=
    new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest;

  v_android_changed :=
    row(
      new.android_device_id,
      new.android_app_package_name,
      new.android_app_signer_sha256,
      new.android_composer_identity_digest,
      new.android_send_control_identity_digest,
      new.android_attested_at
    ) is distinct from row(
      old.android_device_id,
      old.android_app_package_name,
      old.android_app_signer_sha256,
      old.android_composer_identity_digest,
      old.android_send_control_identity_digest,
      old.android_attested_at
    );

  v_old_android_attested := old.android_device_id is not null;
  v_new_android_complete :=
    new.android_device_id is not null
    and new.android_app_package_name is not null
    and new.android_app_signer_sha256 is not null
    and new.android_composer_identity_digest is not null
    and new.android_send_control_identity_digest is not null
    and new.android_attested_at is not null;

  if v_provider_changed and old.provider_conversation_identity_digest is not null then
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;

  if v_provider_changed and new.provider_conversation_identity_digest is not null
    and (old.wake_enabled or old.revoked_at is not null) then
    raise check_violation using
      message = 'First provider identity attestation requires an active, wake-disabled binding';
  end if;

  if v_android_changed and v_old_android_attested then
    raise check_violation using
      message = 'Android target attestation is immutable; revoke and register a new binding';
  end if;

  if v_android_changed and not v_old_android_attested then
    if old.wake_enabled or old.revoked_at is not null or not v_new_android_complete then
      raise check_violation using
        message = 'First Android target attestation requires a complete device proof on an active, wake-disabled binding';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public, anon, authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of
  provider_conversation_identity_digest,
  android_device_id,
  android_app_package_name,
  android_app_signer_sha256,
  android_composer_identity_digest,
  android_send_control_identity_digest,
  android_attested_at
on public.backroom_input_bindings
for each row
execute function public.guard_backroom_input_binding_provider_identity();

-- Device-bearer-authenticated Edge Function only. The RPC rechecks every
-- server-owned scope, device-room relation, active screen session and app
-- signer before writing the opaque, locally-produced hashes.
create or replace function public.register_backroom_android_native_wake_target(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select b.* into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.room_id = p_room_id
    and b.surface = 'android_app'
    and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- The handoff policy treats target_identity_fingerprint as the app signer
  -- for an Android native surface. Never silently substitute a different
  -- app identity or a composer hash for it.
  if v_binding.target_identity_fingerprint is distinct from p_app_signer_sha256 then
    return false;
  end if;

  select d.* into v_device
  from public.backroom_devices d
  join public.backroom_device_room_bindings rb
    on rb.device_id = d.device_id
   and rb.room_id = p_room_id
   and rb.owner_id = v_binding.owner_id
   and rb.revoked_at is null
  where d.device_id = p_device_id
    and d.owner_id = v_binding.owner_id
    and d.platform = 'android'
    and d.status = 'active'
    and d.revoked_at is null;

  if not found then return false; end if;

  select s.* into v_session
  from public.backroom_desktop_sessions s
  where s.session_id = p_screen_session_id
    and s.device_id = p_device_id
    and s.room_id = p_room_id
    and s.session_type = 'screen'
    and s.status = 'active'
    and s.expires_at > v_now;

  if not found then return false; end if;

  select a.* into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.signing_certificate_sha256 = p_app_signer_sha256;

  if not found then return false; end if;

  -- Same binding/session can repeat its device proof idempotently, but cannot
  -- switch device, app, composer, Send control or provider conversation.
  if v_binding.android_device_id is not null then
    return v_binding.android_device_id = p_device_id
      and v_binding.android_app_package_name = p_app_package_name
      and v_binding.android_app_signer_sha256 = p_app_signer_sha256
      and v_binding.android_composer_identity_digest = p_composer_identity_digest
      and v_binding.android_send_control_identity_digest = p_send_control_identity_digest
      and v_binding.provider_conversation_identity_digest = p_provider_conversation_identity_digest
      and v_binding.android_attested_at is not null;
  end if;

  -- Existing consent is never upgraded or retargeted by a new device proof.
  if v_binding.wake_enabled or v_binding.revoked_at is not null then
    return false;
  end if;
  if v_binding.provider_conversation_identity_digest is not null
    and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return false;
  end if;

  update public.backroom_input_bindings
  set provider_conversation_identity_digest = p_provider_conversation_identity_digest,
      android_device_id = p_device_id,
      android_app_package_name = p_app_package_name,
      android_app_signer_sha256 = p_app_signer_sha256,
      android_composer_identity_digest = p_composer_identity_digest,
      android_send_control_identity_digest = p_send_control_identity_digest,
      android_attested_at = v_now,
      updated_at = v_now
  where id = p_binding_id
    and revoked_at is null
    and wake_enabled = false;

  if not found then return false; end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

comment on column public.backroom_input_bindings.android_device_id is
  'Device-bearer-attested Android handset selected for this native input binding.';
comment on column public.backroom_input_bindings.android_app_package_name is
  'Exact selected Android package; raw provider conversation identifiers are not stored.';
comment on column public.backroom_input_bindings.android_app_signer_sha256 is
  'Selected app signer digest; must equal target_identity_fingerprint for Android native handoff.';
comment on column public.backroom_input_bindings.android_composer_identity_digest is
  'Locally computed digest for the exact editable composer; never contains editor text.';
comment on column public.backroom_input_bindings.android_send_control_identity_digest is
  'Locally computed digest for the unique Send control; not permission to send by itself.';
comment on column public.backroom_input_bindings.android_attested_at is
  'Time the exact phone, room, active screen session, app signer, composer, Send control and provider conversation were attested.';
comment on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Service-role-only registration of device-attested Android target hashes; never activates autonomous wake consent.';

          and android_send_control_identity_digest is not null
          and android_send_control_identity_digest ~ '^[a-f0-9]{64}
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_wake_requires_attestation_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_attestation_check
      check (
        surface <> 'android_app'
        or wake_enabled = false
        or (
          provider_conversation_identity_digest is not null
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_signer_sha256 is not null
          and android_composer_identity_digest is not null
          and android_send_control_identity_digest is not null
          and android_attested_at is not null
        )
      );
  end if;
end;
$constraints$;

-- A group binding may be created before a provider adapter exists so that
-- ordinary manual drafts remain available. A trusted device may perform the
-- first provider/Android attestation only while wake is off and the binding
-- is not revoked. Once attested, identity can change only through revoke +
-- creation of a new binding; queued work is never silently retargeted.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_changed boolean;
  v_android_changed boolean;
  v_old_android_attested boolean;
  v_new_android_complete boolean;
begin
  v_provider_changed :=
    new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest;

  v_android_changed :=
    row(
      new.android_device_id,
      new.android_app_package_name,
      new.android_app_signer_sha256,
      new.android_composer_identity_digest,
      new.android_send_control_identity_digest,
      new.android_attested_at
    ) is distinct from row(
      old.android_device_id,
      old.android_app_package_name,
      old.android_app_signer_sha256,
      old.android_composer_identity_digest,
      old.android_send_control_identity_digest,
      old.android_attested_at
    );

  v_old_android_attested := old.android_device_id is not null;
  v_new_android_complete :=
    new.android_device_id is not null
    and new.android_app_package_name is not null
    and new.android_app_signer_sha256 is not null
    and new.android_composer_identity_digest is not null
    and new.android_send_control_identity_digest is not null
    and new.android_attested_at is not null;

  if v_provider_changed and old.provider_conversation_identity_digest is not null then
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;

  if v_provider_changed and new.provider_conversation_identity_digest is not null
    and (old.wake_enabled or old.revoked_at is not null) then
    raise check_violation using
      message = 'First provider identity attestation requires an active, wake-disabled binding';
  end if;

  if v_android_changed and v_old_android_attested then
    raise check_violation using
      message = 'Android target attestation is immutable; revoke and register a new binding';
  end if;

  if v_android_changed and not v_old_android_attested then
    if old.wake_enabled or old.revoked_at is not null or not v_new_android_complete then
      raise check_violation using
        message = 'First Android target attestation requires a complete device proof on an active, wake-disabled binding';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public, anon, authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of
  provider_conversation_identity_digest,
  android_device_id,
  android_app_package_name,
  android_app_signer_sha256,
  android_composer_identity_digest,
  android_send_control_identity_digest,
  android_attested_at
on public.backroom_input_bindings
for each row
execute function public.guard_backroom_input_binding_provider_identity();

-- Device-bearer-authenticated Edge Function only. The RPC rechecks every
-- server-owned scope, device-room relation, active screen session and app
-- signer before writing the opaque, locally-produced hashes.
create or replace function public.register_backroom_android_native_wake_target(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select b.* into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.room_id = p_room_id
    and b.surface = 'android_app'
    and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- The handoff policy treats target_identity_fingerprint as the app signer
  -- for an Android native surface. Never silently substitute a different
  -- app identity or a composer hash for it.
  if v_binding.target_identity_fingerprint is distinct from p_app_signer_sha256 then
    return false;
  end if;

  select d.* into v_device
  from public.backroom_devices d
  join public.backroom_device_room_bindings rb
    on rb.device_id = d.device_id
   and rb.room_id = p_room_id
   and rb.owner_id = v_binding.owner_id
   and rb.revoked_at is null
  where d.device_id = p_device_id
    and d.owner_id = v_binding.owner_id
    and d.platform = 'android'
    and d.status = 'active'
    and d.revoked_at is null;

  if not found then return false; end if;

  select s.* into v_session
  from public.backroom_desktop_sessions s
  where s.session_id = p_screen_session_id
    and s.device_id = p_device_id
    and s.room_id = p_room_id
    and s.session_type = 'screen'
    and s.status = 'active'
    and s.expires_at > v_now;

  if not found then return false; end if;

  select a.* into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.signing_certificate_sha256 = p_app_signer_sha256;

  if not found then return false; end if;

  -- Same binding/session can repeat its device proof idempotently, but cannot
  -- switch device, app, composer, Send control or provider conversation.
  if v_binding.android_device_id is not null then
    return v_binding.android_device_id = p_device_id
      and v_binding.android_app_package_name = p_app_package_name
      and v_binding.android_app_signer_sha256 = p_app_signer_sha256
      and v_binding.android_composer_identity_digest = p_composer_identity_digest
      and v_binding.android_send_control_identity_digest = p_send_control_identity_digest
      and v_binding.provider_conversation_identity_digest = p_provider_conversation_identity_digest
      and v_binding.android_attested_at is not null;
  end if;

  -- Existing consent is never upgraded or retargeted by a new device proof.
  if v_binding.wake_enabled or v_binding.revoked_at is not null then
    return false;
  end if;
  if v_binding.provider_conversation_identity_digest is not null
    and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return false;
  end if;

  update public.backroom_input_bindings
  set provider_conversation_identity_digest = p_provider_conversation_identity_digest,
      android_device_id = p_device_id,
      android_app_package_name = p_app_package_name,
      android_app_signer_sha256 = p_app_signer_sha256,
      android_composer_identity_digest = p_composer_identity_digest,
      android_send_control_identity_digest = p_send_control_identity_digest,
      android_attested_at = v_now,
      updated_at = v_now
  where id = p_binding_id
    and revoked_at is null
    and wake_enabled = false;

  if not found then return false; end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

comment on column public.backroom_input_bindings.android_device_id is
  'Device-bearer-attested Android handset selected for this native input binding.';
comment on column public.backroom_input_bindings.android_app_package_name is
  'Exact selected Android package; raw provider conversation identifiers are not stored.';
comment on column public.backroom_input_bindings.android_app_signer_sha256 is
  'Selected app signer digest; must equal target_identity_fingerprint for Android native handoff.';
comment on column public.backroom_input_bindings.android_composer_identity_digest is
  'Locally computed digest for the exact editable composer; never contains editor text.';
comment on column public.backroom_input_bindings.android_send_control_identity_digest is
  'Locally computed digest for the unique Send control; not permission to send by itself.';
comment on column public.backroom_input_bindings.android_attested_at is
  'Time the exact phone, room, active screen session, app signer, composer, Send control and provider conversation were attested.';
comment on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Service-role-only registration of device-attested Android target hashes; never activates autonomous wake consent.';

          and android_attested_at is not null
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.backroom_input_bindings'::regclass
      and conname = 'backroom_android_native_wake_requires_attestation_check'
  ) then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_attestation_check
      check (
        surface <> 'android_app'
        or wake_enabled = false
        or (
          provider_conversation_identity_digest is not null
          and android_device_id is not null
          and android_app_package_name is not null
          and android_app_signer_sha256 is not null
          and android_composer_identity_digest is not null
          and android_send_control_identity_digest is not null
          and android_attested_at is not null
        )
      );
  end if;
end;
$constraints$;

-- A group binding may be created before a provider adapter exists so that
-- ordinary manual drafts remain available. A trusted device may perform the
-- first provider/Android attestation only while wake is off and the binding
-- is not revoked. Once attested, identity can change only through revoke +
-- creation of a new binding; queued work is never silently retargeted.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider_changed boolean;
  v_android_changed boolean;
  v_old_android_attested boolean;
  v_new_android_complete boolean;
begin
  v_provider_changed :=
    new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest;

  v_android_changed :=
    row(
      new.android_device_id,
      new.android_app_package_name,
      new.android_app_signer_sha256,
      new.android_composer_identity_digest,
      new.android_send_control_identity_digest,
      new.android_attested_at
    ) is distinct from row(
      old.android_device_id,
      old.android_app_package_name,
      old.android_app_signer_sha256,
      old.android_composer_identity_digest,
      old.android_send_control_identity_digest,
      old.android_attested_at
    );

  v_old_android_attested := old.android_device_id is not null;
  v_new_android_complete :=
    new.android_device_id is not null
    and new.android_app_package_name is not null
    and new.android_app_signer_sha256 is not null
    and new.android_composer_identity_digest is not null
    and new.android_send_control_identity_digest is not null
    and new.android_attested_at is not null;

  if v_provider_changed and old.provider_conversation_identity_digest is not null then
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;

  if v_provider_changed and new.provider_conversation_identity_digest is not null
    and (old.wake_enabled or old.revoked_at is not null) then
    raise check_violation using
      message = 'First provider identity attestation requires an active, wake-disabled binding';
  end if;

  if v_android_changed and v_old_android_attested then
    raise check_violation using
      message = 'Android target attestation is immutable; revoke and register a new binding';
  end if;

  if v_android_changed and not v_old_android_attested then
    if old.wake_enabled or old.revoked_at is not null or not v_new_android_complete then
      raise check_violation using
        message = 'First Android target attestation requires a complete device proof on an active, wake-disabled binding';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public, anon, authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of
  provider_conversation_identity_digest,
  android_device_id,
  android_app_package_name,
  android_app_signer_sha256,
  android_composer_identity_digest,
  android_send_control_identity_digest,
  android_attested_at
on public.backroom_input_bindings
for each row
execute function public.guard_backroom_input_binding_provider_identity();

-- Device-bearer-authenticated Edge Function only. The RPC rechecks every
-- server-owned scope, device-room relation, active screen session and app
-- signer before writing the opaque, locally-produced hashes.
create or replace function public.register_backroom_android_native_wake_target(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select b.* into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.room_id = p_room_id
    and b.surface = 'android_app'
    and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- The handoff policy treats target_identity_fingerprint as the app signer
  -- for an Android native surface. Never silently substitute a different
  -- app identity or a composer hash for it.
  if v_binding.target_identity_fingerprint is distinct from p_app_signer_sha256 then
    return false;
  end if;

  select d.* into v_device
  from public.backroom_devices d
  join public.backroom_device_room_bindings rb
    on rb.device_id = d.device_id
   and rb.room_id = p_room_id
   and rb.owner_id = v_binding.owner_id
   and rb.revoked_at is null
  where d.device_id = p_device_id
    and d.owner_id = v_binding.owner_id
    and d.platform = 'android'
    and d.status = 'active'
    and d.revoked_at is null;

  if not found then return false; end if;

  select s.* into v_session
  from public.backroom_desktop_sessions s
  where s.session_id = p_screen_session_id
    and s.device_id = p_device_id
    and s.room_id = p_room_id
    and s.session_type = 'screen'
    and s.status = 'active'
    and s.expires_at > v_now;

  if not found then return false; end if;

  select a.* into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.signing_certificate_sha256 = p_app_signer_sha256;

  if not found then return false; end if;

  -- Same binding/session can repeat its device proof idempotently, but cannot
  -- switch device, app, composer, Send control or provider conversation.
  if v_binding.android_device_id is not null then
    return v_binding.android_device_id = p_device_id
      and v_binding.android_app_package_name = p_app_package_name
      and v_binding.android_app_signer_sha256 = p_app_signer_sha256
      and v_binding.android_composer_identity_digest = p_composer_identity_digest
      and v_binding.android_send_control_identity_digest = p_send_control_identity_digest
      and v_binding.provider_conversation_identity_digest = p_provider_conversation_identity_digest
      and v_binding.android_attested_at is not null;
  end if;

  -- Existing consent is never upgraded or retargeted by a new device proof.
  if v_binding.wake_enabled or v_binding.revoked_at is not null then
    return false;
  end if;
  if v_binding.provider_conversation_identity_digest is not null
    and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return false;
  end if;

  update public.backroom_input_bindings
  set provider_conversation_identity_digest = p_provider_conversation_identity_digest,
      android_device_id = p_device_id,
      android_app_package_name = p_app_package_name,
      android_app_signer_sha256 = p_app_signer_sha256,
      android_composer_identity_digest = p_composer_identity_digest,
      android_send_control_identity_digest = p_send_control_identity_digest,
      android_attested_at = v_now,
      updated_at = v_now
  where id = p_binding_id
    and revoked_at is null
    and wake_enabled = false;

  if not found then return false; end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

comment on column public.backroom_input_bindings.android_device_id is
  'Device-bearer-attested Android handset selected for this native input binding.';
comment on column public.backroom_input_bindings.android_app_package_name is
  'Exact selected Android package; raw provider conversation identifiers are not stored.';
comment on column public.backroom_input_bindings.android_app_signer_sha256 is
  'Selected app signer digest; must equal target_identity_fingerprint for Android native handoff.';
comment on column public.backroom_input_bindings.android_composer_identity_digest is
  'Locally computed digest for the exact editable composer; never contains editor text.';
comment on column public.backroom_input_bindings.android_send_control_identity_digest is
  'Locally computed digest for the unique Send control; not permission to send by itself.';
comment on column public.backroom_input_bindings.android_attested_at is
  'Time the exact phone, room, active screen session, app signer, composer, Send control and provider conversation were attested.';
comment on function public.register_backroom_android_native_wake_target(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Service-role-only registration of device-attested Android target hashes; never activates autonomous wake consent.';
