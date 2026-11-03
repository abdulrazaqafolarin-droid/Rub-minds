-- Store bounded, device-authenticated native-wake completion evidence separately
-- from the short human-readable command result. The host-side lease forwarder can
-- later consume this evidence without trusting a status string alone.
alter table public.backroom_android_commands
  add column if not exists result_payload jsonb;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'backroom_android_commands_result_payload_bound'
      and conrelid = 'public.backroom_android_commands'::regclass
  ) then
    alter table public.backroom_android_commands
      add constraint backroom_android_commands_result_payload_bound
      check (
        result_payload is null
        or (
          pg_catalog.jsonb_typeof(result_payload) = 'object'
          and pg_catalog.octet_length(result_payload::text) <= 8192
        )
      );
  end if;
end
$migration$;

comment on column public.backroom_android_commands.result_payload is
  'Bounded device-authenticated structured result evidence for future native wake handoff acknowledgement; never stores composer text or group-message bodies.';
