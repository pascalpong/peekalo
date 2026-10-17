import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// This suite always creates a disposable, loopback-only database. It never reads
// Supabase credentials, dotenv files, or a remote database URL.
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, '.cache'), { recursive: true });
const directory = await mkdtemp(join(root, '.cache/backend-ledger-'));
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'),
  port,
  user: 'postgres',
  password: randomUUID(),
  persistent: true,
  postgresFlags: ['-h', '127.0.0.1', '-k', '/tmp'],
  onLog: () => {},
  onError: (error) => console.error(error),
});
const clients = new Set();

async function connect() {
  const client = postgres.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  clients.add(client);
  await client.query("set statement_timeout = '5s'; set lock_timeout = '4s'");
  return client;
}

async function value(client, sql, parameters = []) {
  return (await client.query(sql, parameters)).rows[0]?.value;
}

async function fixture(client) {
  const owner = randomUUID();
  const recipient = randomUUID();
  const stranger = randomUUID();
  const post = randomUUID();
  const link = randomUUID();
  const hash = `test-only-${randomUUID()}`;
  const username = `test_${recipient.replaceAll('-', '').slice(0, 16)}`;
  await client.query('insert into auth.users(id) values ($1),($2),($3)', [owner, recipient, stranger]);
  await client.query('insert into peekalo_profiles(id,username) values ($1,$2)', [recipient, username]);
  await client.query("insert into peekalo_posts(id,owner_id,upload_key,kind,status,storage_path) values ($1,$2,$3,'photo','ready','test-only/fixture.jpg')", [post, owner, randomUUID()]);
  await client.query('insert into peekalo_links(id,post_id,nonce,token_hash) values ($1,$2,$3,$4)', [link, post, randomUUID(), hash]);
  return { owner, recipient, stranger, post, link, hash, username, identity: `a:${recipient}` };
}

function lease(client, f, { identity = f.identity, session = randomUUID(), request = randomUUID(), hash = f.hash, post = null } = {}) {
  return value(client, 'select peekalo_lease($1,$2,$3,$4,$5) as value', [identity, session, request, hash, post]);
}

function failure(action, message) {
  return assert.rejects(action, (error) => error.code === 'P0001' && error.message === message);
}

async function accept(client, f) {
  assert.equal(await value(client, 'select peekalo_grant($1,$2,$3) as value', [f.owner, f.post, f.username]), 'pending');
  assert.equal(await value(client, 'select peekalo_accept($1,$2) as value', [f.recipient, f.post]), 'accepted');
}

// Observe the real server lock queue instead of guessing when a promise began.
async function waitForBlock(observer, blocked, blocker) {
  const deadline = Date.now() + 2500;
  const blockerIds = (Array.isArray(blocker) ? blocker : [blocker]).map((client) => client.processID);
  while (Date.now() < deadline) {
    if (await value(observer, 'select pg_blocking_pids($1) && $2::integer[] as value', [blocked.processID, blockerIds])) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected PostgreSQL connection to queue behind the held row lock');
}

try {
  await postgres.initialise();
  await postgres.start();
  const db = await connect();
  await db.query(`
    create schema auth;
    create table auth.users(id uuid primary key);
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
    create role anon;
    create role authenticated;
    create role service_role;
  `);
  const migrations = (await readdir(join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
  let legacyFixture;
  for (const migration of migrations) {
    // Exercise migration of real existing rows, not just an empty database.
    if (migration.startsWith('202610160004')) legacyFixture = await fixture(db);
    await db.query(await readFile(join(root, 'supabase/migrations', migration), 'utf8'));
  }

  await test('PostgreSQL protected-sharing ledger', async (t) => {
    await t.test('migration backfills existing link nonce mappings and preserves their replay', async () => {
      assert.ok(legacyFixture, 'The request mapping migration must be applied');
      const f = legacyFixture;
      const nonce = await value(db, 'select nonce as value from peekalo_links where id=$1', [f.link]);
      assert.equal(await value(db, 'select link_id as value from peekalo_link_requests where post_id=$1 and nonce=$2', [f.post, nonce]), f.link);
      await value(db, 'select peekalo_revoke($1,$2) as value', [f.owner, f.post]);
      const replacement = await value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, randomUUID(), `test-only-${randomUUID()}`]);
      assert.notEqual(replacement.id, f.link);
      const replay = await value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, nonce, f.hash]);
      assert.equal(replay.id, f.link);
      assert.equal(replay.revoked, true);
    });

    await t.test('preview is non-consuming and exposes no storage path', async () => {
      const f = await fixture(db);
      for (let count = 0; count < 3; count++) {
        assert.deepEqual(await value(db, 'select peekalo_preview($1) as value', [f.hash]), { kind: 'photo', available: true });
      }
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 0);
    });

    await t.test('simultaneous independent connections produce one global link winner', async () => {
      const f = await fixture(db);
      const viewers = await Promise.all(Array.from({ length: 6 }, () => connect()));
      const identities = viewers.map(() => `g:${randomUUID()}`);
      const results = await Promise.allSettled(viewers.map((client, index) => lease(client, f, { identity: identities[index] })));
      const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
      assert.equal(winners.length, 1);
      for (const result of results.filter((result) => result.status === 'rejected')) {
        assert.equal(result.reason.code, 'P0001');
        assert.equal(result.reason.message, 'claimed');
      }
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), identities[winners[0]]);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 1);
    });

    await t.test('same-scope retries return the same lease without spending again', async () => {
      const f = await fixture(db);
      const session = randomUUID();
      const request = randomUUID();
      const first = await lease(db, f, { session, request });
      const otherConnection = await connect();
      assert.deepEqual(await lease(otherConnection, f, { session, request }), first);
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1 and identity=$2', [f.post, f.identity]), first.grantedMs);
      await failure(() => lease(db, f, { session: randomUUID(), request }), 'conflict');
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 1);
    });

    await t.test('concurrent identical requests return one lease and debit once', async () => {
      const f = await fixture(db);
      const connections = await Promise.all([connect(), connect(), connect()]);
      const session = randomUUID();
      const request = randomUUID();
      const results = await Promise.all(connections.map((client) => lease(client, f, { session, request })));
      assert.deepEqual(results[1], results[0]);
      assert.deepEqual(results[2], results[0]);
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1 and identity=$2', [f.post, f.identity]), 2000);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 1);
    });

    await t.test('direct and link access for one account share the same cumulative budget', async () => {
      const f = await fixture(db);
      await accept(db, f);
      const direct = await lease(db, f, { hash: null, post: f.post });
      assert.equal(direct.remainingMs, 8000);
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      await db.query("update peekalo_budgets set active_until=clock_timestamp()-interval '1 second' where post_id=$1 and identity=$2", [f.post, f.identity]);
      const linked = await lease(db, f);
      assert.equal(linked.remainingMs, 6000);
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1 and identity=$2', [f.post, f.identity]), 4000);
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), f.identity);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 1);
    });

    await t.test('unavailable posts cannot consume a link or debit its viewer', async () => {
      for (const status of ['uploading', 'failed', 'deleted']) {
        const f = await fixture(db);
        await db.query('update peekalo_posts set status=$2 where id=$1', [f.post, status]);
        await failure(() => lease(db, f), 'unavailable');
        assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
        assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 0);
        assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 0);
      }
    });

    await t.test('request IDs cannot cross direct/link or distinct-link scopes', async () => {
      for (const firstScope of ['direct', 'link']) {
        const f = await fixture(db);
        await accept(db, f);
        const session = randomUUID();
        const request = randomUUID();
        await lease(db, f, { session, request, hash: firstScope === 'direct' ? null : f.hash, post: f.post });
        await failure(() => lease(db, f, { session, request, hash: firstScope === 'direct' ? f.hash : null, post: f.post }), 'conflict');
        if (firstScope === 'direct') assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
        const second = randomUUID();
        const secondHash = `test-only-${randomUUID()}`;
        await db.query('insert into peekalo_links(id,post_id,nonce,token_hash) values($1,$2,$3,$4)', [second, f.post, randomUUID(), secondHash]);
        await failure(() => lease(db, f, { session, request, hash: secondHash }), 'conflict');
        assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [second]), null);
      }
    });

    await t.test('an exhausted account cannot consume an unclaimed fresh link', async () => {
      const f = await fixture(db);
      await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,10000)', [f.post, f.identity]);
      await failure(() => lease(db, f), 'exhausted');
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 0);
    });

    await t.test('owners cannot consume their own external links', async () => {
      const f = await fixture(db);
      await failure(() => lease(db, f, { identity: `a:${f.owner}` }), 'unavailable');
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
    });

    await t.test('direct delivery requires acceptance and revocation prevents further media access', async () => {
      const f = await fixture(db);
      assert.equal(await value(db, 'select peekalo_grant($1,$2,$3) as value', [f.owner, f.post, f.username]), 'pending');
      await failure(() => lease(db, f, { hash: null, post: f.post }), 'unavailable');
      await failure(() => value(db, 'select peekalo_accept($1,$2) as value', [f.stranger, f.post]), 'unavailable');
      await value(db, 'select peekalo_accept($1,$2) as value', [f.recipient, f.post]);
      const granted = await lease(db, f, { hash: null, post: f.post });
      assert.equal((await value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId])).path, 'test-only/fixture.jpg');
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [`a:${f.stranger}`, granted.leaseId]), 'unavailable');
      await value(db, 'select peekalo_revoke($1,$2,$3) as value', [f.owner, f.post, f.username]);
      await failure(() => lease(db, f, { hash: null, post: f.post }), 'unavailable');
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId]), 'unavailable');
    });

    await t.test('only the owner can create links, grant access, or revoke access', async () => {
      const f = await fixture(db);
      await failure(() => value(db, 'select peekalo_grant($1,$2,$3) as value', [f.stranger, f.post, f.username]), 'unavailable');
      await failure(() => value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.stranger, f.post, randomUUID(), `test-only-${randomUUID()}`]), 'unavailable');
      await failure(() => value(db, 'select peekalo_revoke($1,$2) as value', [f.stranger, f.post]), 'unavailable');
      assert.equal(await value(db, 'select revoked as value from peekalo_links where id=$1', [f.link]), false);
    });

    await t.test('retrying an old link nonce returns its revoked result after replacement', async () => {
      const f = await fixture(db);
      const nonce = await value(db, 'select nonce as value from peekalo_links where id=$1', [f.link]);
      // Register the fixture's key through the same path as a real create.
      assert.equal((await value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, nonce, f.hash])).id, f.link);
      await value(db, 'select peekalo_revoke($1,$2) as value', [f.owner, f.post]);
      const replacement = await value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, randomUUID(), `test-only-${randomUUID()}`]);
      assert.notEqual(replacement.id, f.link);
      assert.equal(replacement.revoked, false);
      const retry = await value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, nonce, f.hash]);
      assert.equal(retry.id, f.link);
      assert.equal(retry.revoked, true);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_links where post_id=$1', [f.post]), 2);
    });

    await t.test('an alias nonce preserves its original link across revocation and replacement', async () => {
      const f = await fixture(db);
      const keyA = randomUUID();
      const keyB = randomUUID();
      const create = (nonce) => value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, nonce, `test-only-${randomUUID()}`]);
      assert.equal((await create(keyA)).id, f.link);
      assert.equal((await create(keyB)).id, f.link);
      await value(db, 'select peekalo_revoke($1,$2) as value', [f.owner, f.post]);
      const retryBeforeReplacement = await create(keyB);
      assert.equal(retryBeforeReplacement.id, f.link);
      assert.equal(retryBeforeReplacement.revoked, true);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_links where post_id=$1', [f.post]), 1);
      const replacement = await create(randomUUID());
      assert.notEqual(replacement.id, f.link);
      assert.equal(replacement.revoked, false);
      for (const nonce of [keyA, keyB]) {
        const replay = await create(nonce);
        assert.equal(replay.id, f.link);
        assert.equal(replay.revoked, true);
      }
    });

    await t.test('failed-upload retry respects a full quota and recovers when a slot opens', async () => {
      const f = await fixture(db);
      const failed = await value(db, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, randomUUID(), 'photo', 2]);
      await db.query("update peekalo_posts set status='failed' where id=$1", [failed.id]);
      const replacement = await value(db, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, randomUUID(), 'photo', 2]);
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, failed.upload_key, 'photo', 2]), 'quota');
      assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [failed.id]), 'failed');
      await db.query("update peekalo_posts set status='deleted' where id=$1", [replacement.id]);
      const retry = await value(db, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, failed.upload_key, 'photo', 2]);
      assert.equal(retry.id, failed.id);
      assert.equal(retry.reserved, true);
      assert.equal(retry.status, 'uploading');
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, failed.upload_key, 'video', 2]), 'conflict');
    });

    await t.test('concurrent reservations cannot exceed the explicit quota', async () => {
      const f = await fixture(db);
      const connections = await Promise.all([connect(), connect(), connect()]);
      const results = await Promise.allSettled(connections.map((client) => value(client, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, randomUUID(), 'photo', 2])));
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of results.filter((result) => result.status === 'rejected')) assert.equal(result.reason.message, 'quota');
      assert.equal(await value(db, "select count(*)::integer as value from peekalo_posts where owner_id=$1 and status in ('ready','uploading')", [f.owner]), 2);
    });

    await t.test('competing sessions are busy and immediate same-session renewals are early', async () => {
      const f = await fixture(db);
      const session = randomUUID();
      await lease(db, f, { session });
      const other = await connect();
      await failure(() => lease(other, f), 'busy');
      await failure(() => lease(other, f, { session }), 'early');
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1 and identity=$2', [f.post, f.identity]), 2000);
      await db.query("update peekalo_budgets set active_until=clock_timestamp()-interval '1 second' where post_id=$1 and identity=$2", [f.post, f.identity]);
      const next = await lease(other, f);
      assert.equal(next.remainingMs, 6000);
    });

    await t.test('cumulative grants stop at 10000 ms including a partial final slice', async () => {
      const f = await fixture(db);
      await db.query('insert into peekalo_budgets(post_id,identity,spent_ms) values($1,$2,1250)', [f.post, f.identity]);
      let total = 1250;
      for (let index = 0; index < 5; index++) {
        const granted = await lease(db, f);
        total += granted.grantedMs;
        assert.equal(granted.grantedMs, index === 4 ? 750 : 2000);
        assert.equal(granted.remainingMs, 10000 - total);
        await db.query("update peekalo_budgets set active_until=clock_timestamp()-interval '1 second' where post_id=$1 and identity=$2", [f.post, f.identity]);
      }
      assert.equal(total, 10000);
      await failure(() => lease(db, f), 'exhausted');
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1 and identity=$2', [f.post, f.identity]), 10000);
      await assert.rejects(() => db.query('update peekalo_budgets set spent_ms=10001 where post_id=$1 and identity=$2', [f.post, f.identity]), { code: '23514' });
    });

    await t.test('a link that expires while its reveal waits for a post lock is not claimed', async () => {
      const f = await fixture(db);
      const blocker = await connect();
      const viewer = await connect();
      await blocker.query('begin');
      try {
        await blocker.query('select id from peekalo_posts where id=$1 for update', [f.post]);
        await db.query("update peekalo_links set expires_at=clock_timestamp()+interval '1 hour' where id=$1", [f.link]);
        // Attach a rejection handler immediately, even if a lock assertion fails.
        const pending = lease(viewer, f).then((result) => ({ result }), (error) => ({ error }));
        await waitForBlock(db, viewer, blocker);
        // Start the short expiry only after observing the lock queue, so a busy
        // CI runner need not schedule the viewer within a fixed 200 ms window.
        await db.query("update peekalo_links set expires_at=clock_timestamp()+interval '100 milliseconds' where id=$1", [f.link]);
        await db.query("select pg_sleep(greatest(0,extract(epoch from expires_at-clock_timestamp())+0.02)) from peekalo_links where id=$1", [f.link]);
        await blocker.query('commit');
        const outcome = await pending;
        assert.equal(outcome.error?.message, 'unavailable');
        assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
        assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 0);
      } finally {
        await blocker.query('rollback');
      }
    });

    for (const scope of ['link', 'direct']) {
      await t.test(`${scope} reveal locks the post before its child row and serializes with revocation`, async () => {
        const f = await fixture(db);
        if (scope === 'direct') await accept(db, f);
        const blocker = await connect();
        const viewer = await connect();
        const revoker = await connect();
        const probe = await connect();
        await blocker.query('begin');
        try {
          await blocker.query('select id from peekalo_posts where id=$1 for update', [f.post]);
          const pendingLease = lease(viewer, f, { hash: scope === 'link' ? f.hash : null, post: f.post }).then((result) => ({ result }), (error) => ({ error }));
          await waitForBlock(db, viewer, blocker);
          // With the old link/grant-first order this NOWAIT query fails. That
          // order also allows revoke(post -> child) and reveal(child -> post)
          // to deadlock each other under load.
          await probe.query('begin');
          try {
            if (scope === 'link') await probe.query('select id from peekalo_links where id=$1 for update nowait', [f.link]);
            else await probe.query('select post_id from peekalo_grants where post_id=$1 and recipient_id=$2 for update nowait', [f.post, f.recipient]);
          } finally {
            await probe.query('rollback');
          }
          const pendingRevoke = value(revoker, 'select peekalo_revoke($1,$2,$3) as value', [f.owner, f.post, scope === 'direct' ? f.username : null]).then((result) => ({ result }), (error) => ({ error }));
          // PostgreSQL may report the earlier queued viewer as the direct
          // blocker, because its tuple-lock request precedes the revoker.
          await waitForBlock(db, revoker, [blocker, viewer]);
          await blocker.query('commit');
          const revealed = await pendingLease;
          const revoked = await pendingRevoke;
          assert.equal(revealed.error, undefined);
          assert.ok(revealed.result.leaseId);
          assert.equal(revoked.error, undefined);
          assert.equal(revoked.result, true);
          await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, revealed.result.leaseId]), 'unavailable');
        } finally {
          await blocker.query('rollback');
        }
      });
    }

    await t.test('public client roles cannot read ledger tables or call privileged functions', async () => {
      const f = await fixture(db);
      const tables = ['profiles', 'posts', 'links', 'link_requests', 'grants', 'budgets', 'leases'];
      const calls = [
        ['peekalo_preview($1)', [f.hash]],
        ['peekalo_lease($1,$2,$3,$4,$5)', [f.identity, randomUUID(), randomUUID(), f.hash, null]],
        ['peekalo_media($1,$2)', [f.identity, randomUUID()]],
        ['peekalo_reserve_post($1,$2,$3,$4)', [f.owner, randomUUID(), 'photo', 3]],
        ['peekalo_create_link($1,$2,$3,$4)', [f.owner, f.post, randomUUID(), 'test-only-denied']],
        ['peekalo_grant($1,$2,$3)', [f.owner, f.post, f.username]],
        ['peekalo_accept($1,$2)', [f.recipient, f.post]],
        ['peekalo_revoke($1,$2,$3)', [f.owner, f.post, null]],
      ];
      const client = await connect();
      for (const role of ['anon', 'authenticated']) {
        await client.query(`set role ${role}`);
        for (const table of tables) await assert.rejects(() => client.query(`select * from peekalo_${table}`), { code: '42501' });
        for (const [sql, parameters] of calls) await assert.rejects(() => client.query(`select ${sql}`, parameters), { code: '42501' });
        await client.query('reset role');
      }
      await client.query('set role service_role');
      assert.equal((await value(client, 'select peekalo_preview($1) as value', [f.hash])).available, true);
      assert.equal((await lease(client, f)).grantedMs, 2000);
      await client.query('reset role');
    });
  });
} finally {
  await Promise.allSettled([...clients].map((client) => client.end()));
  await postgres.stop();
  await rm(directory, { recursive: true, force: true });
}
