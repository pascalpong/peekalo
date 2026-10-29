/** Exact loopback-only REL-03 integration. Generated media/accounts only; no
 * hosted settings, phone sessions, captures or existing budgets are touched. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fixtureOperator } from './safety-fixture-operator.mjs';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js'), sharp = require('sharp');
const base = 'http://127.0.0.1:3101';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:55321'); assert.equal(process.env.PUBLIC_APP_URL, base);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [], prefix = `rel03_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
let passed = 0;
const check = (condition, label) => { assert(condition, label); passed++; };
async function api(route, { token, method = 'POST', value, form, cookie, key } = {}) {
  const result = await fetch(`${base}${route}`, { method, headers: { Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: form ?? (value ? JSON.stringify(value) : undefined), signal: AbortSignal.timeout(form ? 120_000 : 20_000) });
  return { status: result.status, headers: result.headers, cookie: result.headers.get('set-cookie')?.split(';')[0], data: result.headers.get('content-type')?.includes('application/json') ? await result.json() : Buffer.from(await result.arrayBuffer()) };
}
async function user(suffix) {
  const email = `${prefix}_${suffix}@example.invalid`, password = randomUUID() + 'aA1!';
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true }); check(!created.error && created.data.user, 'Generated local account'); users.push(created.data.user.id);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email, password }); check(!login.error && login.data.session, 'Generated account sign in');
  const value = { id: created.data.user.id, token: login.data.session.access_token, username: `${prefix}_${suffix}` };
  const saved = await api('/api/profile', { token: value.token, value: { username: value.username } });
  check(saved.status === 200 && saved.data.reviewState === 'pending', 'Username awaits manual approval');
  check((await api(`/api/profile/${value.username}`, { method: 'GET' })).status === 404, 'Pending username not public');
  return value;
}
async function approveProfile(operator, username) { check((await api('/api/operator/profile', { token: operator, value: { username, action: 'approve', reason: 'Generated fixture name reviewed' } })).status === 200, 'Operator approves name'); }
async function decision(operator, postId, action) { return api('/api/operator/decision', { token: operator, value: { postId, action, reason: `Generated fixture ${action}` } }); }
try {
  const operator = await fixtureOperator(db, users, prefix), owner = await user('owner'), viewer = await user('viewer'), stranger = await user('stranger');
  for (const item of [owner, viewer, stranger]) await approveProfile(operator, item.username);
  const config = await api('/api/safety/config', { method: 'GET' }); check(config.status === 200 && config.data.manualApproval && !config.data.contactConfigured, 'Manual approval configured; real contact still pending');
  check((await api('/api/operator/queue', { token: viewer.token, method: 'GET' })).status === 403, 'Nonoperator queue denied');
  check((await api('/api/operator/queue', { method: 'GET' })).status === 401, 'Anonymous queue denied');
  const bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#556f32' } }).jpeg().toBuffer();
  const form = () => { const f = new FormData(); f.set('kind', 'photo'); f.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'generated.jpg'); return f; };
  const key = randomUUID(), uploaded = await api('/api/posts', { token: owner.token, form: form(), key });
  check(uploaded.status === 200 && uploaded.data.status === 'moderation_pending', 'Processing remains private pending manual approval'); const post = uploaded.data.postId;
  check((await api('/api/posts', { token: owner.token, method: 'GET' })).data.activeCount === 1, 'Pending approval counts active quota');
  check((await api('/api/posts', { token: owner.token, form: form(), key })).data.postId === post, 'Pending retry reuses moment');
  check((await api(`/api/posts/${post}/link`, { token: owner.token, key: randomUUID(), value: {} })).data.error === 'moderation_pending', 'Pending moment cannot create link');
  check((await api(`/api/posts/${post}/recipients`, { token: owner.token, value: { username: viewer.username } })).status !== 200, 'Pending moment cannot create grant');
  check((await api(`/api/profile/${owner.username}`, { method: 'GET' })).data.items.length === 0, 'Pending moment absent from public opaque grid');
  const queue = await api('/api/operator/queue', { token: operator, method: 'GET' }); check(queue.status === 200 && queue.data.posts.some(item => item.postId === post), 'Operator queue contains pending moment');
  check(!/storagePath|storage_path|token_hash/.test(JSON.stringify(queue.data)), 'Queue has no original URL or path');
  check((await api(`/api/operator/media/${post}`, { token: viewer.token, method: 'GET' })).status === 403, 'Nonoperator original denied');
  const review = await api(`/api/operator/media/${post}`, { token: operator, method: 'GET' });
  check(review.status === 200 && review.headers.get('content-type') === 'image/jpeg', 'Operator deliberate private review succeeds'); check(review.headers.get('cache-control').includes('no-store'), 'Operator bytes no-store');
  check((await decision(owner.token, post, 'approve')).status === 403, 'Owner cannot self-approve');
  check((await decision(operator, post, 'approve')).status === 200, 'Operator approves reviewed moment');
  const link = await api(`/api/posts/${post}/link`, { token: owner.token, key: randomUUID(), value: {} }); check(link.status === 200, 'Approved moment can share'); const share = new URL(link.data.url).hash.slice(1);
  const granted = await api(`/api/posts/${post}/recipients`, { token: owner.token, value: { username: viewer.username } });
  check(granted.status === 200 && granted.data.accountId === viewer.id, 'Owner creates grant with stable recipient identity');
  check((await api(`/api/inbox/${post}/accept`, { token: viewer.token, value: {} })).status === 200, 'Recipient accepts');
  const report = await api('/api/safety/reports', { token: viewer.token, value: { postId: post, reason: 'child_safety', details: 'Synthetic concern, generated pattern only' } }); check(report.status === 200 && report.data.reportId, 'Authorized native content report persists');
  check((await api('/api/safety/reports', { token: stranger.token, value: { postId: post, reason: 'spam' } })).status === 404, 'Unguessable unauthorized report target denied');
  const guestReport = await api('/api/safety/reports', { value: { token: share, reason: 'other' } }); check(guestReport.status === 200 && guestReport.cookie, 'Guest report without revealing works');
  check((await api('/api/view/status', { value: { token: share } })).data.remainingMs === 10000, 'Report does not claim or spend link');
  const held = await api('/api/view/direct', { token: viewer.token, value: { postId: post, sessionId: randomUUID(), requestId: randomUUID() } }); check(held.status === 200 && held.data.remainingMs === 8000, 'Approved authorized lease uses cumulative ledger');
  const blocked = await api('/api/safety/blocks', { token: viewer.token, value: { accountId: owner.id } }); check(blocked.status === 200 && blocked.data.blocked, 'Recipient blocks identified owner');
  check((await api(new URL(held.data.mediaUrl).pathname, { token: viewer.token, method: 'GET' })).status !== 200, 'Block denies already issued media authorization');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: post } })).status !== 200, 'Block denies direct status');
  check((await api('/api/view/status', { token: viewer.token, value: { token: share } })).status !== 200, 'Block denies signed-in external link');
  check((await api(`/api/profile/${owner.username}`, { token: viewer.token, method: 'GET' })).status === 404, 'Identified profile blocked');
  check((await api(`/api/profile/${owner.username}`, { method: 'GET' })).status === 200, 'Anonymous opaque profile limitation explicit');
  check((await api('/api/inbox', { token: viewer.token, method: 'GET' })).data.items.length === 0, 'Blocked sender absent from inbox');
  check((await api('/api/safety/blocks', { token: viewer.token, method: 'GET' })).data.items[0].username === owner.username, 'Block list manageable');
  const changedOwner = `${prefix}_newown`, changedViewer = `${prefix}_newview`;
  check((await api('/api/profile', { token: owner.token, value: { username: changedOwner } })).data.reviewState === 'pending', 'Changed name reenters manual review');
  const hiddenBlock = await api('/api/safety/blocks', { token: viewer.token, method: 'GET' });
  check(hiddenBlock.data.items[0].username === null && hiddenBlock.data.items[0].accountId === owner.id, 'Block inventory hides unapproved rename and keeps stable control');
  check((await api('/api/safety/reports', { token: viewer.token, value: { accountId: owner.id, reason: 'harassment' } })).status === 200, 'Stable account report survives target rename');
  check((await api('/api/safety/reports', { value: { username: changedOwner, reason: 'other' } })).status === 404, 'Guest cannot report unpublished username by discovery');
  check((await api('/api/profile', { token: viewer.token, value: { username: changedViewer } })).data.reviewState === 'pending', 'Recipient rename also awaits review');
  const hiddenRecipient = await api('/api/posts', { token: owner.token, method: 'GET' });
  const recipient = hiddenRecipient.data.items.find(item => item.postId === post).recipients[0];
  check(recipient.username === null && recipient.accountId === viewer.id, 'Owner inventory masks unapproved recipient name');
  check((await api(`/api/posts/${post}/recipients`, { token: owner.token, method: 'DELETE', value: { accountId: viewer.id } })).status === 200, 'Owner stable recipient revoke works while name hidden');
  check((await api('/api/safety/blocks', { token: viewer.token, method: 'DELETE', value: { accountId: owner.id } })).data.blocked === false, 'Stable unblock survives target rename');
  owner.username = changedOwner; viewer.username = changedViewer;
  await approveProfile(operator, owner.username); await approveProfile(operator, viewer.username);
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: post } })).status === 404, 'Unblock does not silently restore grant');
  const budget = await db.from('peekalo_budgets').select('spent_ms').eq('post_id', post).eq('identity', `a:${viewer.id}`); check(!budget.error && budget.data[0].spent_ms === 2000, 'Block/unblock preserve budget');
  check((await decision(operator, post, 'takedown')).status === 200, 'Operator takes down reported moment');
  check((await api('/api/view/status', { value: { token: share }, cookie: guestReport.cookie })).status !== 200, 'Takedown prevents future guest reveal');
  check((await api(`/api/profile/${owner.username}`, { method: 'GET' })).data.items.length === 0, 'Takedown removes public opaque card');
  check((await api('/api/posts', { token: owner.token, form: form(), key })).status === 403, 'Same-key retry cannot republish takedown');
  check((await api('/api/operator/reports/' + report.data.reportId, { token: operator, value: { state: 'resolved', note: 'Synthetic takedown response recorded' } })).status === 200, 'Report response workflow records resolution');
  check((await api('/api/operator/account', { token: operator, value: { username: owner.username, action: 'suspend', reason: 'Generated fixture sanction' } })).status === 200, 'Operator can suspend reported user');
  check((await api('/api/posts', { token: owner.token, form: form(), key: randomUUID() })).status !== 200, 'Suspended account cannot upload');
  check((await api(`/api/profile/${owner.username}`, { method: 'GET' })).status === 404, 'Suspension hides public profile');
  check((await api('/api/operator/account', { token: operator, value: { username: owner.username, action: 'restore', reason: 'Generated fixture restore' } })).status === 200, 'Operator restores account deliberately');
  const rejected = await api('/api/posts', { token: owner.token, form: form(), key: randomUUID() }); check(rejected.status === 200, 'Restored account may reserve available slot');
  check((await decision(operator, rejected.data.postId, 'reject')).status === 200, 'Operator rejects pending moment');
  check((await api('/api/posts', { token: owner.token, method: 'GET' })).data.activeCount === 0, 'Rejection and takedown release active slots');
  const audit = await api('/api/operator/audit', { token: operator, method: 'GET' }); check(audit.status === 200 && audit.data.items.length >= 8, 'Restricted operator audit records reads/actions');
  check(!JSON.stringify(audit.data).includes(share), 'Audit does not contain raw share token');
  for (const page of ['/safety', '/support', '/operator']) { const result = await api(page, { method: 'GET' }); check(result.status === 200 && result.headers.get('cache-control').includes('no-store'), 'Operational page loads without caching private state'); }
  console.log(`PASS ${passed} isolated-local safety assertions (generated fixtures only)`);
} finally {
  // Paths are enumerated only beneath accounts generated by this invocation.
  for (const id of users) {
    const paths = [];
    async function visit(prefix, depth = 0) {
      assert(depth < 5); const { data, error } = await db.storage.from('peekalo-captures').list(prefix, { limit: 100 });
      assert(!error && data.length < 100);
      for (const item of data) { assert(!/[\\/]/.test(item.name)); const child = `${prefix}/${item.name}`; if (item.id === null) await visit(child, depth + 1); else paths.push(child); }
    }
    await visit(id); if (paths.length) { const removed = await db.storage.from('peekalo-captures').remove(paths); assert(!removed.error); }
    const removed = await db.auth.admin.deleteUser(id); assert(!removed.error);
  }
}
