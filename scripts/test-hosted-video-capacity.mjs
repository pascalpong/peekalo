/** Opt-in development observation, never a load benchmark.
 * Load env explicitly, then set PEEKALO_TEST_BASE_URL and
 * PEEKALO_TEST_VIDEO_CAPACITY=1. Uses generated media and new .invalid users.
 * No real capture, existing account, private media or quota is exercised.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const users = [], attempts = [], pending = [];
const runId = randomUUID();
let db, base, origin, dir;
let phase = 'configuration';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = value => console.log(JSON.stringify(value));
const options = { auth: { persistSession: false, autoRefreshToken: false }, global: {
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]) }),
} };

async function call(route, { token, form, key, timeout = 30_000, method = 'POST' } = {}) {
  const response = await fetch(base + route, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: form, signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function provision(suffix) {
  const email = `test_capacity_${runId.replaceAll('-', '').slice(0, 16)}_${suffix}@example.invalid`;
  const password = randomUUID() + 'aA1!';
  const user = { email, id: null };
  // Keep a recovery record even when a provisioning reply is uncertain.
  users.push(user);
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data?.user?.id) user.id = created.data.user.id;
  assert(!created.error && user.id, 'Temporary account creation failed');
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert(!signedIn.error && signedIn.data.session, 'Temporary account login failed');
  return { ...user, token: signedIn.data.session.access_token };
}

function upload(user, bytes, key) {
  const attempt = { owner: user.id, key, settled: false, uncertain: true, result: null, elapsedMs: null };
  attempts.push(attempt);
  const form = new FormData();
  form.set('kind', 'video');
  form.set('file', new Blob([bytes], { type: 'video/mp4' }), 'generated-ten-second-pattern.mp4');
  const started = performance.now();
  const promise = call('/api/posts', { token: user.token, key, form, timeout: 150_000 }).then(result => {
    attempt.result = result;
    // 5xx can lose publication/failure replies. Reconcile them as uncertain.
    attempt.uncertain = result.status >= 500;
    return result;
  }).finally(() => { attempt.settled = true; attempt.elapsedMs = Math.round(performance.now() - started); });
  // Attach a rejection handler immediately; cleanup waits for every sibling.
  pending.push(promise.catch(() => null));
  return { attempt, promise };
}

async function postFor(attempt) {
  const result = await db.from('peekalo_posts').select('id,status,storage_path').eq('owner_id', attempt.owner).eq('upload_key', attempt.key).maybeSingle();
  assert(!result.error, 'Scoped upload state unavailable');
  return result.data;
}

async function readyEvidence(attempt, response) {
  assert(response.status === 200 && response.data.status === 'ready', 'Generated video did not become ready');
  const post = await postFor(attempt);
  assert(post?.status === 'ready' && post.id === response.data.postId && post.storage_path?.startsWith(attempt.owner + '/'), 'Ready publication mismatch');
  const info = await db.storage.from('peekalo-captures').info(post.storage_path);
  const bytes = info.data?.size ?? info.data?.metadata?.size;
  assert(!info.error && Number.isSafeInteger(bytes) && bytes > 0 && bytes < 30_000_000, 'Private normalized size unavailable');
  return { status: response.status, elapsedMs: attempt.elapsedMs, outputBytes: bytes };
}

async function scopedObjects(owner) {
  assert(users.some(user => user.id === owner), 'Cleanup owner was not created by this run');
  const objects = [];
  let visited = 0;
  async function visit(prefix, depth) {
    assert(depth <= 5, 'Cleanup depth exceeded');
    const result = await db.storage.from('peekalo-captures').list(prefix, { limit: 100 });
    assert(!result.error && result.data.length < 100, 'Cleanup listing unavailable or unexpectedly large');
    for (const entry of result.data) {
      assert(++visited <= 100 && entry.name && !/[\\/]/.test(entry.name) && !['.', '..'].includes(entry.name), 'Unsafe cleanup object');
      const name = prefix + '/' + entry.name;
      if (entry.id === null) await visit(name, depth + 1);
      else { assert(typeof entry.id === 'string', 'Unknown cleanup object'); objects.push(name); }
    }
  }
  await visit(owner, 0);
  return objects;
}

async function settleServerWork(owner) {
  const owned = attempts.filter(attempt => attempt.owner === owner);
  const deadline = performance.now() + 180_000;
  do {
    const states = await Promise.all(owned.map(postFor));
    // A lost response with no observed row is not permission to delete an
    // account while server work might still publish. Preserve it for recovery.
    const safe = states.every((post, index) => post?.status !== 'uploading' && (!owned[index].uncertain || ['ready', 'failed'].includes(post?.status)));
    if (safe) { await pause(1_000); return true; }
    await pause(1_000);
  } while (performance.now() < deadline);
  return false;
}

async function cleanup() {
  await Promise.allSettled(pending);
  const preserved = [];
  for (const user of users) {
    try {
      assert(user.id && await settleServerWork(user.id), 'Uncertain server work');
      const objects = await scopedObjects(user.id);
      if (objects.length) {
        const removed = await db.storage.from('peekalo-captures').remove(objects);
        assert(!removed.error, 'Storage cleanup failed');
      }
      assert((await scopedObjects(user.id)).length === 0, 'Storage cleanup incomplete');
      const deleted = await db.auth.admin.deleteUser(user.id);
      assert(!deleted.error, 'Account cleanup failed');
      const posts = await db.from('peekalo_posts').select('id', { count: 'exact', head: true }).eq('owner_id', user.id);
      assert(!posts.error && posts.count === 0, 'Cascaded row cleanup incomplete');
    } catch { preserved.push({ email: user.email, owner: user.id, uploads: attempts.filter(attempt => attempt.owner === user.id).map(attempt => ({ key: attempt.key, uncertain: attempt.uncertain })) }); }
  }
  if (preserved.length) {
    await mkdir('.cache/private', { recursive: true, mode: 0o700 });
    await writeFile(`.cache/private/video-capacity-recovery-${runId}.json`, JSON.stringify({ generatedOnly: true, users: preserved }), { mode: 0o600 });
    process.exitCode = 1;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  report({ cleanupStatus: preserved.length ? 'preserved_uncertain_for_scoped_recovery' : 'complete' });
}

try {
  assert(process.env.PEEKALO_TEST_VIDEO_CAPACITY === '1', 'Set the explicit development test opt-in');
  assert(process.env.PEEKALO_TEST_BASE_URL && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY, 'Load server env explicitly');
  const url = new URL(process.env.PEEKALO_TEST_BASE_URL);
  assert((url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Expected an explicit API origin');
  base = url.origin;
  origin = new URL(process.env.PUBLIC_APP_URL ?? base).origin;
  db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
  phase = 'bootstrap';
  const config = await call('/api/shares/config', { method: 'GET', timeout: 90_000 });
  assert(config.status === 200 && config.data.ready && config.data.supabaseUrl === process.env.SUPABASE_URL, 'API and database project mismatch');
  phase = 'generation';
  dir = await mkdtemp(path.join(tmpdir(), 'peekalo-capacity-'));
  const source = path.join(dir, 'generated.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-map_metadata', '-1', '-movflags', '+faststart', source], { timeout: 45_000, stdio: 'ignore' });
  const bytes = await readFile(source);
  assert(bytes.length > 0 && bytes.length < 30 * 1024 * 1024, 'Generated input outside upload bounds');
  phase = 'temporary_accounts';
  const firstOwner = await provision('a'), secondOwner = await provision('b');
  phase = 'observe_overlap';
  const first = upload(firstOwner, bytes, randomUUID());
  const observationDeadline = performance.now() + 60_000;
  let observedUploading = false;
  while (!first.attempt.settled && performance.now() < observationDeadline) {
    const post = await postFor(first.attempt);
    if (post?.status === 'uploading' && !first.attempt.settled) { observedUploading = true; break; }
    await pause(200);
  }
  assert(observedUploading, 'No server-side overlapping admission window observed; result is inconclusive');
  const secondKey = randomUUID();
  const second = upload(secondOwner, bytes, secondKey);
  const secondResult = await second.promise;
  assert(!first.attempt.settled, 'First upload finished before overlap response; result is inconclusive');
  assert(secondResult.status === 429 && secondResult.data.error === 'processing_busy', 'Overlapping request was not refused by bounded admission');
  const firstResult = await first.promise;
  const firstEvidence = await readyEvidence(first.attempt, firstResult);
  phase = 'retry_after_release';
  const retry = upload(secondOwner, bytes, secondKey);
  const retryEvidence = await readyEvidence(retry.attempt, await retry.promise);
  const retryPost = await postFor(retry.attempt);
  const count = await db.from('peekalo_posts').select('id', { count: 'exact', head: true }).eq('owner_id', secondOwner.id).eq('upload_key', secondKey);
  assert(!count.error && count.count === 1 && retryPost?.status === 'ready', 'Retry did not create exactly one ready post');
  report({ status: 'passed', generatedDurationSeconds: 10, inputBytes: bytes.length, observedAdmissionStatus: secondResult.status, rejectedElapsedMs: second.attempt.elapsedMs, first: firstEvidence, retry: retryEvidence });
} catch {
  // SDK/FFmpeg errors can contain credentials, paths or arbitrary metadata.
  report({ status: 'failed_or_inconclusive', phase });
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch { report({ cleanupStatus: 'incomplete_private_recovery_required' }); process.exitCode = 1; }
}
