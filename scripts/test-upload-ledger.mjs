import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// Real migrations and independent PostgreSQL connections. Generated identifiers
// only; no environment files, Supabase credentials or remote state are accessed.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.cache'), { recursive: true });
const directory = await mkdtemp(join(root, '.cache/upload-ledger-'));
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
const clients = new Set();
async function connect() {
  const client = postgres.getPgClient('postgres', '127.0.0.1');
  await client.connect(); clients.add(client);
  await client.query("set statement_timeout='5s'; set lock_timeout='4s'");
  return client;
}
const value = async (client, sql, parameters = []) => (await client.query(sql, parameters)).rows[0]?.value;
const reserve = (client, owner, key = randomUUID(), kind = 'photo', limit = null) => value(client,
  'select peekalo_reserve_post($1,$2,$3,$4) as value', [owner, key, kind, limit]);
const objectPath = post => `${post.owner_id}/${post.id}/${post.upload_attempt}.${post.kind === 'photo' ? 'jpg' : 'mp4'}`;
const finish = (client, post, owner = post.owner_id, path = objectPath(post)) => value(client,
  'select peekalo_finish_upload($1,$2,$3,$4) as value', [owner, post.id, post.upload_attempt, path]);
const fail = (client, post) => value(client,
  'select peekalo_fail_upload($1,$2,$3) as value', [post.owner_id, post.id, post.upload_attempt]);
async function owner(client) {
  const id = randomUUID();
  await client.query('insert into auth.users(id) values($1)', [id]);
  return id;
}
const expire = (client, post) => client.query("update peekalo_posts set upload_expires_at=clock_timestamp()-interval '1 second' where id=$1", [post.id]);

try {
  await postgres.initialise(); await postgres.start();
  const db = await connect();
  await db.query(`create schema auth; create table auth.users(id uuid primary key);
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create role anon; create role authenticated; create role service_role;`);
  let legacy;
  for (const migration of (await readdir(join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    if (migration.startsWith('202610220001')) {
      const id = await owner(db); const key = randomUUID();
      legacy = await reserve(db, id, key);
    }
    await db.query(await readFile(join(root, 'supabase/migrations', migration), 'utf8'));
  }
  await test('fenced upload reservations', async t => {
    await t.test('migration permits legacy unfenced reservations to be reclaimed under a new token', async () => {
      assert.ok(legacy);
      const retry = await reserve(db, legacy.owner_id, legacy.upload_key);
      assert.equal(retry.id, legacy.id); assert.equal(retry.reserved, true);
      assert.match(retry.upload_attempt, /^[0-9a-f-]{36}$/);
      assert.equal(await finish(db, retry), true);
    });
    await t.test('live duplicate reserves once and exposes a bounded five-minute attempt', async () => {
      const id = await owner(db); const key = randomUUID();
      const post = await reserve(db, id, key);
      const duplicate = await reserve(db, id, key);
      assert.equal(post.reserved, true); assert.equal(duplicate.reserved, false);
      assert.equal(post.upload_attempt, duplicate.upload_attempt);
      assert(Date.parse(post.upload_expires_at) - Date.now() > 290_000);
      assert(Date.parse(post.upload_expires_at) - Date.now() <= 300_000);
      assert.equal(await finish(db, post), true);
      const ready = await reserve(db, id, key);
      assert.equal(ready.status, 'ready'); assert.equal(ready.reserved, false);
      assert.equal(ready.storage_path, objectPath(post));
      assert.equal(await finish(db, post), true, 'A lost publication reply can replay its exact ready path');
      assert.equal(await finish(db, { ...post, upload_attempt: randomUUID() }), false, 'Another attempt cannot replay the ready publication');
      assert.equal(await fail(db, post), false);
    });
    await t.test('expired attempt cannot publish even before a retry exists', async () => {
      const post = await reserve(db, await owner(db)); await expire(db, post);
      assert.equal(await finish(db, post), false);
      assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [post.id]), 'uploading');
    });
    await t.test('racing retries rotate ownership once; stale completion/failure cannot mutate the winner', async () => {
      const post = await reserve(db, await owner(db)); await expire(db, post);
      const connections = await Promise.all([connect(), connect(), connect()]);
      const retries = await Promise.all(connections.map(client => reserve(client, post.owner_id, post.upload_key)));
      assert.equal(retries.filter(result => result.reserved).length, 1);
      const winner = retries.find(result => result.reserved);
      assert.equal(winner.id, post.id); assert.notEqual(winner.upload_attempt, post.upload_attempt);
      assert.notEqual(objectPath(winner), objectPath(post), 'Stale cleanup must address a different private object');
      assert.equal(await finish(db, post), false); assert.equal(await fail(db, post), false);
      assert.equal(await finish(db, winner), true);
      assert.equal(await fail(db, post), false);
      assert.equal(await value(db, 'select storage_path as value from peekalo_posts where id=$1', [post.id]), objectPath(winner));
    });
    await t.test('expired unrelated keys release configured quota without resurrecting their data', async () => {
      const id = await owner(db); const old = await reserve(db, id, randomUUID(), 'photo', 1); await expire(db, old);
      const next = await reserve(db, id, randomUUID(), 'photo', 1);
      assert.equal(next.reserved, true); assert.equal(await finish(db, old), false);
      await assert.rejects(reserve(db, id, old.upload_key, 'photo', 1), error => error.message === 'quota');
    });
    await t.test('deleted rows, wrong owners and mismatched Storage paths cannot be completed', async () => {
      const id = await owner(db); const stranger = await owner(db); const post = await reserve(db, id);
      assert.equal(await finish(db, post, stranger), false);
      assert.equal(await finish(db, post, id, `${id}/${post.id}.jpg`), false);
      assert.equal(await finish(db, post, id, `${id}/${post.id}/${post.upload_attempt}.mp4`), false);
      await db.query("update peekalo_posts set status='deleted' where id=$1", [post.id]);
      assert.equal(await finish(db, post), false); assert.equal(await fail(db, post), false);
      assert.equal((await reserve(db, id, post.upload_key)).status, 'deleted');
    });
    await t.test('failed retry gets a new token and ready retry preserves revoked links', async () => {
      const post = await reserve(db, await owner(db)); assert.equal(await fail(db, post), true);
      const retry = await reserve(db, post.owner_id, post.upload_key);
      assert.notEqual(retry.upload_attempt, post.upload_attempt); assert.equal(await finish(db, retry), true);
      const nonce = randomUUID();
      await value(db, 'select peekalo_create_link($1,$2,$3,$4) as value', [post.owner_id, post.id, nonce, `test-only-${randomUUID()}`]);
      await value(db, 'select peekalo_revoke($1,$2) as value', [post.owner_id, post.id]);
      assert.equal((await reserve(db, post.owner_id, post.upload_key)).status, 'ready');
      assert.equal(await finish(db, retry), true, 'Ready completion replay cannot reactivate a revoked link');
      assert.equal(await value(db, 'select revoked as value from peekalo_links where post_id=$1', [post.id]), true);
    });
    await t.test('completion refreshes expiry after waiting on a post lock', async () => {
      const post = await reserve(db, await owner(db));
      await db.query("update peekalo_posts set upload_expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1", [post.id]);
      const blocker = await connect(); const worker = await connect();
      await blocker.query('begin');
      try {
        await blocker.query('select id from peekalo_posts where id=$1 for update', [post.id]);
        const pending = finish(worker, post);
        const deadline = Date.now() + 2000;
        while (!(await value(db, 'select $1::integer=any(pg_blocking_pids($2)) as value', [blocker.processID, worker.processID]))) {
          assert(Date.now() < deadline, 'Completion must queue behind the held post');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await new Promise(resolve => setTimeout(resolve, 550));
        await blocker.query('commit');
        assert.equal(await pending, false);
      } finally { await blocker.query('rollback'); }
    });
    await t.test('completion and quota checks serialize even when the old attempt deadline passes before commit', async () => {
      const id = await owner(db); const post = await reserve(db, id, randomUUID(), 'photo', 1);
      await db.query("update peekalo_posts set upload_expires_at=clock_timestamp()+interval '500 milliseconds' where id=$1", [post.id]);
      const publisher = await connect(); const contender = await connect();
      await publisher.query('begin');
      try {
        assert.equal(await finish(publisher, post), true);
        await new Promise(resolve => setTimeout(resolve, 550));
        const pending = reserve(contender, id, randomUUID(), 'photo', 1).then(result => ({ result }), error => ({ error }));
        const deadline = Date.now() + 2000;
        while (!(await value(db, 'select $1::integer=any(pg_blocking_pids($2)) as value', [publisher.processID, contender.processID]))) {
          assert(Date.now() < deadline, 'Quota allocation must wait for the pending publication');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await publisher.query('commit');
        assert.equal((await pending).error?.message, 'quota');
      } finally { await publisher.query('rollback'); }
    });
    await t.test('service role must use fenced RPCs; public roles cannot call them', async () => {
      const id = await owner(db); const client = await connect();
      await client.query('set role service_role');
      const post = await reserve(client, id);
      await assert.rejects(client.query("insert into peekalo_posts(owner_id,upload_key,kind) values($1,$2,'photo')", [id, randomUUID()]), { code: '42501' });
      await assert.rejects(client.query("update peekalo_posts set status='ready' where id=$1", [post.id]), { code: '42501' });
      assert.equal(await finish(client, post), true);
      await client.query('reset role');
      for (const role of ['anon', 'authenticated']) {
        await client.query(`set role ${role}`);
        await assert.rejects(finish(client, post), { code: '42501' });
        await assert.rejects(fail(client, post), { code: '42501' });
        await client.query('reset role');
      }
    });
  });
} finally {
  await Promise.allSettled([...clients].map(client => client.end()));
  await postgres.stop(); await rm(directory, { recursive: true, force: true });
}
