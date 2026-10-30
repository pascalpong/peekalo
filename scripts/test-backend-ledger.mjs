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
let safetyApplied = false;

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
  await client.query(`insert into peekalo_profiles(id,username${safetyApplied ? ',review_state' : ''}) values ($1,$2${safetyApplied ? ",'approved'" : ''}),($3,$4${safetyApplied ? ",'approved'" : ''})`, [recipient, username, owner, `test_${owner.replaceAll('-', '').slice(0, 16)}`]);
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

async function operator(client) {
  const id = randomUUID();
  await client.query('insert into auth.users(id) values($1)', [id]);
  await client.query("insert into peekalo_profiles(id,username,review_state) values($1,$2,'approved')", [id, `operator_${id.replaceAll('-', '').slice(0, 12)}`]);
  await client.query('insert into peekalo_operators(account_id) values($1)', [id]);
  return id;
}

function moderate(client, operatorId, postId, action = 'approve') {
  return value(client, 'select peekalo_moderate($1,$2,$3,$4) as value', [operatorId, postId, action, 'Generated-fixture review']);
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
    if (migration.startsWith('202610290001')) {
      safetyApplied = true;
      // Legacy media was deliberately quarantined by the safety rollout. Check
      // this before reapproving the generated legacy fixture for nonce tests.
      assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [legacyFixture.post]), 'moderation_pending');
      await db.query("update peekalo_profiles set review_state='approved'");
      await db.query("update peekalo_posts set status='ready' where id=$1", [legacyFixture.post]);
    }
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
      for (const status of ['uploading', 'moderation_pending', 'rejected', 'taken_down', 'failed', 'deleted']) {
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

    await t.test('read status never claims links or creates budget/lease rows, including cookie loss', async () => {
      const f = await fixture(db);
      const status = identity => value(db, 'select peekalo_view_status($1,$2) as value', [identity, f.hash]);
      for (const identity of [null, `g:${randomUUID()}`, f.identity]) {
        assert.deepEqual(await status(identity), { kind: 'photo', state: 'available', remainingMs: 10000 });
      }
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 0);
      const original = `g:${randomUUID()}`;
      const granted = await lease(db, f, { identity: original });
      assert.deepEqual(await status(original), { kind: 'photo', state: 'available', remainingMs: granted.remainingMs });
      await failure(() => status(null), 'claimed');
      await failure(() => status(`g:${randomUUID()}`), 'claimed');
      await db.query('update peekalo_budgets set spent_ms=10000 where post_id=$1', [f.post]);
      assert.deepEqual(await status(original), { kind: 'photo', state: 'exhausted', remainingMs: 0 });
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 1);
      await value(db, 'select peekalo_revoke($1,$2) as value', [f.owner, f.post]);
      await failure(() => status(original), 'unavailable');
    });

    await t.test('direct status requires accepted nonrevoked grant and shares the ledger with Inbox', async () => {
      const f = await fixture(db);
      const status = identity => value(db, 'select peekalo_view_status($1,null,$2) as value', [identity, f.post]);
      await value(db, 'select peekalo_grant($1,$2,$3) as value', [f.owner, f.post, f.username]);
      assert.equal((await value(db, 'select peekalo_inbox($1) as value', [f.recipient])).items[0].remainingMs, null);
      await failure(() => status(f.identity), 'unavailable');
      await failure(() => status(`a:${f.stranger}`), 'unavailable');
      await failure(() => status(null), 'unauthorized');
      await accept(db, f);
      assert.equal((await status(f.identity)).remainingMs, 10000);
      await lease(db, f, { hash: null, post: f.post });
      assert.equal((await status(f.identity)).remainingMs, 8000);
      assert.equal((await value(db, 'select peekalo_inbox($1) as value', [f.recipient])).items[0].remainingMs, 8000);
      await value(db, 'select peekalo_revoke($1,$2,$3) as value', [f.owner, f.post, f.username]);
      await failure(() => status(f.identity), 'unavailable');
      assert.deepEqual((await value(db, 'select peekalo_inbox($1) as value', [f.recipient])).items, []);
    });

    await t.test('default and permissive quota calls cannot admit a fourth active reservation; deletion frees one', async () => {
      const f = await fixture(db);
      const workers = await Promise.all([connect(), connect(), connect(), connect()]);
      const requests = await Promise.allSettled(workers.map((client, i) => value(client, 'select peekalo_reserve_post($1,$2,$3,$4) as value', [f.owner, randomUUID(), 'photo', i % 2 ? 99 : null])));
      assert.equal(requests.filter(r => r.status === 'fulfilled').length, 2);
      assert(requests.filter(r => r.status === 'rejected').every(r => r.reason.message === 'quota'));
      const inventory = await value(db, 'select peekalo_own_posts($1) as value', [f.owner]);
      assert.equal(inventory.activeCount, 3); assert.equal(inventory.availableSlots, 0); assert.equal(inventory.limit, 3);
      await failure(() => value(db, 'select peekalo_delete_post($1,$2) as value', [f.stranger, f.post]), 'unavailable');
      await value(db, 'select peekalo_delete_post($1,$2) as value', [f.owner, f.post]);
      const next = await value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, randomUUID(), 'video']);
      const retry = await value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, next.upload_key, 'video']);
      assert.equal(retry.id, next.id); assert.equal(retry.reserved, false);
      assert.equal((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).activeCount, 3);
    });

    await t.test('legacy over-limit inventory retains data and counts beyond the display page', async () => {
      const f = await fixture(db);
      await db.query("insert into peekalo_posts(owner_id,upload_key,kind,status) select $1,gen_random_uuid(),'photo','ready' from generate_series(1,105)", [f.owner]);
      const inventory = await value(db, 'select peekalo_own_posts($1) as value', [f.owner]);
      assert.equal(inventory.activeCount, 106); assert.equal(inventory.availableSlots, 0); assert.equal(inventory.items.length, 100);
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, randomUUID(), 'photo']), 'quota');
      assert.equal(await value(db, "select count(*)::integer as value from peekalo_posts where owner_id=$1 and status='ready'", [f.owner]), 106);
      assert.deepEqual((await value(db, 'select peekalo_own_posts($1) as value', [f.stranger])).items, []);
    });

    await t.test('public profiles expose opaque metadata only while owner inventory reports controls', async () => {
      const f = await fixture(db); const username = `test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await db.query('update peekalo_profiles set username=$2 where id=$1', [f.owner, username]);
      await accept(db, f);
      const profile = await value(db, 'select peekalo_public_profile($1) as value', [username]);
      assert.equal(profile.username, username); assert.equal(profile.items.length, 1);
      assert.deepEqual(Object.keys(profile.items[0]).sort(), ['createdAt', 'kind']);
      const own = (await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).items[0];
      assert.equal(own.link.state, 'active'); assert.deepEqual(own.recipients, [{ accountId: f.recipient, username: f.username, requestState: 'accepted', revoked: false }]);
      assert(!JSON.stringify(own).includes(f.hash)); assert(!JSON.stringify(own).includes('storage_path'));
      await value(db, 'select peekalo_delete_post($1,$2) as value', [f.owner, f.post]);
      assert.deepEqual((await value(db, 'select peekalo_public_profile($1) as value', [username])).items, []);
      await failure(() => value(db, 'select peekalo_public_profile($1) as value', ['unknown_fixture']), 'unavailable');
    });

    await t.test('owner deletion revokes live capabilities and preserves tombstones until cleanup; retries never republish', async () => {
      const f = await fixture(db); await accept(db, f);
      const direct = await lease(db, f, { hash: null, post: f.post });
      const deleted = await value(db, 'select peekalo_delete_post($1,$2) as value', [f.owner, f.post]);
      assert.deepEqual(deleted, { storagePath: 'test-only/fixture.jpg' });
      assert.equal(await value(db, 'select peekalo_post_deleted($1,$2) as value', [f.owner, f.post]), true);
      assert.equal(await value(db, 'select peekalo_post_deleted($1,$2) as value', [f.stranger, f.post]), false);
      assert.deepEqual(await value(db, 'select peekalo_delete_post($1,$2) as value', [f.owner, f.post]), deleted);
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, direct.leaseId]), 'unavailable');
      await failure(() => lease(db, f), 'unavailable');
      assert.equal((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).items[0].cleanupPending, true);
      const uploadKey = await value(db, 'select upload_key as value from peekalo_posts where id=$1', [f.post]);
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, uploadKey, 'photo']), 'unavailable');
      assert.equal(await value(db, 'select peekalo_finish_delete($1,$2,$3) as value', [f.stranger, f.post, deleted.storagePath]), false);
      assert.equal(await value(db, 'select peekalo_finish_delete($1,$2,$3) as value', [f.owner, f.post, 'wrong']), false);
      assert.equal(await value(db, 'select peekalo_finish_delete($1,$2,$3) as value', [f.owner, f.post, deleted.storagePath]), true);
      assert.deepEqual((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).items, []);
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 2000);
    });

    await t.test('finished uploads stay private pending independent approval, count toward quota and cannot bypass terminal decisions', async () => {
      const f = await fixture(db); const reviewer = await operator(db);
      const pending = [];
      for (let i = 0; i < 2; i++) {
        const reserved = await value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, randomUUID(), 'photo']);
        const path = `${f.owner}/${reserved.id}/${reserved.upload_attempt}.jpg`;
        assert.equal(await value(db, 'select peekalo_finish_upload($1,$2,$3,$4) as value', [f.owner, reserved.id, reserved.upload_attempt, path]), true);
        // A lost finish reply remains idempotent while pending; it never publishes.
        assert.equal(await value(db, 'select peekalo_finish_upload($1,$2,$3,$4) as value', [f.owner, reserved.id, reserved.upload_attempt, path]), true);
        assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [reserved.id]), 'moderation_pending');
        await failure(() => value(db, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, reserved.id, randomUUID(), `test-only-${randomUUID()}`]), 'moderation_pending');
        await failure(() => value(db, 'select peekalo_grant($1,$2,$3) as value', [f.owner, reserved.id, f.username]), 'moderation_pending');
        pending.push(reserved);
      }
      const inventory = await value(db, 'select peekalo_own_posts($1) as value', [f.owner]);
      assert.equal(inventory.activeCount, 3);
      assert.equal(inventory.items.filter(item => item.status === 'moderation_pending').length, 2);
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, randomUUID(), 'photo']), 'quota');
      await db.query('insert into peekalo_operators(account_id) values($1)', [f.owner]);
      await failure(() => moderate(db, f.owner, pending[0].id), 'forbidden');
      assert.equal((await moderate(db, reviewer, pending[0].id)).status, 'ready');
      assert.equal((await moderate(db, reviewer, pending[1].id, 'reject')).status, 'rejected');
      assert.equal((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).activeCount, 2);
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, pending[1].upload_key, 'photo']), 'rejected');
      await failure(() => moderate(db, reviewer, pending[1].id), 'unavailable');
      assert.equal((await moderate(db, reviewer, pending[0].id, 'takedown')).status, 'taken_down');
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, pending[0].upload_key, 'photo']), 'taken_down');
      await value(db, 'select peekalo_delete_post($1,$2) as value', [f.owner, pending[1].id]);
      assert.equal((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).items.find(item => item.postId === pending[1].id).cleanupPending, true);
    });

    await t.test('username publication requires manual review and changed names return to pending without losing ownership', async () => {
      const f = await fixture(db); const reviewer = await operator(db);
      const original = `test_${f.owner.replaceAll('-', '').slice(0, 16)}`;
      const username = `new_${f.owner.replaceAll('-', '').slice(0, 16)}`;
      const saved = await value(db, 'select peekalo_save_profile($1,$2) as value', [f.owner, username]);
      assert.deepEqual(saved, { username, reviewState: 'pending' });
      await failure(() => value(db, 'select peekalo_public_profile($1) as value', [original]), 'unavailable');
      await failure(() => value(db, 'select peekalo_lookup_profile($1,$2) as value', [f.recipient, username]), 'unavailable');
      await failure(() => lease(db, f, { identity: `g:${randomUUID()}` }), 'unavailable');
      assert.equal((await value(db, 'select peekalo_moderation_queue($1) as value', [reviewer])).profiles.some(item => item.username === username), true);
      assert.deepEqual(await value(db, 'select peekalo_moderate_profile($1,$2,$3,$4) as value', [reviewer, username, 'approve', 'Fixture name reviewed']), { username, reviewState: 'approved' });
      assert.equal((await value(db, 'select peekalo_public_profile($1) as value', [username])).items.length, 1);
      assert.equal((await value(db, 'select peekalo_save_profile($1,$2) as value', [f.owner, username])).reviewState, 'approved');
      await failure(() => value(db, 'select peekalo_save_profile($1,$2) as value', [f.stranger, username]), 'username_taken');
      await value(db, 'select peekalo_moderate_profile($1,$2,$3,$4) as value', [reviewer, username, 'reject', 'Reported inappropriate name']);
      await failure(() => value(db, 'select peekalo_public_profile($1) as value', [username]), 'unavailable');
      assert.equal(await value(db, 'select owner_id as value from peekalo_posts where id=$1', [f.post]), f.owner);
    });

    await t.test('bilateral blocks deny grants, lookups, previews, claims, delivery and Inbox; unblock never restores rights or budget', async () => {
      const f = await fixture(db); await accept(db, f);
      const ownerName = `test_${f.owner.replaceAll('-', '').slice(0, 16)}`;
      const direct = await lease(db, f, { hash: null, post: f.post });
      await db.query("update peekalo_budgets set active_until=clock_timestamp()-interval '1 second' where post_id=$1", [f.post]);
      await lease(db, f); // Account-claimed links must be revoked by the block.
      assert.deepEqual(await value(db, 'select peekalo_block($1,$2,true) as value', [f.recipient, ownerName]), { blocked: true });
      assert.deepEqual((await value(db, 'select peekalo_blocks($1) as value', [f.recipient])).items.map(item => item.username), [ownerName]);
      assert.equal(await value(db, 'select revoked as value from peekalo_links where id=$1', [f.link]), true);
      assert.equal(await value(db, 'select revoked as value from peekalo_grants where post_id=$1 and recipient_id=$2', [f.post, f.recipient]), true);
      await failure(() => value(db, 'select peekalo_grant($1,$2,$3) as value', [f.owner, f.post, f.username]), 'blocked');
      await failure(() => value(db, 'select peekalo_accept($1,$2) as value', [f.recipient, f.post]), 'blocked');
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, direct.leaseId]), 'blocked');
      await failure(() => value(db, 'select peekalo_view_status($1,null,$2) as value', [f.identity, f.post]), 'blocked');
      await failure(() => value(db, 'select peekalo_lookup_profile($1,$2) as value', [f.recipient, ownerName]), 'unavailable');
      await failure(() => value(db, 'select peekalo_public_profile($1,$2) as value', [f.username, f.owner]), 'unavailable');
      assert.deepEqual((await value(db, 'select peekalo_inbox($1) as value', [f.recipient])).items, []);
      assert.equal((await value(db, 'select peekalo_preview($1,$2) as value', [f.hash, f.identity])).state, 'blocked');
      await value(db, 'select peekalo_block($1,$2,false) as value', [f.recipient, ownerName]);
      await failure(() => lease(db, f, { hash: null, post: f.post }), 'unavailable');
      await failure(() => lease(db, f), 'unavailable');
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 4000);
      assert.deepEqual((await value(db, 'select peekalo_blocks($1) as value', [f.recipient])).items, []);
    });

    await t.test('an identified block prevents claiming an unclaimed link but cannot identify the same person anonymously', async () => {
      const f = await fixture(db);
      await value(db, 'select peekalo_block($1,$2,true) as value', [f.owner, f.username]);
      await failure(() => lease(db, f), 'blocked');
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 0);
      const guest = `g:${randomUUID()}`;
      assert.equal((await value(db, 'select peekalo_preview($1,$2) as value', [f.hash, guest])).available, true);
      assert.ok((await lease(db, f, { identity: guest })).leaseId);
      // Anonymous opaque profile access is intentionally public, not a promise
      // that a blocked person can be identified after clearing all identity.
      assert.equal((await value(db, 'select peekalo_public_profile($1) as value', [f.username])).username, f.username);
    });

    await t.test('block commits ahead of queued reveal and never consumes a link or budget', async () => {
      const f = await fixture(db); const blocker = await connect(); const viewer = await connect();
      await blocker.query('begin');
      try {
        await blocker.query('select pg_advisory_xact_lock(730293001)');
        const pending = lease(viewer, f).then(result => ({ result }), error => ({ error }));
        await waitForBlock(db, viewer, blocker);
        await value(blocker, 'select peekalo_block($1,$2,true) as value', [f.owner, f.username]);
        await blocker.query('commit');
        assert.equal((await pending).error?.message, 'blocked');
        assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
        assert.equal(await value(db, 'select count(*)::integer as value from peekalo_leases where post_id=$1', [f.post]), 0);
      } finally { await blocker.query('rollback'); }
    });

    await t.test('block waiting behind an in-flight authorization revokes its fresh grant before subsequent delivery', async () => {
      const f = await fixture(db); const viewer = await connect(); const blocker = await connect();
      await viewer.query('begin');
      try {
        const granted = await lease(viewer, f);
        const pending = value(blocker, 'select peekalo_block($1,$2,true) as value', [f.owner, f.username]).then(result => ({ result }), error => ({ error }));
        await waitForBlock(db, blocker, viewer);
        await viewer.query('commit');
        assert.deepEqual((await pending).result, { blocked: true });
        await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId]), 'blocked');
        assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 2000);
      } finally { await viewer.query('rollback'); }
    });

    await t.test('takedown serializes with post authorization and stops future delivery without resetting claims or allowances', async () => {
      const f = await fixture(db); const reviewer = await operator(db); const viewer = await connect(); const remover = await connect();
      await viewer.query('begin');
      try {
        const granted = await lease(viewer, f);
        const pending = moderate(remover, reviewer, f.post, 'takedown').then(result => ({ result }), error => ({ error }));
        await waitForBlock(db, remover, viewer);
        await viewer.query('commit');
        assert.equal((await pending).result.status, 'taken_down');
        await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId]), 'unavailable');
        assert.equal((await value(db, 'select peekalo_preview($1) as value', [f.hash])).available, false);
        assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), f.identity);
        assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 2000);
      } finally { await viewer.query('rollback'); }
    });

    await t.test('post reports require known authorized relationships or a link, are non-consuming and urgent duplicates escalate', async () => {
      const f = await fixture(db); const reviewer = await operator(db); const guest = `g:${randomUUID()}`;
      const report = (identity, kind, reason, post, username, hash) => value(db, 'select peekalo_report($1,$2,$3,$4,$5,$6,$7) as value', [identity, kind, reason, 'Generated test feedback', post, username, hash]);
      await failure(() => report(guest, 'post', 'other', f.post, null, null), 'unavailable');
      await failure(() => report(`a:${f.stranger}`, 'post', 'other', f.post, null, null), 'unavailable');
      await failure(() => report(null, 'account', 'other', null, f.username, null), 'unauthorized');
      await failure(() => report(f.identity, 'message', 'other', randomUUID(), null, null), 'conflict');
      await failure(() => report(f.identity, 'comment', 'other', randomUUID(), null, null), 'conflict');
      const first = await report(guest, 'post', 'spam', null, null, f.hash);
      assert.deepEqual(await report(guest, 'post', 'child_safety', null, null, f.hash), first);
      assert.equal(await value(db, 'select reason as value from peekalo_reports where id=$1', [first.reportId]), 'child_safety');
      assert.equal(await value(db, 'select claimed_identity as value from peekalo_links where id=$1', [f.link]), null);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_budgets where post_id=$1', [f.post]), 0);
      assert.equal((await report(guest, 'account', 'harassment', null, f.username, null)).state, 'open');
      const queue = await value(db, 'select peekalo_moderation_queue($1) as value', [reviewer]);
      assert.equal(queue.reports.find(item => item.reportId === first.reportId).username, `test_${f.owner.replaceAll('-', '').slice(0, 16)}`);
      assert.equal(JSON.stringify(queue).includes(f.hash), false);
      assert.equal(JSON.stringify(queue).includes(guest), false);
      await failure(() => value(db, 'select peekalo_resolve_report($1,$2,$3) as value', [f.stranger, first.reportId, 'Unauthorized']), 'forbidden');
      assert.equal((await value(db, 'select peekalo_resolve_report($1,$2,$3,$4) as value', [reviewer, first.reportId, 'Reviewed and referred through the safety response process', 'resolved'])).state, 'resolved');
      assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [f.post]), 'ready');
    });

    await t.test('concurrent reports enforce the per-identity hourly cap atomically, while repeat open targets coalesce', async () => {
      const f = await fixture(db); const guest = `g:${randomUUID()}`;
      const targets = [];
      for (let i = 0; i < 12; i++) targets.push(await fixture(db));
      const workers = await Promise.all(targets.map(() => connect()));
      const outcomes = await Promise.allSettled(workers.map((client, i) => value(client, 'select peekalo_report($1,$2,$3,$4,null,$5) as value', [guest, 'account', 'spam', 'Generated test feedback', targets[i].username])));
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 10);
      assert(outcomes.filter(item => item.status === 'rejected').every(item => item.reason.message === 'rate_limited'));
      const reported = outcomes.findIndex(item => item.status === 'fulfilled');
      const first = outcomes[reported].value;
      assert.deepEqual(await value(db, 'select peekalo_report($1,$2,$3,$4,null,$5) as value', [guest, 'account', 'spam', 'Repeat', targets[reported].username]), first);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_reports where reporter_identity=$1', [guest]), 10);
      assert.equal((await value(db, 'select peekalo_own_posts($1) as value', [f.owner])).activeCount, 1);
    });

    await t.test('operator queue, original-media access, decisions and report dispositions require active membership and are audited', async () => {
      const f = await fixture(db); const reviewer = await operator(db);
      await db.query("update peekalo_posts set status='moderation_pending' where id=$1", [f.post]);
      for (const call of [
        () => value(db, 'select peekalo_moderation_queue($1) as value', [f.owner]),
        () => value(db, 'select peekalo_moderation_media($1,$2) as value', [f.owner, f.post]),
        () => moderate(db, f.owner, f.post),
        () => value(db, 'select peekalo_moderation_audit($1) as value', [f.owner]),
      ]) await failure(call, 'forbidden');
      const queue = await value(db, 'select peekalo_moderation_queue($1) as value', [reviewer]);
      assert.equal(queue.posts.some(item => item.postId === f.post), true);
      assert.equal(JSON.stringify(queue).includes('fixture.jpg'), false);
      assert.deepEqual(await value(db, 'select peekalo_moderation_media($1,$2) as value', [reviewer, f.post]), { kind: 'photo', path: 'test-only/fixture.jpg' });
      await moderate(db, reviewer, f.post, 'reject');
      const report = await value(db, 'select peekalo_report($1,$2,$3,$4,null,$5) as value', [`g:${randomUUID()}`, 'account', 'other', 'Generated', f.username]);
      await value(db, 'select peekalo_resolve_report($1,$2,$3,$4) as value', [reviewer, report.reportId, 'No violation in generated fixture', 'dismissed']);
      const audit = await value(db, 'select peekalo_moderation_audit($1) as value', [reviewer]);
      for (const event of ['queue_read', 'media_read', 'reject', 'report_dismissed', 'audit_read']) assert(audit.items.some(item => item.operatorId === reviewer && item.event === event));
      assert(audit.items.some(item => item.event === 'operator_membership' && item.targetId === reviewer));
      assert.equal(JSON.stringify(audit).includes('fixture.jpg'), false);
      await db.query('update peekalo_operators set enabled=false where account_id=$1', [reviewer]);
      await failure(() => value(db, 'select peekalo_moderation_media($1,$2) as value', [reviewer, f.post]), 'forbidden');
      await failure(() => moderate(db, reviewer, f.post, 'takedown'), 'forbidden');
    });

    await t.test('account suspension hides all public and guest delivery, revokes outgoing/incoming rights, and blocks uploads', async () => {
      const f = await fixture(db); const reviewer = await operator(db); await accept(db, f);
      const ownerName = `test_${f.owner.replaceAll('-', '').slice(0, 16)}`;
      const granted = await lease(db, f);
      assert.equal((await value(db, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [reviewer, ownerName, 'suspend', 'Fixture safety suspension'])).state, 'suspended');
      assert.equal((await value(db, 'select peekalo_preview($1) as value', [f.hash])).available, false);
      await failure(() => value(db, 'select peekalo_public_profile($1) as value', [ownerName]), 'unavailable');
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId]), 'unavailable');
      await failure(() => value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner, randomUUID(), 'photo']), 'suspended');
      assert.equal((await value(db, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [reviewer, ownerName, 'restore', 'Fixture appeal reviewed'])).state, 'active');
      await failure(() => lease(db, f, { hash: null, post: f.post }), 'unavailable');
      await failure(() => lease(db, f), 'unavailable');
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 2000);
    });

    await t.test('suspending an account revokes claimed links even without a direct recipient grant', async () => {
      const f = await fixture(db); const reviewer = await operator(db);
      const granted = await lease(db, f);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_grants where post_id=$1', [f.post]), 0);
      await value(db, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [reviewer, f.username, 'suspend', 'Fixture account review']);
      assert.equal(await value(db, 'select revoked as value from peekalo_links where id=$1', [f.link]), true);
      await value(db, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [reviewer, f.username, 'restore', 'Fixture appeal']);
      await failure(() => lease(db, f), 'unavailable');
      await failure(() => value(db, 'select peekalo_media($1,$2) as value', [f.identity, granted.leaseId]), 'unavailable');
      assert.equal(await value(db, 'select spent_ms as value from peekalo_budgets where post_id=$1', [f.post]), 2000);
    });

    await t.test('operator access revocation waits for an authorized decision then prevents subsequent reads and actions', async () => {
      const f = await fixture(db); const reviewer = await operator(db); const actor = await connect(); const admin = await connect();
      await actor.query('begin');
      try {
        await value(actor, 'select peekalo_moderation_queue($1) as value', [reviewer]);
        const disable = admin.query('update peekalo_operators set enabled=false where account_id=$1', [reviewer]).then(result => ({ result }), error => ({ error }));
        await waitForBlock(db, admin, actor);
        await actor.query('commit');
        assert.equal((await disable).result.rowCount, 1);
        await failure(() => moderate(db, reviewer, f.post, 'takedown'), 'forbidden');
        await failure(() => value(db, 'select peekalo_moderation_queue($1) as value', [reviewer]), 'forbidden');
        const otherOperator = await operator(db);
        await value(db, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [otherOperator, await value(db, 'select username as value from peekalo_profiles where id=$1', [reviewer]), 'suspend', 'Fixture safety suspension']);
        await db.query('update peekalo_operators set enabled=true where account_id=$1', [reviewer]);
        await failure(() => value(db, 'select peekalo_moderation_queue($1) as value', [reviewer]), 'forbidden');
      } finally { await actor.query('rollback'); }
    });

    await t.test('concurrent owner link and recipient controls retain one post-first lock without upgrade deadlocks', async () => {
      const f = await fixture(db); const workers = await Promise.all(Array.from({ length: 6 }, () => connect()));
      const controls = await Promise.all(workers.map((client, i) => i % 2
        ? value(client, 'select peekalo_grant($1,$2,$3) as value', [f.owner, f.post, f.username])
        : value(client, 'select to_jsonb(peekalo_create_link($1,$2,$3,$4)) as value', [f.owner, f.post, randomUUID(), `test-only-${randomUUID()}`])));
      assert(controls.filter((_, i) => i % 2).every(state => state === 'pending'));
      assert(controls.filter((_, i) => !(i % 2)).every(link => link.id === f.link));
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_grants where post_id=$1', [f.post]), 1);
    });

    await t.test('unreviewed renamed usernames stay private while stable IDs retain block, report and revoke controls', async () => {
      const f = await fixture(db); await accept(db, f);
      const reviewer = await operator(db); const hiddenName = `pending_${f.recipient.replaceAll('-', '').slice(0, 12)}`;
      await value(db, 'select peekalo_block($1,$2,true) as value', [f.owner, f.username]);
      await value(db, 'select peekalo_save_profile($1,$2) as value', [f.recipient, hiddenName]);
      const inventory = await value(db, 'select peekalo_own_posts($1) as value', [f.owner]);
      assert.deepEqual(inventory.items[0].recipients, [{ accountId: f.recipient, username: null, requestState: 'accepted', revoked: true }]);
      const blocked = await value(db, 'select peekalo_blocks($1) as value', [f.owner]);
      assert.equal(blocked.items[0].accountId, f.recipient); assert.equal(blocked.items[0].username, null);
      assert.equal(JSON.stringify([inventory, blocked]).includes(hiddenName), false);
      await failure(() => value(db, 'select peekalo_block($1,$2,true) as value', [f.stranger, hiddenName]), 'recipient');
      await failure(() => value(db, 'select peekalo_report($1,$2,$3,$4,null,$5) as value', [`g:${randomUUID()}`, 'account', 'other', '', hiddenName]), 'unavailable');
      await failure(() => value(db, 'select peekalo_report($1,$2,$3,$4,null,null,null,$5) as value', [`g:${randomUUID()}`, 'account', 'other', '', f.recipient]), 'unauthorized');
      const report = await value(db, 'select peekalo_report($1,$2,$3,$4,null,null,null,$5) as value', [`a:${f.owner}`, 'account', 'harassment', 'Known account concern', f.recipient]);
      assert.ok(report.reportId);
      await value(db, 'select peekalo_moderate_profile($1,$2,$3,$4) as value', [reviewer, hiddenName, 'reject', 'Generated rejected name']);
      assert.equal((await value(db, 'select peekalo_blocks($1) as value', [f.owner])).items[0].username, null);
      await value(db, 'select peekalo_block($1,null,false,$2) as value', [f.owner, f.recipient]);
      assert.deepEqual((await value(db, 'select peekalo_blocks($1) as value', [f.owner])).items, []);
      await value(db, 'select peekalo_block($1,null,true,$2) as value', [f.owner, f.recipient]);
      assert.equal((await value(db, 'select peekalo_blocks($1) as value', [f.owner])).items[0].accountId, f.recipient);
      await failure(() => value(db, 'select peekalo_block($1,$2,true,$3) as value', [f.owner, hiddenName, f.recipient]), 'conflict');
      await failure(() => value(db, 'select peekalo_revoke_recipient($1,$2,$3) as value', [f.stranger, f.post, f.recipient]), 'unavailable');
      assert.equal(await value(db, 'select peekalo_revoke_recipient($1,$2,$3) as value', [f.owner, f.post, f.recipient]), true);
      assert.equal(await value(db, 'select revoked as value from peekalo_grants where post_id=$1 and recipient_id=$2', [f.post, f.recipient]), true);
    });

    await t.test('Inbox and grant responses pin account IDs while later username reuse cannot redirect revocation', async () => {
      const f = await fixture(db);
      assert.deepEqual(await value(db, 'select peekalo_grant_target($1,$2,$3) as value', [f.owner, f.post, f.username]), { requestState: 'pending', accountId: f.recipient });
      const inbox = await value(db, 'select peekalo_inbox($1) as value', [f.recipient]);
      assert.equal(inbox.items[0].senderAccountId, f.owner);
      await value(db, 'select peekalo_save_profile($1,$2) as value', [f.recipient, `new_${f.recipient.replaceAll('-', '').slice(0, 16)}`]);
      await value(db, 'select peekalo_save_profile($1,$2) as value', [f.stranger, f.username]);
      const reviewer = await operator(db);
      await value(db, 'select peekalo_moderate_profile($1,$2,$3,$4) as value', [reviewer, f.username, 'approve', 'Reused fixture name reviewed']);
      assert.equal((await value(db, 'select peekalo_grant_target($1,$2,$3) as value', [f.owner, f.post, f.username])).accountId, f.stranger);
      await value(db, 'select peekalo_revoke_recipient($1,$2,$3) as value', [f.owner, f.post, f.recipient]);
      assert.equal(await value(db, 'select revoked as value from peekalo_grants where post_id=$1 and recipient_id=$2', [f.post, f.recipient]), true);
      assert.equal(await value(db, 'select revoked as value from peekalo_grants where post_id=$1 and recipient_id=$2', [f.post, f.stranger]), false);
    });

    await t.test('grant target locks the approved username until the granted ID is returned', async () => {
      const f = await fixture(db); const grantor = await connect(); const renamer = await connect();
      await grantor.query('begin');
      try {
        const result = await value(grantor, 'select peekalo_grant_target($1,$2,$3) as value', [f.owner, f.post, f.username]);
        assert.equal(result.accountId, f.recipient);
        const rename = value(renamer, 'select peekalo_save_profile($1,$2) as value', [f.recipient, `new_${f.recipient.replaceAll('-', '').slice(0, 16)}`]).then(result => ({ result }), error => ({ error }));
        await waitForBlock(db, renamer, grantor);
        await grantor.query('commit');
        assert.equal((await rename).result.reviewState, 'pending');
        assert.equal(await value(db, 'select recipient_id as value from peekalo_grants where post_id=$1', [f.post]), f.recipient);
      } finally { await grantor.query('rollback'); }
    });

    for (const action of ['queue', 'media', 'audit', 'decision', 'report', 'profile', 'account']) {
      await t.test(`operator suspension committed while ${action} waits for safety barrier prevents its operation`, async () => {
        const f = await fixture(db); const reviewer = await operator(db); const admin = await operator(db);
        const operatorName = await value(db, 'select username as value from peekalo_profiles where id=$1', [reviewer]);
        const report = await value(db, 'select peekalo_report($1,$2,$3,$4,null,$5) as value', [f.identity, 'account', 'spam', 'Generated', f.username]);
        const blocker = await connect(); const actor = await connect();
        const call = () => {
          if (action === 'queue') return value(actor, 'select peekalo_moderation_queue($1) as value', [reviewer]);
          if (action === 'media') return value(actor, 'select peekalo_moderation_media($1,$2) as value', [reviewer, f.post]);
          if (action === 'audit') return value(actor, 'select peekalo_moderation_audit($1) as value', [reviewer]);
          if (action === 'decision') return moderate(actor, reviewer, f.post, 'takedown');
          if (action === 'report') return value(actor, 'select peekalo_resolve_report($1,$2,$3) as value', [reviewer, report.reportId, 'Generated resolution']);
          if (action === 'profile') return value(actor, 'select peekalo_moderate_profile($1,$2,$3,$4) as value', [reviewer, f.username, 'reject', 'Generated decision']);
          return value(actor, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [reviewer, f.username, 'suspend', 'Generated suspension']);
        };
        await blocker.query('begin');
        try {
          await blocker.query('select pg_advisory_xact_lock(730293001)');
          const pending = call().then(result => ({ result }), error => ({ error }));
          await waitForBlock(db, actor, blocker);
          await value(blocker, 'select peekalo_moderate_account($1,$2,$3,$4) as value', [admin, operatorName, 'suspend', 'Operator access withdrawn']);
          await blocker.query('commit');
          assert.equal((await pending).error?.message, 'forbidden');
          assert.equal(await value(db, 'select status as value from peekalo_posts where id=$1', [f.post]), 'ready');
          assert.equal(await value(db, 'select review_state as value from peekalo_profiles where id=$1', [f.recipient]), 'approved');
          assert.equal(await value(db, 'select state as value from peekalo_reports where id=$1', [report.reportId]), 'open');
          assert.equal(await value(db, 'select count(*)::integer as value from peekalo_suspended_accounts where account_id=$1', [f.recipient]), 0);
          assert.equal(await value(db, 'select count(*)::integer as value from peekalo_safety_audit where operator_id=$1', [reviewer]), 0);
        } finally { await blocker.query('rollback'); }
      });
    }

    await t.test('account deletion disables access atomically, keeps stable request and fences late publication', async () => {
      const f = await fixture(db); await accept(db, f);
      const held = await lease(db, f);
      const key = randomUUID(); const reservation = await value(db, 'select peekalo_reserve_post($1,$2,$3) as value', [f.owner,key,'photo']);
      const path = `${f.owner}/${reservation.id}/${reservation.upload_attempt}.jpg`;
      const started = await value(db, 'select peekalo_storage_writer($1,$2,true) as value', [f.owner,reservation.upload_attempt]); assert.equal(started,true);
      const job = await value(db, 'select peekalo_begin_deletion($1) as value', [f.owner]);
      assert.deepEqual(await value(db, 'select peekalo_begin_deletion($1) as value', [f.owner]),job);
      assert.equal(await value(db, 'select peekalo_account_access($1) as value', [f.owner]),false);
      assert.equal(await value(db, 'select count(*)::integer as value from peekalo_profiles where id=$1',[f.owner]),0);
      await failure(() => lease(db,f),'unavailable');
      await failure(() => value(db,'select peekalo_media($1,$2) as value',[f.identity,held.leaseId]),'unavailable');
      await failure(() => value(db,'select peekalo_reserve_post($1,$2,$3) as value',[f.owner,randomUUID(),'photo']),'account_deleting');
      await failure(() => value(db,'select peekalo_save_profile($1,$2) as value',[f.owner,'cannot_return']),'account_deleting');
      assert.equal(await value(db,'select peekalo_finish_upload($1,$2,$3,$4) as value',[f.owner,reservation.id,reservation.upload_attempt,path]),false);
      assert.equal(await value(db,'select peekalo_storage_writer($1,$2,true) as value',[f.owner,randomUUID()]),false);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),false);
      assert(!(await value(db,'select peekalo_deletion_jobs(50) as value')).some(item=>item.requestId===job.requestId),'Grace blocks cleanup admission');
      await db.query("update peekalo_account_deletions set requested_at=clock_timestamp()-interval '11 minutes',not_before=clock_timestamp()-interval '1 minute' where request_id=$1",[job.requestId]);
      assert((await value(db,'select peekalo_deletion_jobs(50) as value')).find(item=>item.requestId===job.requestId).writersPending);
      assert.equal(await value(db,'select peekalo_storage_writer($1,$2,false) as value',[f.owner,reservation.upload_attempt]),true);
    });

    await t.test('deleting a viewer preserves other owners and anonymizes claimed links and spent budgets', async () => {
      const f=await fixture(db); await accept(db,f); const held=await lease(db,f);
      const other=await fixture(db); await lease(db,other,{identity:`g:${randomUUID()}`});
      await value(db,"select peekalo_accept_policy($1,'2026-10-29-draft','2026-10-29-draft') as value",[f.recipient]);
      const report=await value(db,"select peekalo_report($1,'post','privacy','synthetic report',$2) as value",[f.identity,f.post]);
      const reviewer=await operator(db);
      await value(db,"select peekalo_resolve_report($1,$2,'Synthetic private resolution') as value",[reviewer,report.reportId]);
      const job=await value(db,'select peekalo_begin_deletion($1) as value',[f.recipient]);
      assert.equal(await value(db,'select note as value from peekalo_safety_audit where target_id=$1 order by id desc limit 1',[report.reportId]),null,'Duplicated resolution audit note is scrubbed too');
      await db.query("update peekalo_account_deletions set requested_at=clock_timestamp()-interval '11 minutes',not_before=clock_timestamp()-interval '1 minute' where request_id=$1",[job.requestId]);
      await failure(()=>value(db,'select peekalo_media($1,$2) as value',[f.identity,held.leaseId]),'unavailable');
      assert.equal(await value(db,'select status as value from peekalo_posts where id=$1',[f.post]),'ready');
      assert.equal(await value(db,'select details as value from peekalo_reports where id=$1',[report.reportId]),'');
      assert.equal(await value(db,"select peekalo_deletion_progress($1,'storage_verified') as value",[job.requestId]),true);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),false,'Auth removal required');
      await db.query('delete from auth.users where id=$1',[f.recipient]);
      assert.equal(await value(db,"select peekalo_deletion_progress($1,'auth_deleted') as value",[job.requestId]),true);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),true);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),true,'Idempotent completion');
      const link=(await db.query('select revoked,claimed_identity from peekalo_links where id=$1',[f.link])).rows[0];
      assert.equal(link.revoked,true); assert.match(link.claimed_identity,/^g:/); assert.notEqual(link.claimed_identity,f.identity);
      assert.equal(await value(db,'select spent_ms as value from peekalo_budgets where post_id=$1',[f.post]),2000);
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_policy_acceptances where account_id=$1',[f.recipient]),0);
      await failure(()=>lease(db,f,{identity:`a:${f.stranger}`}), 'unavailable');
      assert.equal(await value(db,'select status as value from peekalo_posts where id=$1',[other.post]),'ready');
      assert.equal(await value(db,'select spent_ms as value from peekalo_budgets where post_id=$1',[other.post]),2000);
    });

    await t.test('deletion waits for an in-flight authorization transaction before revoking it', async () => {
      const f=await fixture(db); const viewer=await connect(), deleter=await connect();
      await viewer.query('begin'); const held=await lease(viewer,f);
      const deletion=value(deleter,'select peekalo_begin_deletion($1) as value',[f.owner]);
      await waitForBlock(db,deleter,viewer);
      await viewer.query('commit'); const job=await deletion;
      assert.equal(job.status,'pending');
      await failure(()=>value(db,'select peekalo_media($1,$2) as value',[f.identity,held.leaseId]),'unavailable');
    });

    await t.test('queued safety writes recheck disabling after the deletion transaction commits', async () => {
      const f=await fixture(db), blocker=await connect(), reporter=await connect(), blocking=await connect();
      await blocker.query('begin'); await value(blocker,'select peekalo_begin_deletion($1) as value',[f.recipient]);
      const report=value(reporter,"select peekalo_report($1,'post','privacy','must not survive',$2) as value",[f.identity,f.post]);
      const block=value(blocking,'select peekalo_block($1,null,true,$2) as value',[f.recipient,f.owner]);
      const deniedReport=failure(()=>report,'account_deleting'),deniedBlock=failure(()=>block,'account_deleting');
      await waitForBlock(db,reporter,blocker); await waitForBlock(db,blocking,blocker);
      await blocker.query('commit'); await Promise.all([deniedReport,deniedBlock]);
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_reports where reporter_identity=$1',[f.identity]),0);
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_blocks where blocker_id=$1',[f.recipient]),0);
    });

    await t.test('policy versions are idempotent, deletion accessible without acceptance, and Apple cannot falsely complete', async () => {
      const f=await fixture(db);
      assert.equal((await value(db,"select peekalo_policy_status($1,'2026-10-29-draft','2026-10-29-draft') as value",[f.owner])).accepted,false);
      await failure(()=>value(db,"select peekalo_accept_policy($1,'old','old') as value",[f.owner]),'conflict');
      for(let i=0;i<2;i++) assert.deepEqual(await value(db,"select peekalo_accept_policy($1,'2026-10-29-draft','2026-10-29-draft') as value",[f.owner]),{accepted:true});
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_policy_acceptances where account_id=$1',[f.owner]),1);
      const job=await value(db,'select peekalo_begin_deletion($1,true) as value',[f.owner]);
      await failure(()=>value(db,"select peekalo_accept_policy($1,'2026-10-29-draft','2026-10-29-draft') as value",[f.owner]),'account_deleting');
      await db.query("update peekalo_account_deletions set requested_at=clock_timestamp()-interval '11 minutes',not_before=clock_timestamp()-interval '1 minute' where request_id=$1",[job.requestId]);
      await value(db,"select peekalo_deletion_progress($1,'storage_verified') as value",[job.requestId]);
      await db.query('delete from auth.users where id=$1',[f.owner]);
      await value(db,"select peekalo_deletion_progress($1,'auth_deleted') as value",[job.requestId]);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),false);
      assert((await value(db,'select peekalo_deletion_status($1) as value',[job.requestId])).needsAppleReauthentication);
      await value(db,"select peekalo_deletion_progress($1,'provider_revoked',repeat('b',64)) as value",[job.requestId]);
      await value(db,"select peekalo_deletion_progress($1,'provider_required',repeat('a',64)) as value",[job.requestId]);
      assert((await value(db,'select peekalo_deletion_status($1) as value',[job.requestId])).needsAppleReauthentication,'Changed provider subject invalidates old revocation evidence');
      await value(db,"select peekalo_deletion_progress($1,'provider_revoked',repeat('a',64)) as value",[job.requestId]);
      await value(db,"select peekalo_deletion_progress($1,'provider_required',repeat('a',64)) as value",[job.requestId]);
      assert.equal((await value(db,'select peekalo_deletion_status($1) as value',[job.requestId])).needsAppleReauthentication,false,'Stale snapshot cannot clear fresh matching revocation');
      await value(db,"select peekalo_deletion_progress($1,'provider_revoked',repeat('a',64)) as value",[job.requestId]);
      assert.equal(await value(db,'select peekalo_complete_deletion($1) as value',[job.requestId]),true);
    });

    await t.test('retention expires bounded safety text and complete receipts only after a recent successful sweep', async () => {
      const f=await fixture(db); const reviewer=await operator(db);
      const report=await value(db,"select peekalo_report($1,'account','other','synthetic report',null,null,null,$2) as value",[f.identity,f.owner]);
      await db.query("update peekalo_reports set created_at=clock_timestamp()-interval '91 days' where id=$1",[report.reportId]);
      await db.query("insert into peekalo_safety_audit(operator_id,event,note,created_at) values($1,'retention_fixture','synthetic',clock_timestamp()-interval '91 days')",[reviewer]);
      const job=await value(db,'select peekalo_begin_deletion($1) as value',[f.owner]);
      await db.query("update peekalo_account_deletions set requested_at=clock_timestamp()-interval '32 days',not_before=clock_timestamp()-interval '31 days',state='complete',completed_at=clock_timestamp()-interval '31 days',storage_verified_at=clock_timestamp()-interval '2 days' where request_id=$1",[job.requestId]);
      await db.query('delete from auth.users where id=$1',[f.owner]);
      const expired=await value(db,'select peekalo_expire_private_records() as value'); assert(expired.reports>=1);assert(expired.audits>=1);
      assert.equal(await value(db,'select peekalo_deletion_status($1) as value',[job.requestId]),null,'Public receipt expires after 30 days');
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_account_deletions where request_id=$1',[job.requestId]),1,'Stale sweep cannot purge suppression journal');
      await value(db,"select peekalo_deletion_progress($1,'storage_verified') as value",[job.requestId]);
      await value(db,"select peekalo_deletion_progress($1,'failed','storage_failed') as value",[job.requestId]);
      await value(db,'select peekalo_expire_private_records() as value'); assert.equal(await value(db,'select count(*)::integer as value from peekalo_account_deletions where request_id=$1',[job.requestId]),1);
      assert((await value(db,'select peekalo_deletion_jobs(50) as value')).some(item=>item.requestId===job.requestId),'Failed complete sweep remains retryable');
      await value(db,"select peekalo_deletion_progress($1,'storage_verified') as value",[job.requestId]);
      await value(db,'select peekalo_expire_private_records() as value');
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_account_deletions where request_id=$1',[job.requestId]),1,'Backup inventory must be reconciled before suppression can expire');
      assert.equal(await value(db,"select peekalo_reconcile_deletion_backups($1,clock_timestamp()-interval '40 days') as value",[job.requestId]),false);
      assert.equal(await value(db,"select peekalo_reconcile_deletion_backups($1,clock_timestamp()-interval '31 days 12 hours') as value",[job.requestId]),false,'Request timestamp alone cannot prove a committed backup guard');
      assert.equal(await value(db,"select peekalo_reconcile_deletion_backups($1,clock_timestamp()-interval '1 day') as value",[job.requestId]),true);
      await value(db,'select peekalo_expire_private_records() as value');
      assert.equal(await value(db,'select count(*)::integer as value from peekalo_account_deletions where request_id=$1',[job.requestId]),0);
      assert.equal(await value(db,'select peekalo_account_access($1) as value',[f.owner]),false,'Erased Auth identity remains unavailable after receipt expiry');
    });

    await t.test('public client roles cannot read ledger tables or call privileged functions', async () => {
      const f = await fixture(db);
      const tables = ['profiles', 'posts', 'links', 'link_requests', 'grants', 'budgets', 'leases', 'operators', 'blocks', 'reports', 'safety_audit', 'suspended_accounts', 'account_deletions', 'policy_acceptances', 'storage_writers'];
      const calls = [
        ['peekalo_begin_deletion($1)', [f.owner]],
        ['peekalo_deletion_status($1)', [randomUUID()]],
        ['peekalo_deletion_jobs(1)', []],
        ['peekalo_complete_deletion($1)', [randomUUID()]],
        ['peekalo_expire_private_records()', []],
        ['peekalo_reconcile_deletion_backups($1,clock_timestamp())', [randomUUID()]],
        ['peekalo_storage_writer($1,$2,true)', [f.owner,randomUUID()]],
        ['peekalo_policy_status($1,$2,$3)', [f.owner,'fixture','fixture']],
        ['peekalo_save_profile($1,$2)', [f.owner, f.username]],
        ['peekalo_lookup_profile($1,$2)', [f.owner, f.username]],
        ['peekalo_block($1,$2,true)', [f.owner, f.username]],
        ['peekalo_grant_target($1,$2,$3)', [f.owner, f.post, f.username]],
        ['peekalo_revoke_recipient($1,$2,$3)', [f.owner, f.post, f.recipient]],
        ['peekalo_blocks($1)', [f.owner]],
        ['peekalo_report($1,$2,$3)', [f.identity, 'account', 'other']],
        ['peekalo_moderation_queue($1)', [f.owner]],
        ['peekalo_moderation_media($1,$2)', [f.owner, f.post]],
        ['peekalo_moderate($1,$2,$3,$4)', [f.owner, f.post, 'approve', 'Fixture']],
        ['peekalo_moderate_profile($1,$2,$3,$4)', [f.owner, f.username, 'approve', 'Fixture']],
        ['peekalo_moderate_account($1,$2,$3,$4)', [f.owner, f.username, 'suspend', 'Fixture']],
        ['peekalo_resolve_report($1,$2,$3)', [f.owner, randomUUID(), 'Fixture']],
        ['peekalo_moderation_audit($1)', [f.owner]],
        ['peekalo_preview($1)', [f.hash]],
        ['peekalo_own_posts($1)', [f.owner]],
        ['peekalo_public_profile($1)', [f.username]],
        ['peekalo_inbox($1)', [f.recipient]],
        ['peekalo_view_status($1,$2,$3)', [f.identity, f.hash, null]],
        ['peekalo_delete_post($1,$2)', [f.owner, f.post]],
        ['peekalo_post_deleted($1,$2)', [f.owner, f.post]],
        ['peekalo_finish_delete($1,$2,$3)', [f.owner, f.post, 'test-only/fixture.jpg']],
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
      await assert.rejects(() => value(client,'select peekalo_reconcile_deletion_backups($1,clock_timestamp()) as value',[randomUUID()]), { code: '42501' });
      await assert.rejects(() => value(client, 'select peekalo_lease_before_safety($1,$2,$3,$4) as value', [f.identity, randomUUID(), randomUUID(), f.hash]), { code: '42501' });
      await assert.rejects(() => client.query("insert into peekalo_operators(account_id) values($1)", [f.owner]), { code: '42501' });
      await assert.rejects(() => client.query("update peekalo_profiles set review_state='approved' where id=$1", [f.owner]), { code: '42501' });
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
