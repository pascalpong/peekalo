-- D-25: three active moments, with bounded live upload reservations included.
-- Existing over-limit accounts keep every moment and may delete to free capacity.
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
    if result.status<>'failed' then
      return to_jsonb(result) || jsonb_build_object('reserved',false);
    end if;
    if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and
        (status='ready' or (status='uploading' and upload_expires_at>stamp)))>=p_limit then raise exception 'quota'; end if;
    update peekalo_posts set status='uploading',storage_path=null,upload_attempt=gen_random_uuid(),upload_expires_at=stamp+interval '5 minutes'
      where id=result.id returning * into result;
  else
    -- Dead reservations do not pin slots even when the next request uses a new
    -- key. Their old tokens cannot finish; reclaiming their own key rotates it.
    if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and
        (status='ready' or (status='uploading' and upload_expires_at>stamp)))>=p_limit then raise exception 'quota'; end if;
    insert into peekalo_posts(owner_id,upload_key,kind,upload_attempt,upload_expires_at)
      values(p_owner,p_key,p_kind,gen_random_uuid(),stamp+interval '5 minutes') returning * into result;
  end if;
  return to_jsonb(result) || jsonb_build_object('reserved',true);
end $$;


-- Owner-only inventory, including pending object cleanup tombstones for retry.
create function public.peekalo_own_posts(p_owner uuid)
returns jsonb language sql security definer set search_path=public as $$
 with quota as (
   select count(*)::integer as active from peekalo_posts where owner_id=p_owner
     and (status='ready' or (status='uploading' and upload_expires_at>clock_timestamp()))
 ), items as (
   select p.id,p.created_at,jsonb_build_object('postId',p.id,'kind',p.kind,
     'status',case when p.status='uploading' and (p.upload_expires_at is null or p.upload_expires_at<=clock_timestamp()) then 'failed' else p.status end,
     'createdAt',p.created_at,'cleanupPending',p.status='deleted' and p.storage_path is not null,
     'link',coalesce((select jsonb_build_object('state',case when l.revoked then 'revoked' when l.expires_at<=clock_timestamp() then 'expired' when l.claimed_identity is not null then 'claimed' else 'active' end,'expiresAt',l.expires_at)
       from peekalo_links l where l.post_id=p.id order by l.expires_at desc,l.id desc limit 1),jsonb_build_object('state','none')),
     'recipients',coalesce((select jsonb_agg(jsonb_build_object('username',r.username,'requestState',g.request_state,'revoked',g.revoked) order by g.created_at desc)
       from peekalo_grants g join peekalo_profiles r on r.id=g.recipient_id where g.post_id=p.id),'[]'::jsonb)) as item
   from peekalo_posts p where p.owner_id=p_owner and (p.status<>'deleted' or p.storage_path is not null)
   order by p.created_at desc,p.id desc limit 100
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by created_at desc,id desc) from items),'[]'::jsonb),
   'limit',3,'activeCount',quota.active,'availableSlots',greatest(0,3-quota.active)) from quota
$$;

-- No post IDs, storage paths, link capabilities or recipient information is public.
-- Opaque cards are intentionally used until separate processed previews exist.
create function public.peekalo_public_profile(p_username text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare owner uuid; result jsonb;
begin
 select id into owner from peekalo_profiles where username=p_username;
 if not found then raise exception 'unavailable'; end if;
 select coalesce(jsonb_agg(item order by created_at desc,id desc),'[]'::jsonb) into result from (
   select id,created_at,jsonb_build_object('kind',kind,'createdAt',created_at) as item from peekalo_posts
   where owner_id=owner and status='ready' order by created_at desc,id desc limit 100
 ) moments;
 return jsonb_build_object('username',p_username,'items',result);
end $$;

-- Read-only authoritative allowance. Never creates a guest, claims a link,
-- inserts a budget, extends a lease or exposes delivered-media capabilities.
create function public.peekalo_view_status(p_identity text,p_hash text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare post peekalo_posts; link peekalo_links; remaining integer;
begin
 if p_identity is not null and p_identity !~ '^[ag]:[0-9a-f-]{36}$' then raise exception 'unauthorized'; end if;
 if p_hash is not null then
   select post_id into p_post from peekalo_links where token_hash=p_hash;
   if not found then raise exception 'unavailable'; end if;
 elsif p_identity is null or left(p_identity,2)<>'a:' then raise exception 'unauthorized'; end if;
 select * into post from peekalo_posts where id=p_post and status='ready' for share;
 if not found then raise exception 'unavailable'; end if;
 if p_hash is not null then
   select * into link from peekalo_links where token_hash=p_hash and post_id=post.id for share;
   if not found or link.revoked then raise exception 'unavailable'; end if;
   if link.expires_at<=clock_timestamp() then raise exception 'expired'; end if;
   if p_identity='a:' || post.owner_id::text then raise exception 'unavailable'; end if;
   if link.claimed_identity is not null and link.claimed_identity is distinct from p_identity then raise exception 'claimed'; end if;
 else
   perform 1 from peekalo_grants where post_id=post.id and recipient_id=substring(p_identity from 3)::uuid and request_state='accepted' and not revoked for share;
   if not found then raise exception 'unavailable'; end if;
 end if;
 select 10000-spent_ms into remaining from peekalo_budgets where post_id=post.id and identity=p_identity;
 remaining:=coalesce(remaining,10000);
 return jsonb_build_object('kind',post.kind,'remainingMs',remaining,'state',case when remaining=0 then 'exhausted' else 'available' end);
end $$;

-- Post lock precedes child locks, matching leases and revocation. Keep a
-- tombstone so an old upload key cannot republish deleted content.
create function public.peekalo_delete_post(p_owner uuid,p_post uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare post peekalo_posts;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into post from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if not found then raise exception 'unavailable'; end if;
 update peekalo_posts set status='deleted',upload_attempt=null,upload_expires_at=null where id=post.id;
 update peekalo_links set revoked=true where post_id=post.id;
 update peekalo_grants set revoked=true where post_id=post.id;
 return jsonb_build_object('storagePath',post.storage_path);
end $$;
create function public.peekalo_finish_delete(p_owner uuid,p_post uuid,p_path text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 update peekalo_posts set storage_path=null where id=p_post and owner_id=p_owner and status='deleted' and storage_path=p_path;
 return found;
end $$;
revoke all on function public.peekalo_own_posts(uuid),public.peekalo_public_profile(text),public.peekalo_view_status(text,text,uuid),public.peekalo_delete_post(uuid,uuid),public.peekalo_finish_delete(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.peekalo_own_posts(uuid),public.peekalo_public_profile(text),public.peekalo_view_status(text,text,uuid),public.peekalo_delete_post(uuid,uuid),public.peekalo_finish_delete(uuid,uuid,text) to service_role;

create function public.peekalo_inbox(p_recipient uuid)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('items',coalesce(jsonb_agg(item order by created_at desc,post_id desc),'[]'::jsonb)) from (
   select g.created_at,g.post_id,jsonb_build_object('postId',p.id,'kind',p.kind,'senderUsername',coalesce(u.username,'peekalo_user'),
     'requestState',g.request_state,'remainingMs',case when g.request_state='accepted' then 10000-coalesce(b.spent_ms,0) else null end) as item
   from peekalo_grants g join peekalo_posts p on p.id=g.post_id and p.status='ready'
   left join peekalo_profiles u on u.id=p.owner_id
   left join peekalo_budgets b on b.post_id=p.id and b.identity='a:' || p_recipient::text
   where g.recipient_id=p_recipient and not g.revoked order by g.created_at desc,g.post_id desc limit 100
 ) inbox
$$;
revoke all on function public.peekalo_inbox(uuid) from public,anon,authenticated;
grant execute on function public.peekalo_inbox(uuid) to service_role;

-- Compensate a late/ambiguous Storage write only after proving its moment is a
-- permanent owner-scoped tombstone. A lost successful finish reply stays private.
create function public.peekalo_post_deleted(p_owner uuid,p_post uuid)
returns boolean language sql security definer set search_path=public as $$
 select exists(select 1 from peekalo_posts where id=p_post and owner_id=p_owner and status='deleted')
$$;
revoke all on function public.peekalo_post_deleted(uuid,uuid) from public,anon,authenticated;
grant execute on function public.peekalo_post_deleted(uuid,uuid) to service_role;
