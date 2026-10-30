-- Distributed token buckets. Only the trusted gateway can choose a fixed policy;
-- clients cannot supply scope, capacity, clocks or refill rates. No request data,
-- addresses, account IDs, bearer tokens, cookies or share capabilities are stored.
create table public.peekalo_abuse_buckets (
  scope text not null check(scope in ('global','credential','account','guest')),
  lane text not null check(lane in ('api','media','upload','deletion','safety')),
  key_hash text not null check(key_hash ~ '^[0-9a-f]{64}$'),
  tokens numeric not null,
  touched_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(scope,lane,key_hash)
);
create index peekalo_abuse_expiry on public.peekalo_abuse_buckets(expires_at);
alter table public.peekalo_abuse_buckets enable row level security;
revoke all on public.peekalo_abuse_buckets from public,anon,authenticated,service_role;
create table public.peekalo_abuse_totals(lane text primary key, denied bigint not null default 0);
alter table public.peekalo_abuse_totals enable row level security;
revoke all on public.peekalo_abuse_totals from public,anon,authenticated,service_role;

create table public.peekalo_abuse_denials(lane text not null, minute timestamptz not null, denied bigint not null default 0, primary key(lane,minute));
alter table public.peekalo_abuse_denials enable row level security;
revoke all on public.peekalo_abuse_denials from public,anon,authenticated,service_role;
create function public.peekalo_record_abuse_denial(p_lane text) returns void language plpgsql security definer set search_path=public as $$
begin
  insert into peekalo_abuse_totals(lane,denied) values(p_lane,1) on conflict(lane) do update set denied=peekalo_abuse_totals.denied+1;
  insert into peekalo_abuse_denials(lane,minute,denied) values(p_lane,date_trunc('minute',clock_timestamp()),1) on conflict(lane,minute) do update set denied=peekalo_abuse_denials.denied+1;
  -- Fixed lanes and one row per minute, bounded even when maintenance is absent.
  delete from peekalo_abuse_denials where minute<date_trunc('minute',clock_timestamp())-interval '1 hour';
end $$;
revoke all on function public.peekalo_record_abuse_denial(text) from public,anon,authenticated,service_role;

create function public.peekalo_admit_endpoint(p_scope text,p_lane text,p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare capacity numeric; refill numeric; bucket public.peekalo_abuse_buckets; stamp timestamptz; balance numeric; wait_seconds integer;
begin
  if p_scope is null or p_scope not in ('global','credential','account','guest') or p_lane is null or p_lane not in ('api','media','upload','deletion','safety') or p_key is null or p_key !~ '^[0-9a-f]{64}$' or (p_scope='global' and p_key<>repeat('0',64)) then raise exception 'conflict'; end if;
  -- Burst/refill allowances are intentionally generous for playback ranges and
  -- retries, while expensive uploads and privileged/privacy actions have lanes
  -- independent of bulk reads. Tune only from measured aggregate traffic.
  if p_scope='global' then
    capacity:=case p_lane when 'upload' then 20 when 'deletion' then 120 when 'safety' then 120 else 1200 end;
    refill:=case p_lane when 'upload' then 0.5 when 'deletion' then 2 when 'safety' then 2 else 20 end;
  else
    capacity:=case p_lane when 'upload' then 6 when 'deletion' then 12 when 'safety' then 30 else 240 end;
    refill:=case p_lane when 'upload' then 0.1 when 'deletion' then 0.2 when 'safety' then 0.5 else 4 end;
  end if;
  -- Only new keys require the cardinality lock. One attacker cannot allocate an
  -- unbounded bucket table by rotating arbitrary credentials or guest cookies.
  select * into bucket from peekalo_abuse_buckets where scope=p_scope and lane=p_lane and key_hash=p_key for update;
  if not found then
    perform pg_advisory_xact_lock(578810301);
    select * into bucket from peekalo_abuse_buckets where scope=p_scope and lane=p_lane and key_hash=p_key for update;
    if not found then
      stamp:=clock_timestamp();
      delete from peekalo_abuse_buckets where (scope,lane,key_hash) in (select scope,lane,key_hash from peekalo_abuse_buckets where expires_at<stamp order by expires_at limit 1000);
      if (select count(*) from peekalo_abuse_buckets)>=20000 then
        perform peekalo_record_abuse_denial(p_lane);
        return jsonb_build_object('allowed',false,'retryAfter',60);
      end if;
      insert into peekalo_abuse_buckets values(p_scope,p_lane,p_key,capacity,stamp,stamp+interval '15 minutes') returning * into bucket;
    end if;
  end if;
  stamp:=clock_timestamp();
  balance:=least(capacity,bucket.tokens+greatest(0,extract(epoch from stamp-bucket.touched_at))*refill);
  if balance>=1 then
    update peekalo_abuse_buckets set tokens=balance-1,touched_at=stamp,expires_at=stamp+interval '15 minutes' where scope=p_scope and lane=p_lane and key_hash=p_key;
    return jsonb_build_object('allowed',true,'retryAfter',0);
  end if;
  wait_seconds:=greatest(1,ceil((1-balance)/refill)::integer);
  update peekalo_abuse_buckets set tokens=balance,touched_at=stamp where scope=p_scope and lane=p_lane and key_hash=p_key;
  perform peekalo_record_abuse_denial(p_lane);
  return jsonb_build_object('allowed',false,'retryAfter',wait_seconds);
end $$;
create function public.peekalo_abuse_expire() returns integer language plpgsql security definer set search_path=public as $$
declare result integer;
begin
  delete from peekalo_abuse_buckets where (scope,lane,key_hash) in (select scope,lane,key_hash from peekalo_abuse_buckets where expires_at<clock_timestamp() order by expires_at limit 1000);
  get diagnostics result=row_count; return result;
end $$;
create function public.peekalo_abuse_status() returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('buckets',(select count(*) from peekalo_abuse_buckets),'denied',(select coalesce(sum(denied),0) from peekalo_abuse_totals),'deniedLastHour',(select coalesce(sum(denied),0) from peekalo_abuse_denials where minute>=date_trunc('minute',clock_timestamp())-interval '1 hour'));
$$;
revoke all on function public.peekalo_admit_endpoint(text,text,text),public.peekalo_abuse_expire(),public.peekalo_abuse_status() from public,anon,authenticated;
grant execute on function public.peekalo_admit_endpoint(text,text,text),public.peekalo_abuse_expire(),public.peekalo_abuse_status() to service_role;
