-- REL-04. Apply after REL-02 then REL-03, with matching gateway/cleanup runner.
-- Deletion requests survive Auth removal, so provider outages cannot lose work.
create table public.peekalo_account_deletions (
 request_id uuid primary key default gen_random_uuid(),
 account_id uuid not null unique,
 requested_at timestamptz not null default clock_timestamp(),
 not_before timestamptz not null default clock_timestamp()+interval '10 minutes',
 state text not null default 'pending' check(state in ('pending','complete')),
 storage_verified_at timestamptz,
 auth_deleted_at timestamptz,
 provider_required boolean not null default false,
 provider_revoked_at timestamptz,
 revoked_apple_subject_hash text check(revoked_apple_subject_hash ~ '^[0-9a-f]{64}$'),
 attempts integer not null default 0,
 last_attempt_at timestamptz,
 last_error text check(last_error in ('storage_failed','auth_failed','provider_revocation_required','cleanup_failed')),
 completed_at timestamptz,
 backups_reconciled_at timestamptz,
 -- Deliberately no FK to auth.users. A lost Auth deletion reply must retry.
 check(not_before>=requested_at+interval '10 minutes')
);
create table public.peekalo_policy_acceptances (
 account_id uuid not null references auth.users(id) on delete cascade,
 terms_version text not null,
 privacy_version text not null,
 accepted_at timestamptz not null default clock_timestamp(),
 primary key(account_id,terms_version,privacy_version)
);
alter table public.peekalo_account_deletions enable row level security;
alter table public.peekalo_policy_acceptances enable row level security;
revoke all on public.peekalo_account_deletions,public.peekalo_policy_acceptances from public,anon,authenticated,service_role;

-- Durable barrier around outbound Storage writes. Ambiguous writes are never
-- silently timed out into a completed account deletion. REL-05 must reconcile
-- abandoned writers using upstream/process evidence and a fresh prefix sweep.
create table public.peekalo_storage_writers (
 owner_id uuid not null references auth.users(id) on delete cascade,
 attempt_id uuid primary key,
 started_at timestamptz not null default clock_timestamp()
);
alter table public.peekalo_storage_writers enable row level security;
revoke all on public.peekalo_storage_writers from public,anon,authenticated,service_role;

create function public.peekalo_account_access(p_actor uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select p_actor is not null and exists(select 1 from auth.users where id=p_actor)
  and not exists(select 1 from peekalo_account_deletions where account_id=p_actor)
$$;
create or replace function public.peekalo_account_available(p_account uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select p_account is null or (peekalo_account_access(p_account)
  and not exists(select 1 from peekalo_suspended_accounts where account_id=p_account)
  and exists(select 1 from peekalo_profiles where id=p_account and review_state='approved'))
$$;
create function public.peekalo_policy_status(p_actor uuid,p_terms text,p_privacy text)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('accepted',exists(select 1 from peekalo_policy_acceptances where account_id=p_actor and terms_version=p_terms and privacy_version=p_privacy),
  'deletionStatus',(select state from peekalo_account_deletions where account_id=p_actor))
$$;
create function public.peekalo_accept_policy(p_actor uuid,p_terms text,p_privacy text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock_shared(730293001);
 if not peekalo_account_access(p_actor) then raise exception 'account_deleting'; end if;
 if p_terms is distinct from '2026-10-29-draft' or p_privacy is distinct from '2026-10-29-draft' then raise exception 'conflict'; end if;
 insert into peekalo_policy_acceptances(account_id,terms_version,privacy_version) values(p_actor,p_terms,p_privacy) on conflict do nothing;
 return jsonb_build_object('accepted',true);
end $$;

-- Cover writes which did not historically require an approved public profile.
alter function public.peekalo_save_profile(uuid,text) rename to peekalo_save_profile_before_privacy;
create function public.peekalo_save_profile(p_actor uuid,p_username text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock_shared(730293001);
 if not peekalo_account_access(p_actor) then raise exception 'account_deleting'; end if;
 return peekalo_save_profile_before_privacy(p_actor,p_username);
end $$;
alter function public.peekalo_reserve_post(uuid,uuid,text,integer) rename to peekalo_reserve_post_before_privacy;
create function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 perform pg_advisory_xact_lock_shared(730293001);
 if not peekalo_account_access(p_owner) then raise exception 'account_deleting'; end if;
 return peekalo_reserve_post_before_privacy(p_owner,p_key,p_kind,p_limit);
end $$;
create or replace function public.peekalo_require_operator(p_operator uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
 perform 1 from peekalo_operators where account_id=p_operator and enabled for share;
 if not found or not peekalo_account_access(p_operator) or exists(select 1 from peekalo_suspended_accounts where account_id=p_operator) then raise exception 'forbidden'; end if;
end $$;

-- A verified bearer may have passed the gateway just before disabling. Guard
-- safety writes in the same transaction as their mutation, including report text.
alter function public.peekalo_report(text,text,text,text,uuid,text,text,uuid) rename to peekalo_report_before_privacy;
create function public.peekalo_report(p_identity text,p_kind text,p_reason text,p_details text default '',p_post uuid default null,p_username text default null,p_hash text default null,p_account uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001);
 actor:=peekalo_check_identity(p_identity);
 if actor is not null and not peekalo_account_access(actor) then raise exception 'account_deleting'; end if;
 return peekalo_report_before_privacy(p_identity,p_kind,p_reason,p_details,p_post,p_username,p_hash,p_account);
end $$;
alter function public.peekalo_block(uuid,text,boolean,uuid) rename to peekalo_block_before_privacy;
create function public.peekalo_block(p_actor uuid,p_username text,p_blocked boolean,p_target uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(730293001);
 if not peekalo_account_access(p_actor) then raise exception 'account_deleting'; end if;
 return peekalo_block_before_privacy(p_actor,p_username,p_blocked,p_target);
end $$;
revoke all on function public.peekalo_save_profile(uuid,text),public.peekalo_reserve_post(uuid,uuid,text,integer),public.peekalo_report(text,text,text,text,uuid,text,text,uuid),public.peekalo_block(uuid,text,boolean,uuid) from public,anon,authenticated;
revoke all on function public.peekalo_report_before_privacy(text,text,text,text,uuid,text,text,uuid),public.peekalo_block_before_privacy(uuid,text,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.peekalo_report(text,text,text,text,uuid,text,text,uuid),public.peekalo_block(uuid,text,boolean,uuid) to service_role;

create function public.peekalo_begin_deletion(p_actor uuid,p_provider_required boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job peekalo_account_deletions; item record;
begin
 if p_actor is null or not exists(select 1 from auth.users where id=p_actor) then raise exception 'unauthorized'; end if;
 -- Same quota -> global safety -> ordered post -> child lock order as REL-03.
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,0));
 perform pg_advisory_xact_lock(730293001);
 select * into job from peekalo_account_deletions where account_id=p_actor for update;
 if found then
  if coalesce(p_provider_required,false) then update peekalo_account_deletions set provider_required=true where request_id=job.request_id; end if;
  return jsonb_build_object('status',job.state,'requestId',job.request_id);
 end if;
 insert into peekalo_account_deletions(account_id,provider_required) values(p_actor,coalesce(p_provider_required,false)) returning * into job;
 for item in select id,owner_id from peekalo_posts where owner_id=p_actor or id in
  (select post_id from peekalo_grants where recipient_id=p_actor union select post_id from peekalo_links where claimed_identity='a:' || p_actor::text)
  order by id for update loop
  if item.owner_id=p_actor then
   update peekalo_posts set status='deleted',upload_attempt=null,upload_expires_at=null where id=item.id;
  end if;
  update peekalo_links set revoked=true where post_id=item.id and (item.owner_id=p_actor or claimed_identity='a:' || p_actor::text);
  update peekalo_grants set revoked=true where post_id=item.id and (item.owner_id=p_actor or recipient_id=p_actor);
  update peekalo_leases set expires_at=least(expires_at,clock_timestamp()) where post_id=item.id and (item.owner_id=p_actor or identity='a:' || p_actor::text);
 end loop;
 update peekalo_reports set details='',resolution=null where reporter_identity='a:' || p_actor::text or resolved_by=p_actor
  or (target_kind='account' and target_id=p_actor) or (target_kind='post' and target_id in (select id from peekalo_posts where owner_id=p_actor));
 update peekalo_safety_audit set note=null where operator_id=p_actor or target_id=p_actor or target_id in (select id from peekalo_posts where owner_id=p_actor)
  or target_id in (select id from peekalo_reports where reporter_identity='a:' || p_actor::text or resolved_by=p_actor
   or (target_kind='account' and target_id=p_actor) or (target_kind='post' and target_id in (select id from peekalo_posts where owner_id=p_actor)));
 delete from peekalo_profiles where id=p_actor;
 update peekalo_operators set enabled=false where account_id=p_actor;
 return jsonb_build_object('status','pending','requestId',job.request_id);
end $$;

create function public.peekalo_storage_writer(p_owner uuid,p_attempt uuid,p_begin boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 perform pg_advisory_xact_lock_shared(730293001);
 if p_begin then
  if not peekalo_account_access(p_owner) then return false; end if;
  if not exists(select 1 from peekalo_posts where owner_id=p_owner and upload_attempt=p_attempt and status='uploading' and upload_expires_at>clock_timestamp()) then return false; end if;
  insert into peekalo_storage_writers(owner_id,attempt_id) values(p_owner,p_attempt) on conflict do nothing;
 else
  delete from peekalo_storage_writers where owner_id=p_owner and attempt_id=p_attempt;
 end if;
 return true;
end $$;
revoke all on function public.peekalo_storage_writer(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.peekalo_storage_writer(uuid,uuid,boolean) to service_role;

create function public.peekalo_deletion_jobs(p_limit integer default 10)
returns jsonb language sql security definer set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'accountId',account_id,'requestedAt',requested_at,'notBefore',not_before,
  'providerPending',provider_required and provider_revoked_at is null,'providerRevoked',provider_revoked_at is not null,'revokedAppleSubjectHash',revoked_apple_subject_hash,'complete',state='complete',
  'writersPending',exists(select 1 from peekalo_storage_writers where owner_id=account_id))),'[]'::jsonb) from (
  select * from peekalo_account_deletions where not_before<=clock_timestamp() and (state='pending' or storage_verified_at is null or storage_verified_at<clock_timestamp()-interval '1 day') order by case when state='pending' then 0 else 1 end,last_attempt_at nulls first,requested_at limit greatest(1,least(p_limit,50))
 ) jobs
$$;
create function public.peekalo_deletion_progress(p_request uuid,p_stage text,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_stage not in ('storage_verified','auth_deleted','failed','provider_revoked','provider_required') then raise exception 'conflict'; end if;
 if p_stage='provider_revoked' and (p_error is null or p_error !~ '^[0-9a-f]{64}$') then raise exception 'conflict'; end if;
 if p_stage='failed' and (p_error is null or p_error not in ('storage_failed','auth_failed','provider_revocation_required','cleanup_failed')) then raise exception 'conflict'; end if;
 update peekalo_account_deletions set
  storage_verified_at=case when p_stage='storage_verified' then clock_timestamp() when p_stage='failed' and p_error in ('storage_failed','cleanup_failed') then null else storage_verified_at end,
  auth_deleted_at=case when p_stage='auth_deleted' then clock_timestamp() else auth_deleted_at end,
  revoked_apple_subject_hash=case when p_stage='provider_required' and revoked_apple_subject_hash is distinct from p_error then null when p_stage='provider_revoked' then p_error else revoked_apple_subject_hash end,
  provider_required=provider_required or p_stage='provider_required',
  provider_revoked_at=case when p_stage='provider_required' and revoked_apple_subject_hash is distinct from p_error then null when p_stage='provider_revoked' then clock_timestamp() else provider_revoked_at end,
  attempts=attempts+case when p_stage='failed' then 1 else 0 end,last_attempt_at=clock_timestamp(),last_error=case when p_stage='failed' then p_error else null end
 where request_id=p_request and (state='pending' or p_stage in ('storage_verified','failed'))
  and (p_stage in ('provider_revoked','provider_required') or not_before<=clock_timestamp());
 return found;
end $$;
create function public.peekalo_complete_deletion(p_request uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare job peekalo_account_deletions; opaque text;
begin
 perform pg_advisory_xact_lock(730293001);
 select * into job from peekalo_account_deletions where request_id=p_request for update;
 if not found then return false; end if;
 if job.state='complete' then return true; end if;
 if job.storage_verified_at is null or job.auth_deleted_at is null or (job.provider_required and job.provider_revoked_at is null)
  or exists(select 1 from auth.users where id=job.account_id) or exists(select 1 from peekalo_storage_writers where owner_id=job.account_id) then return false; end if;
 -- Auth cascades remove own moments, grants, profiles, blocks, terms and sessions.
 -- For OTHER owners' moments, anonymize the removed viewer while preserving
 -- claim permanence and prepaid totals. A new account cannot obtain that identity.
 opaque:='g:' || gen_random_uuid()::text;
 update peekalo_links set claimed_identity=opaque,revoked=true where claimed_identity='a:' || job.account_id::text;
 update peekalo_budgets set identity=opaque,active_session=null,active_until=null where identity='a:' || job.account_id::text;
 delete from peekalo_leases where identity='a:' || job.account_id::text;
 -- Free text can contain personal data. Scrub it when an associated account is
 -- removed; remaining operational records expire at 90 days, not forever.
 update peekalo_safety_audit set note=null where target_id in (select id from peekalo_reports where reporter_identity='a:' || job.account_id::text or (target_kind='account' and target_id=job.account_id));
 update peekalo_reports set details='',resolution=null,
  reporter_identity=case when reporter_identity='a:' || job.account_id::text then opaque else reporter_identity end,
  target_id=case when target_kind='account' and target_id=job.account_id then gen_random_uuid() else target_id end
 where reporter_identity='a:' || job.account_id::text or (target_kind='account' and target_id=job.account_id);
 update peekalo_safety_audit set target_id=null,note=null where target_id=job.account_id;
 update peekalo_account_deletions set state='complete',completed_at=clock_timestamp(),last_error=null where request_id=p_request;
 return true;
end $$;

-- Operational runner must execute on a verified schedule (REL-05). No legal hold
-- is silently invented. If preservation becomes necessary, define its restricted
-- authority/expiry and conflict handling BEFORE enabling collection.
create function public.peekalo_expire_private_records()
returns jsonb language plpgsql security definer set search_path=public as $$
declare reports integer; audits integer; receipts integer;
begin
 delete from peekalo_reports where created_at<clock_timestamp()-interval '90 days'; get diagnostics reports=row_count;
 delete from peekalo_safety_audit where created_at<clock_timestamp()-interval '90 days'; get diagnostics audits=row_count;
 delete from peekalo_account_deletions where state='complete' and backups_reconciled_at is not null and completed_at<clock_timestamp()-interval '30 days' and storage_verified_at>clock_timestamp()-interval '1 day' and last_error is null
  and not exists(select 1 from peekalo_storage_writers where owner_id=account_id); get diagnostics receipts=row_count;
 return jsonb_build_object('reports',reports,'audits',audits,'receipts',receipts);
end $$;

revoke all on function public.peekalo_save_profile_before_privacy(uuid,text),public.peekalo_reserve_post_before_privacy(uuid,uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.peekalo_account_access(uuid),public.peekalo_policy_status(uuid,text,text),public.peekalo_accept_policy(uuid,text,text),public.peekalo_begin_deletion(uuid,boolean),
 public.peekalo_deletion_jobs(integer),public.peekalo_deletion_progress(uuid,text,text),public.peekalo_complete_deletion(uuid),public.peekalo_expire_private_records() from public,anon,authenticated;
grant execute on function public.peekalo_save_profile(uuid,text),public.peekalo_reserve_post(uuid,uuid,text,integer),public.peekalo_account_access(uuid),public.peekalo_policy_status(uuid,text,text),public.peekalo_accept_policy(uuid,text,text),public.peekalo_begin_deletion(uuid,boolean),
 public.peekalo_deletion_jobs(integer),public.peekalo_deletion_progress(uuid,text,text),public.peekalo_complete_deletion(uuid),public.peekalo_expire_private_records() to service_role;

create function public.peekalo_deletion_status(p_request uuid)
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('status',case when state='complete' and last_error is null then 'complete' else 'pending' end,'needsAppleReauthentication',provider_required and provider_revoked_at is null)
 from peekalo_account_deletions where request_id=p_request and (completed_at is null or completed_at>=clock_timestamp()-interval '30 days')
$$;
revoke all on function public.peekalo_deletion_status(uuid) from public,anon,authenticated;
grant execute on function public.peekalo_deletion_status(uuid) to service_role;

-- Owner/admin SQL only, after REL-05 inventories EVERY recoverable copy (including
-- offsite dumps/PITR). This cannot be set from a bearer or service-role API.
-- Require a restore horizon after cleanup completion, conservatively beyond
-- the earlier committed request guard (requested_at alone precedes its commit).
create function public.peekalo_reconcile_deletion_backups(p_request uuid,p_oldest_recoverable timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_oldest_recoverable is null or p_oldest_recoverable>clock_timestamp() then raise exception 'conflict'; end if;
 update peekalo_account_deletions set backups_reconciled_at=clock_timestamp()
 where request_id=p_request and state='complete' and completed_at<p_oldest_recoverable;
 return found;
end $$;
revoke all on function public.peekalo_reconcile_deletion_backups(uuid,timestamptz) from public,anon,authenticated,service_role;
