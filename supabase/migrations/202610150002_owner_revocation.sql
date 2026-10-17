-- Preserve reservation limits during failed-upload retries and allow owner revocation.
create or replace function public.peekalo_reserve_post(p_owner uuid,p_key uuid,p_kind text,p_limit integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result public.peekalo_posts;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into result from peekalo_posts where owner_id=p_owner and upload_key=p_key for update;
 if found then
   if result.kind <> p_kind then raise exception 'conflict'; end if;
   if result.status='failed' then
     if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and status in ('ready','uploading')) >= p_limit then raise exception 'quota'; end if;
     update peekalo_posts set status='uploading' where id=result.id returning * into result;
     return to_jsonb(result) || jsonb_build_object('reserved',true);
   end if;
   return to_jsonb(result) || jsonb_build_object('reserved',false);
 end if;
 if p_limit is not null and (select count(*) from peekalo_posts where owner_id=p_owner and status in ('ready','uploading')) >= p_limit then raise exception 'quota'; end if;
 insert into peekalo_posts(owner_id,upload_key,kind) values(p_owner,p_key,p_kind) returning * into result;
 return to_jsonb(result) || jsonb_build_object('reserved',true);
end $$;


create function public.peekalo_revoke(p_owner uuid,p_post uuid,p_username text default null)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform 1 from peekalo_posts where id=p_post and owner_id=p_owner for update;
 if not found then raise exception 'unavailable'; end if;
 if p_username is null then
   update peekalo_links set revoked=true where post_id=p_post;
 else
   update peekalo_grants set revoked=true where post_id=p_post and recipient_id=(select id from peekalo_profiles where username=p_username);
 end if;
 return true;
end $$;
revoke all on function public.peekalo_revoke(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.peekalo_revoke(uuid,uuid,text) to service_role;
