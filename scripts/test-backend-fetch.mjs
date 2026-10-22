import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import ts from 'typescript';

// Real loopback HTTP verifies that deadlines abort the transport and response
// body, rather than merely abandoning a Promise. No live provider or env reads.
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/sharing.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function load(fetchAdapter = fetch) {
  const module = { exports: {} };
  const imports = {
    'node:crypto': crypto,
    '@supabase/supabase-js': { createClient() { throw new Error('Unexpected database connection'); } },
  };
  const require = name => { assert(Object.hasOwn(imports, name)); return imports[name]; };
  const environment = { env: {} };
  new Function('require', 'module', 'exports', 'fetch', 'process', source)(require, module, module.exports, fetchAdapter, environment);
  return module.exports.backendFetch;
}
async function server(t, handler) {
  const http = createServer(handler);
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    http.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${http.address().port}`;
}
const aborted = error => ['TimeoutError', 'AbortError'].includes(error.name);

test('backend deadline aborts a response that never sends headers', { timeout: 5000 }, async t => {
  const origin = await server(t, () => {});
  const backendFetch = load();
  await assert.rejects(backendFetch(origin, {}, 100), aborted);
});

test('the same deadline stays active while a successful response body stalls', { timeout: 5000 }, async t => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{"unfinished":');
  });
  const backendFetch = load();
  await assert.rejects((async () => {
    const response = await backendFetch(origin, {}, 100);
    await response.json();
  })(), aborted);
});

test('caller cancellation aborts response-body consumption before the longer deadline', { timeout: 5000 }, async t => {
  const origin = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{"unfinished":');
  });
  const controller = new globalThis.AbortController();
  const response = await load()(origin, { signal: controller.signal }, 4000);
  const body = response.json();
  controller.abort();
  await assert.rejects(body, aborted);
});

test('a pre-cancelled caller never sends an HTTP request', { timeout: 5000 }, async t => {
  let requests = 0;
  const origin = await server(t, (_request, response) => { requests++; response.end('{}'); });
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(load()(origin, { signal: controller.signal }, 100), aborted);
  assert.equal(requests, 0);
});

test('backend fetch forces no-store while preserving method, body and caller headers', { timeout: 5000 }, async t => {
  let observed;
  const origin = await server(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-synthetic-fixture'], 'present');
    assert.equal(Buffer.concat(chunks).toString(), '{"fixture":true}');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  const backendFetch = load((input, init) => { observed = init; return fetch(input, init); });
  const response = await backendFetch(origin, {
    method: 'POST', body: '{"fixture":true}', cache: 'force-cache', headers: { 'X-Synthetic-Fixture': 'present' },
  }, 4000);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(observed.cache, 'no-store');
  assert.ok(observed.signal instanceof globalThis.AbortSignal);
});
