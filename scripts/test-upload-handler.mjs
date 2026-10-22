import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import * as timers from 'node:timers';
import * as perf from 'node:perf_hooks';
import test from 'node:test';
import ts from 'typescript';

// Exercise actual handler catch/finally behavior with a real multipart Request,
// the real admission slot/reader and explicit RPC/Storage/processor boundaries.
// No credentials, developer environment files or remote services are accessed.
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const [handlerSource, sharingSource, admissionSource] = await Promise.all([
  compile('../apps/web/lib/server/handlers.ts'), compile('../apps/web/lib/server/sharing.ts'),
  compile('../apps/web/lib/server/upload-admission.ts'),
]);
function load(source, imports, fetch = () => { throw new Error('Unexpected network access'); }) {
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
const owner = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
const key = '44444444-4444-4444-8444-444444444444';
const expectedPath = `${owner}/${postId}/${attempt}.jpg`;
const normalized = Buffer.from('normalized synthetic photo');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { missingAttempt = false, finish = () => true, fail = () => true, uploadError = false, beforeRead } = {}) {
  const events = []; const calls = []; const writes = []; const removals = []; const cached = [];
  const admission = load(admissionSource, { 'node:timers': timers, 'node:perf_hooks': perf });
  t.after(() => {
    const release = admission.acquireUploadSlot();
    release();
  });
  const handlers = load(handlerSource, {
    './sharing': {
      ...sharing,
      account: async () => owner,
      database: () => ({ storage: { from: bucket => {
        assert.equal(bucket, 'peekalo-captures');
        return {
          upload: async (...args) => { events.push('upload'); writes.push(args); return { error: uploadError ? { message: 'synthetic failure' } : null }; },
          remove: async paths => { events.push('remove'); removals.push(paths); return { error: null }; },
        };
      } } }),
      rpc: async (name, args) => {
        events.push(name); calls.push({ name, args });
        if (name === 'peekalo_reserve_post') return { id: postId, status: 'uploading', reserved: true, ...(!missingAttempt ? { upload_attempt: attempt } : {}) };
        if (name === 'peekalo_finish_upload') return finish();
        if (name === 'peekalo_fail_upload') return fail();
        assert.fail('Unexpected upload RPC');
      },
    },
    './upload-admission': {
      ...admission,
      acquireUploadSlot: () => { events.push('acquire'); return admission.acquireUploadSlot(); },
      readUploadBody: async request => {
        events.push('read-body');
        await beforeRead?.();
        // Small fixtures use the same production reader under a smaller cap.
        return admission.readUploadBody(request, 64 * 1024);
      },
    },
    './processing': { normalizeCapture: async (bytes, kind) => {
      events.push('normalize');
      assert.equal(bytes.toString(), 'synthetic capture');
      assert.equal(kind, 'photo');
      return { bytes: normalized, extension: 'jpg', contentType: 'image/jpeg' };
    } },
    './private-media-cache': { privateMediaCache: { put: (...args) => { events.push('cache-write'); cached.push(args); } } },
  });
  const request = () => {
    const form = new globalThis.FormData();
    form.set('file', new globalThis.Blob(['synthetic capture'], { type: 'image/jpeg' }), 'fixture.jpg');
    form.set('kind', 'photo');
    return new globalThis.Request('https://app.invalid/api/posts', {
      method: 'POST', body: form, headers: { Authorization: 'Bearer synthetic-account', 'Idempotency-Key': key },
    });
  };
  return { events, calls, writes, removals, cached, send: request => handlers.upload(request), request };
}

test('normal publication uses an attempt-scoped non-overwriting object and fenced finish before caching', async t => {
  const f = fixture(t);
  const response = await f.send(f.request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { postId, kind: 'photo', status: 'ready' });
  assert.deepEqual(f.events, ['acquire', 'read-body', 'peekalo_reserve_post', 'normalize', 'upload', 'peekalo_finish_upload', 'cache-write']);
  assert.deepEqual(f.writes, [[expectedPath, normalized, { contentType: 'image/jpeg', upsert: false, cacheControl: '0' }]]);
  assert.deepEqual(f.calls.find(call => call.name === 'peekalo_finish_upload').args,
    { p_owner: owner, p_post: postId, p_attempt: attempt, p_path: expectedPath });
  assert.deepEqual(f.cached, [[expectedPath, 'photo', normalized]]);
  assert.deepEqual(f.removals, []);
});

test('a lost finish reply cannot delete bytes when the failure fence says publication already won', async t => {
  const f = fixture(t, { finish: () => { throw new Error('synthetic lost reply'); }, fail: () => false });
  const response = await f.send(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'sharing_unavailable' });
  assert.deepEqual(f.events, ['acquire', 'read-body', 'peekalo_reserve_post', 'normalize', 'upload', 'peekalo_finish_upload', 'peekalo_fail_upload']);
  assert.deepEqual(f.calls.find(call => call.name === 'peekalo_fail_upload').args, { p_owner: owner, p_post: postId, p_attempt: attempt });
  assert.deepEqual(f.removals, []);
  assert.deepEqual(f.cached, []);
});

test('confirmed failed publication removes only its own attempt-scoped object', async t => {
  const f = fixture(t, { finish: () => false });
  const response = await f.send(f.request());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'conflict' });
  assert.deepEqual(f.events.slice(-3), ['peekalo_finish_upload', 'peekalo_fail_upload', 'remove']);
  assert.deepEqual(f.removals, [[expectedPath]]);
  assert.deepEqual(f.cached, []);
});

test('an unavailable failure fence preserves bytes rather than risking deletion after a committed finish', async t => {
  const f = fixture(t, { finish: () => { throw new Error('synthetic lost reply'); }, fail: () => { throw new Error('synthetic failure-fence outage'); } });
  const response = await f.send(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(f.removals, []);
  assert.deepEqual(f.cached, []);
});

test('a missing upload attempt fails closed before processing or Storage access', async t => {
  const f = fixture(t, { missingAttempt: true });
  const response = await f.send(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'sharing_unavailable' });
  assert.deepEqual(f.events, ['acquire', 'read-body', 'peekalo_reserve_post']);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.removals, []);
});

test('admission rejects a parallel upload before reading or buffering its body and releases afterward', async t => {
  const entered = deferred(); const resume = deferred();
  const f = fixture(t, { beforeRead: async () => { entered.resolve(); await resume.promise; } });
  const first = f.send(f.request());
  await entered.promise;
  let completed;
  try {
    const denied = await f.send(f.request());
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: 'processing_busy' });
    assert.deepEqual(f.events, ['acquire', 'read-body', 'acquire']);
    assert.equal(f.calls.length, 0);
  } finally { resume.resolve(); completed = await first; }
  assert.equal(completed.status, 200);
  // The same loaded handler can admit a later request after completion.
  assert.equal((await f.send(f.request())).status, 200);
});

test('a Storage write failure is fenced before any attempted object cleanup', async t => {
  const f = fixture(t, { uploadError: true });
  const response = await f.send(f.request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upload_failed' });
  assert.deepEqual(f.events.slice(-3), ['upload', 'peekalo_fail_upload', 'remove']);
  assert(!f.calls.some(call => call.name === 'peekalo_finish_upload'));
  assert.deepEqual(f.removals, [[expectedPath]]);
});


test('deadline-aborted finish and failure calls release admission for a later upload', { timeout: 5000 }, async t => {
  const requests = [];
  const http = createServer((request, response) => {
    requests.push(request.url);
    // Supply headers and a partial body, reproducing an SDK JSON read that stalls.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{"unfinished":');
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    http.closeAllConnections();
    await closed;
  });
  const backend = load(sharingSource, {
    'node:crypto': crypto,
    '@supabase/supabase-js': { createClient() { throw new Error('Unexpected database connection'); } },
  }, fetch);
  const origin = `http://127.0.0.1:${http.address().port}`;
  let stalled = true;
  const f = fixture(t, {
    finish: async () => stalled ? (await backend.backendFetch(`${origin}/finish`, {}, 100)).json() : true,
    fail: async () => (await backend.backendFetch(`${origin}/fail`, {}, 100)).json(),
  });
  const first = await f.send(f.request());
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'sharing_unavailable' });
  assert.deepEqual(requests, ['/finish', '/fail']);
  assert.deepEqual(f.removals, [], 'Uncertain publication must preserve its object');
  stalled = false;
  const retry = await f.send(f.request());
  assert.equal(retry.status, 200, 'The sole upload slot must be reusable after both aborts');
});
