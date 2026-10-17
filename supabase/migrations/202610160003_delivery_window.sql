create or replace function public.peekalo_lease(p_identity text,p_session uuid,p_request uuid,p_hash text default null,p_post uuid default null)
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
 -- Two-second slices allow private storage fetches to complete. Renewal opens only near expiry; total remains 10000 ms.
 if budget.active_until>stamp+interval '750 milliseconds' then raise exception 'early'; end if;
 duration:=least(2000,10000-budget.spent_ms);
 deadline:=greatest(stamp,coalesce(budget.active_until,stamp)) + duration * interval '1 millisecond';
 if link.id is not null then
   deadline:=least(deadline,link.expires_at);
   update peekalo_links set claimed_identity=p_identity where id=link.id and claimed_identity is null;
 end if;
 update peekalo_budgets set spent_ms=spent_ms+duration,active_session=p_session,active_until=deadline where post_id=p_post and identity=p_identity;
 insert into peekalo_leases(post_id,identity,link_id,session_id,request_id,granted_ms,remaining_ms,expires_at) values(p_post,p_identity,link.id,p_session,p_request,duration,10000-budget.spent_ms-duration,deadline) returning * into lease;
 return jsonb_build_object('leaseId',lease.id,'grantedMs',lease.granted_ms,'remainingMs',lease.remaining_ms,'expiresAt',lease.expires_at);
end $$;

