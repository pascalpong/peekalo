import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
// Always a new disposable loopback database: no dotenv, remote URL or user data.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.cache'), { recursive: true });
const directory = await mkdtemp(join(root, '.cache/abuse-ledger-'));
const port = await new Promise((resolve, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), port, user: 'postgres', password: randomUUID(), persistent: true, postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'], onLog: () => {}, onError: () => {} });
const clients = [];
async function connect() { const client = postgres.getPgClient('postgres', '127.0.0.1'); await client.connect(); clients.push(client); await client.query("set statement_timeout='10s'; set lock_timeout='8s'"); return client; }
async function admit(client, scope = 'account', lane = 'upload', key = 'a'.repeat(64)) { return (await client.query('select peekalo_admit_endpoint($1,$2,$3) as value', [scope, lane, key])).rows[0].value; }
try {
  await postgres.initialise(); await postgres.start();
  const db = await connect();
  await db.query('create role anon; create role authenticated; create role service_role;');
  await db.query(await readFile(join(root, 'supabase/migrations/202610300002_abuse.sql'), 'utf8'));
  await test('isolated distributed abuse ledger', async t => {
    await t.test('independent gateway connections share exactly one atomic upload burst', async () => {
      const peers = await Promise.all(Array.from({ length: 12 }, connect));
      const results = await Promise.all(peers.map(peer => admit(peer)));
      assert.equal(results.filter(item => item.allowed).length, 6);
      assert(results.filter(item => !item.allowed).every(item => item.retryAfter > 0 && item.retryAfter <= 10));
      assert.equal(Number((await db.query('select count(*) as count from peekalo_abuse_buckets')).rows[0].count), 1);
    });
    await t.test('elapsed authoritative time refills without a fixed-window boundary burst', async () => {
      await db.query("update peekalo_abuse_buckets set touched_at=clock_timestamp()-interval '20 seconds' where key_hash=$1", ['a'.repeat(64)]);
      assert((await admit(db)).allowed); assert((await admit(db)).allowed); assert.equal((await admit(db)).allowed, false);
      await db.query("update peekalo_abuse_buckets set touched_at=clock_timestamp()-interval '1 day'");
      const values = []; for (let i = 0; i < 7; i++) values.push(await admit(db));
      assert.equal(values.filter(item => item.allowed).length, 6, 'Idle buckets never refill beyond source policy capacity');
    });
    await t.test('rotated credential keys cannot bypass a global lane; privacy lane stays separate', async () => {
      const results = []; for (let i = 0; i < 21; i++) results.push(await admit(db, 'global', 'upload', '0'.repeat(64)));
      assert.equal(results.filter(item => item.allowed).length, 20);
      assert.equal((await admit(db, 'global', 'deletion', '0'.repeat(64))).allowed, true);
      assert.equal((await admit(db, 'credential', 'upload', 'b'.repeat(64))).allowed, true);
      assert.equal((await admit(db, 'account', 'upload', 'b'.repeat(64))).allowed, true);
      await assert.rejects(() => admit(db, 'global', 'upload', 'c'.repeat(64)), /conflict/);
      await assert.rejects(() => admit(db, 'account', 'client-policy', 'c'.repeat(64)), /conflict/);
    });
    await t.test('hard cardinality ceiling and bounded idle expiry resist attacker key churn', async () => {
      await db.query('truncate peekalo_abuse_buckets');
      await db.query("insert into peekalo_abuse_buckets select 'credential','api',lpad(to_hex(n),64,'0'),1,clock_timestamp(),clock_timestamp()+interval '15 minutes' from generate_series(1,20000) n");
      assert.equal((await admit(db, 'credential', 'api', 'f'.repeat(64))).allowed, false);
      assert.equal(Number((await db.query('select count(*) as count from peekalo_abuse_buckets')).rows[0].count), 20000);
      await db.query("update peekalo_abuse_buckets set expires_at=clock_timestamp()-interval '1 second'");
      assert.equal((await db.query('select peekalo_abuse_expire() as count')).rows[0].count, 1000);
      assert.equal((await admit(db, 'credential', 'api', 'f'.repeat(64))).allowed, true);
      assert(Number((await db.query('select count(*) as count from peekalo_abuse_buckets')).rows[0].count) <= 19001);
      const status = (await db.query('select peekalo_abuse_status() as value')).rows[0].value;
      assert(status.denied >= 8); assert(status.deniedLastHour >= 8); assert(status.buckets <= 19001); assert.deepEqual(Object.keys(status).sort(), ['buckets', 'denied', 'deniedLastHour']);
    });
    await t.test('public/client roles cannot call maintenance or select hashed operational records', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.query(`set role ${role}`);
        await assert.rejects(() => admit(db), /permission denied/);
        await assert.rejects(() => db.query('select peekalo_abuse_expire()'), /permission denied/);
        await assert.rejects(() => db.query('select peekalo_abuse_status()'), /permission denied/);
        await assert.rejects(() => db.query('select * from peekalo_abuse_buckets'), /permission denied/);
        await db.query('reset role');
      }
      await db.query('set role service_role');
      assert.equal((await admit(db, 'account', 'deletion', 'e'.repeat(64))).allowed, true);
      await assert.rejects(() => db.query('select * from peekalo_abuse_buckets'), /permission denied/);
      await db.query('reset role');
    });
  });
} finally {
  await Promise.allSettled(clients.map(client => client.end()));
  await postgres.stop(); await rm(directory, { recursive: true, force: true });
}
