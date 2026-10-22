-- Upload retries need both database fencing AND attempt-specific Storage paths.
-- Deploy only with the fenced gateway: legacy direct status/path writes do not
-- participate in this protocol. No viewing budget, grant or link is changed.
alter table public.peekalo_posts
  add column upload_attempt uuid,
  add column upload_expires_at timestamptz;

-- Old in-flight work has no fencing token and may be reclaimed on its next
-- deliberate retry. Its legacy flat object path must not be reused by retries.
create or replace function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.peekalo_posts; stamp timestamptz;
begin
  if p_owner is null or p_key is null or p_kind is null or p_kind not in ('photo','video') or
      (p_limit is not null and (p_limit<1 or p_limit>99)) then raise exception 'conflict'; end if;
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

create function public.peekalo_finish_upload(p_owner uuid,p_post uuid,p_attempt uuid,p_path text)
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
  if result.status='ready' then return result.storage_path=p_path; end if;
  if result.status<>'uploading' or result.upload_attempt is distinct from p_attempt or
      result.upload_expires_at is null or result.upload_expires_at<=clock_timestamp() then return false; end if;
  update peekalo_posts set status='ready',storage_path=p_path,upload_attempt=null,upload_expires_at=null where id=result.id;
  return true;
end $$;

create function public.peekalo_fail_upload(p_owner uuid,p_post uuid,p_attempt uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
  update peekalo_posts set status='failed',storage_path=null,upload_attempt=null,upload_expires_at=null
    where id=p_post and owner_id=p_owner and status='uploading' and upload_attempt=p_attempt;
  return found;
end $$;

revoke all on function public.peekalo_reserve_post(uuid,uuid,text,integer), public.peekalo_finish_upload(uuid,uuid,uuid,text), public.peekalo_fail_upload(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.peekalo_reserve_post(uuid,uuid,text,integer), public.peekalo_finish_upload(uuid,uuid,uuid,text), public.peekalo_fail_upload(uuid,uuid,uuid)
  to service_role;

-- The gateway cannot bypass fencing through PostgREST table writes. Existing
-- SELECT/DELETE rights and the security-definer sharing/revocation RPCs remain.
revoke insert,update on public.peekalo_posts from service_role;
