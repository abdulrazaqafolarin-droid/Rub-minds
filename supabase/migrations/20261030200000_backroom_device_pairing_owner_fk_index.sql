-- Cover the device-pairing owner foreign key and owner-scoped pending pairing lookups.
create index if not exists backroom_device_pairings_owner_idx
  on public.backroom_device_pairings(owner_id, created_at desc);
