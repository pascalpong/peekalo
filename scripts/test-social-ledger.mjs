import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,readFile,readdir,rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
// Generated-only, real isolated PostgreSQL. Never reads dotenv or hosted data.
const root=fileURLToPath(new URL('../',import.meta.url));await mkdir(join(root,'.cache'),{recursive:true});const directory=await mkdtemp(join(root,'.cache/social-ledger-'));
const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
const postgres=new EmbeddedPostgres({databaseDir:join(directory,'data'),port,user:'postgres',password:randomUUID(),persistent:true,postgresFlags:['-h','127.0.0.1','-k','/tmp'],onLog:()=>{},onError:()=>{}}),clients=new Set();
async function connect(name='postgres'){const c=postgres.getPgClient(name,'127.0.0.1');await c.connect();clients.add(c);await c.query("set statement_timeout='5s';set lock_timeout='4s'");return c;}
const value=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0]?.value;
async function account(c,{terms=true,operator=false}={}){const id=randomUUID(),username=`test_${id.replaceAll('-','').slice(0,16)}`;await c.query('insert into auth.users(id) values($1)',[id]);await c.query("insert into peekalo_profiles(id,username,review_state) values($1,$2,'approved')",[id,username]);if(terms)await value(c,"select peekalo_accept_policy($1,'2026-10-29-draft','2026-10-29-draft') as value",[id]);if(operator)await c.query('insert into peekalo_operators(account_id) values($1)',[id]);return{id,username};}
async function fixture(c){const a=await account(c),b=await account(c),stranger=await account(c),op=await account(c,{operator:true});const conv=await start(c,a.id,b.id),post=randomUUID();await c.query("insert into peekalo_posts(id,owner_id,upload_key,kind,status) values($1,$2,$3,'photo','ready')",[post,a.id,randomUUID()]);return{a,b,stranger,op,conv:conv.conversationId,post};}
const start=(c,a,b,key=randomUUID())=>value(c,'select peekalo_social_start($1,$2,$3) as value',[a,b,key]);
const respond=(c,a,conv,action='accept')=>value(c,'select peekalo_social_request($1,$2,$3) as value',[a,conv,action]);
const send=(c,a,conv,body='Generated fixture',post=null,key=randomUUID())=>value(c,'select peekalo_social_send($1,$2,$3,$4,$5) as value',[a,conv,key,body,post]);
const messages=(c,a,conv,before=null,beforeId=null,limit=30)=>value(c,'select peekalo_social_messages($1,$2,$3,$4,$5) as value',[a,conv,before,beforeId,limit]);
const comments=(c,a,post)=>value(c,'select peekalo_social_comments($1,$2) as value',[a,post]);
const comment=(c,a,post,body='Generated comment',key=randomUUID())=>value(c,'select peekalo_social_comment($1,$2,$3,$4) as value',[a,post,key,body]);
const review=(c,op,kind,id,action='approve')=>value(c,'select peekalo_social_review($1,$2,$3,$4,$5) as value',[op,kind,id,action,'Generated review']);
const remove=(c,a,kind,id)=>value(c,'select peekalo_social_remove($1,$2,$3) as value',[a,kind,id]);
const report=(c,a,kind,id,reason='privacy',details='Generated details')=>value(c,'select peekalo_social_report($1,$2,$3,$4,$5) as value',[a,kind,id,reason,details]);
const fail=(action,message='unavailable')=>assert.rejects(action,{message});
async function grant(c,f,accepted=true){await value(c,'select peekalo_grant($1,$2,$3) as value',[f.a.id,f.post,f.b.username]);if(accepted)await value(c,'select peekalo_accept($1,$2) as value',[f.b.id,f.post]);}
async function blocked(observer,waiter,holder){const end=Date.now()+2500;while(Date.now()<end){if(await value(observer,'select $2=any(pg_blocking_pids($1)) as value',[waiter.processID,holder.processID]))return;await new Promise(r=>setTimeout(r,5));}assert.fail('real lock queue not observed');}
try{
 await postgres.initialise();await postgres.start();let db=await connect();
 await db.query(`create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);create role anon;create role authenticated;create role service_role;create schema realtime;create table realtime.messages(id bigint);alter table realtime.messages enable row level security;create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;`);
 for(const name of (await readdir(join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort())await db.query(await readFile(join(root,'supabase/migrations',name),'utf8'));
 await test('durable request acceptance is recipient-only, idempotent and text publication requires independent review',async()=>{
  const f=await fixture(db),key=randomUUID();const m=await send(db,f.a.id,f.conv,'Generated opener',null,key);assert.equal(m.status,'moderation_pending');assert.equal((await messages(db,f.b.id,f.conv)).items.length,0);
  assert.equal((await send(db,f.a.id,f.conv,'Generated opener',null,key)).messageId,m.messageId);await fail(()=>send(db,f.a.id,f.conv),'request_pending');await fail(()=>send(db,f.b.id,f.conv),'request_pending');await fail(()=>respond(db,f.a.id,f.conv));
  await fail(()=>review(db,f.a.id,'message',m.messageId),'forbidden');await db.query('insert into peekalo_operators(account_id) values($1)',[f.a.id]);await fail(()=>review(db,f.a.id,'message',m.messageId),'forbidden');
  await review(db,f.op.id,'message',m.messageId);assert.equal((await messages(db,f.b.id,f.conv)).items.length,0);await respond(db,f.b.id,f.conv);assert.equal((await messages(db,f.b.id,f.conv)).items[0].body,'Generated opener');await fail(()=>messages(db,f.stranger.id,f.conv));
  assert.equal((await respond(db,f.b.id,f.conv)).requestState,'accepted');await fail(()=>respond(db,f.b.id,f.conv,'decline'));
 });
 await test('decline scrubs opener and cannot reopen or mint a new pair; body/key retries cannot mutate content',async()=>{
  const f=await fixture(db),key=randomUUID(),m=await send(db,f.a.id,f.conv,'Generated opener',null,key);await fail(()=>send(db,f.a.id,f.conv,'Changed',null,key),'conflict');await respond(db,f.b.id,f.conv,'decline');
  assert.equal(await value(db,'select body is null and reference_post is null as value from peekalo_social_items where id=$1',[m.messageId]),true);assert.equal((await start(db,f.a.id,f.b.id)).requestState,'declined');await fail(()=>send(db,f.a.id,f.conv));await fail(()=>messages(db,f.b.id,f.conv));
 });
 await test('conversation uses stable account IDs through pending/renamed profiles; new requests require approved discovery',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);await db.query("update peekalo_profiles set username=$2,review_state='pending' where id=$1",[f.b.id,`renamed_${randomUUID().slice(0,8)}`]);
  const result=await value(db,'select peekalo_social_conversations($1) as value',[f.a.id]);assert.equal(result.items[0].peerAccountId,f.b.id);assert.equal(result.items[0].peerUsername,null);await send(db,f.a.id,f.conv);
  await fail(()=>start(db,f.stranger.id,f.b.id));
 });
 await test('references require owner/current grant and never grant forwarding rights, accept requests or reset allowances',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);await fail(()=>send(db,f.a.id,f.conv,null,f.post));await grant(db,f,false);const card=await send(db,f.a.id,f.conv,null,f.post);assert.equal(card.kind,'moment');assert.equal((await messages(db,f.b.id,f.conv)).items[0].postId,null);
  assert.equal(await value(db,"select request_state as value from peekalo_grants where post_id=$1 and recipient_id=$2",[f.post,f.b.id]),'pending');await value(db,'select peekalo_accept($1,$2) as value',[f.b.id,f.post]);
  await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,10000)',[f.post,`a:${f.b.id}`]);assert.equal((await messages(db,f.b.id,f.conv)).items[0].postId,f.post);
  await send(db,f.a.id,f.conv,null,f.post);assert.equal(await value(db,'select spent_ms as value from peekalo_budgets where post_id=$1',[f.post]),10000);await fail(()=>send(db,f.b.id,f.conv,null,f.post));
  await value(db,'select peekalo_revoke_recipient($1,$2,$3) as value',[f.a.id,f.post,f.b.id]);assert.equal((await messages(db,f.b.id,f.conv)).items.every(i=>i.postId===null),true);await fail(()=>send(db,f.a.id,f.conv,null,f.post));
 });
 await test('physical deletion of a referenced moment removes its obsolete card without corrupting unrelated conversation/text/budget',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);await grant(db,f);const reference=await send(db,f.a.id,f.conv,null,f.post),text=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',text.messageId);
  const other=randomUUID();await db.query("insert into peekalo_posts(id,owner_id,upload_key,kind,status) values($1,$2,$3,'photo','ready')",[other,f.a.id,randomUUID()]);await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,6000)',[other,`a:${f.b.id}`]);
  await db.query('delete from peekalo_posts where id=$1',[f.post]);assert.equal(await value(db,'select count(*)::int as value from peekalo_social_items where id=$1',[reference.messageId]),0);assert.equal(await value(db,"select count(*)::int as value from peekalo_social_tombstones where kind='message' and item_id=$1",[reference.messageId]),1);assert.equal((await messages(db,f.b.id,f.conv)).items[0].body,'Generated fixture');assert.equal(await value(db,'select spent_ms as value from peekalo_budgets where post_id=$1',[other]),6000);assert.equal(await value(db,'select count(*)::int as value from peekalo_conversations where id=$1',[f.conv]),1);
 });
 await test('owner moment deletion scrubs its comments/references immediately while preserving independent text and ledgers',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);await grant(db,f);
  const card=await send(db,f.a.id,f.conv,null,f.post),c=await comment(db,f.b.id,f.post),text=await send(db,f.a.id,f.conv);await review(db,f.op.id,'comment',c.commentId);await review(db,f.op.id,'message',text.messageId);
  await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,6000)',[f.post,`a:${f.b.id}`]);
  await value(db,'select peekalo_delete_post($1,$2) as value',[f.a.id,f.post]);
  assert.equal(await value(db,"select bool_and(status='removed' and body is null and reference_post is null) as value from peekalo_social_items where id=any($1::uuid[])",[[card.messageId,c.commentId]]),true);
  assert.equal(await value(db,'select count(*)::int as value from peekalo_social_tombstones where item_id=any($1::uuid[])',[[card.messageId,c.commentId]]),2);
  assert.equal((await messages(db,f.b.id,f.conv)).items[0].body,'Generated fixture');assert.equal(await value(db,'select spent_ms as value from peekalo_budgets where post_id=$1',[f.post]),6000);await fail(()=>comments(db,f.b.id,f.post));
 });
 await test('comments require accepted native audience, survive exhaustion and fail after revocation; anonymous/strangers denied',async()=>{
  const f=await fixture(db);await fail(()=>comment(db,f.b.id,f.post));await fail(()=>comments(db,f.stranger.id,f.post));await fail(()=>comments(db,null,f.post));await grant(db,f,false);await fail(()=>comments(db,f.b.id,f.post));await value(db,'select peekalo_accept($1,$2) as value',[f.b.id,f.post]);
  const i=await comment(db,f.b.id,f.post);assert.equal((await comments(db,f.a.id,f.post)).items.length,0);await review(db,f.op.id,'comment',i.commentId);await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,10000)',[f.post,`a:${f.b.id}`]);assert.equal((await comments(db,f.b.id,f.post)).items[0].commentId,i.commentId);
  await value(db,'select peekalo_revoke_recipient($1,$2,$3) as value',[f.a.id,f.post,f.b.id]);await fail(()=>comments(db,f.b.id,f.post));assert.deepEqual(await remove(db,f.b.id,'comment',i.commentId),{removed:true});
 });
 await test('author deletion/post-owner removal scrub bodies, report resolution/audit notes and cannot be undone by approval',async()=>{
  const f=await fixture(db);await grant(db,f);const i=await comment(db,f.b.id,f.post);await review(db,f.op.id,'comment',i.commentId);await fail(()=>remove(db,f.stranger.id,'comment',i.commentId));const r=await report(db,f.a.id,'comment',i.commentId);await value(db,'select peekalo_resolve_report($1,$2,$3) as value',[f.op.id,r.reportId,'Generated sensitive resolution']);
  await remove(db,f.a.id,'comment',i.commentId);assert.equal(await value(db,'select body is null as value from peekalo_social_items where id=$1',[i.commentId]),true);assert.equal(await value(db,"select details='' and resolution is null as value from peekalo_reports where id=$1",[r.reportId]),true);assert.equal(await value(db,'select bool_and(note is null) as value from peekalo_safety_audit where target_id in($1,$2)',[i.commentId,r.reportId]),true);await fail(()=>review(db,f.op.id,'comment',i.commentId));
 });
 await test('terminal social removal prevents late reports/resolutions/audit notes from restoring free text',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);const m=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',m.messageId);const r=await report(db,f.b.id,'message',m.messageId);await review(db,f.op.id,'message',m.messageId,'takedown');
  assert.equal(await value(db,'select bool_and(note is null) as value from peekalo_safety_audit where target_id=$1',[m.messageId]),true);await fail(()=>report(db,f.a.id,'message',m.messageId));await value(db,'select peekalo_resolve_report($1,$2,$3) as value',[f.op.id,r.reportId,'Late generated sensitive resolution']);
  assert.equal(await value(db,"select details='' and resolution is null as value from peekalo_reports where id=$1",[r.reportId]),true);assert.equal(await value(db,'select bool_and(note is null) as value from peekalo_safety_audit where target_id in ($1,$2)',[m.messageId,r.reportId]),true);
  const rejected=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',rejected.messageId,'reject');assert.equal(await value(db,"select note is null as value from peekalo_safety_audit where event='social_reject' and target_id=$1",[rejected.messageId]),true);
 });
 await test('reports resolve actual audience targets, prioritize child safety and share the same hourly report lane',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);const m=await send(db,f.a.id,f.conv);await fail(()=>report(db,f.b.id,'message',m.messageId));await review(db,f.op.id,'message',m.messageId);await fail(()=>report(db,f.stranger.id,'message',m.messageId));
  const r=await report(db,f.b.id,'message',m.messageId);assert.equal((await report(db,f.b.id,'message',m.messageId,'child_safety')).reportId,r.reportId);assert.equal(await value(db,'select reason as value from peekalo_reports where id=$1',[r.reportId]),'child_safety');
  const q=await value(db,'select peekalo_moderation_queue($1) as value',[f.op.id]);assert.equal(q.reports.find(i=>i.reportId===r.reportId).messageId,m.messageId);
  for(let i=0;i<9;i++)await db.query("insert into peekalo_reports(reporter_identity,target_kind,target_id,reason,details) values($1,'account',$2,'spam','')",[`a:${f.b.id}`,randomUUID()]);const m2=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',m2.messageId);await fail(()=>report(db,f.b.id,'message',m2.messageId),'rate_limited');
 });
 await test('bilateral blocks/suspensions disable existing threads and comment authors, and global restriction epoch fences third-party readers',async()=>{
  const f=await fixture(db);await grant(db,f);await respond(db,f.b.id,f.conv);const i=await comment(db,f.b.id,f.post);await review(db,f.op.id,'comment',i.commentId);await value(db,'select peekalo_grant($1,$2,$3) as value',[f.a.id,f.post,f.stranger.username]);await value(db,'select peekalo_accept($1,$2) as value',[f.stranger.id,f.post]);
  const before=(await value(db,'select peekalo_social_epoch($1) as value',[f.stranger.id])).epoch;await value(db,'select peekalo_block($1,null,true,$2) as value',[f.b.id,f.a.id]);await fail(()=>messages(db,f.b.id,f.conv));await fail(()=>messages(db,f.a.id,f.conv));await fail(()=>comment(db,f.b.id,f.post));
  assert((await value(db,'select peekalo_social_epoch($1) as value',[f.stranger.id])).epoch>before);await value(db,'select peekalo_block($1,null,false,$2) as value',[f.b.id,f.a.id]);await value(db,'select peekalo_moderate_account($1,$2,$3,$4) as value',[f.op.id,f.b.username,'suspend','Generated safety restriction']);assert.equal((await comments(db,f.stranger.id,f.post)).items.length,0);await fail(()=>messages(db,f.b.id,f.conv));
 });
 await test('authenticated realtime policy binds exact self account and disabling denies new subscriptions; signals contain no content',async()=>{
  const f=await fixture(db);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[f.a.id]);assert.equal(await value(db,'select peekalo_realtime_allowed($1) as value',[`peekalo:account:${f.a.id}`]),true);assert.equal(await value(db,'select peekalo_realtime_allowed($1) as value',[`peekalo:account:${f.b.id}`]),false);assert.equal(await value(db,"select count(*)::int as value from pg_policies where schemaname='realtime' and policyname='peekalo_social_receive' and cmd='SELECT'"),1);
  const before=await value(db,'select peekalo_social_epoch($1) as value',[f.b.id]);await value(db,'select peekalo_begin_deletion($1) as value',[f.a.id]);assert.equal(await value(db,'select peekalo_realtime_allowed($1) as value',[`peekalo:account:${f.a.id}`]),false);assert((await value(db,'select peekalo_social_epoch($1) as value',[f.b.id])).epoch>before.epoch);
  const columns=await value(db,"select array_agg(column_name::text order by ordinal_position) as value from information_schema.columns where table_name='peekalo_social_epochs'");assert.deepEqual(columns,['epoch','account_id','created_at']);
 });
 await test('terms guards, hard body bounds, meaningful cursor pagination and sender rate limits hold at SQL boundary',async()=>{
  const f=await fixture(db),noTerms=await account(db,{terms:false});await fail(()=>start(db,noTerms.id,f.a.id),'terms_required');await respond(db,f.b.id,f.conv);await fail(()=>send(db,f.a.id,f.conv,'x'.repeat(1001)),'conflict');await fail(()=>send(db,f.a.id,f.conv,' '),'conflict');
  const ids=[];for(let n=0;n<5;n++)ids.push((await send(db,f.a.id,f.conv,`Generated ${n}`)).messageId);const first=await messages(db,f.a.id,f.conv,null,null,3),second=await messages(db,f.a.id,f.conv,first.nextCursor.createdAt,first.nextCursor.id,3);assert.equal(new Set([...first.items,...second.items].map(i=>i.messageId)).size,5);assert.equal(second.nextCursor,null);
  for(let n=0;n<15;n++)await send(db,f.a.id,f.conv);await fail(()=>send(db,f.a.id,f.conv),'rate_limited');await fail(()=>messages(db,f.a.id,f.conv,null,null,51),'conflict');
 });
 await test('real lock-queued send cannot write after account disabling commits; deletion removes both participants content/membership and preserves unrelated discussion',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);const m=await send(db,f.a.id,f.conv);const other=await start(db,f.b.id,f.stranger.id);await respond(db,f.stranger.id,other.conversationId);const kept=await send(db,f.b.id,other.conversationId);
  const holder=await connect(),writer=await connect();await holder.query('begin');await holder.query('select pg_advisory_xact_lock(730293001)');const pending=send(writer,f.b.id,f.conv).then(v=>({value:v}),error=>({error}));await blocked(db,writer,holder);await value(holder,'select peekalo_begin_deletion($1) as value',[f.a.id]);await holder.query('commit');assert.equal((await pending).error.message,'unavailable');
  assert.equal(await value(db,'select count(*)::int as value from peekalo_conversations where id=$1',[f.conv]),0);assert.equal(await value(db,'select count(*)::int as value from peekalo_social_items where id=$1',[m.messageId]),0);assert.equal(await value(db,'select count(*)::int as value from peekalo_social_items where id=$1',[kept.messageId]),1);assert.equal(await value(db,"select count(*)::int as value from peekalo_social_tombstones where kind='conversation' and item_id=$1",[f.conv]),1);
 });
 await test('real lock-queued social reads and writes deny after a bilateral block commits',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);await grant(db,f);const m=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',m.messageId);
  const before=(await value(db,'select peekalo_social_epoch($1) as value',[f.b.id])).epoch;
  const holder=await connect(),reader=await connect(),writer=await connect();await holder.query('begin');await holder.query('select pg_advisory_xact_lock(730293001)');
  const read=messages(reader,f.b.id,f.conv).then(value=>({value}),error=>({error})),write=send(writer,f.b.id,f.conv).then(value=>({value}),error=>({error}));
  await blocked(db,reader,holder);await blocked(db,writer,holder);await value(holder,'select peekalo_block($1,null,true,$2) as value',[f.a.id,f.b.id]);await holder.query('commit');
  assert.equal((await read).error.message,'unavailable');assert.equal((await write).error.message,'unavailable');
  assert((await value(db,'select peekalo_social_epoch($1) as value',[f.b.id])).epoch>before);assert.equal(await value(db,'select count(*)::int as value from peekalo_social_items where conversation_id=$1',[f.conv]),1);
 });
 await test('concurrent distinct-recipient request admissions share the sender cap and simultaneous pair creation is single-winner',async()=>{
  const a=await account(db),targets=[];for(let n=0;n<12;n++)targets.push(await account(db));const connections=await Promise.all(Array.from({length:12},()=>connect()));const results=await Promise.allSettled(connections.map((c,n)=>start(c,a.id,targets[n].id)));assert.equal(results.filter(r=>r.status==='fulfilled').length,10);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='rate_limited').length,2);
  const x=await account(db),y=await account(db);const pairs=await Promise.all(connections.slice(0,6).map((c,n)=>start(c,n%2?y.id:x.id,n%2?x.id:y.id)));assert.equal(new Set(pairs.map(i=>i.conversationId)).size,1);
 });
 await test('direct table/helper/checkpoint privileges deny all clients; operators only receive audited text reads',async()=>{
  for(const role of ['anon','authenticated','service_role']){assert.equal(await value(db,"select has_table_privilege($1,'peekalo_social_items','select') as value",[role]),false);assert.equal(await value(db,"select has_function_privilege($1,'peekalo_social_item_json(uuid,uuid)','execute') as value",[role]),false);assert.equal(await value(db,"select has_function_privilege($1,'peekalo_replay_recovery_checkpoint(jsonb)','execute') as value",[role]),false);}
  const f=await fixture(db),m=await send(db,f.a.id,f.conv);await fail(()=>value(db,'select peekalo_social_read($1,$2,$3) as value',[f.stranger.id,'message',m.messageId]),'forbidden');const data=await value(db,'select peekalo_social_read($1,$2,$3) as value',[f.op.id,'message',m.messageId]);assert.equal(data.body,'Generated fixture');assert.equal(await value(db,"select count(*)::int as value from peekalo_safety_audit where event='social_body_read' and target_id=$1",[m.messageId]),1);const q=await value(db,'select peekalo_social_queue($1) as value',[f.op.id]);assert.equal(q.items.some(i=>'body'in i),false);
 });
 await test('operator delivery fence checks fresh privileged membership even while ordinary account epoch stays unchanged',async()=>{
  const f=await fixture(db),m=await send(db,f.a.id,f.conv);const before=await value(db,'select peekalo_social_operator_epoch($1) as value',[f.op.id]);
  assert.equal((await value(db,'select peekalo_social_read($1,$2,$3) as value',[f.op.id,'message',m.messageId])).body,'Generated fixture');
  await db.query('update peekalo_operators set enabled=false where account_id=$1',[f.op.id]);
  assert.equal((await value(db,'select peekalo_social_epoch($1) as value',[f.op.id])).epoch,before.epoch);
  await fail(()=>value(db,'select peekalo_social_operator_epoch($1) as value',[f.op.id]),'forbidden');
 });
 await test('actual older database snapshot cannot resurrect removed text, declined memberships or account-deleted social bodies on restricted replay',async()=>{
  const f=await fixture(db);await respond(db,f.b.id,f.conv);const m=await send(db,f.a.id,f.conv);await review(db,f.op.id,'message',m.messageId);await grant(db,f);const i=await comment(db,f.b.id,f.post);await review(db,f.op.id,'comment',i.commentId);const x=await account(db),y=await account(db),pending=await start(db,x.id,y.id),opener=await send(db,x.id,pending.conversationId);await review(db,f.op.id,'message',opener.messageId);const retained=await fixture(db);await respond(db,retained.b.id,retained.conv);await grant(db,retained);const standaloneMessage=await send(db,retained.a.id,retained.conv),standaloneComment=await comment(db,retained.b.id,retained.post);await review(db,retained.op.id,'message',standaloneMessage.messageId);await review(db,retained.op.id,'comment',standaloneComment.commentId);
  for(const c of [...clients]){await c.end();clients.delete(c);}const admin=await connect('template1');await admin.query('create database generated_social_restore template postgres');db=await connect();
  await remove(db,f.a.id,'message',m.messageId);await remove(db,retained.a.id,'message',standaloneMessage.messageId);await remove(db,retained.b.id,'comment',standaloneComment.commentId);await respond(db,y.id,pending.conversationId,'decline');await value(db,'select peekalo_begin_deletion($1) as value',[f.b.id]);const cp=await value(db,'select peekalo_export_recovery_checkpoint() as value');assert(cp.socialRestrictions.some(r=>r.itemId===m.messageId));assert(!JSON.stringify(cp).includes('Generated fixture'));
  const restored=await connect('generated_social_restore');assert.equal(await value(restored,'select body is not null as value from peekalo_social_items where id=$1',[m.messageId]),true);await value(restored,'select peekalo_replay_recovery_checkpoint($1) as value',[JSON.stringify(cp)]);assert.equal(await value(restored,'select count(*)::int as value from peekalo_social_items where id in ($1,$2)',[m.messageId,i.commentId]),0);assert.equal(await value(restored,'select request_state as value from peekalo_conversations where id=$1',[pending.conversationId]),'declined');await fail(()=>messages(restored,y.id,pending.conversationId));assert.equal(await value(restored,'select body is null as value from peekalo_social_items where id=$1',[opener.messageId]),true);
  assert.equal(await value(restored,"select bool_and(status='removed' and body is null and reference_post is null) as value from peekalo_social_items where id in($1,$2)",[standaloneMessage.messageId,standaloneComment.commentId]),true);assert.equal((await messages(restored,retained.b.id,retained.conv)).items.length,0);await value(restored,'select peekalo_replay_recovery_checkpoint($1) as value',[JSON.stringify(cp)]);const invalid={...cp};delete invalid.socialRestrictions;await fail(()=>value(restored,'select peekalo_replay_recovery_checkpoint($1) as value',[JSON.stringify(invalid)]),'conflict');
 });
}finally{await Promise.allSettled([...clients].map(c=>c.end()));await postgres.stop();await rm(directory,{recursive:true,force:true});}
