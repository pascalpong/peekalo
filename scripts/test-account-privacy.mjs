import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const { Request, Response } = globalThis;
const compile=async path=>ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const [source,sharingSource,appleSource]=await Promise.all([compile('../apps/web/lib/server/account-privacy.ts'),compile('../apps/web/lib/server/sharing.ts'),compile('../apps/web/lib/server/apple-revocation.ts')]);
function load(code,imports){const module={exports:{}};new Function('require','module','exports',code)(name=>{assert(Object.hasOwn(imports,name),name);return imports[name];},module,module.exports);return module.exports;}
const sharing=load(sharingSource,{'node:crypto':crypto,'@supabase/supabase-js':{}});
const actor='11111111-1111-4111-8111-111111111111', requestId='22222222-2222-4222-8222-222222222222', app='https://app.invalid';
const jwt=(claims={})=>`synthetic.${Buffer.from(JSON.stringify({sub:actor,amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}],...claims})).toString('base64url')}.synthetic`;
function fixture({call=async name=>name==='peekalo_begin_deletion'?{status:'pending',requestId}:name==='peekalo_deletion_status'?{status:'pending',needsAppleReauthentication:false}:{accepted:false,deletionStatus:null},identities=[],revoke=async()=>{},ready=false,auth=async()=>actor}={}){
 const calls=[];const module=load(source,{'node:crypto':crypto,'./sharing':{...sharing,account:auth,sameOrigin:request=>{if(request.headers.get('origin')!==app)throw new sharing.ApiError(403,'origin_not_allowed');},policyReady:()=>ready,configuration:()=>({appUrl:app,secret:'synthetic-fixture-secret-never-production'}),database:()=>({auth:{getUser:async()=>({data:{user:{id:actor,identities}},error:null})}}),rpc:async(name,args)=>{calls.push({name,args});return call(name,args);}},'./apple-revocation':{revokeAppleAuthorization:revoke}});
 const req=(value,token=jwt(),origin=app)=>new Request(`${app}/api/account/delete`,{method:'POST',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(origin?{Origin:origin}: {})},body:JSON.stringify(value)});
 return {module,calls,req};
}
test('recent authentication uses signed authentication event, never refresh/issuance/recovery or editable metadata',()=>{
 const f=fixture();const now=Date.now(), timestamp=Math.floor(now/1000);
 for(const amr of [[{method:'password',timestamp}],[{method:'oauth',timestamp}]])assert.doesNotThrow(()=>f.module.requireRecentAuthentication(jwt({amr}),actor,now));
 for(const claims of [{iat:timestamp,amr:[{method:'password',timestamp:timestamp-301}]},{amr:[{method:'token_refresh',timestamp}]},{amr:[{method:'recovery',timestamp}]},{amr:[{method:'email/signup',timestamp}]},{amr:[{method:'oauth',timestamp:timestamp+60}]},{sub:requestId},{amr:null}])assert.throws(()=>f.module.requireRecentAuthentication(jwt(claims),actor,now),/recent_auth_required/);
});
test('deletion derives owner from verified bearer, demands explicit exact confirmation, ignores no supplied account ID',async()=>{
 const f=fixture();
 for(const input of [{confirmation:'delete'},{confirmation:'DELETE',accountId:requestId},{confirmation:'DELETE',appleAuthorizationCode:123}])assert.equal((await f.module.deleteAccount(f.req(input))).status,400);
 assert.equal(f.calls.length,0);
 const result=await f.module.deleteAccount(f.req({confirmation:'DELETE'}));assert.equal(result.status,202);assert.match(result.headers.get('cache-control'),/no-store/);
 const value=await result.json();assert.equal(value.status,'pending');assert.equal(value.requestId,requestId);assert.equal(value.receipt.length,43);assert.equal(new URL(value.statusUrl).search,'');
 assert.deepEqual(f.calls[0],{name:'peekalo_begin_deletion',args:{p_actor:actor,p_provider_required:false}});
});
test('cross-origin browser deletion and stale auth do not reach mutation',async()=>{
 const f=fixture();assert.equal((await f.module.deleteAccount(f.req({confirmation:'DELETE'},jwt(),'https://evil.invalid'))).status,403);
 assert.equal((await f.module.deleteAccount(f.req({confirmation:'DELETE'},jwt({amr:[]})))).status,401);assert.equal(f.calls.length,0);
 const denied=fixture({auth:async()=>{throw new sharing.ApiError(401,'sign_in_required');}});assert.equal((await denied.module.deleteAccount(denied.req({confirmation:'DELETE'},null))).status,401);
});
test('Apple request disables first; missing/failing provider revocation remains pending and never records success',async()=>{
 for(const code of [undefined,'synthetic-code']){
  const f=fixture({identities:[{provider:'apple',identity_data:{sub:'synthetic-sub'}}],revoke:async()=>{throw new Error('sensitive upstream text');}});
  const result=await f.module.deleteAccount(f.req({confirmation:'DELETE',...(code?{appleAuthorizationCode:code}: {})}));assert.equal(result.status,202);assert.equal(f.calls.length,1);assert(f.calls[0].args.p_provider_required);assert(!JSON.stringify(await result.json()).includes('sensitive'));
 }
});
test('Apple confirmed revocation follows durable disabling and is recorded for retryable cleanup',async()=>{
 const events=[];const f=fixture({identities:[{provider:'apple',identity_data:{sub:'synthetic-sub'}}],call:async name=>{events.push(name);return {status:'pending',requestId};},revoke:async(code,sub)=>{assert.equal(code,'synthetic-code');assert.equal(sub,'synthetic-sub');events.push('revoke');}});
 assert.equal((await f.module.deleteAccount(f.req({confirmation:'DELETE',appleAuthorizationCode:'synthetic-code'}))).status,202);
 assert.deepEqual(events,['peekalo_begin_deletion','revoke','peekalo_deletion_progress']);
});
test('private status receipt works without login, forged proof cannot probe queue or restore access',async()=>{
 const f=fixture();const value=await(await f.module.deleteAccount(f.req({confirmation:'DELETE'}))).json();
 const status=await f.module.deletionStatus(f.req({requestId,receipt:value.receipt},null));assert.deepEqual(await status.json(),{status:'pending',needsAppleReauthentication:false});
 const before=f.calls.length;assert.equal((await f.module.deletionStatus(f.req({requestId,receipt:'A'.repeat(43)},null))).status,404);assert.equal(f.calls.length,before);
});
test('policy acceptance is exact-version, explicit and closed until publication; status still accessible for deleting account',async()=>{
 const f=fixture();const version='2026-10-29-draft';assert.equal((await f.module.acceptTerms(f.req({termsVersion:version,privacyVersion:version}))).status,503);
 assert.equal((await f.module.acceptTerms(f.req({termsVersion:'old',privacyVersion:'old'}))).status,409);
 const status=await(await f.module.privacy(new Request(`${app}/api/account/privacy`,{headers:{Authorization:`Bearer ${jwt()}`}}))).json();assert.equal(status.policyReady,false);assert.equal(status.termsVersion,version);
 const ready=fixture({ready:true,call:async()=>({accepted:true})});assert.deepEqual(await(await ready.module.acceptTerms(ready.req({termsVersion:version,privacyVersion:version}))).json(),{accepted:true});
});
test('publication switch needs explicit operator/country/age/contact configuration',t=>{
 const names=['POLICY_PUBLISHED','POLICY_OPERATOR_NAME','POLICY_COUNTRIES','POLICY_MINIMUM_AGE','SAFETY_SUPPORT_EMAIL','SAFETY_CHILD_SAFETY_EMAIL','SAFETY_AGE_POLICY'];const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));t.after(()=>{for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}});
 for(const name of names)delete process.env[name];assert.equal(sharing.policyReady(),false);
 const values=['true','Synthetic fixture operator','TH','18','support@example.invalid','safety@example.invalid','Synthetic age policy'];names.forEach((name,i)=>process.env[name]=values[i]);assert.equal(sharing.policyReady(),true);
 process.env.POLICY_COUNTRIES='';assert.equal(sharing.policyReady(),false);process.env.POLICY_COUNTRIES='TH';process.env.SAFETY_SUPPORT_EMAIL='javascript:bad';assert.equal(sharing.policyReady(),false);
});

test('Apple revocation binds signed client and returned verified subject before invalidating token',async t=>{
 const names=['APPLE_NATIVE_CLIENT_ID','APPLE_TEAM_ID','APPLE_SIGN_IN_KEY_ID','APPLE_SIGN_IN_PRIVATE_KEY'];const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));t.after(()=>{for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}});
 const signing=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}), apple=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 Object.assign(process.env,{APPLE_NATIVE_CLIENT_ID:'fixture.bundle',APPLE_TEAM_ID:'FIXTURETEAM',APPLE_SIGN_IN_KEY_ID:'FIXTUREKEY',APPLE_SIGN_IN_PRIVATE_KEY:signing.privateKey.export({type:'pkcs8',format:'pem'})});
 const now=Math.floor(Date.now()/1000);const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');const unsigned=`${encode({alg:'RS256',kid:'synthetic-apple-key'})}.${encode({iss:'https://appleid.apple.com',aud:'fixture.bundle',sub:'fixture-sub',exp:now+300,iat:now})}`;const token=`${unsigned}.${crypto.sign('RSA-SHA256',Buffer.from(unsigned),apple.privateKey).toString('base64url')}`;const events=[];
 const mod=load(appleSource,{'node:crypto':crypto,'./sharing':{backendFetch:async(url,init)=>{events.push(url);if(url.endsWith('/token')){const proof=init.body.get('client_secret').split('.');assert(crypto.verify('sha256',Buffer.from(`${proof[0]}.${proof[1]}`),{key:signing.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(proof[2],'base64url')));return Response.json({id_token:token,refresh_token:'fixture-refresh'});}if(url.endsWith('/keys'))return Response.json({keys:[{...apple.publicKey.export({format:'jwk'}),kid:'synthetic-apple-key'}]});assert.equal(init.body.get('token'),'fixture-refresh');return new Response('',{status:200});}}});
 await mod.revokeAppleAuthorization('fixture-code','fixture-sub');assert.equal(events.length,3);
 events.length=0;await assert.rejects(()=>mod.revokeAppleAuthorization('fixture-code','wrong-sub'));assert.equal(events.length,1,'Different Apple account never reaches revoke');
});
