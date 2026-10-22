import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Run the real handler, endpoint/error wrapper and byte cache in memory.
// Identity, live authorization and Storage are explicit controlled boundaries;
// no environment files, credentials or remote services are loaded.
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const [handlerSource, sharingSource, cacheSource] = await Promise.all([
  compile('../apps/web/lib/server/handlers.ts'),
  compile('../apps/web/lib/server/sharing.ts'),
  compile('../apps/web/lib/server/private-media-cache.ts'),
]);
function load(source, imports = {}, fetch = () => { throw new Error('Unexpected network access'); }) {
  const module = { exports: {} };
  const require = name => {
    assert(Object.hasOwn(imports, name), `Unexpected module: ${name}`);
    return imports[name];
  };
  new Function('require', 'module', 'exports', 'fetch', source)(require, module, module.exports, fetch);
  return module.exports;
}
const sharing = load(sharingSource, {
  'node:crypto': crypto,
  '@supabase/supabase-js': { createClient() { throw new Error('Unexpected database connection'); } },
});
const { createPrivateMediaCache } = load(cacheSource);
const leaseId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const MiB = 1024 * 1024;

function fixture(t, { kind = 'photo', path = 'fixture/attempt/photo.jpg', authorize, storage } = {}) {
  const events = []; const requests = [];
  const cache = createPrivateMediaCache();
  t.after(() => cache.clear());
  const item = { path, kind, expiresAt: new Date(Date.now() + 2000).toISOString() };
  let rpcCalls = 0;
  const adapter = {
    ...sharing,
    account: async () => { events.push('account'); return ownerId; },
    guest: () => ({ identity: 'g:synthetic-fixture' }),
    configuration: () => ({ url: 'https://storage.invalid', service: 'synthetic-server-key' }),
    rpc: async (name, args) => {
      assert.equal(name, 'peekalo_media');
      assert.equal(args.p_lease, leaseId);
      assert(['g:synthetic-fixture', `a:${ownerId}`].includes(args.p_identity));
      events.push('authorize');
      rpcCalls++;
      return authorize ? authorize(rpcCalls, item) : item;
    },
  };
  const handlers = load(handlerSource, {
    './sharing': adapter,
    './processing': {},
    './upload-admission': {},
    './private-media-cache': { privateMediaCache: {
      get(path, kind) { events.push('cache-read'); return cache.get(path, kind); },
      put(path, kind, bytes) { events.push('cache-write'); cache.put(path, kind, bytes); },
    } },
  }, async (url, init) => {
    events.push('storage'); requests.push({ url, init });
    assert(storage, 'Unexpected Storage access on a cache hit');
    return storage(url, init);
  });
  const request = headers => handlers.media(leaseId)(new globalThis.Request(`https://app.invalid/api/view/media/${leaseId}`, { headers }));
  return { cache, events, requests, request, item };
}
function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
}

test('cached photo still requires both live authorizations before private bytes leave the handler', async t => {
  const f = fixture(t);
  f.cache.put(f.item.path, 'photo', Buffer.from('normalized fixture photo'));
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'normalized fixture photo');
  assertPrivate(response);
  assert.deepEqual(f.events, ['authorize', 'cache-read', 'authorize']);
  assert.equal(f.requests.length, 0);
});

test('a denied precheck never reads cached bytes or calls Storage', async t => {
  for (const [status, code] of [[404, 'unavailable'], [410, 'expired']]) {
    const f = fixture(t, { authorize: () => { throw new sharing.ApiError(status, code); } });
    f.cache.put(f.item.path, 'photo', Buffer.from('must stay private'));
    const response = await f.request();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(f.events, ['authorize']);
    assert.equal(f.requests.length, 0);
  }
});

test('cache hits cannot bypass revocation or expiry reached before the final check', async t => {
  for (const [status, code] of [[404, 'unavailable'], [410, 'expired']]) {
    const f = fixture(t, { authorize: (count, item) => {
      if (count === 2) throw new sharing.ApiError(status, code);
      return item;
    } });
    f.cache.put(f.item.path, 'photo', Buffer.from('must stay private'));
    const response = await f.request();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(f.events, ['authorize', 'cache-read', 'authorize']);
  }
});

test('a photo cache miss performs both checks and admits bytes only after the final check', async t => {
  const f = fixture(t, { storage: () => new globalThis.Response('normalized storage fixture', { headers: { 'Content-Type': 'image/jpeg' } }) });
  const first = await f.request();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'normalized storage fixture');
  assertPrivate(first);
  assert.deepEqual(f.events, ['authorize', 'cache-read', 'storage', 'authorize', 'cache-write']);
  assert.equal(f.requests[0].url, `https://storage.invalid/storage/v1/object/authenticated/peekalo-captures/${f.item.path}`);
  assert.equal(f.requests[0].init.cache, 'no-store');
  assert.equal(f.requests[0].init.headers.get('Authorization'), 'Bearer synthetic-server-key');
  const second = await f.request({ Authorization: 'Bearer synthetic-account' });
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'normalized storage fixture');
  assert.deepEqual(f.events.slice(5), ['account', 'authorize', 'cache-read', 'authorize']);
  assert.equal(f.requests.length, 1);
});

test('revocation or expiry during Storage reading denies delivery and cannot populate the cache', async t => {
  for (const [status, code] of [[404, 'unavailable'], [410, 'expired']]) {
    let revoked = false;
    const f = fixture(t, {
      authorize: (count, item) => {
        if (revoked) throw new sharing.ApiError(status, code);
        return item;
      },
      storage: () => {
        const response = new globalThis.Response('private fixture');
        const read = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => { const bytes = await read(); revoked = true; return bytes; };
        return response;
      },
    });
    const response = await f.request();
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(f.events, ['authorize', 'cache-read', 'storage', 'authorize']);
    assert.equal(f.cache.get(f.item.path, 'photo'), undefined);
  }
});

test('cached video ranges are bounded to one MiB and report exact partial bytes', async t => {
  const video = Buffer.alloc(2 * MiB + 19);
  for (let i = 0; i < video.length; i++) video[i] = i % 251;
  for (const [range, start, end] of [
    ['bytes=13-9999999', 13, MiB + 12],
    ['bytes=1048576-', MiB, 2 * MiB - 1],
    ['bytes=2097152-', 2 * MiB, video.length - 1],
    [undefined, 0, MiB - 1],
  ]) {
    const f = fixture(t, { kind: 'video', path: 'fixture/attempt/video.mp4' });
    f.cache.put(f.item.path, 'video', video);
    const response = await f.request({ Authorization: 'Bearer synthetic-account', ...(range ? { Range: range } : {}) });
    assert.equal(response.status, 206);
    assertPrivate(response);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.equal(Number(response.headers.get('content-length')), end - start + 1);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= MiB);
    assert.deepEqual(bytes, video.subarray(start, end + 1));
    assert.deepEqual(f.events, ['account', 'authorize', 'cache-read', 'authorize']);
  }
});

test('uncached video forwards a bounded range and repeats live authorization after Storage', async t => {
  const bytes = Buffer.alloc(MiB, 7);
  const f = fixture(t, { kind: 'video', path: 'fixture/attempt/video.mp4', storage: (url, init) => {
    assert.equal(init.headers.get('Range'), `bytes=10-${MiB + 9}`);
    return new globalThis.Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 10-${MiB + 9}/${3 * MiB}` } });
  } });
  const response = await f.request({ Range: 'bytes=10-9999999' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 10-${MiB + 9}/${3 * MiB}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(f.events, ['authorize', 'cache-read', 'storage', 'authorize']);
  assert.equal(f.cache.get(f.item.path, 'video'), undefined, 'Partial video responses never become full cached objects');
});

test('cache path and media kind cannot substitute a different object for the authorized one', async t => {
  for (const mismatch of ['path', 'kind']) {
    const f = fixture(t, { storage: () => new globalThis.Response('correct normalized photo') });
    f.cache.put(mismatch === 'path' ? 'different-owner/attempt/photo.jpg' : f.item.path,
      mismatch === 'kind' ? 'video' : 'photo', Buffer.from('wrong private object'));
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'correct normalized photo');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.events, ['authorize', 'cache-read', 'storage', 'authorize', 'cache-write']);
  }
});

test('a changed path or kind at the final live check cannot return previously loaded bytes', async t => {
  for (const cached of [true, false]) {
    for (const change of ['path', 'kind']) {
      const f = fixture(t, {
        authorize: (count, item) => count === 1 ? item : {
          ...item, ...(change === 'path' ? { path: 'fixture/new-attempt/photo.jpg' } : { kind: 'video' }),
        },
        storage: () => new globalThis.Response('previously authorized photo'),
      });
      if (cached) f.cache.put(f.item.path, 'photo', Buffer.from('previously authorized photo'));
      const response = await f.request();
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'unavailable' });
      assert.deepEqual(f.events, cached ? ['authorize', 'cache-read', 'authorize'] : ['authorize', 'cache-read', 'storage', 'authorize']);
      if (!cached) assert.equal(f.cache.get(f.item.path, 'photo'), undefined);
    }
  }
});

test('invalid or unsatisfiable cached ranges never return media bytes', async t => {
  for (const range of ['bytes=20-', 'bytes=9-2', 'bytes=-5', 'bytes=0-1,3-4', 'bytes=999999999999999999999-']) {
    const f = fixture(t, { kind: 'video' });
    f.cache.put(f.item.path, 'video', Buffer.alloc(10));
    const response = await f.request({ Range: range });
    assert.equal(response.status, 416);
    assert.deepEqual(await response.json(), { error: 'invalid_range' });
    assert.equal(f.requests.length, 0);
  }
});
