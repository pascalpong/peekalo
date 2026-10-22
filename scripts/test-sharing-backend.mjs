/** Integration test: creates only generated geometric fixtures and temporary .invalid users.
 * Run with server env loaded and PEEKALO_TEST_BASE_URL pointing at the running API.
 * Never run against an existing production project. All test objects/users are removed.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const base = process.env.PEEKALO_TEST_BASE_URL;
assert(base && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY, 'Load server env and PEEKALO_TEST_BASE_URL first');
const origin = new URL(process.env.PUBLIC_APP_URL ?? base).origin;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const namespace = `test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const users = [];
const dir = await mkdtemp(path.join(tmpdir(), 'peekalo-test-'));
let passed = 0;
const timings = new Map();
const check = (condition, label) => { assert(condition, label); passed++; };
function category(route) {
  if (route.startsWith('/api/view/media/')) return 'media';
  if (route.startsWith('/api/view/')) return route.endsWith('/preview') ? 'preview' : 'lease';
  if (route === '/api/posts') return 'upload';
  if (route.endsWith('/link')) return 'link';
  if (route.endsWith('/recipients')) return 'recipient';
  if (route.endsWith('/accept')) return 'accept';
  return 'profile';
}
function reportTimings() {
  for (const [endpoint, samples] of timings) {
    const durations = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
    const percentile = fraction => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
    const counts = {};
    for (const sample of samples) counts[sample.status] = (counts[sample.status] ?? 0) + 1;
    console.log(JSON.stringify({ endpoint, count: samples.length, minMs: durations[0], p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: durations.at(-1), statusCounts: counts }));
  }
}
async function afterExpiry(grant) {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(grant.data.expiresAt) - Date.now() + 100)));
}
function stillValid(grant, label) {
  check(Number.isFinite(Date.parse(grant.data.expiresAt)) && Date.now() < Date.parse(grant.data.expiresAt), label);
}
async function together(operations) {
  // A failed request must not leave sibling requests running while cleanup
  // deletes the generated accounts and objects they are still exercising.
  const results = await Promise.allSettled(operations);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}
async function api(route, { token, value, form, cookie, key, method = 'POST', headers = {} } = {}) {
  const endpoint = category(route); const started = performance.now(); let status = 'network_failure';
  try {
    const response = await fetch(`${base}${route}`, { method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: form ?? (value ? JSON.stringify(value) : undefined), signal: AbortSignal.timeout(form ? 150_000 : 20_000) });
    status = response.status;
    let data;
    if (response.headers.get('content-type')?.includes('application/json')) data = await response.json();
    else data = Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  } catch { throw new Error(`Integration ${endpoint} request failed; configuration and request details omitted.`); }
  finally {
    const samples = timings.get(endpoint) ?? [];
    samples.push({ status, elapsedMs: Math.round(performance.now() - started) });
    timings.set(endpoint, samples);
  }
}
async function user(suffix) {
  const email = `${namespace}_${suffix}@example.invalid`; const password = randomUUID() + 'aA1!';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  assert(!error && data.user, 'Test user provisioning'); users.push(data.user.id);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  assert(!signIn.error && signIn.data.session, 'Test user sign-in');
  return { id: data.user.id, token: signIn.data.session.access_token, client, username: `${namespace.slice(0, 18)}_${suffix}` };
}
function form(bytes, kind, mime) { const value = new FormData(); value.set('kind', kind); value.set('file', new Blob([bytes], { type: mime }), `fixture.${kind === 'photo' ? 'jpg' : 'mp4'}`); return value; }
async function unclaimedLink(postId, token, label) {
  const hash = createHash('sha256').update(token).digest('hex');
  const { data, error } = await db.from('peekalo_links').select('claimed_identity').eq('post_id', postId).eq('token_hash', hash).single();
  check(!error && data?.claimed_identity === null, label);
}
async function fixtureStorageObjects(owner) {
  // Never enumerate the bucket root or a prefix outside accounts created by
  // this run. Support both legacy owner/file and fenced owner/post/attempt.
  assert(users.includes(owner) && /^[0-9a-f-]{36}$/i.test(owner), 'Cleanup requires an account created by this integration run');
  const storage = db.storage.from('peekalo-captures');
  const objects = []; let visited = 0;
  async function visit(prefix, depth) {
    assert(depth <= 8, 'Generated fixture cleanup exceeded its folder depth bound');
    for (let offset = 0; offset < 10_000; offset += 100) {
      const { data: entries, error } = await storage.list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      assert(!error && Array.isArray(entries), 'Generated fixture Storage listing failed');
      for (const entry of entries) {
        assert(++visited <= 10_000, 'Generated fixture cleanup exceeded its entry bound');
        assert(typeof entry.name === 'string' && entry.name.length > 0 && !['.', '..'].includes(entry.name) && !/[\\/]/.test(entry.name), 'Generated fixture cleanup received an unsafe object name');
        const path = `${prefix}/${entry.name}`;
        if (entry.id === null) await visit(path, depth + 1);
        else {
          assert(typeof entry.id === 'string' && entry.id.length > 0, 'Generated fixture cleanup received an unknown Storage entry');
          objects.push(path);
        }
      }
      if (entries.length < 100) return;
    }
    assert.fail('Generated fixture cleanup exceeded its pagination bound');
  }
  await visit(owner, 0);
  return objects;
}
try {
  // Warm the gateway before a two-second grant; compilation/startup is not viewing time.
  await api(`/api/view/media/${randomUUID()}`, { method: 'GET' });
  const owner = await user('a'); const recipient = await user('b');
  for (const person of [owner, recipient]) {
    const result = await api('/api/profile', { token: person.token, value: { username: person.username } });
    check(result.status === 200, 'Account profile persisted');
  }
  const image = await sharp({ create: { width: 360, height: 640, channels: 3, background: '#b5d278' } }).jpeg().toBuffer();
  const key = randomUUID();
  const uploads = await together([0, 1].map(() => api('/api/posts', { token: owner.token, key, form: form(image, 'photo', 'image/jpeg') })));
  const success = uploads.find(result => result.status === 200);
  check(Boolean(success), 'At least one idempotent concurrent upload succeeds');
  const post = success.data.postId;
  const repeated = await api('/api/posts', { token: owner.token, key, form: form(image, 'photo', 'image/jpeg') });
  check(repeated.status === 200 && repeated.data.postId === post, 'Upload retry returns original post');
  const { count } = await db.from('peekalo_posts').select('id', { head: true, count: 'exact' }).eq('owner_id', owner.id).eq('upload_key', key);
  check(count === 1, 'Concurrent upload reserves exactly one post');
  const forged = await api('/api/posts', { token: owner.token, key: randomUUID(), form: form(Buffer.from('not an image'), 'photo', 'image/jpeg') });
  check(forged.status === 422, 'Forged MIME body rejected');
  const unauthorized = await api(`/api/posts/${post}/link`, { token: recipient.token, key: randomUUID() });
  check(unauthorized.status === 404, 'Non-owner cannot create share rights');
  const linkKeys = [randomUUID(), randomUUID()];
  const links = await together(linkKeys.map(key => api(`/api/posts/${post}/link`, { token: owner.token, key })));
  check(links.every(result => result.status === 200) && links[0].data.url === links[1].data.url, 'Concurrent link requests reuse single active link');
  const token = new URL(links[0].data.url).hash.slice(1);
  const before = await api('/api/view/preview', { value: { token } });
  const after = await api('/api/view/preview', { value: { token } });
  check(before.data.available && after.data.available, 'Repeated previews never consume link');
  const ownerClaim = await api('/api/view/lease', { token: owner.token, value: { token, sessionId: randomUUID(), requestId: randomUUID() } });
  check(ownerClaim.status === 404 && ownerClaim.data.error === 'unavailable', 'Owner cannot consume own external link');
  await unclaimedLink(post, token, 'Denied owner reveal leaves the link unclaimed');
  const { data: unclaimed } = await db.from('peekalo_links').select('claimed_identity').eq('post_id', post);
  check(unclaimed.every(link => link.claimed_identity === null), 'Preview does not write claim');
  const csrf = await api('/api/view/lease', { value: { token, sessionId: randomUUID(), requestId: randomUUID() }, headers: { Origin: 'https://untrusted.invalid' } });
  check(csrf.status === 403, 'Cross-origin cookie reveal is rejected');
  const sessions = [randomUUID(), randomUUID()]; const requests = [randomUUID(), randomUUID()];
  let winnerChecks;
  const race = await together(sessions.map(async (sessionId, index) => {
    const result = await api('/api/view/lease', { value: { token, sessionId, requestId: requests[index] } });
    if (result.status === 200) {
      // Exercise these short-lease constraints as soon as the winner arrives,
      // without spending its grant waiting for the slower losing response.
      winnerChecks = together([
        api('/api/view/lease', { cookie: result.cookie, value: { token, sessionId, requestId: requests[index] } }),
        api('/api/view/lease', { cookie: result.cookie, value: { token, sessionId: randomUUID(), requestId: randomUUID() } }),
        api('/api/view/lease', { cookie: result.cookie, value: { token, sessionId, requestId: randomUUID() } }),
      ]);
      // Attach rejection handling immediately, even if the losing race is slow.
      await winnerChecks;
    }
    return result;
  }));
  const winnerIndex = race.findIndex(result => result.status === 200); const winner = race[winnerIndex];
  check(winnerIndex >= 0 && race.filter(result => result.status === 200).length === 1 && race.some(result => result.status === 410), 'Exactly one anonymous racing identity claims link');
  const [repeat, busy, early] = await winnerChecks;
  check(repeat.status === 200 && repeat.data.leaseId === winner.data.leaseId && repeat.data.remainingMs === 8000, 'Duplicate lease request is idempotent');
  check(busy.status === 409 && busy.data.error === 'viewer_busy', 'Simultaneous same-identity sessions are serialized');
  check(early.status === 409 && early.data.error === 'renew_later', 'Immediate renewal cannot prepay full allowance');
  const cleared = await api('/api/view/lease', { value: { token, sessionId: randomUUID(), requestId: randomUUID() } });
  check(cleared.status === 410, 'Cookie reset cannot reclaim claimed link');
  await afterExpiry(winner);
  const expired = await api(new URL(winner.data.mediaUrl).pathname, { cookie: winner.cookie, method: 'GET' });
  check(expired.status === 410, 'New media requests fail after lease expiration');
  const sessionId = sessions[winnerIndex]; let latest;
  for (let index = 0; index < 4; index++) {
    latest = await api('/api/view/lease', { cookie: winner.cookie, value: { token, sessionId, requestId: randomUUID() } });
    check(latest.status === 200 && latest.data.remainingMs === 6000 - index * 2000, 'Cumulative budget never resets across holds');
    if (index === 0) {
      // Delivery gets an ordinary fresh slice, separate from race/idempotency
      // round trips. It must still finish under the real two-second deadline.
      const rawMedia = await api(new URL(latest.data.mediaUrl).pathname, { cookie: winner.cookie, method: 'GET' });
      check(rawMedia.status === 200 && rawMedia.headers.get('cache-control').includes('no-store'), `Authorized media is private and no-store (HTTP ${rawMedia.status})`);
      const metadata = await sharp(rawMedia.data).metadata();
      check(metadata.width === 1080 && metadata.height === 1920 && !metadata.exif, 'Photo normalized to 9:16 without EXIF');
    }
    if (index < 3) await afterExpiry(latest);
  }
  const exhausted = await api('/api/view/lease', { cookie: winner.cookie, value: { token, sessionId, requestId: randomUUID() } });
  check(exhausted.status === 410 && exhausted.data.error === 'exhausted', 'Five prepaid slices exhaust budget');
  const originalRevoke = await api(`/api/posts/${post}/link`, { token: owner.token, method: 'DELETE' });
  check(originalRevoke.status === 200, 'Owner revokes original link before replacement');
  // Both concurrent keys resolved to the same link. One is its canonical nonce,
  // and the other is an alias; neither may mint a new link after revocation.
  for (const key of linkKeys) {
    const retry = await api(`/api/posts/${post}/link`, { token: owner.token, key });
    check(retry.status === 200 && retry.data.url === links[0].data.url && retry.data.expiresAt === links[0].data.expiresAt, 'Canonical and alias retries preserve revoked link before replacement');
  }
  const { count: beforeReplacement, error: linkCountError } = await db.from('peekalo_links').select('id', { head: true, count: 'exact' }).eq('post_id', post);
  check(!linkCountError && beforeReplacement === 1, 'Retries after revocation do not create a fresh link');
  const replacement = await api(`/api/posts/${post}/link`, { token: owner.token, key: randomUUID() });
  check(replacement.status === 200 && replacement.data.url !== links[0].data.url, 'A new link key creates a distinct replacement');
  const replacementToken = new URL(replacement.data.url).hash.slice(1);
  for (const key of linkKeys) {
    const retry = await api(`/api/posts/${post}/link`, { token: owner.token, key });
    check(retry.status === 200 && retry.data.url === links[0].data.url && retry.data.expiresAt === links[0].data.expiresAt, 'Canonical and alias retries preserve original result after replacement');
  }
  const revokedPreview = await api('/api/view/preview', { value: { token } });
  check(revokedPreview.status === 200 && !revokedPreview.data.available, 'Retrying revoked link keys does not reactivate the original');
  await unclaimedLink(post, replacementToken, 'Link-key retries leave replacement unclaimed');
  const send = await api(`/api/posts/${post}/recipients`, { token: owner.token, value: { username: recipient.username } });
  check(send.status === 200 && send.data.requestState === 'pending', 'Only owner creates pending recipient grant');
  const directInput = { postId: post, sessionId: randomUUID(), requestId: randomUUID() };
  const pending = await api('/api/view/direct', { token: recipient.token, value: directInput });
  check(pending.status === 404, 'Pending request cannot reveal even with grant');
  const accepted = await api(`/api/inbox/${post}/accept`, { token: recipient.token });
  check(accepted.status === 200, 'Recipient explicitly accepts own request');
  const denyRevoke = await api(`/api/posts/${post}/recipients`, { token: recipient.token, method: 'DELETE', value: { username: recipient.username } });
  check(denyRevoke.status === 404, 'Recipient cannot revoke owner grants');
  const direct = await api('/api/view/direct', { token: recipient.token, value: directInput });
  check(direct.status === 200 && direct.data.remainingMs === 8000, 'Accepted direct recipient has independent account budget');
  const directMedia = await api(new URL(direct.data.mediaUrl).pathname, { token: recipient.token, method: 'GET' });
  check(directMedia.status === 200 && directMedia.headers.get('cache-control').includes('no-store'), 'Accepted direct recipient can fetch private photo bytes before revocation');
  await afterExpiry(direct);
  const directRevocationLease = await api('/api/view/direct', { token: recipient.token, value: { ...directInput, requestId: randomUUID() } });
  check(directRevocationLease.status === 200 && directRevocationLease.data.remainingMs === 6000, 'Fresh recipient revocation slice charges the existing cumulative allowance');
  const ownerRevoke = await api(`/api/posts/${post}/recipients`, { token: owner.token, method: 'DELETE', value: { username: recipient.username } });
  check(ownerRevoke.status === 200, 'Owner can revoke recipient grant');
  const [revoked, deniedDirectLease] = await together([
    api(new URL(directRevocationLease.data.mediaUrl).pathname, { token: recipient.token, method: 'GET' }),
    api('/api/view/direct', { token: recipient.token, value: { ...directInput, requestId: randomUUID() } }),
  ]);
  check(revoked.status === 404, 'Revocation denies new media requests immediately');
  check(deniedDirectLease.status === 404, 'Revoked recipient grant denies a new lease');
  stillValid(directRevocationLease, 'Recipient revocation denials complete before the existing grant expires');
  const restored = await api(`/api/posts/${post}/recipients`, { token: owner.token, value: { username: recipient.username } });
  check(restored.status === 200 && restored.data.requestState === 'accepted', 'Owner can restore an already accepted recipient grant');
  const directAsLink = await api('/api/view/lease', { token: recipient.token, value: { token: replacementToken, sessionId: directInput.sessionId, requestId: directInput.requestId } });
  check(directAsLink.status === 409 && directAsLink.data.error === 'conflict', 'Same-session direct request cannot replay through a link');
  await unclaimedLink(post, replacementToken, 'Cross-scope direct retry does not claim the fresh link');
  // Let the existing slice expire before granting a new request through the
  // other path. Account identity/post retains its original cumulative budget.
  await afterExpiry(directRevocationLease);
  const accountLinkInput = { token: replacementToken, sessionId: directInput.sessionId, requestId: randomUUID() };
  const accountLink = await api('/api/view/lease', { token: recipient.token, value: accountLinkInput });
  check(accountLink.status === 200 && accountLink.data.remainingMs === 4000, 'Account direct and link access share one cumulative allowance');
  const linkAsDirect = await api('/api/view/direct', { token: recipient.token, value: { postId: post, sessionId: accountLinkInput.sessionId, requestId: accountLinkInput.requestId } });
  check(linkAsDirect.status === 409 && linkAsDirect.data.error === 'conflict', 'Same-session link request cannot replay through direct access');
  const replacementRevoke = await api(`/api/posts/${post}/link`, { token: owner.token, method: 'DELETE' });
  check(replacementRevoke.status === 200, 'Owner revokes account-claimed replacement link');
  const nextLink = await api(`/api/posts/${post}/link`, { token: owner.token, key: randomUUID() });
  check(nextLink.status === 200 && nextLink.data.url !== replacement.data.url, 'Distinct link scope exists for request replay check');
  const nextToken = new URL(nextLink.data.url).hash.slice(1);
  const differentLink = await api('/api/view/lease', { token: recipient.token, value: { ...accountLinkInput, token: nextToken } });
  check(differentLink.status === 409 && differentLink.data.error === 'conflict', 'Same-session request cannot replay across two link scopes');
  await unclaimedLink(post, nextToken, 'Cross-link retry leaves the new link unclaimed');
  const guessed = await api(`/api/view/media/${randomUUID()}`, { token: recipient.token, method: 'GET' });
  check(guessed.status === 404, 'Guessing lease identifiers does not reveal originals');
  const clientRead = await recipient.client.from('peekalo_posts').select('*');
  check(Boolean(clientRead.error) || clientRead.data.length === 0, 'Authenticated client cannot read sensitive tables');
  const anonymous = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const client of [recipient.client, anonymous]) {
    const mappingRead = await client.from('peekalo_link_requests').select('*');
    check(Boolean(mappingRead.error) || mappingRead.data.length === 0, 'Public client roles cannot read link request mappings');
  }
  const deniedRpc = await anonymous.rpc('peekalo_lease', { p_identity: `g:${randomUUID()}`, p_session: randomUUID(), p_request: randomUUID(), p_hash: createHash('sha256').update(nextToken).digest('hex'), p_post: null });
  check(deniedRpc.error?.code === '42501', 'Anonymous client cannot call the privileged lease RPC directly');
  await unclaimedLink(post, nextToken, 'Denied anonymous RPC leaves the link unclaimed');
  const { data: postRow } = await db.from('peekalo_posts').select('storage_path').eq('id', post).single();
  const storageRead = await recipient.client.storage.from('peekalo-captures').download(postRow.storage_path);
  check(Boolean(storageRead.error), 'Authenticated recipient has no direct storage read');
  const videoPath = path.join(dir, 'fixture.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xb5d278:s=180x320:r=15', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { timeout: 20_000, stdio: 'ignore' });
  const video = await api('/api/posts', { token: owner.token, key: randomUUID(), form: form(await readFile(videoPath), 'video', 'video/mp4') });
  check(video.status === 200 && video.data.kind === 'video', 'Trusted worker normalizes generated short video');
  const videoLink = await api(`/api/posts/${video.data.postId}/link`, { token: owner.token, key: randomUUID() });
  const videoToken = new URL(videoLink.data.url).hash.slice(1);
  const videoSession = randomUUID();
  const videoLease = await api('/api/view/lease', { value: { token: videoToken, sessionId: videoSession, requestId: randomUUID() } });
  check(videoLease.status === 200, 'Processed video uses same protected lease ledger');
  const videoRange = await api(new URL(videoLease.data.mediaUrl).pathname, { cookie: videoLease.cookie, method: 'GET', headers: { Range: 'bytes=0-65535' } });
  check(videoRange.status === 206 && videoRange.data.length <= 65536 && videoRange.headers.has('content-range'), `Authorized video range is bounded and private (HTTP ${videoRange.status}, bytes ${videoRange.data.length}, range ${videoRange.headers.has('content-range')})`);
  // Downloading the first range can consume most of its valid slice. Do not
  // confuse its expiry with revocation: obtain a fresh paid slice specifically
  // for the owner-revoke and denial checks, retaining the same total allowance.
  await afterExpiry(videoLease);
  const revocationLease = await api('/api/view/lease', { cookie: videoLease.cookie, value: { token: videoToken, sessionId: videoSession, requestId: randomUUID() } });
  check(revocationLease.status === 200 && revocationLease.data.remainingMs === 6000, 'Fresh video revocation slice charges the existing cumulative allowance');
  const videoRevoke = await api(`/api/posts/${video.data.postId}/link`, { token: owner.token, method: 'DELETE' });
  check(videoRevoke.status === 200, 'Owner can revoke external link');
  const [deniedVideo, deniedVideoLease] = await together([
    api(new URL(revocationLease.data.mediaUrl).pathname, { cookie: videoLease.cookie, method: 'GET', headers: { Range: 'bytes=0-65535' } }),
    api('/api/view/lease', { cookie: videoLease.cookie, value: { token: videoToken, sessionId: videoSession, requestId: randomUUID() } }),
  ]);
  check(deniedVideo.status === 404, 'Revoked link denies later video ranges');
  check(deniedVideoLease.status === 404, 'Revoked link denies a new video lease');
  stillValid(revocationLease, 'External-link revocation denials complete before the existing grant expires');
  const longPath = path.join(dir, 'long.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xb5d278:s=90x160:r=1', '-t', '11', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', longPath], { timeout: 20_000, stdio: 'ignore' });
  const long = await api('/api/posts', { token: owner.token, key: randomUUID(), form: form(await readFile(longPath), 'video', 'video/mp4') });
  check(long.status === 422, 'Over-ten-second video rejected server-side');
  console.log(`Protected sharing: ${passed} integration assertions passed (generated fixtures only).`);
} finally {
  reportTimings();
  let cleanupFailed = false;
  for (const id of users) {
    try {
      // Finish all pagination before deleting, so removals cannot shift offsets
      // and skip files. Delete only fully listed objects, never virtual folders.
      const objects = await fixtureStorageObjects(id);
      for (let offset = 0; offset < objects.length; offset += 100) {
        const { error } = await db.storage.from('peekalo-captures').remove(objects.slice(offset, offset + 100));
        assert(!error, 'Generated fixture object removal failed');
      }
      assert.equal((await fixtureStorageObjects(id)).length, 0, 'Generated fixture objects remain after cleanup');
      // Keep the account if Storage cleanup failed, preserving its ownership
      // reference for recovery. This list contains only accounts created above.
      const { error } = await db.auth.admin.deleteUser(id);
      if (error) cleanupFailed = true;
    } catch { cleanupFailed = true; }
  }
  try { await rm(dir, { force: true, recursive: true }); }
  catch { cleanupFailed = true; }
  if (cleanupFailed) {
    console.error('Generated integration fixture cleanup failed; inspect the development project using the admin dashboard.');
    process.exitCode = 1;
  }
}
