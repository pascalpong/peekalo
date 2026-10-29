import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const { Request, Response } = globalThis;
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const [source, sharingSource] = await Promise.all([compile('../apps/web/lib/server/safety.ts'), compile('../apps/web/lib/server/sharing.ts')]);
function load(code, imports) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert(Object.hasOwn(imports, name), name); return imports[name]; }, module, module.exports);
  return module.exports;
}
const sharing = load(sharingSource, { 'node:crypto': crypto, '@supabase/supabase-js': {} });
const app = 'https://app.invalid', actor = '11111111-1111-4111-8111-111111111111', post = '22222222-2222-4222-8222-222222222222';
const path = `${actor}/${post}/33333333-3333-4333-8333-333333333333.jpg`;
function fixture({ rpc = async () => ({}), auth = async () => actor, fetch = async () => new Response('synthetic normalized bytes') } = {}) {
  const calls = [], events = [];
  const handlers = load(source, { './sharing': { ...sharing,
    account: async request => { events.push('auth'); return auth(request); }, configuration: () => ({ appUrl: app, url: 'https://db.invalid', service: 'synthetic-server-key' }),
    sameOrigin: request => { if (request.headers.get('origin') !== app) throw new sharing.ApiError(403, 'origin_not_allowed'); },
    guest: () => ({ identity: `g:${actor}`, cookie: 'peekalo_guest=synthetic; HttpOnly; SameSite=Strict' }),
    rpc: async (name, args) => { calls.push({ name, args }); events.push(name); return rpc(name, args, calls.length); },
    backendFetch: async (...args) => { events.push('storage'); return fetch(...args); },
  } });
  function request(value, { method = 'POST', auth = true, origin = app } = {}) {
    return new Request(`${app}/api/safety`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(auth ? { Authorization: 'Bearer synthetic' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
  }
  return { handlers, calls, events, request };
}
function noStore(result) { assert.match(result.headers.get('cache-control'), /private.*no-store/); assert.equal(result.headers.get('referrer-policy'), 'no-referrer'); }

test('report target and identity are derived by server; raw link token is hashed, guest report does not claim', async () => {
  const f = fixture({ rpc: async () => ({ reportId: post, state: 'open' }) });
  const result = await f.handlers.reports(f.request({ token: 'a'.repeat(43), reason: 'child_safety', details: 'Review this concern' }, { auth: false }));
  assert.equal(result.status, 200); noStore(result); assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.deepEqual(f.calls, [{ name: 'peekalo_report', args: { p_identity: `g:${actor}`, p_kind: 'post', p_reason: 'child_safety', p_details: 'Review this concern', p_post: null, p_username: null, p_hash: crypto.createHash('sha256').update('a'.repeat(43)).digest('hex'), p_account: null } }]);
  assert(!JSON.stringify(await result.json()).includes('aaaa'));
});
test('report input rejects unsupported future targets, mixed targets, oversized details and forged actors', async () => {
  const f = fixture();
  for (const input of [{ postId: post, username: 'somebody', reason: 'spam' }, { messageId: post, reason: 'spam' }, { postId: post, reason: 'spam', identity: `a:${post}` }, { postId: post, reason: 'spam', details: 'a'.repeat(1001) }, { postId: post, reason: 'bad' }]) {
    assert.equal((await f.handlers.reports(f.request(input))).status, 400);
  }
  assert.equal(f.calls.length, 0);
});
test('anonymous reports require exact origin; invalid bearer never downgrades to guest', async () => {
  const f = fixture({ auth: async () => { throw new sharing.ApiError(401, 'sign_in_required'); } });
  for (const origin of [null, 'https://bad.invalid']) assert.equal((await f.handlers.reports(f.request({ username: 'sender', reason: 'harassment' }, { auth: false, origin }))).status, 403);
  assert.equal((await f.handlers.reports(f.request({ username: 'sender', reason: 'harassment' }))).status, 401);
  assert.equal(f.calls.length, 0);
});
test('block and unblock cannot supply another actor and preserve native no-Origin bearer use', async () => {
  const f = fixture({ rpc: async (_name, args) => ({ blocked: args.p_blocked }) });
  for (const method of ['POST', 'DELETE']) {
    const result = await f.handlers.blocks(f.request({ username: 'sender', actor: post }, { method, origin: null }));
    assert.equal(result.status, 200); noStore(result);
    assert.deepEqual(f.calls.at(-1), { name: 'peekalo_block', args: { p_actor: actor, p_username: 'sender', p_target: null, p_blocked: method !== 'DELETE' } });
  }
});
test('operator queue/audit/decision checks account before privileged RPC; errors redact upstream details', async () => {
  const f = fixture({ rpc: async () => { throw new sharing.ApiError(403, 'operator_required'); } });
  for (const invoke of [() => f.handlers.operatorQueue(f.request(undefined, { method: 'GET' })), () => f.handlers.operatorAudit(f.request(undefined, { method: 'GET' })), () => f.handlers.operatorDecision(f.request({ postId: post, action: 'approve', reason: 'Reviewed generated fixture' }))]) {
    const result = await invoke(); assert.equal(result.status, 403); noStore(result); assert.deepEqual(await result.json(), { error: 'operator_required' });
  }
  assert.equal((await f.handlers.operatorDecision(f.request({ postId: post, action: 'approve', reason: '' }))).status, 400);
});
test('operator media denial never requests Storage; successful IO rechecks operator and post after fetch', async () => {
  const denied = fixture({ rpc: async () => { throw new sharing.ApiError(403, 'operator_required'); }, fetch: () => assert.fail('No Storage before operator auth') });
  assert.equal((await denied.handlers.operatorMedia(post)(denied.request(undefined, { method: 'GET' }))).status, 403);
  const f = fixture({ rpc: async () => ({ path, kind: 'photo' }) });
  const result = await f.handlers.operatorMedia(post)(f.request(undefined, { method: 'GET' }));
  assert.equal(result.status, 200); noStore(result); assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.equal(await result.text(), 'synthetic normalized bytes');
  assert.deepEqual(f.events, ['auth', 'peekalo_moderation_media', 'storage', 'peekalo_moderation_media']);
});
test('operator removal during Storage IO denies bytes; oversized and invalid paths fail closed', async () => {
  const f = fixture({ rpc: async (_name, _args, count) => { if (count === 2) throw new sharing.ApiError(403, 'operator_required'); return { path, kind: 'photo' }; } });
  const result = await f.handlers.operatorMedia(post)(f.request(undefined, { method: 'GET' }));
  assert.equal(result.status, 403); assert(!String(await result.text()).includes('normalized bytes'));
  const large = fixture({ rpc: async () => ({ path, kind: 'photo' }), fetch: async () => new Response('fixture', { headers: { 'Content-Length': String(16 * 1024 * 1024) } }) });
  assert.equal((await large.handlers.operatorMedia(post)(large.request(undefined, { method: 'GET' }))).status, 404);
  const bad = fixture({ rpc: async () => ({ path: '../private', kind: 'photo' }), fetch: () => assert.fail() });
  assert.equal((await bad.handlers.operatorMedia(post)(bad.request(undefined, { method: 'GET' }))).status, 404);
});
test('support config publishes only valid real configuration and shows missing fields as pending', async t => {
  const keys = ['SAFETY_SUPPORT_EMAIL', 'SAFETY_CHILD_SAFETY_EMAIL', 'SAFETY_AGE_POLICY']; const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  for (const key of keys) delete process.env[key];
  const f = fixture();
  const empty = await f.handlers.safetyConfig(f.request(undefined, { method: 'GET' }));
  noStore(empty); const data = await empty.json(); assert.equal(data.contactConfigured, false); assert.equal(data.agePolicyConfigured, false); assert.equal(data.supportEmail, undefined);
  process.env.SAFETY_SUPPORT_EMAIL = 'javascript:bad'; process.env.SAFETY_CHILD_SAFETY_EMAIL = 'person\n@example.invalid';
  const invalid = await (await f.handlers.safetyConfig(f.request(undefined, { method: 'GET' }))).json(); assert.equal(invalid.contactConfigured, false);
  process.env.SAFETY_SUPPORT_EMAIL = 'support@example.invalid'; process.env.SAFETY_CHILD_SAFETY_EMAIL = 'safety@example.invalid'; process.env.SAFETY_AGE_POLICY = 'Generated fixture policy';
  const configured = await (await f.handlers.safetyConfig(f.request(undefined, { method: 'GET' }))).json(); assert.equal(configured.contactConfigured, true); assert.equal(configured.agePolicyConfigured, true);
});

 test('authenticated reports, blocks and owner revocation pin a stable target through username changes', async () => {
  const f = fixture({ rpc: async () => ({ reportId: post, state: 'open', blocked: true }) });
  const report = await f.handlers.reports(f.request({ accountId: post, reason: 'harassment' }));
  assert.equal(report.status, 200); assert.equal(f.calls.at(-1).args.p_account, post); assert.equal(f.calls.at(-1).args.p_username, null);
  const blocked = await f.handlers.blocks(f.request({ accountId: post }));
  assert.equal(blocked.status, 200); assert.equal(f.calls.at(-1).args.p_target, post); assert.equal(f.calls.at(-1).args.p_username, null);
  assert.equal((await f.handlers.reports(f.request({ accountId: post, reason: 'other' }, { auth: false }))).status, 401);
  assert.equal((await f.handlers.blocks(f.request({ accountId: post, username: 'sender' }))).status, 400);
});
