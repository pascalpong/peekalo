import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise production endpoints, error mapping and signed guest-cookie validation.
// Generated identities and explicit storage/RPC boundaries; no environment files.
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const [handlerSource, sharingSource] = await Promise.all([
  compile('../apps/web/lib/server/handlers.ts'), compile('../apps/web/lib/server/sharing.ts'),
]);
function load(source, imports) {
  const module = { exports: {} };
  const require = name => { assert(Object.hasOwn(imports, name), `Unexpected module ${name}`); return imports[name]; };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}
const sharing = load(sharingSource, {
  'node:crypto': crypto,
  '@supabase/supabase-js': { createClient() { throw new Error('Unexpected connection'); } },
});
const owner = '11111111-1111-4111-8111-111111111111';
const post = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(43);
const app = 'https://app.invalid';
function fixture({ rpc = async () => ({}), account = async () => owner, storage = async () => ({ error: null }), database } = {}) {
  const calls = []; const events = [];
  const handlers = load(handlerSource, {
    '@peekalo/contracts': { ACTIVE_MEDIA_LIMIT: 3 },
    './sharing': { ...sharing, endpoint: fn => sharing.endpoint(fn, async () => {}), account,
      configuration: () => ({ appUrl: app }),
      linkToken: () => token,
      rpc: async (name, args) => { calls.push({ name, args }); events.push(name); return rpc(name, args); },
      database: database ?? (() => ({ storage: { from(bucket) {
        assert.equal(bucket, 'peekalo-captures'); return { remove: async paths => { events.push(['remove', ...paths]); return storage(paths); } };
      } } })),
    },
    './processing': {}, './upload-admission': {},
    './private-media-cache': { privateMediaCache: { remove: path => events.push(['cache-remove', path]) } },
  });
  const request = (path, { method = 'POST', value, headers = {} } = {}) => new globalThis.Request(`${app}${path}`, {
    method, headers: { Origin: app, ...headers }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  return { handlers, calls, events, request };
}
function privateResponse(response) {
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('set-cookie'), null);
}

test('status reads with no cookie or a forged cookie pass null identity, never create a cookie or call lease', async t => {
  const previous = { app: process.env.PUBLIC_APP_URL, url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY, secret: process.env.SHARE_TOKEN_SECRET };
  Object.assign(process.env, { PUBLIC_APP_URL: app, SUPABASE_URL: 'https://db.invalid', SUPABASE_ANON_KEY: 'fixture', SUPABASE_SERVICE_ROLE_KEY: 'fixture', SHARE_TOKEN_SECRET: 'synthetic-only-secret-12345678901234567890' });
  t.after(() => { for (const [key, value] of Object.entries({ PUBLIC_APP_URL: previous.app, SUPABASE_URL: previous.url, SUPABASE_ANON_KEY: previous.anon, SUPABASE_SERVICE_ROLE_KEY: previous.service, SHARE_TOKEN_SECRET: previous.secret })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = fixture({ rpc: async name => { assert.equal(name, 'peekalo_view_status'); return { kind: 'photo', state: 'available', remainingMs: 10000 }; } });
  for (const cookie of ['', `peekalo_guest=${owner}.forged`]) {
    const result = await f.handlers.viewStatus()(f.request('/api/view/status', { value: { token }, headers: cookie ? { Cookie: cookie } : {} }));
    assert.equal(result.status, 200); privateResponse(result);
    assert.equal(f.calls.at(-1).args.p_identity, null);
  }
  const issued = sharing.guest(f.request('/api/view/lease'), true).cookie;
  const result = await f.handlers.viewStatus()(f.request('/api/view/status', { value: { token }, headers: { Cookie: issued.split(';')[0] } }));
  assert.equal(result.status, 200); privateResponse(result);
  assert.match(f.calls.at(-1).args.p_identity, /^g:/);
  const reset = fixture({ rpc: async () => { throw new sharing.ApiError(410, 'already_claimed'); } });
  const denied = await reset.handlers.viewStatus()(reset.request('/api/view/status', { value: { token } }));
  assert.equal(denied.status, 410); privateResponse(denied);
});

test('direct status derives only the authenticated account and validates post IDs', async () => {
  const f = fixture({ rpc: async () => ({ kind: 'video', state: 'exhausted', remainingMs: 0 }) });
  const result = await f.handlers.viewStatus(true)(f.request('/api/view/direct/status', { value: { postId: post, identity: `a:${nonce}` } }));
  assert.equal(result.status, 200); privateResponse(result);
  assert.deepEqual(f.calls, [{ name: 'peekalo_view_status', args: { p_identity: `a:${owner}`, p_hash: null, p_post: post } }]);
  const invalid = await f.handlers.viewStatus(true)(f.request('/api/view/direct/status', { value: { postId: 'bad' } }));
  assert.equal(invalid.status, 400); assert.equal(f.calls.length, 1);
});

test('owner lists and deletion use the authenticated owner; failed cleanup remains retryable without exposing its path', async () => {
  const path = `${owner}/${post}/fixture.jpg`;
  let cleanupFail = true;
  const f = fixture({ rpc: async (name, args) => {
    assert.equal(args.p_owner, owner);
    if (name === 'peekalo_own_posts') return { items: [], limit: 3, activeCount: 0, availableSlots: 3 };
    if (name === 'peekalo_delete_post') return { storagePath: path };
    assert.equal(name, 'peekalo_finish_delete'); assert.equal(args.p_path, path); return true;
  }, storage: async paths => { assert.deepEqual(paths, [path]); return { error: cleanupFail ? { message: 'synthetic private error' } : null }; } });
  const inventory = await f.handlers.ownPosts(f.request('/api/posts', { method: 'GET' }));
  assert.equal(inventory.status, 200); privateResponse(inventory);
  const first = await f.handlers.deletePost(post)(f.request(`/api/posts/${post}`, { method: 'DELETE' }));
  assert.deepEqual(await first.json(), { deleted: true, cleanupPending: true });
  assert(!f.calls.some(call => call.name === 'peekalo_finish_delete'));
  assert.deepEqual(f.events.slice(-3), ['peekalo_delete_post', ['cache-remove', path], ['remove', path]]);
  cleanupFail = false;
  const second = await f.handlers.deletePost(post)(f.request(`/api/posts/${post}`, { method: 'DELETE' }));
  assert.deepEqual(await second.json(), { deleted: true, cleanupPending: false });
  privateResponse(second); assert.equal(f.calls.at(-1).name, 'peekalo_finish_delete');
});

test('unauthorized deletion never touches Storage or cache and response redacts database details', async () => {
  const f = fixture({ rpc: async () => { throw new sharing.ApiError(404, 'unavailable'); } });
  const result = await f.handlers.deletePost(post)(f.request(`/api/posts/${post}`, { method: 'DELETE' }));
  assert.equal(result.status, 404); assert.deepEqual(await result.json(), { error: 'unavailable' });
  assert.deepEqual(f.events, ['peekalo_delete_post']);
});

test('replayed revoked and expired link keys return their true state without reminting', async () => {
  for (const [revoked, claimed, expiresAt, expected] of [
    [true, null, Date.now() + 60000, 'revoked'], [false, null, Date.now() - 1000, 'expired'],
    [false, 'g:fixture', Date.now() + 60000, 'claimed'], [false, null, Date.now() + 60000, 'active'],
  ]) {
    const f = fixture({ rpc: async () => ({ nonce, revoked, claimed_identity: claimed, expires_at: new Date(expiresAt).toISOString() }) });
    const result = await f.handlers.createLink(post)(f.request(`/api/posts/${post}/link`, { headers: { 'Idempotency-Key': nonce } }));
    assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.state, expected);
    assert.equal(f.calls.length, 1); assert(!JSON.stringify(data).includes('claimed_identity'));
  }
});

test('the fixture username is reserved before profile storage and public real-profile lookup', async () => {
  const f = fixture({ database: () => assert.fail('Reserved username must not reach a database'), rpc: () => assert.fail('Reserved username must not reach RPC') });
  const saved = await f.handlers.saveProfile(f.request('/api/profile', { value: { username: 'demo' } }));
  assert.equal(saved.status, 409); assert.deepEqual(await saved.json(), { error: 'username_reserved' });
  const lookup = await f.handlers.publicProfile('demo')(f.request('/api/profile/demo', { method: 'GET' }));
  assert.equal(lookup.status, 404); assert.deepEqual(await lookup.json(), { error: 'unavailable' });
  assert.deepEqual(f.calls, []);
});
