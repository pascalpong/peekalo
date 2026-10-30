import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source=ts.transpileModule(await readFile(new URL('../apps/web/lib/server/media-maintenance.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const owner='11111111-1111-4111-8111-111111111111', post='22222222-2222-4222-8222-222222222222', current='33333333-3333-4333-8333-333333333333', old='44444444-4444-4444-8444-444444444444';
const base=`${owner}/${post}`, protectedPath=`${base}/${current}.mp4`, stalePath=`${base}/${old}.mp4`;
function fixture({paths=[protectedPath,stalePath,`${base}.jpg`],jobs=[{ownerId:owner,postId:post}],partial=false,fail=false,allow=path=>path!==protectedPath,done=true}={}){
 const files=new Set([...paths,`${owner}/other/keep.mp4`]),events=[];
 const storage={async list(prefix,options){events.push(['list',prefix]);if(fail)throw Error('private provider error');const names=new Map();for(const path of files){if(!path.startsWith(`${prefix}/`))continue;const tail=path.slice(prefix.length+1),name=tail.split('/')[0];names.set(name,{name,id:tail.includes('/')?null:'object'});}return{data:[...names.values()].sort((a,b)=>a.name.localeCompare(b.name)).slice(options.offset,options.offset+options.limit),error:null};},async remove(paths){events.push(['remove',...paths]);if(!partial)for(const path of paths)files.delete(path);return{error:null};}};
 const call=async(name,args)=>{events.push([name,args]);if(name==='peekalo_media_cleanup_jobs')return jobs;if(name==='peekalo_media_cleanup_path')return allow(args.p_path);assert.equal(name,'peekalo_media_cleanup_done');return done;};
 const db={storage:{from(){return storage;}}},module={exports:{}};
 new Function('require','module','exports',source)(name=>name==='./sharing'?{database:()=>db,rpc:call}:{privateMediaCache:{remove:path=>events.push(['cache',path])}},module,module.exports);
 return{files,events,run:module.exports.createMediaMaintenance()};
}
test('sweep recovers attempt/legacy orphans while preserving the published path and unrelated moments',async()=>{const f=fixture();assert.deepEqual(await f.run(),{examined:1,completed:1,pending:0,removed:2});assert.deepEqual([...f.files],[protectedPath,`${owner}/other/keep.mp4`]);assert.equal(f.events.at(-1)[1].p_ok,true);});
test('authorization is checked per current path, so a retry that started after enumeration is preserved',async()=>{let checks=0;const f=fixture({paths:[stalePath],allow:()=>{checks++;return false;}});assert.equal((await f.run()).completed,1);assert(f.files.has(stalePath));assert.equal(checks,2);assert(!f.events.some(e=>e[0]==='remove'));});
test('partial successful Storage replies and provider outages remain retryable pending',async()=>{for(const config of[{partial:true},{fail:true}]){const f=fixture(config);assert.equal((await f.run()).pending,1);assert.equal(f.events.at(-1)[1].p_ok,false);}});
test('unexpected subdirectories, invalid attempt names and malformed jobs never widen deletion',async()=>{for(const path of[`${base}/unknown.jpg`,`${base}/nested/${old}.mp4`]){const f=fixture({paths:[path]});assert.equal((await f.run()).pending,1);assert(!f.events.some(e=>e[0]==='remove'));}const f=fixture({jobs:[{ownerId:'../other',postId:post}]});assert.equal((await f.run()).pending,1);assert(!f.events.some(e=>e[0]==='list'));});
test('large paginated inventories are collected before deletion and reverified',async()=>{const paths=Array.from({length:220},(_,i)=>`${base}/${i.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111.jpg`);const f=fixture({paths,allow:()=>true});assert.equal((await f.run()).removed,220);assert.equal(f.files.size,1);assert(f.events.filter(e=>e[0]==='list').length>=6);});
test('unreleased writer barriers or failed progress cannot mark a sweep complete',async()=>{const f=fixture({done:false});assert.equal((await f.run()).pending,1);assert.equal(f.events.at(-1)[1].p_ok,false);});
