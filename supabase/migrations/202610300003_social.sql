-- REL-06. Ordered after REL-02 -> 03 -> 04 -> 05, with matching clients/API.
-- Durable text is private. Realtime carries empty invalidations, never bodies,
-- post capabilities or conversation identifiers. Delivered bytes cannot be erased.
create table public.peekalo_conversations (
 id uuid primary key default gen_random_uuid(),
 sender_id uuid not null references auth.users(id) on delete cascade,
 recipient_id uuid not null references auth.users(id) on delete cascade,
 request_key uuid not null,
 request_state text not null default 'pending' check(request_state in ('pending','accepted','declined')),
 created_at timestamptz not null default clock_timestamp(),
 check(sender_id<>recipient_id), unique(sender_id,request_key)
);
create unique index peekalo_conversations_pair on public.peekalo_conversations(least(sender_id,recipient_id),greatest(sender_id,recipient_id));
create index peekalo_conversations_recipient on public.peekalo_conversations(recipient_id,created_at desc,id desc);
create index peekalo_conversations_sender on public.peekalo_conversations(sender_id,created_at desc,id desc);
create table public.peekalo_social_items (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('message','comment')),
 author_id uuid not null references auth.users(id) on delete cascade,
 request_key uuid not null,
 conversation_id uuid references public.peekalo_conversations(id) on delete cascade,
 post_id uuid references public.peekalo_posts(id) on delete cascade,
 reference_post uuid references public.peekalo_posts(id) on delete cascade,
 body text check(length(body) between 1 and 1000),
 status text not null default 'moderation_pending' check(status in ('moderation_pending','approved','rejected','removed')),
 created_at timestamptz not null default clock_timestamp(),
 unique(author_id,kind,request_key),
 check((kind='message' and conversation_id is not null and post_id is null) or (kind='comment' and conversation_id is null and post_id is not null)),
 check(status in ('removed','rejected') or ((body is not null)::integer+(reference_post is not null)::integer=1)),
 check(kind='message' or reference_post is null)
);
create index peekalo_social_messages on public.peekalo_social_items(conversation_id,created_at desc,id desc);
create index peekalo_social_comments on public.peekalo_social_items(post_id,created_at desc,id desc);
create index peekalo_social_pending on public.peekalo_social_items(status,created_at,id);
-- Suppression identifiers outlive content and memberships. No body/account/token
-- is stored here. They must remain in complete independent recovery checkpoints.
create table public.peekalo_social_tombstones (
 kind text not null check(kind in ('message','comment','conversation')),
 item_id uuid not null, created_at timestamptz not null default clock_timestamp(),
 primary key(kind,item_id)
);
create table public.peekalo_social_epochs (
 epoch bigint generated always as identity primary key,
 account_id uuid references auth.users(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp()
);
create index peekalo_social_epoch_account on public.peekalo_social_epochs(account_id,epoch desc);
alter table public.peekalo_conversations enable row level security;
alter table public.peekalo_social_items enable row level security;
alter table public.peekalo_social_tombstones enable row level security;
alter table public.peekalo_social_epochs enable row level security;
revoke all on public.peekalo_conversations,public.peekalo_social_items,public.peekalo_social_tombstones,public.peekalo_social_epochs from public,anon,authenticated,service_role;

-- Existing relationships use stable IDs even while a changed username awaits
-- review. New discovery still requires an approved username. Suspension/deletion
-- always wins, including for an already-open subscription or queued transaction.
create function public.peekalo_social_active(p_actor uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select peekalo_account_access(p_actor) and not exists(select 1 from peekalo_suspended_accounts where account_id=p_actor)
$$;
create function public.peekalo_social_guard(p_actor uuid,p_write boolean default false)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not peekalo_social_active(p_actor) then raise exception 'unavailable'; end if;
 if p_write and not exists(select 1 from peekalo_policy_acceptances where account_id=p_actor and terms_version='2026-10-29-draft' and privacy_version='2026-10-29-draft') then raise exception 'terms_required'; end if;
end $$;
create function public.peekalo_social_signal(p_actor uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
 if p_actor is not null and not exists(select 1 from auth.users where id=p_actor) then return; end if;
 insert into peekalo_social_epochs(account_id) values(p_actor);
 if p_actor is null then return; end if;
 -- Real Supabase provides this function; disposable SQL tests deliberately do
 -- not emulate network delivery. A missing realtime transport means polling only.
 if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
  execute 'select realtime.send($1,$2,$3,$4)' using '{}'::jsonb,'invalidate','peekalo:account:' || p_actor::text,true;
 end if;
end $$;
create function public.peekalo_social_epoch(p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_guard(p_actor);
 return jsonb_build_object('epoch',greatest(coalesce((select max(epoch) from peekalo_social_epochs where account_id=p_actor),0),coalesce((select max(epoch) from peekalo_social_epochs where account_id is null),0)));
end $$;
create function public.peekalo_realtime_allowed(p_topic text)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare actor uuid;
begin
 begin actor:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
 exception when others then return false; end;
 return actor is not null and p_topic='peekalo:account:' || actor::text and peekalo_social_active(actor);
end $$;
-- Private Broadcast authorization is explicit. No authenticated INSERT policy:
-- a user cannot forge invalidations. Never add a broad messages select policy.
do $$ begin
 if to_regclass('realtime.messages') is not null then
  execute 'create policy peekalo_social_receive on realtime.messages for select to authenticated using (public.peekalo_realtime_allowed(realtime.topic()))';
 end if;
end $$;
revoke all on function public.peekalo_realtime_allowed(text) from public,anon,service_role;
grant execute on function public.peekalo_realtime_allowed(text) to authenticated;

create function public.peekalo_social_conversation(p_actor uuid,p_conversation uuid,p_write boolean default false)
returns public.peekalo_conversations language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations; peer uuid;
begin
 perform peekalo_social_guard(p_actor,p_write);
 select * into c from peekalo_conversations where id=p_conversation and p_actor in (sender_id,recipient_id) for share;
 if not found then raise exception 'unavailable'; end if;
 peer:=case when p_actor=c.sender_id then c.recipient_id else c.sender_id end;
 if not peekalo_social_active(peer) or peekalo_accounts_blocked(p_actor,peer) or c.request_state='declined' then raise exception 'unavailable'; end if;
 return c;
end $$;
create function public.peekalo_social_audience(p_actor uuid,p_post uuid,p_write boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
 perform peekalo_social_guard(p_actor,p_write);
 select owner_id into owner from peekalo_posts where id=p_post and status='ready' for share;
 if not found or not peekalo_social_active(owner) or peekalo_accounts_blocked(p_actor,owner) then raise exception 'unavailable'; end if;
 if owner<>p_actor and not exists(select 1 from peekalo_grants where post_id=p_post and recipient_id=p_actor and request_state='accepted' and not revoked) then raise exception 'unavailable'; end if;
end $$;
create function public.peekalo_social_conversation_json(p_actor uuid,p_conversation uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('conversationId',c.id,'peerAccountId',case when c.sender_id=p_actor then c.recipient_id else c.sender_id end,
 'peerUsername',(select case when p.review_state='approved' then p.username else null end from peekalo_profiles p where p.id=case when c.sender_id=p_actor then c.recipient_id else c.sender_id end),
 'requestState',c.request_state,'incoming',c.recipient_id=p_actor,'createdAt',c.created_at) from peekalo_conversations c where c.id=p_conversation
$$;
create function public.peekalo_social_item_json(p_actor uuid,p_item uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare i peekalo_social_items; show_body boolean; reference uuid;
begin
 select * into i from peekalo_social_items where id=p_item;
 if not found then return null; end if;
 show_body:=i.status='approved' or i.author_id=p_actor;
 reference:=i.reference_post;
 if reference is not null and not exists(select 1 from peekalo_posts p where p.id=reference and p.owner_id=i.author_id and p.status='ready' and peekalo_social_active(p.owner_id)
  and (p_actor=p.owner_id or exists(select 1 from peekalo_grants g where g.post_id=p.id and g.recipient_id=p_actor and not g.revoked and g.request_state='accepted'))
  and not peekalo_accounts_blocked(p.owner_id,p_actor)) then reference:=null; end if;
 return jsonb_build_object(case when i.kind='message' then 'messageId' else 'commentId' end,i.id,'authorAccountId',i.author_id,
 'authorUsername',(select case when review_state='approved' then username else null end from peekalo_profiles where id=i.author_id),
 'status',i.status,'createdAt',i.created_at,'body',case when show_body then i.body else null end,
 'kind',case when i.reference_post is not null then 'moment' else 'text' end,
 'postId',case when i.kind='comment' then i.post_id else reference end,'conversationId',i.conversation_id);
end $$;
create function public.peekalo_social_page_guard(p_before timestamptz,p_before_id uuid,p_limit integer)
returns void language plpgsql immutable security definer set search_path=public as $$
begin
 if (p_before is null)<>(p_before_id is null) or p_limit is null or p_limit<1 or p_limit>50 then raise exception 'conflict'; end if;
end $$;
create function public.peekalo_social_start(p_actor uuid,p_recipient uuid default null,p_key uuid default null,p_username text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations; target uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_guard(p_actor,true);
 if (p_recipient is null)=(p_username is null) or p_key is null then raise exception 'conflict'; end if;
 if p_username is not null then select id into target from peekalo_profiles where username=p_username and review_state='approved' for share;
 else select id into target from peekalo_profiles where id=p_recipient and review_state='approved' for share; end if;
 if target is null or target=p_actor or not peekalo_social_active(target) or peekalo_accounts_blocked(p_actor,target) then raise exception 'unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,730306003));
 perform pg_advisory_xact_lock(hashtextextended(least(p_actor,target)::text || greatest(p_actor,target)::text,730306001));
 select * into c from peekalo_conversations where sender_id=p_actor and request_key=p_key;
 if found then
  if c.recipient_id<>target then raise exception 'conflict'; end if;
  return peekalo_social_conversation_json(p_actor,c.id);
 end if;
 select * into c from peekalo_conversations where least(sender_id,recipient_id)=least(p_actor,target) and greatest(sender_id,recipient_id)=greatest(p_actor,target);
 if found then return peekalo_social_conversation_json(p_actor,c.id); end if;
 if (select count(*) from peekalo_conversations where sender_id=p_actor and created_at>clock_timestamp()-interval '1 hour')>=10 then raise exception 'rate_limited'; end if;
 insert into peekalo_conversations(sender_id,recipient_id,request_key) values(p_actor,target,p_key) returning * into c;
 return peekalo_social_conversation_json(p_actor,c.id);
end $$;
create function public.peekalo_social_request(p_actor uuid,p_conversation uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_guard(p_actor,true);
 if p_action is null or p_action not in ('accept','decline') then raise exception 'conflict'; end if;
 select * into c from peekalo_conversations where id=p_conversation and recipient_id=p_actor for update;
 if not found or not peekalo_social_active(c.sender_id) or peekalo_accounts_blocked(p_actor,c.sender_id) then raise exception 'unavailable'; end if;
 if c.request_state<>'pending' then
  if c.request_state<>(case when p_action='accept' then 'accepted' else 'declined' end) then raise exception 'unavailable'; end if;
 else
  update peekalo_conversations set request_state=case when p_action='accept' then 'accepted' else 'declined' end where id=c.id;
  if p_action='decline' then
   update peekalo_social_items set body=null,reference_post=null,status='removed' where conversation_id=c.id;
   insert into peekalo_social_tombstones(kind,item_id) values('conversation',c.id) on conflict do nothing;
  end if;
 end if;
 return peekalo_social_conversation_json(p_actor,c.id);
end $$;
create function public.peekalo_social_conversations(p_actor uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; cursor jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_guard(p_actor); perform peekalo_social_page_guard(p_before,p_before_id,p_limit);
 with page as (select * from peekalo_conversations c where p_actor in (sender_id,recipient_id) and request_state<>'declined'
  and peekalo_social_active(case when sender_id=p_actor then recipient_id else sender_id end) and not peekalo_accounts_blocked(sender_id,recipient_id)
  and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit p_limit)
 select coalesce(jsonb_agg(peekalo_social_conversation_json(p_actor,id) order by created_at desc,id desc),'[]'::jsonb),
 (select jsonb_build_object('createdAt',created_at,'id',id) from page order by created_at,id limit 1) into result,cursor from page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then cursor else null end);
end $$;
create function public.peekalo_social_messages(p_actor uuid,p_conversation uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations; result jsonb; cursor jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001); c:=peekalo_social_conversation(p_actor,p_conversation); perform peekalo_social_page_guard(p_before,p_before_id,p_limit);
 with page as(select * from peekalo_social_items where conversation_id=c.id and (author_id=p_actor or (c.request_state='accepted' and status='approved'))
  and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit p_limit)
 select coalesce(jsonb_agg(peekalo_social_item_json(p_actor,id) order by created_at desc,id desc),'[]'::jsonb),
 (select jsonb_build_object('createdAt',created_at,'id',id) from page order by created_at,id limit 1) into result,cursor from page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then cursor else null end);
end $$;
create function public.peekalo_social_send(p_actor uuid,p_conversation uuid,p_key uuid,p_body text default null,p_post uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations; i peekalo_social_items; peer uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001); c:=peekalo_social_conversation(p_actor,p_conversation,true);
 -- Serialize sender rate/idempotency without taking quota locks after safety.
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,730306002));
 if p_key is null or (p_body is null)=(p_post is null) or (p_body is not null and length(trim(p_body)) not between 1 and 1000) then raise exception 'conflict'; end if;
 select * into i from peekalo_social_items where author_id=p_actor and kind='message' and request_key=p_key;
 if found then
  if i.conversation_id<>p_conversation or (i.status not in ('removed','rejected') and (i.body is distinct from p_body or i.reference_post is distinct from p_post)) then raise exception 'conflict'; end if;
  return peekalo_social_item_json(p_actor,i.id);
 end if;
 if c.request_state<>'accepted' and (c.sender_id<>p_actor or exists(select 1 from peekalo_social_items where conversation_id=c.id)) then raise exception 'request_pending'; end if;
 if (select count(*) from peekalo_social_items where author_id=p_actor and created_at>clock_timestamp()-interval '1 minute')>=20 then raise exception 'rate_limited'; end if;
 peer:=case when c.sender_id=p_actor then c.recipient_id else c.sender_id end;
 if p_post is not null then
  perform 1 from peekalo_posts p where p.id=p_post and p.owner_id=p_actor and p.status='ready' for share;
  if not found or not exists(select 1 from peekalo_grants where post_id=p_post and recipient_id=peer and not revoked) then raise exception 'unavailable'; end if;
 end if;
 insert into peekalo_social_items(kind,author_id,request_key,conversation_id,body,reference_post,status)
 values('message',p_actor,p_key,c.id,p_body,p_post,case when p_post is null then 'moderation_pending' else 'approved' end) returning * into i;
 return peekalo_social_item_json(p_actor,i.id);
end $$;
create function public.peekalo_social_comments(p_actor uuid,p_post uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; cursor jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_audience(p_actor,p_post); perform peekalo_social_page_guard(p_before,p_before_id,p_limit);
 with page as(select * from peekalo_social_items where kind='comment' and post_id=p_post and (author_id=p_actor or status='approved') and peekalo_social_active(author_id) and not peekalo_accounts_blocked(p_actor,author_id)
  and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit p_limit)
 select coalesce(jsonb_agg(peekalo_social_item_json(p_actor,id) order by created_at desc,id desc),'[]'::jsonb),
 (select jsonb_build_object('createdAt',created_at,'id',id) from page order by created_at,id limit 1) into result,cursor from page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then cursor else null end);
end $$;
create function public.peekalo_social_comment(p_actor uuid,p_post uuid,p_key uuid,p_body text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_audience(p_actor,p_post,true);
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,730306002));
 if p_key is null or p_body is null or length(trim(p_body)) not between 1 and 1000 then raise exception 'conflict'; end if;
 select * into i from peekalo_social_items where author_id=p_actor and kind='comment' and request_key=p_key;
 if found then
  if i.post_id<>p_post or (i.status not in ('removed','rejected') and i.body is distinct from p_body) then raise exception 'conflict'; end if;
  return peekalo_social_item_json(p_actor,i.id);
 end if;
 if (select count(*) from peekalo_social_items where author_id=p_actor and created_at>clock_timestamp()-interval '1 minute')>=20 then raise exception 'rate_limited'; end if;
 insert into peekalo_social_items(kind,author_id,request_key,post_id,body) values('comment',p_actor,p_key,p_post,p_body) returning * into i;
 return peekalo_social_item_json(p_actor,i.id);
end $$;
create function public.peekalo_social_target(p_actor uuid,p_kind text,p_item uuid)
returns public.peekalo_social_items language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items; c peekalo_conversations;
begin
 if p_kind is null or p_kind not in ('message','comment') then raise exception 'conflict'; end if;
 select * into i from peekalo_social_items where id=p_item and kind=p_kind for share;
 if not found or i.status in ('removed','rejected') then raise exception 'unavailable'; end if;
 if p_kind='message' then
  c:=peekalo_social_conversation(p_actor,i.conversation_id);
  if i.author_id<>p_actor and (c.request_state<>'accepted' or i.status<>'approved') then raise exception 'unavailable'; end if;
 else
  perform peekalo_social_audience(p_actor,i.post_id);
  if i.author_id<>p_actor and (i.status<>'approved' or not peekalo_social_active(i.author_id) or peekalo_accounts_blocked(p_actor,i.author_id)) then raise exception 'unavailable'; end if;
 end if;
 return i;
end $$;
create function public.peekalo_social_remove(p_actor uuid,p_kind text,p_item uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items;
begin
 -- Exclusive barrier serializes removal with fresh reads/reports/review.
 perform pg_advisory_xact_lock(730293001); perform peekalo_social_guard(p_actor);
 select * into i from peekalo_social_items where id=p_item and kind=p_kind for update;
 if not found or (i.author_id<>p_actor and not (i.kind='comment' and exists(select 1 from peekalo_posts where id=i.post_id and owner_id=p_actor))) then raise exception 'unavailable'; end if;
 update peekalo_social_items set status='removed',body=null,reference_post=null where id=i.id;
 return jsonb_build_object('removed',true);
end $$;
alter table public.peekalo_reports drop constraint peekalo_reports_target_kind_check;
alter table public.peekalo_reports add constraint peekalo_reports_target_kind_check check(target_kind in ('post','account','message','comment'));
create function public.peekalo_social_report(p_actor uuid,p_kind text,p_item uuid,p_reason text,p_details text default '')
returns jsonb language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items; report uuid;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_social_guard(p_actor);
 i:=peekalo_social_target(p_actor,p_kind,p_item);
 if p_reason is null or p_reason not in ('child_safety','sexual_content','violence','harassment','privacy','spam','other') or p_details is null or length(p_details)>2000 then raise exception 'conflict'; end if;
 perform pg_advisory_xact_lock(hashtextextended('a:' || p_actor::text,730293002));
 select id into report from peekalo_reports where reporter_identity='a:' || p_actor::text and target_kind=p_kind and target_id=p_item and state='open' order by created_at limit 1;
 if found then
  if p_reason='child_safety' then update peekalo_reports set reason=p_reason,details=p_details where id=report; end if;
 else
  if (select count(*) from peekalo_reports where reporter_identity='a:' || p_actor::text and created_at>clock_timestamp()-interval '1 hour')>=10 then raise exception 'rate_limited'; end if;
  insert into peekalo_reports(reporter_identity,target_kind,target_id,reason,details) values('a:' || p_actor::text,p_kind,p_item,p_reason,p_details) returning id into report;
 end if;
 return jsonb_build_object('reportId',report,'state','open');
end $$;
create function public.peekalo_social_queue(p_operator uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; cursor jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_require_operator(p_operator); perform peekalo_social_page_guard(p_before,p_before_id,p_limit);
 insert into peekalo_safety_audit(operator_id,event) values(p_operator,'social_queue_read');
 with page as(select * from peekalo_social_items where status='moderation_pending'
  and (p_before is null or (created_at,id)>(p_before,p_before_id)) order by created_at,id limit p_limit)
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'itemId',id,'authorAccountId',author_id,'status',status,'createdAt',created_at) order by created_at,id),'[]'::jsonb),
 (select jsonb_build_object('createdAt',created_at,'id',id) from page order by created_at desc,id desc limit 1) into result,cursor from page;
 return jsonb_build_object('items',result,'nextCursor',case when jsonb_array_length(result)=p_limit then cursor else null end);
end $$;
create function public.peekalo_social_read(p_operator uuid,p_kind text,p_item uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 perform pg_advisory_xact_lock_shared(730293001); perform peekalo_require_operator(p_operator);
 perform 1 from peekalo_social_items where id=p_item and kind=p_kind and status<>'removed' for share;
 if not found then raise exception 'unavailable'; end if;
 insert into peekalo_safety_audit(operator_id,event,target_id) values(p_operator,'social_body_read',p_item);
 -- Operator reads are separately audited and do not rely on audience membership.
 select peekalo_social_item_json(author_id,id) into result from peekalo_social_items where id=p_item;
 return result || jsonb_build_object('itemId',p_item);
end $$;
create function public.peekalo_social_review(p_operator uuid,p_kind text,p_item uuid,p_action text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items; next_status text;
begin
 perform pg_advisory_xact_lock(730293001); perform peekalo_require_operator(p_operator);
 if p_action is null or p_action not in ('approve','reject','takedown') or p_reason is null or length(trim(p_reason)) not between 1 and 1000 then raise exception 'conflict'; end if;
 select * into i from peekalo_social_items where id=p_item and kind=p_kind for update;
 if not found or i.status in ('removed','rejected') then raise exception 'unavailable'; end if;
 if p_action in ('approve','reject') and i.status<>'moderation_pending' then raise exception 'unavailable'; end if;
 if p_action='approve' then
  if i.author_id=p_operator then raise exception 'forbidden'; end if;
  if not peekalo_social_active(i.author_id) then raise exception 'unavailable'; end if;
  if i.kind='message' then perform peekalo_social_conversation(i.author_id,i.conversation_id); else perform peekalo_social_audience(i.author_id,i.post_id); end if;
  next_status:='approved';
 else next_status:=case when p_action='reject' then 'rejected' else 'removed' end;
 end if;
 update peekalo_social_items set status=next_status,body=case when next_status='approved' then body else null end,reference_post=case when next_status='approved' then reference_post else null end where id=i.id;
 insert into peekalo_safety_audit(operator_id,event,target_id,note) values(p_operator,'social_' || p_action,p_item,case when next_status='approved' then p_reason else null end);
 return jsonb_build_object('itemId',p_item,'status',next_status);
end $$;

-- All durable changes invalidate current clients. Restriction changes only carry
-- an empty wake-up; a formerly authorized listener cannot receive text/IDs.
create function public.peekalo_social_item_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare i peekalo_social_items; member record;
begin
 if tg_op='DELETE' or (tg_op='UPDATE' and new.status in ('removed','rejected')) then perform peekalo_social_signal(null); end if;
 i:=case when tg_op='DELETE' then old else new end;
 if tg_op='DELETE' or i.status in ('removed','rejected') then
  insert into peekalo_social_tombstones(kind,item_id) values(i.kind,i.id) on conflict do nothing;
 end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and new.status in ('removed','rejected')) then
  update peekalo_safety_audit set note=null where target_id=i.id or target_id in(select id from peekalo_reports where target_kind=i.kind and target_id=i.id);
  update peekalo_reports set details='',resolution=null where target_kind=i.kind and target_id=i.id;
 end if;
 if i.kind='message' then
  for member in select sender_id as account_id from peekalo_conversations where id=i.conversation_id union select recipient_id from peekalo_conversations where id=i.conversation_id order by account_id limit 100 loop perform peekalo_social_signal(member.account_id); end loop;
 else
  -- Wake at most 100 audiences immediately. The universal restriction epoch
  -- fences every fresh read; polling catches audiences beyond this bounded batch.
  for member in select owner_id as account_id from peekalo_posts where id=i.post_id union select recipient_id from peekalo_grants where post_id=i.post_id and not revoked and request_state='accepted' order by account_id limit 100 loop perform peekalo_social_signal(member.account_id); end loop;
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger peekalo_social_item_changes after insert or update or delete on public.peekalo_social_items for each row execute function public.peekalo_social_item_change();
create function public.peekalo_social_conversation_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare c peekalo_conversations;
begin
 if tg_op='DELETE' or new.request_state='declined' then perform peekalo_social_signal(null); end if;
 c:=case when tg_op='DELETE' then old else new end;
 if tg_op='DELETE' or c.request_state='declined' then insert into peekalo_social_tombstones(kind,item_id) values('conversation',c.id) on conflict do nothing; end if;
 perform peekalo_social_signal(c.sender_id); perform peekalo_social_signal(c.recipient_id);
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger peekalo_social_conversation_changes after insert or update or delete on public.peekalo_conversations for each row execute function public.peekalo_social_conversation_change();
create function public.peekalo_social_account_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare actor uuid; member record;
begin
 perform peekalo_social_signal(null);
 if tg_table_name='peekalo_blocks' then
  actor:=case when tg_op='DELETE' then old.blocker_id else new.blocker_id end;
  perform peekalo_social_signal(case when tg_op='DELETE' then old.blocked_id else new.blocked_id end);
 else actor:=case when tg_op='DELETE' then old.account_id else new.account_id end; end if;
 perform peekalo_social_signal(actor);
 for member in select sender_id as id from peekalo_conversations where recipient_id=actor union select recipient_id from peekalo_conversations where sender_id=actor order by id limit 100 loop perform peekalo_social_signal(member.id); end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger peekalo_social_block_changes after insert or update or delete on public.peekalo_blocks for each row execute function public.peekalo_social_account_change();
create trigger peekalo_social_suspension_changes after insert or update or delete on public.peekalo_suspended_accounts for each row execute function public.peekalo_social_account_change();
create function public.peekalo_social_audience_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare member record; post uuid;
begin
 perform peekalo_social_signal(null);
 if tg_table_name='peekalo_grants' then
  perform peekalo_social_signal(case when tg_op='DELETE' then old.recipient_id else new.recipient_id end);
  post:=case when tg_op='DELETE' then old.post_id else new.post_id end;
 else
  post:=case when tg_op='DELETE' then old.id else new.id end;
  -- Moment rows persist as retry/allowance tombstones. Logical deletion must
  -- therefore scrub discussion and cards now, without waiting for FK cascades.
  if tg_op='UPDATE' and new.status='deleted' then
   update peekalo_social_items set status='removed',body=null,reference_post=null
    where (post_id=post or reference_post=post) and status<>'removed';
  end if;
 end if;
 for member in select owner_id as id from peekalo_posts where id=post union select recipient_id from peekalo_grants where post_id=post order by id limit 100 loop perform peekalo_social_signal(member.id); end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger peekalo_social_grant_changes after insert or update or delete on public.peekalo_grants for each row execute function public.peekalo_social_audience_change();
create trigger peekalo_social_post_changes after update of status or delete on public.peekalo_posts for each row execute function public.peekalo_social_audience_change();

-- Begin/replay deletion both insert/update the suppression row under the global
-- exclusive barrier. Scrub actual social content and membership immediately,
-- BEFORE Auth cascade, while targets for report/audit scrubbing still exist.
create function public.peekalo_social_account_cleanup()
returns trigger language plpgsql security definer set search_path=public as $$
declare member record;
begin
 perform peekalo_social_signal(null);
 for member in select sender_id as id from peekalo_conversations where recipient_id=new.account_id union select recipient_id from peekalo_conversations where sender_id=new.account_id order by id limit 100 loop perform peekalo_social_signal(member.id); end loop;
 delete from peekalo_social_items where author_id=new.account_id or post_id in(select id from peekalo_posts where owner_id=new.account_id)
  or conversation_id in(select id from peekalo_conversations where new.account_id in(sender_id,recipient_id));
 delete from peekalo_conversations where new.account_id in(sender_id,recipient_id);
 delete from peekalo_social_epochs where account_id=new.account_id;
 return new;
end $$;
create trigger peekalo_social_account_deleting after insert or update on public.peekalo_account_deletions for each row execute function public.peekalo_social_account_cleanup();

-- Extend the existing restricted checkpoint, never bypass its claim/budget and
-- deletion replay. An old pre-social checkpoint cannot assert recovery safety.
alter function public.peekalo_export_recovery_checkpoint() rename to peekalo_export_recovery_checkpoint_before_social;
create function public.peekalo_export_recovery_checkpoint()
returns jsonb language plpgsql security definer set search_path=public as $$
declare restrictions jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'itemId',item_id)),'[]'::jsonb) into restrictions from (
  select kind,item_id from peekalo_social_tombstones union select kind,id from peekalo_social_items where status<>'approved' union select 'conversation',id from peekalo_conversations where request_state='declined'
 ) entries;
 if jsonb_array_length(restrictions)>10000 then raise exception 'checkpoint_capacity'; end if;
 return peekalo_export_recovery_checkpoint_before_social() || jsonb_build_object('socialRestrictions',restrictions);
end $$;
alter function public.peekalo_replay_recovery_checkpoint(jsonb) rename to peekalo_replay_recovery_checkpoint_before_social;
create function public.peekalo_replay_recovery_checkpoint(p_checkpoint jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare restriction jsonb; target uuid; restriction_kind text;
begin
 if jsonb_typeof(p_checkpoint->'socialRestrictions') is distinct from 'array' or jsonb_array_length(p_checkpoint->'socialRestrictions')>10000 then raise exception 'conflict'; end if;
 perform pg_advisory_xact_lock(730293001);
 perform peekalo_replay_recovery_checkpoint_before_social(p_checkpoint);
 for restriction in select value from jsonb_array_elements(p_checkpoint->'socialRestrictions') loop
  target:=(restriction->>'itemId')::uuid; restriction_kind:=restriction->>'kind';
  if target is null or restriction_kind is null or restriction_kind not in ('conversation','message','comment') then raise exception 'conflict'; end if;
  insert into peekalo_social_tombstones(kind,item_id) values(restriction_kind,target) on conflict do nothing;
  if restriction_kind='conversation' then
   update peekalo_conversations set request_state='declined' where id=target;
   update peekalo_social_items set status='removed',body=null,reference_post=null where conversation_id=target;
  else update peekalo_social_items set status='removed',body=null,reference_post=null where id=target and peekalo_social_items.kind=restriction_kind;
  end if;
 end loop;
 return true;
end $$;
-- Restricted helpers are not bearer entry points. Whitelist service RPCs below.
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
  (p.proname like 'peekalo_social_%' or p.proname in ('peekalo_export_recovery_checkpoint_before_social','peekalo_replay_recovery_checkpoint_before_social')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
 end loop;
end $$;
grant execute on function public.peekalo_social_epoch(uuid),public.peekalo_social_start(uuid,uuid,uuid,text),public.peekalo_social_request(uuid,uuid,text),
 public.peekalo_social_conversations(uuid,timestamptz,uuid,integer),public.peekalo_social_messages(uuid,uuid,timestamptz,uuid,integer),public.peekalo_social_send(uuid,uuid,uuid,text,uuid),
 public.peekalo_social_comments(uuid,uuid,timestamptz,uuid,integer),public.peekalo_social_comment(uuid,uuid,uuid,text),public.peekalo_social_remove(uuid,text,uuid),public.peekalo_social_report(uuid,text,uuid,text,text),
 public.peekalo_social_queue(uuid,timestamptz,uuid,integer),public.peekalo_social_read(uuid,text,uuid),public.peekalo_social_review(uuid,text,uuid,text,text) to service_role;
revoke all on function public.peekalo_export_recovery_checkpoint(),public.peekalo_replay_recovery_checkpoint(jsonb) from public,anon,authenticated,service_role;

-- Operator reports retain their stable social target IDs through renames.
alter function public.peekalo_moderation_queue(uuid) rename to peekalo_moderation_queue_before_social;
create function public.peekalo_moderation_queue(p_operator uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; reports jsonb;
begin
 result:=peekalo_moderation_queue_before_social(p_operator);
 select coalesce(jsonb_agg(item || jsonb_build_object('targetId',r.target_id,
  'messageId',case when r.target_kind='message' then r.target_id else null end,
  'commentId',case when r.target_kind='comment' then r.target_id else null end,
  'authorAccountId',s.author_id) order by ordinal),'[]'::jsonb) into reports
 from jsonb_array_elements(result->'reports') with ordinality entries(item,ordinal) left join peekalo_reports r on r.id=(item->>'reportId')::uuid
 left join peekalo_social_items s on s.id=r.target_id and s.kind=r.target_kind;
 return jsonb_set(result,'{reports}',reports);
end $$;
create function public.peekalo_social_operations()
returns jsonb language sql security definer set search_path=public as $$
 select jsonb_build_object('pendingReview',(select count(*) from peekalo_social_items where status='moderation_pending'),
 'oldestPendingSeconds',coalesce((select greatest(0,extract(epoch from clock_timestamp()-min(created_at)))::bigint from peekalo_social_items where status='moderation_pending'),0),
 'restrictions',(select count(*) from (select kind,item_id from peekalo_social_tombstones union select kind,id from peekalo_social_items where status<>'approved' union select 'conversation',id from peekalo_conversations where request_state='declined') entries))
$$;
alter function public.peekalo_expire_private_records() rename to peekalo_expire_private_records_before_social;
create function public.peekalo_expire_private_records()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; removed integer;
begin
 result:=peekalo_expire_private_records_before_social();
 -- Preserve the newest event per account/global sentinel so epochs never move
 -- backward. Bounded maintenance avoids one old backlog dominating a run.
 delete from peekalo_social_epochs where epoch in (select e.epoch from peekalo_social_epochs e where created_at<clock_timestamp()-interval '1 day'
  and exists(select 1 from peekalo_social_epochs newer where newer.account_id is not distinct from e.account_id and newer.epoch>e.epoch)
  order by epoch limit 5000);
 get diagnostics removed=row_count;
 return result || jsonb_build_object('socialEpochs',removed);
end $$;
revoke all on function public.peekalo_moderation_queue_before_social(uuid),public.peekalo_expire_private_records_before_social() from public,anon,authenticated,service_role;
revoke all on function public.peekalo_moderation_queue(uuid),public.peekalo_expire_private_records(),public.peekalo_social_operations() from public,anon,authenticated;
grant execute on function public.peekalo_moderation_queue(uuid),public.peekalo_expire_private_records(),public.peekalo_social_operations() to service_role;
revoke all on sequence public.peekalo_social_epochs_epoch_seq from public,anon,authenticated,service_role;

-- A late report resolution/operator note must not reintroduce free text after
-- content deletion. These guards also cover replay onto missing old rows.
create function public.peekalo_social_report_scrub()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.target_kind in ('message','comment') and (exists(select 1 from peekalo_social_tombstones where kind=new.target_kind and item_id=new.target_id)
  or not exists(select 1 from peekalo_social_items where id=new.target_id and kind=new.target_kind and status not in ('removed','rejected'))) then
  new.details:=''; new.resolution:=null;
 end if;
 return new;
end $$;
create trigger peekalo_social_report_scrubbing before insert or update on public.peekalo_reports for each row execute function public.peekalo_social_report_scrub();
create function public.peekalo_social_audit_scrub()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from peekalo_social_tombstones where item_id=new.target_id) or exists(select 1 from peekalo_reports r join peekalo_social_tombstones t on t.kind=r.target_kind and t.item_id=r.target_id where r.id=new.target_id) then new.note:=null; end if;
 return new;
end $$;
create trigger peekalo_social_audit_scrubbing before insert or update on public.peekalo_safety_audit for each row execute function public.peekalo_social_audit_scrub();
create function public.peekalo_social_tombstone_scrub()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 update peekalo_safety_audit set note=null where target_id=new.item_id or target_id in(select id from peekalo_reports where target_kind=new.kind and target_id=new.item_id);
 update peekalo_reports set details='',resolution=null where target_kind=new.kind and target_id=new.item_id;
 return new;
end $$;
create trigger peekalo_social_tombstone_scrubbing after insert on public.peekalo_social_tombstones for each row execute function public.peekalo_social_tombstone_scrub();
revoke all on function public.peekalo_social_report_scrub(),public.peekalo_social_audit_scrub(),public.peekalo_social_tombstone_scrub() from public,anon,authenticated,service_role;

-- Operator text delivery fences must recheck the privileged membership itself,
-- not only the account's ordinary social-read eligibility.
create function public.peekalo_social_operator_epoch(p_operator uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock_shared(730293001);
 perform peekalo_require_operator(p_operator);
 return peekalo_social_epoch(p_operator);
end $$;
revoke all on function public.peekalo_social_operator_epoch(uuid) from public,anon,authenticated;
grant execute on function public.peekalo_social_operator_epoch(uuid) to service_role;
