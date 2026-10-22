import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import ts from 'typescript';

// Compile the actual route/helper into memory; no Next server, env files,
// private data or remote services are used by this suite.
const helperSource = await readFile(new URL('../apps/web/lib/server/waitlist.ts', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`;
const routeSource = await readFile(new URL('../apps/web/app/api/waitlist/route.ts', import.meta.url), 'utf8');
async function freshRoute() {
  // A fresh module represents a fresh process limiter. No production reset or
  // test-only control is exposed by the endpoint or server helper.
  const source = routeSource.replace("'../../../lib/server/waitlist'", JSON.stringify(`${helperUrl}#${randomUUID()}`));
  return (await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText).toString('base64')}`)).POST;
}

const fixture = {
  WAITLIST_ENABLED: 'true',
  PUBLIC_APP_URL: 'https://peekalo.example',
  SUPABASE_URL: 'https://synthetic-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-key',
};

function request(body = { email: 'friend@example.com', consent: true }, headers = {}) {
  return new globalThis.Request('https://peekalo.example/api/waitlist', {
    method: 'POST',
    headers: { Origin: fixture.PUBLIC_APP_URL, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

await test('waitlist POST uses durable storage and sanitizes failures', async (t) => {
  const savedEnv = Object.fromEntries([...Object.keys(fixture), 'PUBLIC_SITE_URL'].map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  const writes = [];
  let POST;
  try {
    t.beforeEach(async () => {
      POST = await freshRoute();
      Object.assign(process.env, fixture);
      delete process.env.PUBLIC_SITE_URL;
      globalThis.fetch = async (url, init) => {
        writes.push({ url, init });
        return new globalThis.Response(null, { status: 201 });
      };
    });

    await t.test('collection is closed by default and only explicit true opens it', async () => {
      const count = writes.length;
      for (const enabled of [undefined, 'false', '1', 'TRUE', '']) {
        if (enabled === undefined) delete process.env.WAITLIST_ENABLED;
        else process.env.WAITLIST_ENABLED = enabled;
        const result = await POST(request());
        assert.equal(result.status, 503);
        assert.deepEqual(await result.json(), { error: 'waitlist_unavailable' });
      }
      assert.equal(writes.length, count);
      process.env.WAITLIST_ENABLED = 'true';
    });

    await t.test('stores normalized email and versioned consent without returning either', async () => {
      const result = await POST(request({ email: '  Friend+Beta@Example.COM  ', consent: true, website: '' }));
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { ok: true });
      assert.match(result.headers.get('cache-control'), /no-store/);
      assert.equal(writes.length, 1);
      const { url, init } = writes[0];
      assert.equal(url, `${fixture.SUPABASE_URL}/rest/v1/peekalo_waitlist?on_conflict=email`);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, `Bearer ${fixture.SUPABASE_SERVICE_ROLE_KEY}`);
      assert.equal(init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
      assert.deepEqual(JSON.parse(init.body), { email: 'friend+beta@example.com', consent_version: 'early-access-v1' });
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal);
    });

    await t.test('duplicates use the same generic success and insert-only operation', async () => {
      const first = await POST(request());
      const duplicate = await POST(request());
      assert.deepEqual(await first.json(), await duplicate.json());
      assert.equal(duplicate.status, 200);
      assert.equal(writes.at(-1).init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
    });

    await t.test('rejects absent, cross-site and deceptive origins before storage', async () => {
      const count = writes.length;
      for (const headers of [
        { Origin: '' }, { Origin: 'https://evil.example' }, { Origin: 'https://peekalo.example.evil.example' },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
      ]) {
        const result = await POST(request(undefined, headers));
        assert.equal(result.status, 403);
        assert.deepEqual(await result.json(), { error: 'origin_not_allowed' });
      }
      assert.equal(writes.length, count);
    });

    await t.test('separate marketing origin is allowed without opening product origins', async () => {
      process.env.PUBLIC_SITE_URL = 'https://site.peekalo.example';
      assert.equal((await POST(request())).status, 403);
      assert.equal((await POST(request(undefined, { Origin: process.env.PUBLIC_SITE_URL }))).status, 200);
      assert.equal((await POST(request(undefined, { Origin: 'https://evil.example' }))).status, 403);
    });

    await t.test('requires explicit consent and a bounded, valid email', async () => {
      const count = writes.length;
      for (const consent of [undefined, false, 'true', 1]) {
        assert.equal((await POST(request({ email: 'friend@example.com', consent }))).status, 400);
      }
      for (const email of ['', null, ['friend@example.com'], 'bad', 'a@@example.com', 'a..b@example.com',
        'a\nb@example.com', 'a@-example.com', 'a@example..com', 'a@localhost', `${'a'.repeat(65)}@example.com`,
        `a@${'b'.repeat(64)}.com`, `${'a'.repeat(400)}@example.com`]) {
        const result = await POST(request({ email, consent: true }));
        assert.equal(result.status, 400);
        assert.deepEqual(await result.json(), { error: 'invalid_email' });
      }
      assert.equal(writes.length, count);
    });

    await t.test('rejects wrong types, malformed JSON and oversized body with or without length', async () => {
      const count = writes.length;
      for (const body of ['{bad', 'null', '[]', 'true']) assert.equal((await POST(request(body))).status, 400);
      for (const website of [42, {}, 'x'.repeat(201)]) {
        assert.equal((await POST(request({ email: 'friend@example.com', consent: true, website }))).status, 400);
      }
      assert.equal((await POST(request(undefined, { 'Content-Type': 'text/plain' }))).status, 415);
      assert.equal((await POST(request(undefined, { 'Content-Length': '2049' }))).status, 413);
      assert.equal((await POST(request('x'.repeat(2049)))).status, 413);
      assert.equal(writes.length, count);
    });

    await t.test('honeypot bots get a generic response without storing an address', async () => {
      const count = writes.length;
      assert.deepEqual(await (await POST(request({ website: 'spam.example' }))).json(), { ok: true });
      assert.equal(writes.length, count);
    });

    await t.test('four in-flight requests bound work and all slots recover after completion', async () => {
      const complete = [];
      let allStarted;
      const started = new Promise(resolve => { allStarted = resolve; });
      globalThis.fetch = async () => new Promise(resolve => {
        complete.push(() => resolve(new globalThis.Response(null, { status: 201 })));
        if (complete.length === 4) allStarted();
      });
      const pending = Array.from({ length: 4 }, () => POST(request()));
      await started;
      const rejected = await POST(request());
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get('retry-after'), '1');
      assert.deepEqual(await rejected.json(), { error: 'too_many_requests' });
      assert.equal(complete.length, 4);
      for (const finish of complete) finish();
      assert.deepEqual((await Promise.all(pending)).map(result => result.status), [200, 200, 200, 200]);
      globalThis.fetch = async () => new globalThis.Response(null, { status: 201 });
      assert.equal((await POST(request())).status, 200);
    });

    await t.test('rolling minute admission rejects bursts and recovers after expiry', async (context) => {
      let now = 100000;
      context.mock.method(Date, 'now', () => now);
      for (let count = 0; count < 30; count++) assert.equal((await POST(request())).status, 200);
      let rejected = await POST(request());
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get('retry-after'), '60');
      assert.deepEqual(await rejected.json(), { error: 'too_many_requests' });
      now += 59001;
      rejected = await POST(request());
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers.get('retry-after'), '1');
      now += 1000;
      assert.equal((await POST(request())).status, 200);
    });

    await t.test('stalled request body returns 408 even when stream cancellation never settles', { timeout: 10000 }, async () => {
      const count = writes.length;
      let cancelled = false;
      const body = new globalThis.ReadableStream({
        cancel() { cancelled = true; return new Promise(() => {}); },
      });
      const stalled = new globalThis.Request('https://peekalo.example/api/waitlist', {
        method: 'POST', headers: request().headers, body, duplex: 'half',
      });
      const started = Date.now();
      const result = await POST(stalled);
      assert.equal(result.status, 408);
      assert.deepEqual(await result.json(), { error: 'request_timeout' });
      assert.ok(Date.now() - started < 8000, 'The server read deadline must bound the stalled stream');
      assert.equal(cancelled, true);
      assert.equal(writes.length, count);
      // A timed-out read must release its request slot.
      assert.equal((await POST(request())).status, 200);
    });

    await t.test('missing configuration, missing table and upstream failures never imply signup', async () => {
      for (const key of Object.keys(fixture)) {
        delete process.env[key];
        const result = await POST(request());
        assert.equal(result.status, 503);
        assert.deepEqual(await result.json(), { error: 'waitlist_unavailable' });
        process.env[key] = fixture[key];
      }
      for (const status of [401, 403, 404, 409, 500]) {
        globalThis.fetch = async () => new globalThis.Response('private upstream sentinel', { status });
        const result = await POST(request());
        assert.equal(result.status, 503);
        assert.deepEqual(await result.json(), { error: 'waitlist_unavailable' });
      }
      globalThis.fetch = async () => { throw new Error('private network sentinel'); };
      const result = await POST(request());
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), { error: 'waitlist_unavailable' });
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

await test('waitlist migration enforces service-only insertion and immutable duplicates in PostgreSQL', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(root, '.cache'), { recursive: true });
  const directory = await mkdtemp(join(root, '.cache/waitlist-'));
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'), port, user: 'postgres', password: randomUUID(), persistent: true,
    postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'], onLog: () => {}, onError: () => {},
  });
  let db;
  try {
    await postgres.initialise();
    await postgres.start();
    db = postgres.getPgClient('postgres', '127.0.0.1');
    await db.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon, authenticated, service_role');
    await db.query(await readFile(new URL('../supabase/migrations/202610200001_marketing_waitlist.sql', import.meta.url), 'utf8'));
    for (const role of ['anon', 'authenticated']) {
      await db.query(`set role ${role}`);
      for (const sql of [
        'select * from peekalo_waitlist',
        "insert into peekalo_waitlist(email,consent_version) values ('test-only@example.com','early-access-v1')",
        'delete from peekalo_waitlist',
      ]) await assert.rejects(db.query(sql), error => error.code === '42501');
      await db.query('reset role');
    }
    await db.query('set role service_role');
    const insert = "insert into peekalo_waitlist(email,consent_version) values ('test-only@example.com','early-access-v1') on conflict(email) do nothing";
    assert.equal((await db.query(insert)).rowCount, 1);
    assert.equal((await db.query(insert)).rowCount, 0);
    await assert.rejects(db.query('select * from peekalo_waitlist'), error => error.code === '42501');
    await assert.rejects(db.query('delete from peekalo_waitlist'), error => error.code === '42501');
    await assert.rejects(db.query("update peekalo_waitlist set consented_at=now()"), error => error.code === '42501');
    await db.query('reset role');
    const result = await db.query('select email,consent_version,consented_at from peekalo_waitlist');
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].email, 'test-only@example.com');
    assert.equal(result.rows[0].consent_version, 'early-access-v1');
    assert.ok(result.rows[0].consented_at);
  } finally {
    if (db) await db.end();
    await postgres.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
