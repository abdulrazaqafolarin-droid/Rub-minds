create table public.agent_request_log (
 id bigint generated always as identity primary key,
 connection_id uuid not null references public.agent_connections(id) on delete cascade,
 operation text not null check (operation in ('read','send')),
 created_at timestamptz not null default now()
);
create index agent_request_log_window_idx on public.agent_request_log(connection_id,operation,created_at desc);
alter table public.agent_request_log enable row level security;
create or replace function public.agent_exchange(agent_secret text, operation text, payload text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare connection public.agent_connections%rowtype; message_id uuid; result jsonb; request_count integer; request_limit integer;
begin
 if agent_secret is null or agent_secret !~ '^[0-9a-f]{64}$' then raise exception 'Invalid credential'; end if;
 if operation not in ('read','send') then raise exception 'Unknown operation'; end if;
 select * into connection from public.agent_connections
 where credential_digest=encode(sha256(convert_to(agent_secret,'UTF8')),'hex') and revoked_at is null and expires_at>now();
 if not found then raise exception 'Invalid credential'; end if;
 perform pg_advisory_xact_lock(hashtextextended(connection.id::text,0));
 request_limit := case when operation='send' then 20 else 60 end;
 select count(*) into request_count from public.agent_request_log l
 where l.connection_id=connection.id and l.operation=agent_exchange.operation
 and l.created_at>now()-interval '1 minute';
 if request_count>=request_limit then raise exception 'Agent request limit exceeded'; end if;
 insert into public.agent_request_log(connection_id,operation) values(connection.id,operation);
 if operation='read' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at,t.id),'[]'::jsonb) into result
  from (select m.id,m.sender_id,m.body,m.created_at from public.messages m
  where m.room_id=connection.room_id order by m.created_at desc,m.id desc limit 50) t;
  return jsonb_build_object('room_id',connection.room_id,'participant_id',connection.participant_id,'messages',result);
 end if;
 if payload is null or char_length(btrim(payload)) not between 1 and 10000 then raise exception 'Invalid message'; end if;
 insert into public.messages(room_id,sender_id,body)
 values(connection.room_id,connection.participant_id,btrim(payload)) returning id into message_id;
 update public.participants set status='active' where id=connection.participant_id;
 return jsonb_build_object('room_id',connection.room_id,'message_id',message_id);
end;
$$;
revoke all on function public.agent_exchange(text,text,text) from public,anon,authenticated;
grant execute on function public.agent_exchange(text,text,text) to service_role;
