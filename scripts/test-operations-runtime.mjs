import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import runtime from './operations-runtime.cjs';
const { Response } = globalThis;
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/operations.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module = {exports:{}};
new Function('require','module','exports',source)(name => {
  if (name === './sharing') return {rpc:()=>{throw new Error('Unexpected database');}};
  if (name === './account-cleanup') return {createAccountCleanup:()=>{throw new Error('Unexpected cleanup');}};
  if (name === './media-maintenance') return {createMediaMaintenance:()=>{throw new Error('Unexpected cleanup');}};
  assert.fail('Unexpected import');
}, module, module.exports);
const create = module.exports.createOperations;
const env = {PEEKALO_DEPLOYMENT:'staging',SUPABASE_URL:'https://staging.example.invalid',PEEKALO_EXPECTED_BACKEND_ORIGIN:'https://staging.example.invalid',PEEKALO_PRODUCTION_BACKEND_ORIGIN:'https://production.example.invalid',OPS_HEARTBEAT_URL:'https://monitor.example.invalid/private-heartbeat',OPS_ALERT_URL:'https://monitor.example.invalid/private-alert'};

test('environment guard rejects cross-environment target and missing monitor destinations before mutation',()=>{
  assert.doesNotThrow(()=>runtime.validateOperationsEnvironment(env));
  for(const value of [
    {...env,PEEKALO_EXPECTED_BACKEND_ORIGIN:env.PEEKALO_PRODUCTION_BACKEND_ORIGIN},
    {...env,SUPABASE_URL:env.PEEKALO_PRODUCTION_BACKEND_ORIGIN,PEEKALO_EXPECTED_BACKEND_ORIGIN:env.PEEKALO_PRODUCTION_BACKEND_ORIGIN},
    {...env,PEEKALO_DEPLOYMENT:'production'}, {...env,PEEKALO_PRODUCTION_BACKEND_ORIGIN:''},
    {...env,OPS_ALERT_URL:''}, {...env,OPS_HEARTBEAT_URL:'http://monitor.example.invalid'},
    {...env,OPS_ALERT_URL:'https://user:secret@example.invalid'},
  ]) assert.throws(()=>runtime.validateOperationsEnvironment(value));
  assert.doesNotThrow(()=>runtime.validateOperationsEnvironment({...env,PEEKALO_DEPLOYMENT:'production',SUPABASE_URL:env.PEEKALO_PRODUCTION_BACKEND_ORIGIN,PEEKALO_EXPECTED_BACKEND_ORIGIN:env.PEEKALO_PRODUCTION_BACKEND_ORIGIN}));
});

test('repeat scheduled runs sequence bounded cleanup, expiry, durable completion and independent heartbeat',async()=>{
  const events=[];
  const run=create({media:async()=>{events.push('media');return {pending:0};},accounts:async()=>{events.push('accounts');return {examined:1,completed:1,pending:0};},call:async(name,args)=>{events.push([name,args]);},notify:async event=>events.push(event)});
  await run(); await run();
  assert.deepEqual(events.slice(0,5),['media','accounts',['peekalo_abuse_expire',{}],['peekalo_maintenance_heartbeat',{p_ok:true,p_pending:0}],'success']);
  assert.deepEqual(events.slice(0,5),events.slice(5));
});

test('partial storage/auth/writer failures and outages cannot signal success; alert failure remains nonzero',async()=>{
  for(const failure of ['pending','media','database','alert']) {
    const events=[];
    const run=create({media:async()=>{if(failure==='media')throw new Error('private-path');return {pending:failure==='pending'?1:0};},accounts:async()=>({examined:0,completed:0,pending:0}),call:async(name,args)=>{events.push([name,args]);if(failure==='database')throw new Error('credential');},notify:async event=>{events.push(event);if(failure==='alert')throw new Error('private-hook');}});
    await assert.rejects(run,/operations_incomplete/);
    assert.equal(events.at(-1),'failure');
    assert(events.some(value=>Array.isArray(value)&&value[0]==='peekalo_maintenance_heartbeat'&&value[1].p_ok===false));
  }
});

test('independent watchdog detects first run, scheduler loss and failed run',async()=>{
  for(const status of [{},{lastRunOk:true,lastSuccessSeconds:null},{lastRunOk:true,lastSuccessSeconds:1801},{lastRunOk:false,lastSuccessSeconds:1},{lastRunOk:true,lastSuccessSeconds:-1}]){
    const events=[];const run=create({call:async()=>status,notify:async event=>events.push(event)});
    await assert.rejects(()=>run('monitor'));assert.deepEqual(events,['failure']);
  }
  const events=[];await create({call:async()=>({lastRunOk:true,lastSuccessSeconds:60,oldestDeletionSeconds:0,writerPending:0,staleUploads:0,cleanupBacklog:0,deniedLastHour:0}),notify:async event=>events.push(event)})('monitor');assert.deepEqual(events,['success']);
});

test('notifications carry fixed events only, bound timeout and refuse redirects/provider errors',async()=>{
  const calls=[];const send=async(url,init)=>{calls.push({url,init});return new Response(null,{status:204});};
  const hooks=runtime.validateOperationsEnvironment(env);
  await runtime.createNotifier(hooks,send)('failure');
  assert.equal(calls[0].url,hooks.alert);assert.equal(calls[0].init.redirect,'error');
  assert.deepEqual(JSON.parse(calls[0].init.body),{service:'peekalo-maintenance',event:'failure'});
  await assert.rejects(()=>runtime.createNotifier(hooks,async()=>new Response(null,{status:503}))('failure'));
});

test('packaged runner refuses absent credentials/hooks with fixed redacted output',()=>{
  const result=spawnSync(process.execPath,['apps/web/.next/maintenance/account-cleanup.cjs'],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Peekalo operations incomplete; inspect restricted operational state.\n');
});

test('watchdog alerts for stale writers, aged deletions, queue overflow and abnormal traffic',async()=>{
  const healthy={lastRunOk:true,lastSuccessSeconds:60,oldestDeletionSeconds:0,writerPending:0,staleUploads:0,cleanupBacklog:0};
  for(const patch of [{writerPending:1},{oldestDeletionSeconds:3601},{cleanupBacklog:101},{staleUploads:1},{writerPending:'1'}]){
    const events=[];
    const run=create({call:async name=>name==='peekalo_operations_status'?{...healthy,...patch}:{deniedLastHour:0},notify:async event=>events.push(event)});
    await assert.rejects(()=>run('monitor'));assert.deepEqual(events,['failure']);
  }
  for(const deniedLastHour of [100,NaN,-1]){
    const events=[];
    await assert.rejects(()=>create({call:async name=>name==='peekalo_operations_status'?healthy:{deniedLastHour},notify:async event=>events.push(event)})('monitor'));
    assert.deepEqual(events,['failure']);
  }
});

test('readiness refuses missing operations migrations and releases all upstream bodies',async()=>{
  const healthSource=ts.transpileModule(await readFile(new URL('../apps/web/app/api/health/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  for(const missing of [null,'peekalo_operations_status','peekalo_abuse_status']){
    let released=0;const module={exports:{}};
    new Function('require','module','exports','fetch',healthSource)(()=>({configuration:()=>({url:'https://backend.invalid',service:'private-sentinel'})}),module,module.exports,async input=>{
      const path=new URL(input).pathname;
      if(path.endsWith('/peekalo-captures'))return Response.json({public:false,file_size_limit:30*1024*1024});
      return new Response(new globalThis.ReadableStream({cancel(){released++;}}),{status:missing&&path.endsWith(missing)?404:200});
    });
    const result=await module.exports.GET();assert.equal(result.status,missing?503:200);assert.deepEqual(await result.json(),{ready:!missing});assert.equal(released,3);assert.match(result.headers.get('cache-control'),/no-store/);
  }
});
