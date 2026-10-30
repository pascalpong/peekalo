-- REL-05: bounded durable cleanup, operational aggregates and explicit recovery.
-- Apply only after REL-02, REL-03 and REL-04 with matching maintenance runner.
alter table public.peekalo_posts add column maintenance_checked_at timestamptz, add column maintenance_attempted_at timestamptz;
create index peekalo_posts_maintenance on public.peekalo_posts(maintenance_attempted_at nulls first,created_at);

-- The post remains as the idempotency tombstone: cleanup never removes claims,
-- budgets or retry keys. Old attempts cannot publish once fenced here.
create function public.peekalo_media_cleanup_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item record; jobs jsonb:='[]'::jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'conflict'; end if;
 -- Avoid lock-order inversion between concurrent multi-owner enumeration batches.
 if not pg_try_advisory_xact_lock(730293005) then return jobs; end if;
 for item in select id,owner_id from peekalo_posts where maintenance_checked_at is null or maintenance_checked_at<clock_timestamp()-interval '1 day'
  or (status='uploading' and (upload_expires_at is null or upload_expires_at<=clock_timestamp()))
  or exists(select 1 from peekalo_storage_writers where owner_id=peekalo_posts.owner_id)
  order by maintenance_attempted_at nulls first,created_at,id limit p_limit loop
  perform pg_advisory_xact_lock(hashtextextended(item.owner_id::text,0));
  update peekalo_posts set status='failed',upload_attempt=null,upload_expires_at=null
   where id=item.id and status='uploading' and (upload_expires_at is null or upload_expires_at<=clock_timestamp());
  update peekalo_posts set maintenance_attempted_at=clock_timestamp() where id=item.id;
  jobs:=jobs || jsonb_build_array(jsonb_build_object('ownerId',item.owner_id,'postId',item.id));
 end loop;
 return jobs;
end $$;

-- Check each candidate against CURRENT state, not an earlier inventory. A retry
-- may already be writing its different random attempt path. Authorizing removal
-- of an old path cannot authorize a current/published path or another owner.
create function public.peekalo_media_cleanup_path(p_owner uuid,p_post uuid,p_path text)
returns boolean language plpgsql security definer set search_path=public as $$
declare item peekalo_posts; base text; leaf text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into item from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if not found or p_path is null then return false; end if;
 base:=p_owner::text || '/' || p_post::text;
 if p_path not like base || '/%' and p_path not in (base || '.jpg',base || '.mp4') then return false; end if;
 leaf:=substring(p_path from length(base)+2);
 if p_path not in (base || '.jpg',base || '.mp4') and leaf !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|mp4)$' then return false; end if;
 if item.status='uploading' and (item.upload_expires_at is null or item.upload_expires_at<=clock_timestamp()) then
  update peekalo_posts set status='failed',upload_attempt=null,upload_expires_at=null where id=p_post returning * into item;
 end if;
 if item.status<>'deleted' and item.storage_path=p_path then return false; end if;
 if item.status='uploading' and p_path=(base || '/' || item.upload_attempt::text || case when item.kind='photo' then '.jpg' else '.mp4' end) then return false; end if;
 return true;
end $$;
create function public.peekalo_media_cleanup_done(p_owner uuid,p_post uuid,p_ok boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 -- Failed/ambiguous work remains due but attempted_at rotates it fairly so a
 -- poison job cannot starve later owners. Successful sweeps rotate daily.
 if p_ok and exists(select 1 from peekalo_storage_writers writer where writer.owner_id=p_owner and
  (writer.started_at<clock_timestamp()-interval '10 minutes' or not exists(select 1 from peekalo_posts post where post.owner_id=p_owner and post.upload_attempt=writer.attempt_id and post.status='uploading' and post.upload_expires_at>clock_timestamp()))) then return false; end if;
 update peekalo_posts set maintenance_checked_at=case when p_ok then clock_timestamp() else null end where id=p_post and owner_id=p_owner;
 return found;
end $$;

-- A durable writer is deliberately NOT released by age. The owner/admin must
-- establish termination/settlement at the process AND upstream Storage boundary,
-- fence the old attempt, then rerun a fresh sweep. No bearer/service role may
-- manufacture this evidence. Only the exact specified barrier is removed.
create function public.peekalo_reconcile_storage_writer(p_owner uuid,p_attempt uuid,p_settled boolean)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_settled is distinct from true then raise exception 'conflict'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 if exists(select 1 from peekalo_posts where owner_id=p_owner and upload_attempt=p_attempt and status='uploading' and upload_expires_at>clock_timestamp()) then raise exception 'conflict'; end if;
 update peekalo_posts set status='failed',upload_attempt=null,upload_expires_at=null where owner_id=p_owner and upload_attempt=p_attempt and status='uploading';
 delete from peekalo_storage_writers where owner_id=p_owner and attempt_id=p_attempt;
 if not found then return false; end if;
 update peekalo_account_deletions set storage_verified_at=null,last_error='cleanup_failed' where account_id=p_owner;
 update peekalo_posts set maintenance_checked_at=null where owner_id=p_owner;
 return true;
end $$;
revoke all on function public.peekalo_reconcile_storage_writer(uuid,uuid,boolean) from public,anon,authenticated,service_role;

create table public.peekalo_maintenance_state (
 singleton boolean primary key default true check(singleton),
 last_success_at timestamptz,last_failure_at timestamptz,last_attempt_at timestamptz,
 pending integer not null default 0 check(pending>=0),last_run_ok boolean
);
insert into public.peekalo_maintenance_state(singleton) values(true);
alter table public.peekalo_maintenance_state enable row level security;
revoke all on public.peekalo_maintenance_state from public,anon,authenticated,service_role;
create function public.peekalo_maintenance_heartbeat(p_ok boolean,p_pending integer)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if p_ok is null or p_pending is null or p_pending<0 or p_pending>1000000000 then raise exception 'conflict'; end if;
 update peekalo_maintenance_state set last_attempt_at=clock_timestamp(),
 last_success_at=case when p_ok then clock_timestamp() else last_success_at end,
 last_failure_at=case when p_ok then last_failure_at else clock_timestamp() end,pending=p_pending,last_run_ok=p_ok;
 return true;
end $$;
create function public.peekalo_operations_status()
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object(
 'oldestDeletionSeconds',coalesce((select greatest(0,extract(epoch from clock_timestamp()-min(not_before)))::bigint from peekalo_account_deletions where state='pending' and not_before<=clock_timestamp()),0),
 'writerPending',(select count(*) from peekalo_storage_writers where started_at<clock_timestamp()-interval '10 minutes'),
 'activeWriters',(select count(*) from peekalo_storage_writers),
 'staleUploads',(select count(*) from peekalo_posts where status='uploading' and (upload_expires_at is null or upload_expires_at<=clock_timestamp())),
 'cleanupBacklog',(select count(*) from peekalo_posts where maintenance_checked_at is null or maintenance_checked_at<clock_timestamp()-interval '1 day' or (status='uploading' and (upload_expires_at is null or upload_expires_at<=clock_timestamp())) or exists(select 1 from peekalo_storage_writers where owner_id=peekalo_posts.owner_id)),
 'pendingDeletions',(select count(*) from peekalo_account_deletions where state='pending'),
 'lastSuccessSeconds',case when last_success_at is null then null else greatest(0,extract(epoch from clock_timestamp()-last_success_at))::bigint end,
 'lastRunOk',last_run_ok,
 'lastFailureSeconds',coalesce(greatest(0,extract(epoch from clock_timestamp()-last_failure_at))::bigint,-1),
 'lastAttemptSeconds',coalesce(greatest(0,extract(epoch from clock_timestamp()-last_attempt_at))::bigint,-1),
 'maintenancePending',pending) from peekalo_maintenance_state where singleton
$$;
revoke all on function public.peekalo_media_cleanup_jobs(integer),public.peekalo_media_cleanup_path(uuid,uuid,text),public.peekalo_media_cleanup_done(uuid,uuid,boolean),public.peekalo_maintenance_heartbeat(boolean,integer),public.peekalo_operations_status() from public,anon,authenticated;
grant execute on function public.peekalo_media_cleanup_jobs(integer),public.peekalo_media_cleanup_path(uuid,uuid,text),public.peekalo_media_cleanup_done(uuid,uuid,boolean),public.peekalo_maintenance_heartbeat(boolean,integer),public.peekalo_operations_status() to service_role;

-- Before restoring traffic, replay the independently retained minimal deletion
-- journal into a CLOSED restored database (owner/admin SQL only). Entries contain
-- no messages, tokens or media paths. Fresh sweeps/Auth/provider reconciliation
-- are mandatory again; old backup acknowledgements never survive replay.
create function public.peekalo_replay_deletion_suppression(p_entries jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare item jsonb; actor uuid; request uuid; stamp timestamptz; affected record; total integer:=0;
begin
 if p_entries is null or jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)>10000 then raise exception 'conflict'; end if;
 for item in select value from jsonb_array_elements(p_entries) loop
  actor:=(item->>'accountId')::uuid; request:=(item->>'requestId')::uuid; stamp:=(item->>'requestedAt')::timestamptz;
  if actor is null or request is null or stamp is null or stamp>clock_timestamp() or jsonb_typeof(item->'providerRequired') is distinct from 'boolean' then raise exception 'conflict'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,0));
  perform pg_advisory_xact_lock(730293001);
  -- Fail rather than merge contradictory journal identities.
  if exists(select 1 from peekalo_account_deletions where request_id=request and account_id<>actor or account_id=actor and request_id<>request) then raise exception 'conflict'; end if;
  insert into peekalo_account_deletions(request_id,account_id,requested_at,not_before,provider_required)
   values(request,actor,stamp,stamp+interval '10 minutes',(item->>'providerRequired')::boolean)
   on conflict(account_id) do update set state='pending',storage_verified_at=null,auth_deleted_at=null,completed_at=null,backups_reconciled_at=null,
    provider_required=peekalo_account_deletions.provider_required or excluded.provider_required,provider_revoked_at=null,revoked_apple_subject_hash=null,last_error=null;
  for affected in select id,owner_id from peekalo_posts where owner_id=actor or id in
   (select post_id from peekalo_grants where recipient_id=actor union select post_id from peekalo_links where claimed_identity='a:' || actor::text) order by id for update loop
   if affected.owner_id=actor then update peekalo_posts set status='deleted',upload_attempt=null,upload_expires_at=null,maintenance_checked_at=null where id=affected.id; end if;
   update peekalo_links set revoked=true where post_id=affected.id and (affected.owner_id=actor or claimed_identity='a:' || actor::text);
   update peekalo_grants set revoked=true where post_id=affected.id and (affected.owner_id=actor or recipient_id=actor);
   update peekalo_leases set expires_at=least(expires_at,clock_timestamp()) where post_id=affected.id and (affected.owner_id=actor or identity='a:' || actor::text);
  end loop;
  update peekalo_reports set details='',resolution=null where reporter_identity='a:' || actor::text or resolved_by=actor
   or (target_kind='account' and target_id=actor) or (target_kind='post' and target_id in(select id from peekalo_posts where owner_id=actor));
  update peekalo_safety_audit set note=null where operator_id=actor or target_id=actor or target_id in(select id from peekalo_posts where owner_id=actor)
   or target_id in(select id from peekalo_reports where reporter_identity='a:' || actor::text or resolved_by=actor or (target_kind='account' and target_id=actor) or (target_kind='post' and target_id in(select id from peekalo_posts where owner_id=actor)));
  delete from peekalo_profiles where id=actor;
  update peekalo_operators set enabled=false where account_id=actor;
  total:=total+1;
 end loop;
 return total;
end $$;
revoke all on function public.peekalo_replay_deletion_suppression(jsonb) from public,anon,authenticated,service_role;

-- Restricted checkpoint for recovery from an OLDER database snapshot. Export
-- with traffic/writers stopped and retain independently/encrypted. It carries
-- identifiers/identity ledger keys, never media paths, capability tokens or text.
-- It is NOT a WAL replacement: missing/newer evidence means keep traffic CLOSED.
create function public.peekalo_export_recovery_checkpoint()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; section text;
begin
 select jsonb_build_object('version',1,'capturedAt',clock_timestamp(),
  'deletions',coalesce((select jsonb_agg(jsonb_build_object('requestId',request_id,'accountId',account_id,'requestedAt',requested_at,'providerRequired',provider_required)) from peekalo_account_deletions),'[]'::jsonb),
  'claims',coalesce((select jsonb_agg(jsonb_build_object('linkId',id,'postId',post_id,'identity',claimed_identity)) from peekalo_links where claimed_identity is not null or revoked),'[]'::jsonb),
  'budgets',coalesce((select jsonb_agg(jsonb_build_object('postId',post_id,'identity',identity,'spentMs',spent_ms)) from peekalo_budgets where spent_ms>0),'[]'::jsonb),
  'suspensions',coalesce((select jsonb_agg(account_id) from peekalo_suspended_accounts),'[]'::jsonb),
  'blocks',coalesce((select jsonb_agg(jsonb_build_object('actor',blocker_id,'target',blocked_id)) from peekalo_blocks),'[]'::jsonb),
  'grants',coalesce((select jsonb_agg(jsonb_build_object('postId',post_id,'recipient',recipient_id)) from peekalo_grants where revoked or request_state='declined'),'[]'::jsonb),
  'posts',coalesce((select jsonb_agg(jsonb_build_object('postId',id,'status',status)) from peekalo_posts where status in ('deleted','rejected','taken_down','moderation_pending')),'[]'::jsonb)) into result;
 foreach section in array array['deletions','claims','budgets','suspensions','blocks','grants','posts'] loop
  if jsonb_array_length(result->section)>10000 then raise exception 'checkpoint_capacity'; end if;
 end loop;
 return result;
end $$;
create function public.peekalo_replay_recovery_checkpoint(p_checkpoint jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare item jsonb; section text; viewer_identity text; spent integer; post uuid; link uuid; actor uuid; target uuid; state text;
begin
 if p_checkpoint is null or p_checkpoint->>'version' is distinct from '1' or (p_checkpoint->>'capturedAt')::timestamptz>clock_timestamp() or p_checkpoint->>'capturedAt' is null then raise exception 'conflict'; end if;
 foreach section in array array['deletions','claims','budgets','suspensions','blocks','grants','posts'] loop
  if jsonb_typeof(p_checkpoint->section) is distinct from 'array' or jsonb_array_length(p_checkpoint->section)>10000 then raise exception 'conflict'; end if;
 end loop;
 -- Administrator must keep restored service closed; exclusive safety locking
 -- also serializes any accidental concurrent authorization/safety transactions.
 perform pg_advisory_xact_lock(730293001);
 perform peekalo_replay_deletion_suppression(p_checkpoint->'deletions');
 for item in select value from jsonb_array_elements(p_checkpoint->'claims') loop
  link:=(item->>'linkId')::uuid; post:=(item->>'postId')::uuid; viewer_identity:=item->>'identity';
  if link is null or post is null or (viewer_identity is not null and viewer_identity !~ '^[ag]:[0-9a-f-]{36}$') then raise exception 'conflict'; end if;
  -- A claim/revocation checkpoint closes that link conservatively, even for
  -- the former claimant. Conflicting/missing identities cannot reopen it.
  update peekalo_links set revoked=true,claimed_identity=coalesce(claimed_identity,viewer_identity) where id=link and post_id=post;
 end loop;
 for item in select value from jsonb_array_elements(p_checkpoint->'budgets') loop
  post:=(item->>'postId')::uuid; viewer_identity:=item->>'identity'; spent:=(item->>'spentMs')::integer;
  if post is null or viewer_identity is null or viewer_identity !~ '^[ag]:[0-9a-f-]{36}$' or spent is null or spent<0 or spent>10000 then raise exception 'conflict'; end if;
  if exists(select 1 from peekalo_posts where id=post) then
   insert into peekalo_budgets(post_id,identity,spent_ms) values(post,viewer_identity,spent)
    on conflict(post_id,identity) do update set spent_ms=greatest(peekalo_budgets.spent_ms,excluded.spent_ms),active_session=null,active_until=null;
  end if;
 end loop;
 for item in select value from jsonb_array_elements(p_checkpoint->'suspensions') loop
  actor:=trim(both '"' from item::text)::uuid;
  if exists(select 1 from auth.users where id=actor) then insert into peekalo_suspended_accounts(account_id,reason) values(actor,'Recovery restriction replay') on conflict do nothing; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_checkpoint->'blocks') loop
  actor:=(item->>'actor')::uuid; target:=(item->>'target')::uuid;
  if actor is null or target is null or actor=target then raise exception 'conflict'; end if;
  if exists(select 1 from auth.users where id=actor) and exists(select 1 from auth.users where id=target) then insert into peekalo_blocks(blocker_id,blocked_id) values(actor,target) on conflict do nothing; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_checkpoint->'grants') loop
  post:=(item->>'postId')::uuid; target:=(item->>'recipient')::uuid;
  if post is null or target is null then raise exception 'conflict'; end if;
  update peekalo_grants set revoked=true where post_id=post and recipient_id=target;
 end loop;
 for item in select value from jsonb_array_elements(p_checkpoint->'posts') loop
  post:=(item->>'postId')::uuid; state:=item->>'status';
  if post is null or state is null or state not in ('deleted','rejected','taken_down','moderation_pending') then raise exception 'conflict'; end if;
  -- Never promote an already stricter tombstone/rejection from the snapshot.
  update peekalo_posts set status=state,upload_attempt=null,upload_expires_at=null,maintenance_checked_at=null
   where id=post and status not in ('deleted','taken_down','rejected');
 end loop;
 -- Restored leases and scheduler successes are stale evidence.
 update peekalo_leases set expires_at=least(expires_at,clock_timestamp());
 update peekalo_maintenance_state set last_success_at=null,last_run_ok=false;
 return true;
end $$;
revoke all on function public.peekalo_export_recovery_checkpoint(),public.peekalo_replay_recovery_checkpoint(jsonb) from public,anon,authenticated,service_role;
