import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const { Request } = globalThis;
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const [source, sharingSource] = await Promise.all([compile('../apps/web/lib/server/social.ts'), compile('../apps/web/lib/server/sharing.ts')]);
function load(code, imports) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert(Object.hasOwn(imports, name), name); return imports[name]; }, module, module.exports);
  return module.exports;
}
const sharing = load(sharingSource, { 'node:crypto': crypto, '@supabase/supabase-js': {} });
const app = 'https://app.invalid', actor = crypto.randomUUID(), target = crypto.randomUUID(), key = crypto.randomUUID();
function fixture({ authError, rpcError } = {}) {
  const calls = [], events = [];
  const handlers = load(source, { './sharing': { ...sharing, endpoint: fn => sharing.endpoint(fn, async () => {}),
    account: async (_request, options) => { events.push({ auth: options }); if (authError) throw authError; return actor; },
    sameOrigin: request => { if (request.headers.get('origin') !== app) throw new sharing.ApiError(403, 'origin_not_allowed'); },
    rpc: async (name, args) => { calls.push({ name, args }); if (rpcError) throw rpcError; return { items: [], epoch: 1 }; },
  } });
  const request = (value, { method = value ? 'POST' : 'GET', query = '', origin = null } = {}) => new Request(`${app}/api/social${query}`, {
    method, headers: { Authorization: 'Bearer synthetic', ...(origin ? { Origin: origin } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  return { handlers, calls, events, request };
}
function privateResponse(response) { assert.match(response.headers.get('cache-control'), /private.*no-store/); assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); }

test('social uses server-authenticated actor and policy gate for writes; no original or capability routes', async () => {
  const f = fixture();
  const result = await f.handlers.conversations(f.request({ username: 'someone', requestKey: key }));
  assert.equal(result.status, 200); privateResponse(result);
  assert.deepEqual(f.events, [{ auth: { requireTerms: true } }]);
  assert.deepEqual(f.calls[0], { name: 'peekalo_social_start', args: { p_actor: actor, p_recipient: null, p_username: 'someone', p_key: key } });
  for (const value of [
    { username: 'someone', requestKey: key, actor }, { username: 'someone', accountId: target, requestKey: key },
    { accountId: target, requestKey: 'bad' }, { username: 'demo', requestKey: key },
  ]) assert.equal((await f.handlers.conversations(f.request(value))).status, 400);
});
test('stable-account start survives name changes without a client-chosen actor', async () => {
  const f = fixture();
  assert.equal((await f.handlers.conversations(f.request({ accountId: target, requestKey: key }))).status, 200);
  assert.equal(f.calls[0].args.p_recipient, target); assert.equal(f.calls[0].args.p_username, null);
});
test('text and existing moment are exclusive bounded operations; attachment or forwarding inputs rejected', async () => {
  const f = fixture();
  for (const input of [{ body: 'Generated fixture text' }, { postId: target }]) {
    const result = await f.handlers.messages(target)(f.request({ requestKey: key, ...input }));
    assert.equal(result.status, 200); privateResponse(result);
  }
  assert.deepEqual(f.calls.at(-1), { name: 'peekalo_social_send', args: { p_actor: actor, p_conversation: target, p_key: key, p_body: null, p_post: target } });
  for (const value of [ {}, { body: 'x', postId: target }, { body: '' }, { body: 'x'.repeat(1001) }, { body: 'x\u0000' }, { body: 'x', attachment: 'uri' }, { postId: target, grant: true }, { body: 'x', authorAccountId: actor } ]) {
    assert.equal((await f.handlers.messages(target)(f.request({ requestKey: key, ...value }))).status, 400);
  }
});
test('pagination validates full stable cursor and a hard 50-item page', async () => {
  const f = fixture(); const stamp = '2026-10-30T12:34:56.123456+00:00';
  const result = await f.handlers.messages(target)(f.request(null, { query: `?before=${encodeURIComponent(stamp)}&beforeId=${key}&limit=50` }));
  assert.equal(result.status, 200); assert.equal(f.calls[0].args.p_before, stamp); assert.equal(f.calls[0].args.p_before_id, key); assert.equal(f.calls[0].args.p_limit, 50);
  for (const query of ['?limit=51', '?limit=0', '?limit=1&limit=2', '?before=bad', `?beforeId=${key}`, '?unknown=1', `?before=2026-10-30&beforeId=${key}`]) {
    assert.equal((await f.handlers.comments(target)(f.request(null, { query }))).status, 400);
  }
});
test('accept/decline, comments and removal pin target IDs and reject forged metadata', async () => {
  const f = fixture();
  assert.equal((await f.handlers.respond(target)(f.request({ accept: true }))).status, 200);
  assert.deepEqual(f.calls.at(-1), { name: 'peekalo_social_request', args: { p_actor: actor, p_conversation: target, p_action: 'accept' } });
  assert.equal((await f.handlers.respond(target)(f.request({ accept: 'true' }))).status, 400);
  assert.equal((await f.handlers.comments(target)(f.request({ requestKey: key, body: 'Generated comment' }))).status, 200);
  assert.equal((await f.handlers.removeSocial('comment', target)(f.request(null, { method: 'DELETE' }))).status, 200);
  assert.deepEqual(f.calls.at(-1), { name: 'peekalo_social_remove', args: { p_actor: actor, p_kind: 'comment', p_item: target } });
  assert.equal((await f.handlers.removeSocial('post', target)(f.request(null, { method: 'DELETE' }))).status, 400);
});
test('account/origin denial happens before text access; backend failures stay sanitized', async () => {
  const f = fixture({ authError: new sharing.ApiError(401, 'sign_in_required') });
  const result = await f.handlers.comments(target)(f.request()); assert.equal(result.status, 401); assert.equal(f.calls.length, 0); privateResponse(result);
  const cross = fixture(); assert.equal((await cross.handlers.conversations(cross.request(null, { origin: 'https://other.invalid' }))).status, 403); assert.equal(cross.events.length, 0);
  const failure = fixture({ rpcError: new Error('private body bearer information') });
  const denied = await failure.handlers.socialEpoch(failure.request()); assert.equal(denied.status, 503); assert.deepEqual(await denied.json(), { error: 'sharing_unavailable' });
});
test('operator inspection and decisions use restricted audited RPC, never expose an unreviewed queue body', async () => {
  const f = fixture();
  assert.equal((await f.handlers.operatorSocialQueue(f.request())).status, 200);
  assert.equal((await f.handlers.operatorSocialItem('message', target)(f.request())).status, 200);
  assert.equal(f.calls.at(-1).name, 'peekalo_social_read');
  assert.equal((await f.handlers.operatorSocialEpoch(f.request())).status, 200);
  assert.deepEqual(f.calls.at(-1), { name: 'peekalo_social_operator_epoch', args: { p_operator: actor } });
  assert.equal((await f.handlers.operatorSocialItem('message', target)(f.request({ action: 'approve', reason: 'Generated assessment' }))).status, 200);
  assert.equal((await f.handlers.operatorSocialItem('message', target)(f.request({ action: 'approve', reason: '' }))).status, 400);
  assert.equal((await f.handlers.operatorSocialItem('message', target)(f.request({ action: 'approve', reason: 'x', body: 'bypass' }))).status, 400);
});
