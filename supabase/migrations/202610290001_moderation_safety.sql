-- REL-03: manual invited-beta publication gate and service-only safety workflow.
-- Apply after media_controls and deploy with its matching gateway. Existing
-- ready captures remain private/preserved, but must be reviewed before delivery.
alter table public.peekalo_posts drop constraint peekalo_posts_status_check;
alter table public.peekalo_posts add constraint peekalo_posts_status_check check
 (status in ('uploading','moderation_pending','ready','rejected','taken_down','failed','deleted'));
update public.peekalo_posts set status='moderation_pending' where status='ready';
alter table public.peekalo_profiles add column review_state text not null default 'pending'
 check(review_state in ('pending','approved','rejected'));
alter table public.peekalo_profiles add column created_at timestamptz not null default clock_timestamp();

create table public.peekalo_operators (
 account_id uuid primary key references auth.users(id) on delete cascade,
 enabled boolean not null default true
);
create table public.peekalo_blocks (
 blocker_id uuid not null references auth.users(id) on delete cascade,
 blocked_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp(),
 primary key(blocker_id,blocked_id), check(blocker_id<>blocked_id)
);
create index peekalo_blocks_target on public.peekalo_blocks(blocked_id,blocker_id);
create table public.peekalo_reports (
 id uuid primary key default gen_random_uuid(),
 reporter_identity text not null check(reporter_identity ~ '^[ag]:[0-9a-f-]{36}$'),
 target_kind text not null check(target_kind in ('post','account')),
 target_id uuid not null,
 reason text not null check(reason in ('child_safety','sexual_content','violence','harassment','privacy','spam','other')),
 details text not null check(length(details)<=2000),
 state text not null default 'open' check(state in ('open','resolved','dismissed')),
 resolution text check(length(resolution)<=1000),
 resolved_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz
);
create index peekalo_reports_queue on public.peekalo_reports(state,created_at);
create index peekalo_reports_identity on public.peekalo_reports(reporter_identity,created_at);
create table public.peekalo_safety_audit (
 id bigint generated always as identity primary key,
 operator_id uuid references auth.users(id) on delete set null,
 event text not null,
 target_id uuid,
 note text check(length(note)<=1000),
 created_at timestamptz not null default clock_timestamp()
);
-- No mobile/web user can self-assign operator authority, read reports or audit,
-- or write block rows. Gateway entry points are SECURITY DEFINER RPCs below.
alter table public.peekalo_operators enable row level security;
alter table public.peekalo_blocks enable row level security;
alter table public.peekalo_reports enable row level security;
alter table public.peekalo_safety_audit enable row level security;
revoke all on public.peekalo_operators,public.peekalo_blocks,public.peekalo_reports,public.peekalo_safety_audit from public,anon,authenticated,service_role;
revoke all on sequence public.peekalo_safety_audit_id_seq from public,anon,authenticated,service_role;

-- Shared lock at authorization entry; rare block changes take it exclusively
-- BEFORE any post/child row. This allows simultaneous reveals while ensuring a
-- completed block cannot race an old grant, acceptance, claim or media check.
-- Existing row order remains post -> link/grant -> budget. No ledger reset.
create function public.peekalo_accounts_blocked(p_left uuid,p_right uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from peekalo_blocks where
  (blocker_id=p_left and blocked_id=p_right) or (blocker_id=p_right and blocked_id=p_left))
$$;
create function public.peekalo_require_operator(p_operator uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
 perform 1 from peekalo_operators where account_id=p_operator and enabled for share;
 if not found or exists(select 1 from peekalo_suspended_accounts where account_id=p_operator) then raise exception 'forbidden'; end if;
end $$;

create or replace function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.peekalo_posts; stamp timestamptz;
begin
  if p_owner is null or p_key is null or p_kind is null or p_kind not in ('photo','video') or
      (p_limit is not null and (p_limit<1 or p_limit>99)) then raise exception 'conflict'; end if;
  -- Callers may request a stricter test/operational cap, never a bypass of D-25.
  p_limit:=least(coalesce(p_limit,3),3);
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
  stamp:=clock_timestamp();
  select * into result from peekalo_posts where owner_id=p_owner and upload_key=p_key for update;
  if found then
    if result.kind<>p_kind then raise exception 'conflict'; end if;
    if result.status='uploading' and (result.upload_expires_at is null or result.upload_expires_at<=stamp) then
      -- Invalidate the previous token before assigning new ownership below.
      update peekalo_posts set status='failed',storage_path=null,upload_attempt=null,upload_expires_at=null
        where id=result.id returning * into result;
    end if;
    if result.status='deleted' then raise exception 'unavailable'; end if;
    if result.status='rejected' then raise exception 'rejected'; end if;
    if result.status='taken_down' then raise exception 'taken_down'; end if;
    if result.status<>'failed' then
      return to_jsonb(result) || jsonb_build_object('reserved',false);
    end if;
    if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and
        (status in ('ready','moderation_pending') or (status='uploading' and upload_expires_at>stamp)))>=p_limit then raise exception 'quota'; end if;
    update peekalo_posts set status='uploading',storage_path=null,upload_attempt=gen_random_uuid(),upload_expires_at=stamp+interval '5 minutes'
      where id=result.id returning * into result;
  else
    -- Dead reservations do not pin slots even when the next request uses a new
    -- key. Their old tokens cannot finish; reclaiming their own key rotates it.
    if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and
        (status in ('ready','moderation_pending') or (status='uploading' and upload_expires_at>stamp)))>=p_limit then raise exception 'quota'; end if;
    insert into peekalo_posts(owner_id,upload_key,kind,upload_attempt,upload_expires_at)
      values(p_owner,p_key,p_kind,gen_random_uuid(),stamp+interval '5 minutes') returning * into result;
  end if;
  return to_jsonb(result) || jsonb_build_object('reserved',true);
end $$;



create or replace function public.peekalo_finish_upload(p_owner uuid,p_post uuid,p_attempt uuid,p_path text)
returns boolean language plpgsql security definer set search_path=public as $$
declare result public.peekalo_posts;
begin
  -- Serialize publication with quota accounting; an uncommitted completion
  -- must not look like an expired reservation to a competing new upload.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
  select * into result from peekalo_posts where id=p_post and owner_id=p_owner for update;
  if not found or p_attempt is null then return false; end if;
  if p_path is distinct from (p_owner::text || '/' || p_post::text || '/' || p_attempt::text ||
      case when result.kind='photo' then '.jpg' else '.mp4' end) then return false; end if;
  -- A committed publication may lose its HTTP reply. Only that same attempt's
  -- exact object can replay success; no status/link/grant/budget is changed.
  if result.status in ('ready','moderation_pending') then return result.storage_path=p_path; end if;
  if result.status<>'uploading' or result.upload_attempt is distinct from p_attempt or
      result.upload_expires_at is null or result.upload_expires_at<=clock_timestamp() then return false; end if;
  update peekalo_posts set status='moderation_pending',storage_path=p_path,upload_attempt=null,upload_expires_at=null where id=result.id;
  return true;
end $$;


create or replace function public.peekalo_own_posts(p_owner uuid)
returns jsonb language sql security definer set search_path=public as $$
 with quota as (
   select count(*)::integer as active from peekalo_posts where owner_id=p_owner
     and (status in ('ready','moderation_pending') or (status='uploading' and upload_expires_at>clock_timestamp()))
 ), items as (
   select p.id,p.created_at,jsonb_build_object('postId',p.id,'kind',p.kind,
     'status',case when p.status='uploading' and (p.upload_expires_at is null or p.upload_expires_at<=clock_timestamp()) then 'failed' else p.status end,
     'createdAt',p.created_at,'cleanupPending',p.status='deleted' and p.storage_path is not null,
     'link',coalesce((select jsonb_build_object('state',case when l.revoked then 'revoked' when l.expires_at<=clock_timestamp() then 'expired' when l.claimed_identity is not null then 'claimed' else 'active' end,'expiresAt',l.expires_at)
       from peekalo_links l where l.post_id=p.id order by l.expires_at desc,l.id desc limit 1),jsonb_build_object('state','none')),
     'recipients',coalesce((select jsonb_agg(jsonb_build_object('accountId',g.recipient_id,'username',case when r.review_state='approved' then r.username else null end,'requestState',g.request_state,'revoked',g.revoked) order by g.created_at desc)
       from peekalo_grants g join peekalo_profiles r on r.id=g.recipient_id where g.post_id=p.id),'[]'::jsonb)) as item
   from peekalo_posts p where p.owner_id=p_owner and (p.status<>'deleted' or p.storage_path is not null)
   order by p.created_at desc,p.id desc limit 100
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by created_at desc,id desc) from items),'[]'::jsonb),
   'limit',3,'activeCount',quota.active,'availableSlots',greatest(0,3-quota.active)) from quota
$$;


-- Account suspension is distinct from user blocking and applies to anonymous
-- links too. It does not delete captures or reset their allowances.
create table public.peekalo_suspended_accounts (
 account_id uuid primary key references auth.users(id) on delete cascade,
 reason text not null check(length(reason) between 1 and 1000),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.peekalo_suspended_accounts enable row level security;
revoke all on public.peekalo_suspended_accounts from public,anon,authenticated,service_role;
create function public.peekalo_operator_membership_audit()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into peekalo_safety_audit(event,target_id,note) values('operator_membership',coalesce(new.account_id,old.account_id),
  case when tg_op='DELETE' then 'removed' when new.enabled then 'enabled' else 'disabled' end);
 return coalesce(new,old);
end $$;
create trigger peekalo_operator_membership_changes after insert or update or delete on public.peekalo_operators
 for each row execute function public.peekalo_operator_membership_audit();

create function public.peekalo_account_available(p_account uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select p_account is null or not exists(select 1 from peekalo_suspended_accounts where account_id=p_account)
$$;
create function public.peekalo_check_identity(p_identity text)
returns uuid language plpgsql immutable security definer set search_path=public as $$
begin
 if p_identity is null then return null; end if;
 if p_identity !~ '^[ag]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'unauthorized'; end if;
 if left(p_identity,2)='a:' then return substring(p_identity from 3)::uuid; end if;
 return null;
end $$;
create function public.peekalo_check_viewer(p_owner uuid,p_identity text)
returns void language plpgsql security definer set search_path=public as $$
declare viewer uuid;
begin
 viewer:=peekalo_check_identity(p_identity);
 if not peekalo_account_available(p_owner) or not peekalo_account_available(viewer) then raise exception 'unavailable'; end if;
 if peekalo_accounts_blocked(p_owner,viewer) then raise exception 'blocked'; end if;
end $$;

-- Preserve proven ledger/idempotency implementations behind new entry guards.
-- These renamed internals have no API role execution privilege.
alter function public.peekalo_lease(text,uuid,uuid,text,uuid) rename to peekalo_lease_before_safety;
create function public.peekalo_lease(p_identity text,p_session uuid,p_request uuid,p_hash text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 if p_hash is not null then select post_id into p_post from peekalo_links where token_hash=p_hash; end if;
 select owner_id into owner from peekalo_posts where id=p_post for share;
 if not found then raise exception 'unavailable'; end if;
 perform peekalo_check_viewer(owner,p_identity);
 return peekalo_lease_before_safety(p_identity,p_session,p_request,p_hash,p_post);
end $$;
alter function public.peekalo_media(text,uuid) rename to peekalo_media_before_safety;
create function public.peekalo_media(p_identity text,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid; post uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select post_id into post from peekalo_leases where id=p_lease and identity=p_identity;
 select owner_id into owner from peekalo_posts where id=post for share;
 if not found then raise exception 'unavailable'; end if;
 perform peekalo_check_viewer(owner,p_identity);
 return peekalo_media_before_safety(p_identity,p_lease);
end $$;
alter function public.peekalo_view_status(text,text,uuid) rename to peekalo_view_status_before_safety;
create function public.peekalo_view_status(p_identity text,p_hash text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 if p_hash is not null then select post_id into p_post from peekalo_links where token_hash=p_hash; end if;
 select owner_id into owner from peekalo_posts where id=p_post for share;
 if not found then raise exception 'unavailable'; end if;
 perform peekalo_check_viewer(owner,p_identity);
 return peekalo_view_status_before_safety(p_identity,p_hash,p_post);
end $$;
alter function public.peekalo_preview(text) rename to peekalo_preview_before_safety;
create function public.peekalo_preview(p_hash text,p_identity text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid; post uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select post_id into post from peekalo_links where token_hash=p_hash;
 select owner_id into owner from peekalo_posts where id=post for share;
 if not found then return jsonb_build_object('kind','photo','available',false); end if;
 begin
  perform peekalo_check_viewer(owner,p_identity);
 exception when raise_exception then
  if sqlerrm='blocked' then return jsonb_build_object('kind','photo','available',false,'state','blocked'); end if;
  if sqlerrm='unavailable' then return jsonb_build_object('kind','photo','available',false); end if;
  raise;
 end;
 return peekalo_preview_before_safety(p_hash);
end $$;
alter function public.peekalo_grant(uuid,uuid,text) rename to peekalo_grant_before_safety;
create function public.peekalo_grant(p_owner uuid,p_post uuid,p_username text)
returns text language plpgsql security definer set search_path=public as $$
declare target uuid; state text;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select status into state from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if state='moderation_pending' then raise exception 'moderation_pending'; end if;
 if state='rejected' then raise exception 'rejected'; end if;
 if state='taken_down' then raise exception 'taken_down'; end if;
 select id into target from peekalo_profiles where username=p_username;
 if not peekalo_account_available(p_owner) or not peekalo_account_available(target) then raise exception 'unavailable'; end if;
 if peekalo_accounts_blocked(p_owner,target) then raise exception 'blocked'; end if;
 return peekalo_grant_before_safety(p_owner,p_post,p_username);
end $$;
alter function public.peekalo_accept(uuid,uuid) rename to peekalo_accept_before_safety;
create function public.peekalo_accept(p_recipient uuid,p_post uuid)
returns text language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select owner_id into owner from peekalo_posts where id=p_post and status='ready' for share;
 if not found then raise exception 'unavailable'; end if;
 perform peekalo_check_viewer(owner,'a:' || p_recipient::text);
 return peekalo_accept_before_safety(p_recipient,p_post);
end $$;
alter function public.peekalo_create_link(uuid,uuid,uuid,text) rename to peekalo_create_link_before_safety;
create function public.peekalo_create_link(p_owner uuid,p_post uuid,p_nonce uuid,p_hash text)
returns public.peekalo_links language plpgsql security definer set search_path=public as $$
declare state text;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select status into state from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if state='moderation_pending' then raise exception 'moderation_pending'; end if;
 if state='rejected' then raise exception 'rejected'; end if;
 if state='taken_down' then raise exception 'taken_down'; end if;
 if not peekalo_account_available(p_owner) then raise exception 'unavailable'; end if;
 return peekalo_create_link_before_safety(p_owner,p_post,p_nonce,p_hash);
end $$;
alter function public.peekalo_inbox(uuid) rename to peekalo_inbox_before_safety;
create function public.peekalo_inbox(p_recipient uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 if not peekalo_account_available(p_recipient) then return jsonb_build_object('items','[]'::jsonb); end if;
 select jsonb_build_object('items',coalesce(jsonb_agg(item order by created_at desc,post_id desc),'[]'::jsonb)) into result from (
  select g.created_at,g.post_id,jsonb_build_object('postId',p.id,'kind',p.kind,'senderAccountId',p.owner_id,'senderUsername',case when u.review_state='approved' then u.username else null end,
   'requestState',g.request_state,'remainingMs',case when g.request_state='accepted' then 10000-coalesce(b.spent_ms,0) else null end) as item
  from peekalo_grants g join peekalo_posts p on p.id=g.post_id and p.status='ready'
  left join peekalo_profiles u on u.id=p.owner_id
  left join peekalo_budgets b on b.post_id=p.id and b.identity='a:' || p_recipient::text
  where g.recipient_id=p_recipient and not g.revoked and not peekalo_accounts_blocked(p.owner_id,p_recipient)
   and peekalo_account_available(p.owner_id) order by g.created_at desc,g.post_id desc limit 100
 ) inbox;
 return result;
end $$;
alter function public.peekalo_public_profile(text) rename to peekalo_public_profile_before_safety;
create function public.peekalo_public_profile(p_username text,p_viewer uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select id into owner from peekalo_profiles where username=p_username;
 if not found or not peekalo_account_available(owner) or not peekalo_account_available(p_viewer) or
  peekalo_accounts_blocked(owner,p_viewer) then raise exception 'unavailable'; end if;
 return peekalo_public_profile_before_safety(p_username);
end $$;
create function public.peekalo_lookup_profile(p_viewer uuid,p_username text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform peekalo_public_profile(p_username,p_viewer);
 return jsonb_build_object('username',p_username);
end $$;

create function public.peekalo_block(p_actor uuid,p_username text,p_blocked boolean,p_target uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target uuid; item record;
begin
 if p_actor is null or p_blocked is null then raise exception 'unauthorized'; end if;
 if (p_username is null)=(p_target is null) then raise exception 'conflict'; end if;
 perform pg_advisory_xact_lock(730293001);
 if p_target is not null then
  select id into target from peekalo_profiles where id=p_target;
 else
  select id into target from peekalo_profiles where username=p_username and review_state='approved';
 end if;
 if target is null or target=p_actor then raise exception 'recipient'; end if;
 if p_blocked then
  -- Lock every affected post in a stable order before touching grants/links.
  for item in select id from peekalo_posts where owner_id in (p_actor,target) order by id for update loop
   update peekalo_grants set revoked=true where post_id=item.id and
    ((recipient_id=target and exists(select 1 from peekalo_posts where id=item.id and owner_id=p_actor)) or
     (recipient_id=p_actor and exists(select 1 from peekalo_posts where id=item.id and owner_id=target)));
   update peekalo_links set revoked=true where post_id=item.id and
    ((claimed_identity='a:' || target::text and exists(select 1 from peekalo_posts where id=item.id and owner_id=p_actor)) or
     (claimed_identity='a:' || p_actor::text and exists(select 1 from peekalo_posts where id=item.id and owner_id=target)));
  end loop;
  insert into peekalo_blocks(blocker_id,blocked_id) values(p_actor,target) on conflict do nothing;
 else
  delete from peekalo_blocks where blocker_id=p_actor and blocked_id=target;
 end if;
 return jsonb_build_object('blocked',p_blocked);
end $$;
create function public.peekalo_blocks(p_actor uuid)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('accountId',b.blocked_id,'username',case when p.review_state='approved' then p.username else null end,'createdAt',b.created_at) order by b.created_at desc),'[]'::jsonb))
 from peekalo_blocks b join peekalo_profiles p on p.id=b.blocked_id where b.blocker_id=p_actor
$$;

-- Extensible report target contract: REL-06 adds authorized comment/message
-- resolution here, rather than accepting arbitrary IDs for nonexistent content.
create function public.peekalo_report(p_identity text,p_kind text,p_reason text,p_details text default '',p_post uuid default null,p_username text default null,p_hash text default null,p_account uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid; target uuid; result uuid;
begin
 actor:=peekalo_check_identity(p_identity);
 if p_identity is null then raise exception 'unauthorized'; end if;
 if p_kind not in ('post','account') or p_kind is null or p_reason is null or p_reason not in
  ('child_safety','sexual_content','violence','harassment','privacy','spam','other') or
  p_details is null or length(p_details)>2000 then raise exception 'conflict'; end if;
 if p_kind='account' then
  if (p_username is null)=(p_account is null) or p_post is not null or p_hash is not null then raise exception 'conflict'; end if;
  if p_account is not null then
   if actor is null then raise exception 'unauthorized'; end if;
   select id into target from peekalo_profiles where id=p_account;
  else
   select id into target from peekalo_profiles where username=p_username and review_state='approved';
  end if;
  if not found then raise exception 'unavailable'; end if;
 else
  if p_account is not null or p_username is not null then raise exception 'conflict'; end if;
  target:=p_post;
  if p_hash is not null then
   -- An available/claimed capability may report even after exhaustion; reporting
   -- never claims, refreshes or debits a link. A third party cannot guess post IDs.
   select l.post_id into target from peekalo_links l join peekalo_posts p on p.id=l.post_id
    where l.token_hash=p_hash and not l.revoked and l.expires_at>clock_timestamp() and p.status='ready';
   if not found or (p_post is not null and p_post<>target) then raise exception 'unavailable'; end if;
  elsif actor is null or not exists(select 1 from peekalo_posts p where p.id=target and
   (p.owner_id=actor or exists(select 1 from peekalo_grants g where g.post_id=p.id and g.recipient_id=actor))) then
   raise exception 'unavailable';
  end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_identity,730293002));
 select id into result from peekalo_reports where reporter_identity=p_identity and target_kind=p_kind and target_id=target and state='open' order by created_at limit 1;
 if found then
  -- An urgent follow-up must not remain buried behind an earlier spam report.
  if p_reason='child_safety' then update peekalo_reports set reason=p_reason,details=p_details where id=result; end if;
  return jsonb_build_object('reportId',result,'state','open');
 end if;
 if (select count(*) from peekalo_reports where reporter_identity=p_identity and created_at>clock_timestamp()-interval '1 hour')>=10 then raise exception 'rate_limited'; end if;
 insert into peekalo_reports(reporter_identity,target_kind,target_id,reason,details) values(p_identity,p_kind,target,p_reason,p_details) returning id into result;
 return jsonb_build_object('reportId',result,'state','open');
end $$;

create function public.peekalo_moderation_media(p_operator uuid,p_post uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare post peekalo_posts;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 select * into post from peekalo_posts where id=p_post and status in ('moderation_pending','ready','rejected','taken_down') and storage_path is not null for share;
 if not found then raise exception 'unavailable'; end if;
 insert into peekalo_safety_audit(operator_id,event,target_id) values(p_operator,'media_read',p_post);
 return jsonb_build_object('path',post.storage_path,'kind',post.kind);
end $$;
create function public.peekalo_moderate(p_operator uuid,p_post uuid,p_action text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare post peekalo_posts; next_status text;
begin
 if p_reason is null or length(trim(p_reason)) not between 1 and 1000 or p_action is null or p_action not in ('approve','reject','takedown') then raise exception 'conflict'; end if;
 select owner_id into post.owner_id from peekalo_posts where id=p_post;
 if not found then raise exception 'unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(post.owner_id::text,0));
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 select * into post from peekalo_posts where id=p_post for update;
 if not found then raise exception 'unavailable'; end if;
 if p_action='approve' then
  if post.owner_id=p_operator then raise exception 'forbidden'; end if;
  if post.status<>'moderation_pending' or not peekalo_account_available(post.owner_id) then raise exception 'unavailable'; end if;
  next_status:='ready';
 elsif p_action='reject' then
  if post.status<>'moderation_pending' then raise exception 'unavailable'; end if;
  next_status:='rejected';
 else
  if post.status not in ('ready','moderation_pending','rejected','taken_down') then raise exception 'unavailable'; end if;
  next_status:='taken_down';
 end if;
 update peekalo_posts set status=next_status where id=post.id;
 if next_status<>'ready' then
  update peekalo_links set revoked=true where post_id=post.id;
  update peekalo_grants set revoked=true where post_id=post.id;
 end if;
 insert into peekalo_safety_audit(operator_id,event,target_id,note) values(p_operator,p_action,p_post,p_reason);
 return jsonb_build_object('postId',p_post,'status',next_status);
end $$;
create function public.peekalo_resolve_report(p_operator uuid,p_report uuid,p_resolution text,p_state text default 'resolved')
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 if p_state is null or p_state not in ('resolved','dismissed') or p_resolution is null or length(trim(p_resolution)) not between 1 and 1000 then raise exception 'conflict'; end if;
 update peekalo_reports set state=p_state,resolution=p_resolution,resolved_by=p_operator,resolved_at=clock_timestamp() where id=p_report and state='open';
 if not found then raise exception 'unavailable'; end if;
 insert into peekalo_safety_audit(operator_id,event,target_id,note) values(p_operator,'report_' || p_state,p_report,p_resolution);
 return jsonb_build_object('reportId',p_report,'state',p_state);
end $$;
create function public.peekalo_moderation_audit(p_operator uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 insert into peekalo_safety_audit(operator_id,event) values(p_operator,'audit_read');
 select jsonb_build_object('items',coalesce(jsonb_agg(item order by id desc),'[]'::jsonb)) into result from (
  select id,jsonb_build_object('id',id,'operatorId',operator_id,'event',event,'targetId',target_id,'note',note,'createdAt',created_at) as item
  from peekalo_safety_audit order by id desc limit 100
 ) records;
 return result;
end $$;
create function public.peekalo_moderate_account(p_operator uuid,p_username text,p_action text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target uuid; item record;
begin
 if p_action is null or p_action not in ('suspend','restore') or p_reason is null or length(trim(p_reason)) not between 1 and 1000 then raise exception 'conflict'; end if;
 perform pg_advisory_xact_lock(730293001);
 perform peekalo_require_operator(p_operator);
 select id into target from peekalo_profiles where username=p_username;
 if not found then raise exception 'unavailable'; end if;
 if p_action='suspend' then
  for item in select id from peekalo_posts where owner_id=target or id in (select post_id from peekalo_grants where recipient_id=target)
   or id in (select post_id from peekalo_links where claimed_identity='a:' || target::text) order by id for update loop
   update peekalo_grants set revoked=true where post_id=item.id and (recipient_id=target or exists(select 1 from peekalo_posts where id=item.id and owner_id=target));
   update peekalo_links set revoked=true where post_id=item.id and (claimed_identity='a:' || target::text or exists(select 1 from peekalo_posts where id=item.id and owner_id=target));
  end loop;
  insert into peekalo_suspended_accounts(account_id,reason) values(target,p_reason) on conflict(account_id) do update set reason=excluded.reason;
 else
  delete from peekalo_suspended_accounts where account_id=target;
 end if;
 insert into peekalo_safety_audit(operator_id,event,target_id,note) values(p_operator,'account_' || p_action,target,p_reason);
 return jsonb_build_object('username',p_username,'state',case when p_action='suspend' then 'suspended' else 'active' end);
end $$;
-- Usernames are public UGC too. New or changed names stay out of public profile,
-- recipient discovery and publication until a separate operator approves them.
revoke insert,update,delete on public.peekalo_profiles from service_role;
create function public.peekalo_save_profile(p_actor uuid,p_username text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result peekalo_profiles;
begin
 if p_actor is null then raise exception 'unauthorized'; end if;
 if p_username is null or p_username !~ '^[a-z0-9_]{3,24}$' then raise exception 'username'; end if;
 perform pg_advisory_xact_lock_shared(730293001);
 if exists(select 1 from peekalo_suspended_accounts where account_id=p_actor) then raise exception 'unavailable'; end if;
 begin
  insert into peekalo_profiles(id,username) values(p_actor,p_username) on conflict(id) do update
   set username=excluded.username,review_state=case when peekalo_profiles.username=excluded.username then peekalo_profiles.review_state else 'pending' end
   returning * into result;
 exception when unique_violation then raise exception 'username_taken';
 end;
 return jsonb_build_object('username',result.username,'reviewState',result.review_state);
end $$;
create or replace function public.peekalo_account_available(p_account uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select p_account is null or (not exists(select 1 from peekalo_suspended_accounts where account_id=p_account)
  and exists(select 1 from peekalo_profiles where id=p_account and review_state='approved'))
$$;
-- Preserve the existing quota protocol but prevent a suspended account starting
-- or retrying an upload. Pending profile approval may still capture/upload.
alter function public.peekalo_reserve_post(uuid,uuid,text,integer) rename to peekalo_reserve_post_before_safety;
create function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 -- Quota lock precedes safety lock, matching moderation decisions/deletion.
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 perform pg_advisory_xact_lock_shared(730293001);
 if exists(select 1 from peekalo_suspended_accounts where account_id=p_owner) then raise exception 'suspended'; end if;
 return peekalo_reserve_post_before_safety(p_owner,p_key,p_kind,p_limit);
end $$;
create function public.peekalo_moderate_profile(p_operator uuid,p_username text,p_action text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target uuid; state text;
begin
 if p_action is null or p_action not in ('approve','reject') or p_reason is null or length(trim(p_reason)) not between 1 and 1000 then raise exception 'conflict'; end if;
 -- Changing profile availability must serialize with all identified access,
 -- including lookups/public profiles that don't otherwise lock a post.
 perform pg_advisory_xact_lock(730293001);
 perform peekalo_require_operator(p_operator);
 select id into target from peekalo_profiles where username=p_username for update;
 if not found then raise exception 'unavailable'; end if;
 if p_operator=target then raise exception 'forbidden'; end if;
 state:=case when p_action='approve' then 'approved' else 'rejected' end;
 update peekalo_profiles set review_state=state where id=target;
 insert into peekalo_safety_audit(operator_id,event,target_id,note) values(p_operator,'profile_' || p_action,target,p_reason);
 return jsonb_build_object('username',p_username,'reviewState',state);
end $$;
-- Replace queue once profile moderation fields exist. Only bounded metadata is
-- returned; clear originals require the separately audited media entry point.
create function public.peekalo_moderation_queue(p_operator uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare posts jsonb; reports jsonb; profiles jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 insert into peekalo_safety_audit(operator_id,event) values(p_operator,'queue_read');
 select coalesce(jsonb_agg(item order by created_at,id),'[]'::jsonb) into posts from (
  select p.created_at,p.id,jsonb_build_object('postId',p.id,'username',u.username,'kind',p.kind,'status',p.status,'createdAt',p.created_at) as item
   from peekalo_posts p left join peekalo_profiles u on u.id=p.owner_id where p.status='moderation_pending' order by p.created_at,p.id limit 100
 ) pending;
 select coalesce(jsonb_agg(item order by created_at,id),'[]'::jsonb) into profiles from (
  select created_at,id,jsonb_build_object('username',username,'reviewState',review_state,'createdAt',created_at) as item
  from peekalo_profiles where review_state='pending' order by created_at,id limit 100
 ) names;
 select coalesce(jsonb_agg(item order by priority,created_at,id),'[]'::jsonb) into reports from (
  select r.id,r.created_at,case when r.reason='child_safety' then 0 else 1 end as priority,
   jsonb_build_object('reportId',r.id,'targetKind',r.target_kind,'postId',case when r.target_kind='post' then r.target_id else null end,
    'username',u.username,'reason',r.reason,'details',r.details,'state',r.state,'createdAt',r.created_at) as item
  from peekalo_reports r left join peekalo_posts p on r.target_kind='post' and p.id=r.target_id
  left join peekalo_profiles u on u.id=case when r.target_kind='account' then r.target_id else p.owner_id end
  where r.state='open' order by priority,r.created_at,r.id limit 100
 ) open_reports;
 return jsonb_build_object('posts',posts,'profiles',profiles,'reports',reports);
end $$;

-- The result pins the actual granted account while the approved username row
-- is locked. A changed/recycled username can never retarget a later revoke.
create function public.peekalo_grant_target(p_owner uuid,p_post uuid,p_username text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target uuid; state text;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 select id into target from peekalo_profiles where username=p_username and review_state='approved' for share;
 if not found then raise exception 'recipient'; end if;
 state:=peekalo_grant(p_owner,p_post,p_username);
 return jsonb_build_object('requestState',state,'accountId',target);
end $$;
create function public.peekalo_revoke_recipient(p_owner uuid,p_post uuid,p_recipient uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_recipient is null then raise exception 'recipient'; end if;
 perform 1 from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if not found then raise exception 'unavailable'; end if;
 update peekalo_grants set revoked=true where post_id=p_post and recipient_id=p_recipient;
 return true;
end $$;

-- Revoke renamed bypasses and private helpers explicitly. Only these validated
-- service entry points are API-callable. Neither an Auth claim nor user metadata
-- grants moderation rights; only the admin-managed allowlist does.
revoke all on function public.peekalo_lease_before_safety(text,uuid,uuid,text,uuid),public.peekalo_media_before_safety(text,uuid),
 public.peekalo_view_status_before_safety(text,text,uuid),public.peekalo_preview_before_safety(text),public.peekalo_grant_before_safety(uuid,uuid,text),
 public.peekalo_accept_before_safety(uuid,uuid),public.peekalo_create_link_before_safety(uuid,uuid,uuid,text),public.peekalo_inbox_before_safety(uuid),
 public.peekalo_public_profile_before_safety(text),public.peekalo_reserve_post_before_safety(uuid,uuid,text,integer),
 public.peekalo_accounts_blocked(uuid,uuid),public.peekalo_account_available(uuid),public.peekalo_check_identity(text),public.peekalo_check_viewer(uuid,text),
 public.peekalo_require_operator(uuid),public.peekalo_operator_membership_audit()
 from public,anon,authenticated,service_role;
revoke all on function public.peekalo_preview(text,text),public.peekalo_public_profile(text,uuid),public.peekalo_lookup_profile(uuid,text),
 public.peekalo_lease(text,uuid,uuid,text,uuid),public.peekalo_media(text,uuid),public.peekalo_view_status(text,text,uuid),public.peekalo_grant(uuid,uuid,text),
 public.peekalo_accept(uuid,uuid),public.peekalo_create_link(uuid,uuid,uuid,text),public.peekalo_inbox(uuid),public.peekalo_reserve_post(uuid,uuid,text,integer),
 public.peekalo_block(uuid,text,boolean,uuid),public.peekalo_blocks(uuid),public.peekalo_report(text,text,text,text,uuid,text,text,uuid),
 public.peekalo_moderation_queue(uuid),public.peekalo_moderation_media(uuid,uuid),public.peekalo_moderate(uuid,uuid,text,text),
 public.peekalo_resolve_report(uuid,uuid,text,text),public.peekalo_moderation_audit(uuid),public.peekalo_moderate_account(uuid,text,text,text),
 public.peekalo_save_profile(uuid,text),public.peekalo_moderate_profile(uuid,text,text,text),public.peekalo_grant_target(uuid,uuid,text),public.peekalo_revoke_recipient(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.peekalo_preview(text,text),public.peekalo_public_profile(text,uuid),public.peekalo_lookup_profile(uuid,text),
 public.peekalo_lease(text,uuid,uuid,text,uuid),public.peekalo_media(text,uuid),public.peekalo_view_status(text,text,uuid),public.peekalo_grant(uuid,uuid,text),
 public.peekalo_accept(uuid,uuid),public.peekalo_create_link(uuid,uuid,uuid,text),public.peekalo_inbox(uuid),public.peekalo_reserve_post(uuid,uuid,text,integer),
 public.peekalo_block(uuid,text,boolean,uuid),public.peekalo_blocks(uuid),public.peekalo_report(text,text,text,text,uuid,text,text,uuid),
 public.peekalo_moderation_queue(uuid),public.peekalo_moderation_media(uuid,uuid),public.peekalo_moderate(uuid,uuid,text,text),
 public.peekalo_resolve_report(uuid,uuid,text,text),public.peekalo_moderation_audit(uuid),public.peekalo_moderate_account(uuid,text,text,text),
 public.peekalo_save_profile(uuid,text),public.peekalo_moderate_profile(uuid,text,text,text),public.peekalo_grant_target(uuid,uuid,text),public.peekalo_revoke_recipient(uuid,uuid,uuid) to service_role;
