/** REL-02 integration: exact isolated loopback backend only; generated fixtures.
 * Never reads hosted env or original phone accounts. Cleanup is confined to
 * account IDs created by this invocation, including their object prefixes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const base = 'http://127.0.0.1:3101';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:55321', 'Use isolated local environment');
assert.equal(process.env.PUBLIC_APP_URL, base, 'Use isolated local gateway');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [], clients = [];
const prefix = `rel02_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let passed = 0, failed = false;
const check = (condition, label) => { assert(condition, label); passed++; };
async function api(route, { token, method = 'POST', value, form, cookie, key } = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: {
    Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
  }, body: form ?? (value ? JSON.stringify(value) : undefined), signal: AbortSignal.timeout(form ? 120_000 : 20_000) });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
async function user(suffix) {
  const email = `${prefix}_${suffix}@example.invalid`, password = randomUUID() + 'aA1!';
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  check(!error && data.user, 'Generated local user created'); users.push(data.user.id);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); clients.push(client);
  const login = await client.auth.signInWithPassword({ email, password });
  check(!login.error && login.data.session, 'Generated local user signs in');
  const result = { id: data.user.id, token: login.data.session.access_token, username: `${prefix}_${suffix}` };
  check((await api('/api/profile', { token: result.token, value: { username: result.username } })).status === 200, 'Generated username saved');
  return result;
}
async function objects(owner) {
  assert(users.includes(owner)); const result = [];
  async function visit(path, depth) {
    assert(depth <= 5); const { data, error } = await db.storage.from('peekalo-captures').list(path, { limit: 100 });
    assert(!error && Array.isArray(data)); assert(data.length < 100);
    for (const item of data) {
      assert(item.name && !/[\\/]/.test(item.name) && !['.', '..'].includes(item.name));
      const child = `${path}/${item.name}`;
      if (item.id === null) await visit(child, depth + 1); else result.push(child);
    }
  }
  await visit(owner, 0); return result;
}
try {
  const owner = await user('o'), viewer = await user('v');
  check((await api('/api/posts', { method: 'GET' })).status === 401, 'Owner listing requires sign-in');
  check((await api('/api/profile', { token: viewer.token, value: { username: 'demo' } })).data.error === 'username_reserved', 'Sample route username is reserved');
  const bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#526f3a' } }).jpeg().toBuffer();
  const form = () => { const f = new FormData(); f.set('kind', 'photo'); f.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'generated.jpg'); return f; };
  const keys = [randomUUID(), randomUUID(), randomUUID()]; const posts = [];
  for (const key of keys) {
    const result = await api('/api/posts', { token: owner.token, form: form(), key });
    check(result.status === 200 && result.data.status === 'ready', 'Generated capture processed privately'); posts.push(result.data.postId);
  }
  const full = await api('/api/posts', { method: 'GET', token: owner.token });
  check(full.status === 200 && full.data.items.length === 3 && full.data.activeCount === 3 && full.data.limit === 3 && full.data.availableSlots === 0, 'Own moments returns authoritative full quota');
  check(!/storage_path|storagePath|token_hash|claimed_identity|upload_key|upload_attempt/.test(JSON.stringify(full.data)), 'Owner inventory exposes no internal paths or capabilities');
  const fourth = await api('/api/posts', { token: owner.token, form: form(), key: randomUUID() });
  check(fourth.status === 409 && fourth.data.error === 'active_limit', 'Fourth active moment is rejected');
  const replay = await api('/api/posts', { token: owner.token, form: form(), key: keys[0] });
  check(replay.status === 200 && replay.data.postId === posts[0], 'Ready retry at quota returns same moment');
  const publicProfile = await api(`/api/profile/${owner.username}`, { method: 'GET' });
  check(publicProfile.status === 200 && publicProfile.data.items.length === 3, 'Real public profile lists hidden moments');
  check(publicProfile.data.items.every(item => Object.keys(item).sort().join(',') === 'createdAt,kind'), 'Public cards expose only kind/time');
  check(!posts.some(id => JSON.stringify(publicProfile.data).includes(id)), 'Public profile has no post capabilities');
  const page = await api(`/u/${owner.username}`, { method: 'GET' });
  check(page.status === 200 && page.data.includes(owner.username) && !page.data.includes('/api/view/media/'), 'Real profile HTML uses opaque cards');
  check((await api('/api/profile/missing_rel02_profile', { method: 'GET' })).status === 404, 'Missing profile is unavailable');
  const link = await api(`/api/posts/${posts[0]}/link`, { token: owner.token, key: randomUUID(), value: {} });
  check(link.status === 200, 'Owner creates link'); const token = new URL(link.data.url).hash.slice(1);
  const before = await db.from('peekalo_budgets').select('post_id').eq('post_id', posts[0]);
  const status = await api('/api/view/status', { value: { token } });
  check(status.status === 200 && status.data.remainingMs === 10_000 && !status.cookie, 'Unclaimed status creates no guest cookie');
  check(status.headers.get('cache-control')?.includes('no-store'), 'Allowance snapshots are not cached');
  const after = await db.from('peekalo_budgets').select('post_id').eq('post_id', posts[0]);
  check(!before.error && !after.error && before.data.length === after.data.length && after.data.length === 0, 'Status does not insert or spend a budget');
  const held = await api('/api/view/lease', { value: { token, sessionId: randomUUID(), requestId: randomUUID() } });
  check(held.status === 200 && held.cookie && held.data.remainingMs === 8000, 'Deliberate reveal claims once and prepays a slice');
  const restored = await api('/api/view/status', { value: { token }, cookie: held.cookie });
  check(restored.status === 200 && restored.data.remainingMs === 8000 && !restored.cookie, 'Existing guest sees authoritative remaining balance');
  check((await api('/api/view/status', { value: { token } })).status === 410, 'Cookie reset cannot reopen claimed link');
  check((await api(`/api/posts/${posts[0]}`, { method: 'DELETE', token: viewer.token })).status === 404, 'Nonowner cannot delete');
  const revoked = await api(`/api/posts/${posts[0]}/link`, { token: owner.token, method: 'DELETE' });
  check(revoked.status === 200, 'Owner revokes link');
  const replayKey = randomUUID();
  const newLink = await api(`/api/posts/${posts[0]}/link`, { token: owner.token, key: replayKey, value: {} });
  check(newLink.data.state === 'active', 'Replacement link reports active state');
  await api(`/api/posts/${posts[0]}/link`, { token: owner.token, method: 'DELETE' });
  const replayRevoked = await api(`/api/posts/${posts[0]}/link`, { token: owner.token, key: replayKey, value: {} });
  check(replayRevoked.data.url === newLink.data.url && replayRevoked.data.state === 'revoked', 'Idempotent revoked-link retry reports its original revoked state');
  check((await api('/api/view/status', { value: { token }, cookie: held.cookie })).status === 404, 'Revoked link status denied');
  check((await api(new URL(held.data.mediaUrl).pathname, { method: 'GET', cookie: held.cookie })).status === 404, 'Revoked link blocks already issued media gateway');
  check((await api(`/api/posts/${posts[1]}/recipients`, { token: owner.token, value: { username: viewer.username } })).data.requestState === 'pending', 'Owner creates pending recipient grant');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: posts[1] } })).status === 404, 'Pending grant cannot read reveal status');
  check((await api(`/api/inbox/${posts[1]}/accept`, { token: viewer.token, value: {} })).status === 200, 'Recipient accepts grant');
  const directStatus = await api('/api/view/direct/status', { token: viewer.token, value: { postId: posts[1] } });
  check(directStatus.status === 200 && directStatus.data.remainingMs === 10_000, 'Accepted recipient status reads without spending');
  const direct = await api('/api/view/direct', { token: viewer.token, value: { postId: posts[1], sessionId: randomUUID(), requestId: randomUUID() } });
  check(direct.status === 200 && direct.data.remainingMs === 8000, 'Accepted recipient receives same ledger-backed allowance');
  const inbox = await api('/api/inbox', { token: viewer.token, method: 'GET' });
  check(inbox.status === 200 && inbox.data.items[0].remainingMs === 8000, 'Inbox displays authoritative remaining allowance');
  check((await api(`/api/posts/${posts[1]}/recipients`, { token: owner.token, method: 'DELETE', value: { username: viewer.username } })).status === 200, 'Owner revokes a selected recipient');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: posts[1] } })).status === 404, 'Revoked recipient loses status authorization');
  const regrant = await api(`/api/posts/${posts[1]}/recipients`, { token: owner.token, value: { username: viewer.username } });
  check(regrant.data.requestState === 'accepted', 'Restoring a grant preserves prior acceptance');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: posts[1] } })).data.remainingMs === 8000, 'Restoring a grant never restores spent allowance');
  const listed = await api('/api/posts', { token: owner.token, method: 'GET' });
  check(listed.data.items.some(item => item.postId === posts[0] && item.link.state === 'revoked'), 'Owner sees revoked link state');
  check(listed.data.items.some(item => item.postId === posts[1] && item.recipients.some(r => r.username === viewer.username && r.requestState === 'accepted')), 'Owner sees recipient acceptance');
  const removed = await api(`/api/posts/${posts[1]}`, { token: owner.token, method: 'DELETE' });
  check(removed.status === 200 && removed.data.deleted === true && removed.data.cleanupPending === false, 'Owner deletion revokes and removes private object');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: posts[1] } })).status === 404, 'Deleted moment denies direct status');
  check((await api(new URL(direct.data.mediaUrl).pathname, { token: viewer.token, method: 'GET' })).status === 404, 'Deletion invalidates active media capability');
  const deletedRetry = await api('/api/posts', { token: owner.token, key: keys[1], form: form() });
  check(deletedRetry.status === 404, 'Old upload key cannot resurrect deleted moment');
  const newCapture = await api('/api/posts', { token: owner.token, key: randomUUID(), form: form() });
  check(newCapture.status === 200 && newCapture.data.postId !== posts[1], 'Deleting frees slot for a distinct capture');
  check((await api(`/api/posts/${posts[1]}`, { token: owner.token, method: 'DELETE' })).status === 200, 'Owner delete retry is idempotent');
  console.log(`REL-02 isolated local integration: ${passed} assertions passed.`);
} catch (error) {
  failed = true;
  // Assertion labels are fixed strings; never print upstream bodies/credentials.
  console.error(error instanceof assert.AssertionError ? `REL-02 check failed: ${error.message.split('\n')[0]}` : 'REL-02 integration request failed; private details omitted.');
} finally {
  for (const client of clients) client.auth.stopAutoRefresh();
  try {
    for (const id of users) {
      const paths = await objects(id);
      if (paths.length) { const result = await db.storage.from('peekalo-captures').remove(paths); assert(!result.error); }
      const result = await db.auth.admin.deleteUser(id); assert(!result.error);
    }
    console.log('Generated local accounts and objects cleaned up. Original/hosted data was not accessed.');
  } catch { failed = true; console.error('Generated local fixture cleanup needs attention; no broad deletion attempted.'); }
  if (failed) process.exitCode = 1;
}
