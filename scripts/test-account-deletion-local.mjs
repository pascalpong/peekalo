/** REL-04 real HTTP/Auth/private-Storage integration. Exact loopback project,
 * generated identities/objects only. Never opens or changes phone/hosted data.
 * Fixture aging is confined to requests created by this invocation; the API's
 * normal ten-minute grace is checked before the fixture-only maintenance step.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { fixtureOperator } from './safety-fixture-operator.mjs';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js'), sharp = require('sharp');
const exec = promisify(execFile), base = process.env.PEEKALO_TEST_APP_ORIGIN ?? 'http://127.0.0.1:3124';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:55321');
assert.equal(process.env.PUBLIC_APP_URL, base); assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base));
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [], clients = [], requests = [], prefix = `rel04_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const version = '2026-10-29-draft'; let passed = 0;
const check = (condition, label) => { assert(condition, label); passed++; };
const uuid = value => { assert(/^[0-9a-f-]{36}$/.test(value)); return value; };
async function sql(statement) {
  return (await exec('docker', ['exec', 'supabase_db_peekalo-local-testing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', statement], { maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function call(name, args) { const result = await db.rpc(name, args); assert(!result.error, `Fixture RPC ${name} failed`); return result.data; }
async function api(route, { token, method = 'POST', value, form, key, cookie, origin = base } = {}) {
  const result = await fetch(`${base}${route}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: form ?? (value ? JSON.stringify(value) : undefined), signal: AbortSignal.timeout(form ? 120_000 : 20_000) });
  return { status: result.status, data: result.headers.get('content-type')?.includes('application/json') ? await result.json() : Buffer.from(await result.arrayBuffer()), cookie: result.headers.get('set-cookie')?.split(';')[0], headers: result.headers };
}
async function user(suffix, operator) {
  const email = `${prefix}_${suffix}@example.invalid`, password = `${randomUUID()}aA1!`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true }); check(!created.error && created.data.user, 'Generated local account');
  const id = created.data.user.id; users.push(id);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); clients.push(client);
  check(Boolean((await client.auth.signInWithPassword({ email, password: 'invalid-password' })).error), 'Incorrect password cannot authenticate');
  const login = await client.auth.signInWithPassword({ email, password }); check(!login.error && login.data.session, 'Fresh generated password authentication');
  const value = { id, token: login.data.session.access_token, username: `${prefix}_${suffix}`, email, password, client };
  const privacy = await api('/api/account/privacy', { token: value.token, method: 'GET' });
  check(privacy.status === 200 && privacy.data.accepted === false && privacy.data.policyReady === true, 'Isolated fixture-only policy configuration is ready without invented acceptance');
  check((await api('/api/account/terms', { value: { termsVersion: version, privacyVersion: version } })).status === 401, 'Policy acceptance requires account authentication');
  check((await api('/api/account/terms', { token: value.token, value: { termsVersion: 'wrong-version', privacyVersion: version } })).status === 409, 'Stale policy versions cannot be accepted');
  const accepted = await api('/api/account/terms', { token: value.token, value: { termsVersion: version, privacyVersion: version } });
  check(accepted.status === 200 && accepted.data.accepted, 'Explicit acceptance of fixture-configured policy is durably stored');
  check((await api('/api/account/privacy', { token: value.token, method: 'GET' })).data.accepted, 'Version acceptance is returned authoritatively');
  check((await api('/api/profile', { token: value.token, value: { username: value.username } })).status === 200, 'Generated username saved');
  check((await api('/api/operator/profile', { token: operator, value: { username: value.username, action: 'approve', reason: 'Generated fixture name reviewed' } })).status === 200, 'Generated profile reviewed');
  return value;
}
async function objects(owner) {
  assert(users.includes(owner)); const paths = [];
  async function visit(path, depth = 0) {
    assert(depth < 5); const result = await db.storage.from('peekalo-captures').list(path, { limit: 100 });
    assert(!result.error && result.data.length < 100);
    for (const item of result.data) { assert(item.name && !/[\\/]/.test(item.name) && !['.', '..'].includes(item.name)); const child = `${path}/${item.name}`; if (item.id === null) await visit(child, depth + 1); else paths.push(child); }
  }
  await visit(owner); return paths;
}
async function cleanupFactory() {
  const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/account-cleanup.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (name === 'node:crypto') return require(name);
    if (name === './sharing') return { database: () => db, rpc: call };
    assert.equal(name, './private-media-cache'); return { privateMediaCache: { remove() {} } };
  }, module, module.exports);
  return module.exports.createAccountCleanup({ db, call: async (name, args) => {
    if (name === 'peekalo_deletion_jobs') return (await call(name, { p_limit: 50 })).filter(job => requests.some(item => item.requestId === job.requestId));
    // Global retention maintenance is verified in disposable PostgreSQL. This
    // integration may mutate only its generated fixture accounts/requests.
    if (name === 'peekalo_expire_private_records') return { reports: 0, audits: 0, receipts: 0 };
    assert(requests.some(item => item.requestId === args.p_request)); return call(name, args);
  } });
}
try {
  const operator = await fixtureOperator(db, users, prefix);
  const owner = await user('owner', operator), viewer = await user('viewer', operator), keeper = await user('keeper', operator), survivor = await user('survivor', operator);
  const bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#536f31' } }).jpeg().toBuffer();
  const form = () => { const f = new FormData(); f.set('kind', 'photo'); f.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'generated.jpg'); return f; };
  async function upload(actor) {
    const result = await api('/api/posts', { token: actor.token, form: form(), key: randomUUID() });
    check(result.status === 200 && result.data.status === 'moderation_pending', 'Generated capture awaits review');
    check((await api('/api/operator/decision', { token: operator, value: { postId: result.data.postId, action: 'approve', reason: 'Generated pattern reviewed' } })).status === 200, 'Generated capture approved'); return result.data.postId;
  }
  const ownedPost = await upload(owner), keptPost = await upload(keeper);
  const keptPaths = await objects(keeper.id); check(keptPaths.length === 1, 'Unrelated owner has one private capture');
  const ownPaths = await objects(owner.id); check(ownPaths.length === 1, 'Deletion target has one private capture');
  const grant = await api(`/api/posts/${keptPost}/recipients`, { token: keeper.token, value: { username: viewer.username } }); check(grant.status === 200, 'Other owner grants generated viewer');
  check((await api(`/api/inbox/${keptPost}/accept`, { token: viewer.token, value: {} })).status === 200, 'Viewer accepts request');
  check((await api(`/api/posts/${keptPost}/recipients`, { token: keeper.token, value: { username: survivor.username } })).status === 200, 'Other surviving viewer granted access');
  check((await api(`/api/inbox/${keptPost}/accept`, { token: survivor.token, value: {} })).status === 200, 'Surviving viewer accepts request');
  const survivedLease = await api('/api/view/direct', { token: survivor.token, value: { postId: keptPost, sessionId: randomUUID(), requestId: randomUUID() } });
  check(survivedLease.status === 200 && survivedLease.data.remainingMs === 8000, 'Surviving identity spends separate cumulative allowance');
  const link = await api(`/api/posts/${keptPost}/link`, { token: keeper.token, value: {}, key: randomUUID() }); check(link.status === 200, 'Other owner creates single-use link');
  const token = new URL(link.data.url).hash.slice(1);
  const claimed = await api('/api/view/lease', { token: viewer.token, value: { token, sessionId: randomUUID(), requestId: randomUUID() } });
  check(claimed.status === 200 && claimed.data.remainingMs === 8000, 'Deleting viewer claims link and spends cumulative allowance');
  const ownLink = await api(`/api/posts/${ownedPost}/link`, { token: owner.token, value: {}, key: randomUUID() }); check(ownLink.status === 200, 'Deletion target owns a live capability');
  const ownToken = new URL(ownLink.data.url).hash.slice(1);
  const guest = await api('/api/view/lease', { value: { token: ownToken, sessionId: randomUUID(), requestId: randomUUID() } }); check(guest.status === 200, 'Generated guest can reveal deletion target before disable');
  const report = await api('/api/safety/reports', { token: viewer.token, value: { postId: keptPost, reason: 'privacy', details: 'Synthetic deletion integration text' } }); check(report.status === 200, 'Generated safety report persists');
  check((await api('/api/account/delete', { value: { confirmation: 'DELETE', accountId: owner.id } })).status === 401, 'Anonymous external account-ID deletion denied');
  check((await api('/api/account/delete', { token: viewer.token, value: { confirmation: 'DELETE', accountId: owner.id } })).status === 400, 'Authenticated forged other-account deletion denied');
  check((await api('/api/account/delete', { token: viewer.token, value: { confirmation: 'delete' } })).status === 400, 'Destructive confirmation is explicit');
  check((await api('/api/account/delete', { token: viewer.token, origin: 'https://bad.invalid', value: { confirmation: 'DELETE' } })).status === 403, 'Cross-origin destructive request denied');
  for (const actor of [owner, viewer]) {
    const deleted = await api('/api/account/delete', { token: actor.token, value: { confirmation: 'DELETE' } });
    check(deleted.status === 202 && deleted.data.status === 'pending' && deleted.data.receipt, 'Verified account-control deletion queues durable pending cleanup');
    requests.push({ ...deleted.data, actor: actor.id });
    check(deleted.headers.get('cache-control').includes('no-store'), 'Deletion receipt response is not cached');
    const replay = await api('/api/account/delete', { token: actor.token, value: { confirmation: 'DELETE' } });
    check(replay.status === 202 && replay.data.requestId === deleted.data.requestId, 'Deletion retry reuses durable request');
    check((await api('/api/profile', { token: actor.token, method: 'GET' })).status === 403, 'Account access disabled immediately before provider cleanup');
    check((await api(`/api/profile/${actor.username}`, { method: 'GET' })).status === 404, 'Deleted profile immediately absent');
    const status = await api('/api/account/deletion-status', { value: { requestId: deleted.data.requestId, receipt: deleted.data.receipt } });
    check(status.status === 200 && status.data.status === 'pending', 'Receipt reports pending rather than fake success');
  }
  check((await api(new URL(guest.data.mediaUrl).pathname, { method: 'GET', cookie: guest.cookie })).status !== 200, 'Previously issued owner-media lease disabled');
  check((await api('/api/view/status', { value: { token: ownToken }, cookie: guest.cookie })).status !== 200, 'Owner link unavailable immediately');
  check((await api('/api/view/status', { value: { token } })).status !== 200, 'Deleting claimant cannot reopen other-owner claimed link');
  const before = await call('peekalo_deletion_jobs', { p_limit: 50 }); check(!before.some(item => requests.some(request => item.requestId === request.requestId)), 'Server enforces ten-minute cleanup grace');
  check((await objects(owner.id)).length === 1, 'Original target object remains private pending cleanup');
  for (const item of requests) {
    uuid(item.requestId);
    await sql(`update public.peekalo_account_deletions set requested_at=clock_timestamp()-interval '11 minutes',not_before=clock_timestamp()-interval '1 minute' where request_id='${item.requestId}' and account_id='${uuid(item.actor)}'`);
  }
  const run = await cleanupFactory(), result = await run(50); check(result.completed === 2 && result.pending === 0, 'Real private Storage/Auth/data cleanup completes fixture requests');
  check((await objects(owner.id)).length === 0, 'Deleted owner private objects actually removed');
  check(JSON.stringify(await objects(keeper.id)) === JSON.stringify(keptPaths), 'Unrelated owner private objects remain intact');
  for (const item of requests) {
    const absent = await db.auth.admin.getUserById(item.actor); check(absent.error?.code === 'user_not_found' && absent.error?.status === 404, 'Deleted Auth account actually absent');
    const status = await api('/api/account/deletion-status', { value: { requestId: item.requestId, receipt: item.receipt } }); check(status.status === 200 && status.data.status === 'complete', 'Possession-bound receipt now reports completed');
    check((await api('/api/account/deletion-status', { value: { requestId: item.requestId, receipt: 'a'.repeat(43) } })).status === 404, 'Forged receipt denied');
    check(await sql(`select count(*) from public.peekalo_policy_acceptances where account_id='${uuid(item.actor)}'`) === '0', 'Policy acceptance data cascades on deletion');
  }
  const survivorBalance = await api('/api/view/direct/status', { token: survivor.token, value: { postId: keptPost } });
  check(survivorBalance.status === 200 && survivorBalance.data.remainingMs === 8000, 'Deleting another viewer never resets surviving viewing allowance');
  const oldBudget = await db.from('peekalo_budgets').select('spent_ms,identity').eq('post_id', keptPost);
  check(!oldBudget.error && oldBudget.data.some(item => item.spent_ms === 2000 && item.identity.startsWith('g:') && !item.identity.includes(viewer.id)), 'Other-owner cumulative budget retained under nonrecoverable pseudonym');
  const retainedLink = await db.from('peekalo_links').select('revoked,claimed_identity').eq('post_id', keptPost);
  check(!retainedLink.error && retainedLink.data.some(item => item.revoked && item.claimed_identity?.startsWith('g:')), 'Other-owner claim remains permanently unavailable after claimant removal');
  check(await sql(`select count(*) from public.peekalo_reports where id='${uuid(report.data.reportId)}' and details='' and reporter_identity not like '%${uuid(viewer.id)}%'`) === '1', 'Retained report free text scrubbed and reporter anonymized');
  check((await api('/api/view/lease', { value: { token, sessionId: randomUUID(), requestId: randomUUID() } })).status !== 200, 'Cookie reset cannot claim deleted viewer link');
  check((await api('/api/posts', { token: keeper.token, method: 'GET' })).data.items.some(item => item.postId === keptPost), 'Unrelated owner keeps moment and access');
  console.log(`PASS ${passed} isolated-local account deletion assertions (generated fixtures only)`);
} finally {
  for (const client of clients) client.auth.stopAutoRefresh();
  for (const id of users) {
    const paths = await objects(id); if (paths.length) { const removed = await db.storage.from('peekalo-captures').remove(paths); assert(!removed.error); }
    const removed = await db.auth.admin.deleteUser(id);
    if (removed.error) { const current = await db.auth.admin.getUserById(id); assert(current.error?.code === 'user_not_found'); }
  }
  // Delete only generated durable receipts after generated Auth users are gone.
  for (const item of requests) await sql(`delete from public.peekalo_account_deletions where request_id='${uuid(item.requestId)}' and account_id='${uuid(item.actor)}'`);
}
