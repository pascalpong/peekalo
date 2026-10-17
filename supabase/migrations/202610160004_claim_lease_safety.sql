-- Lock each post before its access rows, matching owner grant/link revocation.
-- Refresh wall time after lock waits; request arrival time is not authorization time.
create or replace function public.peekalo_lease(p_identity text,p_session uuid,p_request uuid,p_hash text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  link public.peekalo_links;
  post public.peekalo_posts;
  budget public.peekalo_budgets;
  lease public.peekalo_leases;
  stamp timestamptz;
  duration integer;
  deadline timestamptz;
begin
  if p_identity is null or p_identity !~ '^[ag]:[0-9a-f-]{36}$' or p_session is null or p_request is null then
    raise exception 'unauthorized';
  end if;

  -- Resolve the capability without locking it yet. Recheck it under lock below.
  if p_hash is not null then
    select post_id into p_post from peekalo_links where token_hash=p_hash;
    if not found then raise exception 'unavailable'; end if;
  elsif left(p_identity,2)<>'a:' then
    raise exception 'unauthorized';
  end if;

  select * into post from peekalo_posts where id=p_post and status='ready' for share;
  if not found then raise exception 'unavailable'; end if;

  if p_hash is not null then
    -- Owner review must never consume an external recipient's link.
    if p_identity='a:' || post.owner_id::text then raise exception 'unavailable'; end if;
    select * into link from peekalo_links where token_hash=p_hash and post_id=post.id for update;
    if not found or link.revoked then raise exception 'unavailable'; end if;
    if link.claimed_identity is not null and link.claimed_identity<>p_identity then raise exception 'claimed'; end if;
  else
    perform 1 from peekalo_grants
      where post_id=post.id and recipient_id=substring(p_identity from 3)::uuid
        and request_state='accepted' and not revoked for share;
    if not found then raise exception 'unavailable'; end if;
  end if;

  insert into peekalo_budgets(post_id,identity) values(post.id,p_identity) on conflict do nothing;
  select * into budget from peekalo_budgets where post_id=post.id and identity=p_identity for update;
  stamp:=clock_timestamp();
  if link.id is not null and link.expires_at<=stamp then raise exception 'unavailable'; end if;

  select * into lease from peekalo_leases where post_id=post.id and identity=p_identity and request_id=p_request;
  if found then
    -- A retry can replay only the original session AND authorization path.
    if lease.session_id<>p_session or lease.link_id is distinct from link.id then raise exception 'conflict'; end if;
    return jsonb_build_object('leaseId',lease.id,'grantedMs',lease.granted_ms,'remainingMs',lease.remaining_ms,'expiresAt',lease.expires_at);
  end if;
  if budget.active_until>stamp and budget.active_session<>p_session then raise exception 'busy'; end if;
  if budget.spent_ms>=10000 then raise exception 'exhausted'; end if;
  if budget.active_until>stamp+interval '750 milliseconds' then raise exception 'early'; end if;

  duration:=least(2000,10000-budget.spent_ms);
  deadline:=greatest(stamp,coalesce(budget.active_until,stamp)) + duration * interval '1 millisecond';
  if link.id is not null then
    deadline:=least(deadline,link.expires_at);
    update peekalo_links set claimed_identity=p_identity where id=link.id and claimed_identity is null;
  end if;
  update peekalo_budgets set spent_ms=spent_ms+duration,active_session=p_session,active_until=deadline
    where post_id=post.id and identity=p_identity;
  insert into peekalo_leases(post_id,identity,link_id,session_id,request_id,granted_ms,remaining_ms,expires_at)
    values(post.id,p_identity,link.id,p_session,p_request,duration,10000-budget.spent_ms-duration,deadline) returning * into lease;
  return jsonb_build_object('leaseId',lease.id,'grantedMs',lease.granted_ms,'remainingMs',lease.remaining_ms,'expiresAt',lease.expires_at);
end $$;

-- Several creation requests may resolve to the same active link. Remember every
-- request key so replaying an alias after revocation cannot mint a fresh link.
create table public.peekalo_link_requests (
  post_id uuid not null references public.peekalo_posts(id) on delete cascade,
  nonce uuid not null,
  link_id uuid not null references public.peekalo_links(id) on delete cascade,
  primary key(post_id,nonce)
);
alter table public.peekalo_link_requests enable row level security;
revoke all on public.peekalo_link_requests from anon,authenticated;
grant all on public.peekalo_link_requests to service_role;
insert into public.peekalo_link_requests(post_id,nonce,link_id)
  select post_id,nonce,id from public.peekalo_links;

create or replace function public.peekalo_create_link(p_owner uuid,p_post uuid,p_nonce uuid,p_hash text)
returns public.peekalo_links language plpgsql security definer set search_path=public as $$
declare result public.peekalo_links;
begin
  perform 1 from peekalo_posts where id=p_post and owner_id=p_owner and status='ready' for update;
  if not found then raise exception 'unavailable'; end if;
  -- A retry of an old key must return that key's result, even after replacement.
  select l.* into result from peekalo_link_requests r join peekalo_links l on l.id=r.link_id
    where r.post_id=p_post and r.nonce=p_nonce;
  if found then return result; end if;
  -- Also recognize canonical rows inserted by legacy requests during rollout.
  select * into result from peekalo_links where post_id=p_post and nonce=p_nonce;
  if found then
    insert into peekalo_link_requests(post_id,nonce,link_id) values(p_post,p_nonce,result.id);
    return result;
  end if;
  select * into result from peekalo_links where post_id=p_post and not revoked and expires_at>clock_timestamp() order by expires_at desc limit 1;
  if not found then
    insert into peekalo_links(post_id,nonce,token_hash) values(p_post,p_nonce,p_hash) returning * into result;
  end if;
  insert into peekalo_link_requests(post_id,nonce,link_id) values(p_post,p_nonce,result.id);
  return result;
end $$;

-- CREATE OR REPLACE preserves existing ACLs; keep the service-only boundary explicit.
revoke all on function public.peekalo_lease(text,uuid,uuid,text,uuid), public.peekalo_create_link(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.peekalo_lease(text,uuid,uuid,text,uuid), public.peekalo_create_link(uuid,uuid,uuid,text) to service_role;
