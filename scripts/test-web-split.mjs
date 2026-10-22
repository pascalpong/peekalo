import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual shared validator and marketing bridge in memory, without
// loading developer environment files, credentials or external services.
const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const originsUrl = compile(await readFile(new URL('../packages/web-ui/src/origins.ts', import.meta.url), 'utf8'));
const { publicOrigin } = await import(originsUrl);
const load = async path => import(compile((await readFile(new URL(path, import.meta.url), 'utf8'))
  .replaceAll("'@peekalo/web-ui/origins'", JSON.stringify(originsUrl))));
const { waitlistProxyPost: POST } = await load('../apps/site/lib/server/waitlist-proxy.ts');
const { getPublicConfig } = await load('../apps/site/lib/public-config.ts');
const { siteOrigin: getSiteOrigin } = await load('../apps/web/lib/site-origin.ts');

await test('public destinations accept origins only and reject unsafe navigation', () => {
  for (const value of ['https://peekalo.example', 'https://peekalo.example/', 'http://127.0.0.1:3100', 'http://localhost:3101', 'http://[::1]:3100']) {
    assert.equal(publicOrigin(value), new URL(value).origin);
  }
  for (const value of [undefined, '', 'bad', '//peekalo.example', 'javascript:alert(1)', 'http://peekalo.example',
    'https://user:password@peekalo.example', 'https://peekalo.example/path', 'https://peekalo.example/?q=1', 'https://peekalo.example/#token']) {
    assert.equal(publicOrigin(value), null);
  }
});

await test('site/product boundary and waitlist proxy fail closed', async t => {
  const fixture = { NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://site.peekalo.example',
    PUBLIC_APP_URL: 'https://app.peekalo.example', WAITLIST_ENABLED: 'true' };
  const saved = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  let calls;
  const request = (body = JSON.stringify({ email: 'synthetic@example.com', consent: true }), headers = {}) =>
    new globalThis.Request(`${fixture.PUBLIC_SITE_URL}/api/waitlist`, {
      method: 'POST', body, headers: { Origin: fixture.PUBLIC_SITE_URL,
        'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
      ...(typeof body === 'string' ? {} : { duplex: 'half' }),
    });
  t.beforeEach(() => {
    Object.assign(process.env, fixture);
    calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return globalThis.Response.json({ ok: true }, { headers: { 'Set-Cookie': 'sentinel=private' } });
    };
  });
  try {
    await t.test('production has no guessed destination; development origins agree', () => {
      delete process.env.PUBLIC_SITE_URL;
      delete process.env.PUBLIC_APP_URL;
      assert.deepEqual(getPublicConfig(), { siteOrigin: null, appOrigin: null, waitlistEnabled: false });
      assert.equal(getSiteOrigin(), null);
      process.env.NODE_ENV = 'development';
      assert.deepEqual(getPublicConfig(), { siteOrigin: 'http://127.0.0.1:3100', appOrigin: 'http://127.0.0.1:3101', waitlistEnabled: true });
      assert.equal(getSiteOrigin(), 'http://127.0.0.1:3100');
    });
    await t.test('same-origin configuration cannot create redirect or proxy loops', async () => {
      process.env.PUBLIC_SITE_URL = fixture.PUBLIC_APP_URL;
      assert.equal(getPublicConfig().appOrigin, null);
      assert.equal(getPublicConfig().waitlistEnabled, false);
      assert.equal(getSiteOrigin(), null);
      assert.equal((await POST(request())).status, 503);
      assert.equal(calls.length, 0);
    });
    await t.test('closed or invalid production configuration never calls backend', async () => {
      for (const [key, value] of [['WAITLIST_ENABLED', 'false'], ['PUBLIC_APP_URL', ''], ['PUBLIC_SITE_URL', 'https://site.peekalo.example/path']]) {
        process.env[key] = value;
        assert.equal((await POST(request())).status, 503);
        process.env[key] = fixture[key];
      }
      assert.equal(calls.length, 0);
    });
    await t.test('cross-origin submissions are rejected before forwarding', async () => {
      for (const headers of [{ Origin: '' }, { Origin: fixture.PUBLIC_APP_URL }, { Origin: 'https://evil.example' },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
        assert.equal((await POST(request(undefined, headers))).status, 403);
      }
      assert.equal(calls.length, 0);
    });
    await t.test('forwards only bounded signup body to configured product endpoint', async () => {
      const result = await POST(request(undefined, { Cookie: 'session=private', Authorization: 'Bearer private', 'X-Forwarded-For': '192.0.2.1' }));
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { ok: true });
      assert.equal(result.headers.has('set-cookie'), false);
      assert.match(result.headers.get('cache-control'), /no-store/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${fixture.PUBLIC_APP_URL}/api/waitlist`);
      assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', Origin: fixture.PUBLIC_SITE_URL, 'Sec-Fetch-Site': 'same-origin' });
      assert.equal(calls[0].init.credentials, 'omit');
      assert.equal(calls[0].init.redirect, 'error');
      assert.equal(calls[0].init.cache, 'no-store');
      assert.ok(calls[0].init.signal);
      assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'synthetic@example.com', consent: true });
    });
    await t.test('body bounds apply with and without content length', async () => {
      assert.equal((await POST(request(undefined, { 'Content-Type': 'text/plain' }))).status, 415);
      assert.equal((await POST(request(undefined, { 'Content-Length': 'bad' }))).status, 400);
      assert.equal((await POST(request(undefined, { 'Content-Length': '2049' }))).status, 413);
      assert.equal((await POST(request('x'.repeat(2049)))).status, 413);
      const invalid = new globalThis.ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([255])); controller.close(); } });
      assert.equal((await POST(request(invalid))).status, 400);
      assert.equal(calls.length, 0);
    });
    await t.test('stalled request is bounded even if cancellation never settles', { timeout: 9000 }, async () => {
      let cancelled = false;
      const body = new globalThis.ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
      assert.equal((await POST(request(body))).status, 408);
      assert.equal(cancelled, true);
      assert.equal(calls.length, 0);
    });
    await t.test('sanitizes upstream responses and admits only public error contract', async () => {
      globalThis.fetch = async () => globalThis.Response.json({ error: 'too_many_requests', private: 'sentinel' }, {
        status: 429, headers: { 'Retry-After': '60', 'Set-Cookie': 'sentinel=private' },
      });
      const limited = await POST(request());
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '60');
      assert.equal(limited.headers.has('set-cookie'), false);
      assert.deepEqual(await limited.json(), { error: 'too_many_requests' });
      for (const response of [globalThis.Response.json({ error: 'private_error' }, { status: 400 }),
        new globalThis.Response('private upstream sentinel', { status: 500 }), globalThis.Response.json({ unexpected: 'private' })]) {
        globalThis.fetch = async () => response;
        const result = await POST(request());
        assert.equal(result.status, 503);
        assert.deepEqual(await result.json(), { error: 'waitlist_unavailable' });
      }
      globalThis.fetch = async () => { throw new Error('private network sentinel'); };
      assert.equal((await POST(request())).status, 503);
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
