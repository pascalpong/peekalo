-- Service-only media and reveal ledger. No client role can read originals or mutate grants.
create table public.peekalo_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$')
);
create table public.peekalo_posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  upload_key uuid not null,
  kind text not null check (kind in ('photo','video')),
  status text not null default 'uploading' check (status in ('uploading','ready','failed','deleted')),
  storage_path text,
  created_at timestamptz not null default now(),
  unique(owner_id,upload_key)
);
create table public.peekalo_links (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.peekalo_posts(id) on delete cascade,
  nonce uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null default now() + interval '24 hours',
  revoked boolean not null default false,
  claimed_identity text,
  unique(post_id,nonce)
);
create table public.peekalo_grants (
  post_id uuid not null references public.peekalo_posts(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  request_state text not null default 'pending' check(request_state in ('pending','accepted')),
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(post_id,recipient_id)
);
create table public.peekalo_budgets (
  post_id uuid not null references public.peekalo_posts(id) on delete cascade,
  identity text not null,
  spent_ms integer not null default 0 check(spent_ms between 0 and 10000),
  active_session uuid,
  active_until timestamptz,
  primary key(post_id,identity)
);
create table public.peekalo_leases (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.peekalo_posts(id) on delete cascade,
  identity text not null,
  link_id uuid references public.peekalo_links(id) on delete cascade,
  session_id uuid not null,
  request_id uuid not null,
  granted_ms integer not null,
  remaining_ms integer not null,
  expires_at timestamptz not null,
  unique(post_id,identity,request_id)
);
create index peekalo_grants_inbox on public.peekalo_grants(recipient_id,created_at desc);
create index peekalo_links_post on public.peekalo_links(post_id);

alter table public.peekalo_profiles enable row level security;
alter table public.peekalo_posts enable row level security;
alter table public.peekalo_links enable row level security;
alter table public.peekalo_grants enable row level security;
alter table public.peekalo_budgets enable row level security;
alter table public.peekalo_leases enable row level security;
revoke all on public.peekalo_profiles, public.peekalo_posts, public.peekalo_links, public.peekalo_grants, public.peekalo_budgets, public.peekalo_leases from anon, authenticated;
grant all on public.peekalo_profiles, public.peekalo_posts, public.peekalo_links, public.peekalo_grants, public.peekalo_budgets, public.peekalo_leases to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values ('peekalo-captures','peekalo-captures',false,31457280) on conflict(id) do update set public=false;

create function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.peekalo_posts;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into result from peekalo_posts where owner_id=p_owner and upload_key=p_key for update;
 if found then
   if result.kind <> p_kind then raise exception 'conflict'; end if;
   if result.status='failed' then
     update peekalo_posts set status='uploading' where id=result.id returning * into result;
     return to_jsonb(result) || jsonb_build_object('reserved',true);
   end if;
   return to_jsonb(result) || jsonb_build_object('reserved',false);
 end if;
 if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and status in ('ready','uploading')) >= p_limit then raise exception 'quota'; end if;
 insert into peekalo_posts(owner_id,upload_key,kind) values(p_owner,p_key,p_kind) returning * into result;
 return to_jsonb(result) || jsonb_build_object('reserved',true);
end $$;

create function public.peekalo_create_link(p_owner uuid,p_post uuid,p_nonce uuid,p_hash text)
returns public.peekalo_links language plpgsql security definer set search_path=public as $$
declare result public.peekalo_links;
begin
 perform 1 from peekalo_posts where id=p_post and owner_id=p_owner and status='ready' for update;
 if not found then raise exception 'unavailable'; end if;
 select * into result from peekalo_links where post_id=p_post and not revoked and expires_at>clock_timestamp() order by expires_at desc limit 1;
 if found then return result; end if;
 -- An old idempotency key must never mint a new unclaimed link.
 select * into result from peekalo_links where post_id=p_post and nonce=p_nonce;
 if found then return result; end if;
 insert into peekalo_links(post_id,nonce,token_hash) values(p_post,p_nonce,p_hash) returning * into result;
 return result;
end $$;

create function public.peekalo_grant(p_owner uuid,p_post uuid,p_username text)
returns text language plpgsql security definer set search_path=public as $$
declare target uuid; state text;
begin
 perform 1 from peekalo_posts where id=p_post and owner_id=p_owner and status='ready' for update;
 if not found then raise exception 'unavailable'; end if;
 select id into target from peekalo_profiles where username=p_username;
 if target is null or target=p_owner then raise exception 'recipient'; end if;
 insert into peekalo_grants(post_id,recipient_id) values(p_post,target) on conflict(post_id,recipient_id) do update set revoked=false returning request_state into state;
 return state;
end $$;

create function public.peekalo_accept(p_recipient uuid,p_post uuid)
returns text language plpgsql security definer set search_path=public as $$
begin
 update peekalo_grants set request_state='accepted' where post_id=p_post and recipient_id=p_recipient and not revoked;
 if not found then raise exception 'unavailable'; end if;
 return 'accepted';
end $$;

create function public.peekalo_preview(p_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 select jsonb_build_object('kind',p.kind,'available',true) into result from peekalo_links l join peekalo_posts p on p.id=l.post_id where l.token_hash=p_hash and not l.revoked and l.expires_at>clock_timestamp() and p.status='ready';
 return coalesce(result,jsonb_build_object('kind','photo','available',false));
end $$;

create function public.peekalo_lease(p_identity text,p_session uuid,p_request uuid,p_hash text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare link public.peekalo_links; post public.peekalo_posts; budget public.peekalo_budgets; lease public.peekalo_leases; stamp timestamptz := clock_timestamp(); duration integer; deadline timestamptz;
begin
 if p_identity !~ '^[ag]:[0-9a-f-]{36}$' then raise exception 'unauthorized'; end if;
 if p_hash is not null then
   select * into link from peekalo_links where token_hash=p_hash for update;
   if not found or link.revoked or link.expires_at<=stamp then raise exception 'unavailable'; end if;
   if link.claimed_identity is not null and link.claimed_identity<>p_identity then raise exception 'claimed'; end if;
   p_post:=link.post_id;
 else
   if left(p_identity,2)<>'a:' then raise exception 'unauthorized'; end if;
   perform 1 from peekalo_grants where post_id=p_post and recipient_id=substring(p_identity from 3)::uuid and request_state='accepted' and not revoked for share;
   if not found then raise exception 'unavailable'; end if;
 end if;
 select * into post from peekalo_posts where id=p_post and status='ready' for share;
 if not found then raise exception 'unavailable'; end if;
 insert into peekalo_budgets(post_id,identity) values(p_post,p_identity) on conflict do nothing;
 select * into budget from peekalo_budgets where post_id=p_post and identity=p_identity for update;
 select * into lease from peekalo_leases where post_id=p_post and identity=p_identity and request_id=p_request;
 if found then
   if lease.session_id<>p_session then raise exception 'conflict'; end if;
   return jsonb_build_object('leaseId',lease.id,'grantedMs',lease.granted_ms,'remainingMs',lease.remaining_ms,'expiresAt',lease.expires_at);
 end if;
 if budget.active_until>stamp and budget.active_session<>p_session then raise exception 'busy'; end if;
 if budget.spent_ms>=10000 then raise exception 'exhausted'; end if;
 -- At most one second may be prepaid ahead, preventing rapid requests from minting a long lease.
 if budget.active_until>stamp+interval '250 milliseconds' then raise exception 'early'; end if;
 duration:=least(1000,10000-budget.spent_ms);
 deadline:=greatest(stamp,coalesce(budget.active_until,stamp)) + duration * interval '1 millisecond';
 if link.id is not null then
   deadline:=least(deadline,link.expires_at);
   update peekalo_links set claimed_identity=p_identity where id=link.id and claimed_identity is null;
 end if;
 update peekalo_budgets set spent_ms=spent_ms+duration,active_session=p_session,active_until=deadline where post_id=p_post and identity=p_identity;
 insert into peekalo_leases(post_id,identity,link_id,session_id,request_id,granted_ms,remaining_ms,expires_at) values(p_post,p_identity,link.id,p_session,p_request,duration,10000-budget.spent_ms-duration,deadline) returning * into lease;
 return jsonb_build_object('leaseId',lease.id,'grantedMs',lease.granted_ms,'remainingMs',lease.remaining_ms,'expiresAt',lease.expires_at);
end $$;

create function public.peekalo_media(p_identity text,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare lease public.peekalo_leases; post public.peekalo_posts; budget public.peekalo_budgets; link public.peekalo_links;
begin
 select * into lease from peekalo_leases where id=p_lease and identity=p_identity;
 if not found then raise exception 'unavailable'; end if;
 select * into budget from peekalo_budgets where post_id=lease.post_id and identity=p_identity;
 if budget.active_session<>lease.session_id or budget.active_until<=clock_timestamp() then raise exception 'expired'; end if;
 select * into post from peekalo_posts where id=lease.post_id and status='ready';
 if not found then raise exception 'unavailable'; end if;
 if lease.link_id is not null then
   select * into link from peekalo_links where id=lease.link_id and not revoked and expires_at>clock_timestamp() and claimed_identity=p_identity;
   if not found then raise exception 'unavailable'; end if;
 else
   perform 1 from peekalo_grants where post_id=post.id and recipient_id=substring(p_identity from 3)::uuid and request_state='accepted' and not revoked;
   if not found then raise exception 'unavailable'; end if;
 end if;
 return jsonb_build_object('path',post.storage_path,'kind',post.kind,'expiresAt',budget.active_until);
end $$;

revoke all on function public.peekalo_reserve_post(uuid,uuid,text,integer), public.peekalo_create_link(uuid,uuid,uuid,text), public.peekalo_grant(uuid,uuid,text), public.peekalo_accept(uuid,uuid), public.peekalo_preview(text), public.peekalo_lease(text,uuid,uuid,text,uuid), public.peekalo_media(text,uuid) from public, anon, authenticated;
grant execute on function public.peekalo_reserve_post(uuid,uuid,text,integer), public.peekalo_create_link(uuid,uuid,uuid,text), public.peekalo_grant(uuid,uuid,text), public.peekalo_accept(uuid,uuid), public.peekalo_preview(text), public.peekalo_lease(text,uuid,uuid,text,uuid), public.peekalo_media(text,uuid) to service_role;
