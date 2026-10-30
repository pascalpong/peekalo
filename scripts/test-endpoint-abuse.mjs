import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/sharing.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', source)(name => { if (name === 'node:crypto') return crypto; assert.equal(name, '@supabase/supabase-js'); return {}; }, module, module.exports);
const sharing = module.exports;
const { Request, Response, ReadableStream } = globalThis;
function env(t) {
  const values = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_ANON_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture', SHARE_TOKEN_SECRET: 'fixture-only-secret-12345678901234567890', PUBLIC_APP_URL: 'https://app.invalid' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const request = (path = '/api/posts', headers = {}) => new Request(`https://app.invalid${path}`, { method: 'POST', headers });
test('admission precedes handler/body; unavailable backend and malformed responses fail closed without leaking errors', async () => {
  for (const fail of [async () => { throw new Error('fixture secret detail'); }, async req => sharing.admitRequest(req, undefined, async () => ({ allowed: 'yes' }))]) {
    let called = false;
    const result = await sharing.endpoint(async () => { called = true; return Response.json({}); }, fail)(request());
    assert.equal(result.status, 503); assert.equal(called, false);
    assert.deepEqual(await result.json(), { error: 'sharing_unavailable' });
  }
});
test('denied admission gives no-store retry-after and never enters handler', async () => {
  const response = await sharing.endpoint(async () => assert.fail('Denied handler ran'), req => sharing.admitRequest(req, undefined, async () => ({ allowed: false, retryAfter: 8 })))(request());
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '8'); assert.match(response.headers.get('cache-control'), /no-store/);
});
test('fixed global lane ignores spoofed IPs; credential/account keys contain only domain-separated HMACs', async t => {
  env(t); const calls = [];
  const call = async (name, args) => { assert.equal(name, 'peekalo_admit_endpoint'); calls.push(args); return { allowed: true, retryAfter: 0 }; };
  const req = request('/api/posts', { Authorization: 'Bearer private-fixture-token', 'x-forwarded-for': 'spoofed-address' });
  await sharing.admitRequest(req, undefined, call); await sharing.admitRequest(req, 'private-fixture-account', call);
  assert.deepEqual(calls.map(item => item.p_scope), ['global', 'credential', 'account']);
  assert(calls.every(item => item.p_lane === 'upload' && /^[a-f0-9]{64}$/.test(item.p_key)));
  assert.equal(calls[0].p_key, '0'.repeat(64)); assert.notEqual(calls[1].p_key, calls[2].p_key);
  assert(!JSON.stringify(calls).includes('private-fixture')); assert(!JSON.stringify(calls).includes('spoofed'));
  assert.equal(sharing.abuseLane(request('/api/posts/arbitrary/link')), 'api');
  assert.equal(sharing.abuseLane(request('/api/account/delete')), 'deletion');
  assert.equal(sharing.abuseLane(request('/api/operator/media/id')), 'safety');
  assert.equal(sharing.abuseLane(request('/api/view/media/id')), 'media');
});
test('only authentic existing guest cookies receive an identity lane; cookie resets still consume global lane', async t => {
  env(t); const calls = []; const call = async (name, args) => { calls.push(args); return { allowed: true, retryAfter: 0 }; };
  for (const cookie of ['', 'peekalo_guest=11111111-1111-4111-8111-111111111111.forged']) await sharing.admitRequest(request('/api/view/lease', { Cookie: cookie }), undefined, call);
  assert.deepEqual(calls.map(item => item.p_scope), ['global', 'global']);
  const cookie = sharing.guest(request(), true).cookie.split(';')[0];
  await sharing.admitRequest(request('/api/view/lease', { Cookie: cookie }), undefined, call);
  assert.deepEqual(calls.slice(-2).map(item => item.p_scope), ['global', 'guest']);
  assert(!JSON.stringify(calls).includes(cookie));
});
test('small-body deadline/disconnect/oversize cancel safely even with unending cancel callbacks', async () => {
  let cancelled = 0;
  const stalled = new Request('https://fixture.invalid', { method: 'POST', body: new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), duplex: 'half' });
  await assert.rejects(() => sharing.limitedBody(stalled, 20, 15), error => error.status === 408); assert.equal(cancelled, 1);
  const oversized = new Request('https://fixture.invalid', { method: 'POST', body: 'too long' });
  await assert.rejects(() => sharing.limitedBody(oversized, 3), error => error.status === 413);
  const controller = new globalThis.AbortController();
  const aborted = new Request('https://fixture.invalid', { method: 'POST', body: new ReadableStream({}), duplex: 'half', signal: controller.signal });
  const result = sharing.limitedBody(aborted, 20, 200); controller.abort();
  await assert.rejects(() => result, error => error.status === 408);
  assert.equal((await sharing.limitedBody(new Request('https://fixture.invalid', { method: 'POST', body: 'ok' }), 2)).toString(), 'ok');
});
test('account lane uses the SDK-verified subject across bearer rotation and never an unverified JWT/body ID', async t => {
  env(t); const calls = []; let valid = true;
  const accountModule = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (name === 'node:crypto') return crypto;
    assert.equal(name, '@supabase/supabase-js');
    return { createClient: () => ({ auth: { getUser: async () => valid ? { data: { user: { id: 'verified-fixture-account' } } } : { error: true, data: {} } }, rpc: async (name, args) => {
      calls.push({ name, args }); return { data: name === 'peekalo_admit_endpoint' ? { allowed: true, retryAfter: 0 } : true };
    } }) };
  }, accountModule, accountModule.exports);
  for (const token of ['Bearer forged-subject-first', 'Bearer forged-subject-rotated']) {
    assert.equal(await accountModule.exports.account(request('/api/posts', { Authorization: token })), 'verified-fixture-account');
  }
  const admits = calls.filter(item => item.name === 'peekalo_admit_endpoint');
  assert.equal(admits.length, 2); assert.equal(admits[0].args.p_scope, 'account'); assert.equal(admits[0].args.p_key, admits[1].args.p_key);
  const count = calls.length; valid = false;
  await assert.rejects(() => accountModule.exports.account(request('/api/posts', { Authorization: 'Bearer invalid' })), error => error.status === 401);
  assert.equal(calls.length, count);
});
