/** REL-06 real loopback Auth/API/Storage/Realtime checks. Run only against the
 * explicitly created empty rel06 stack; never consumes hosted/original data.
 * All identities, media, report text and chat bodies are generated fixtures.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clearTimeout } from 'node:timers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js'), sharp = require('sharp');
const exec = promisify(execFile), base = 'http://127.0.0.1:3136';
assert.equal(process.env.PEEKALO_SOCIAL_TEST, '1');
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:56321');
assert.equal(process.env.PUBLIC_APP_URL, base);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [], clients = [], requests = [], channels = [];
const prefix = `rel06_${randomUUID().replaceAll('-', '').slice(0, 8)}`, version = '2026-10-29-draft';
let passed = 0;
const check = (condition, label) => { assert(condition, label); passed++; };
const uuid = value => { assert(/^[0-9a-f-]{36}$/.test(value)); return value; };
// Newer Realtime adds a random delivery UUID to SQL's otherwise empty payload.
// This is transport metadata, never an account/post/message identifier.
const safeSignal = event => event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && Object.keys(event.payload).every(key => key === 'id' && /^[0-9a-f-]{36}$/.test(event.payload.id));
async function sql(statement) {
  return (await exec('docker', ['exec', 'supabase_db_peekalo-rel06-social-testing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAc', statement], { maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function call(name, args) { const result = await db.rpc(name, args); assert(!result.error, `Fixture RPC ${name} failed`); return result.data; }
async function api(route, { token, method = 'POST', value, form, key, origin = base } = {}) {
  const result = await fetch(`${base}${route}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: form ?? (value ? JSON.stringify(value) : undefined), signal: AbortSignal.timeout(form ? 120_000 : 20_000) });
  const data = result.headers.get('content-type')?.includes('application/json') ? await result.json() : Buffer.from(await result.arrayBuffer());
  return { status: result.status, data, headers: result.headers };
}
async function user(suffix, operator) {
  const email = `${prefix}_${suffix}@example.invalid`, password = `${randomUUID()}aA1!`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true }); check(!created.error && created.data.user, 'Generated local account');
  const id = created.data.user.id; users.push(id);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); clients.push(client);
  const login = await client.auth.signInWithPassword({ email, password }); check(!login.error && login.data.session, 'Real Auth password login');
  const actor = { id, token: login.data.session.access_token, username: `${prefix}_${suffix}`, email, password, client };
  if (!operator) {
    await sql(`insert into public.peekalo_operators(account_id) values('${uuid(id)}')`);
  }
  check((await api('/api/account/terms', { token: actor.token, value: { termsVersion: version, privacyVersion: version } })).status === 200, 'Generated account accepts fixture policy');
  check((await api('/api/profile', { token: actor.token, value: { username: actor.username } })).status === 200, 'Generated username saved');
  if (operator) check((await api('/api/operator/profile', { token: operator.token, value: { username: actor.username, action: 'approve', reason: 'Generated name reviewed' } })).status === 200, 'Independent operator approves generated username');
  return actor;
}
async function objects(owner) {
  const paths = [];
  async function visit(path, depth = 0) {
    assert(depth < 5); const result = await db.storage.from('peekalo-captures').list(path, { limit: 100 });
    assert(!result.error && result.data.length < 100);
    for (const item of result.data) { assert(item.name && !/[\\/]/.test(item.name) && !['.', '..'].includes(item.name)); const child = `${path}/${item.name}`; if (item.id === null) await visit(child, depth + 1); else paths.push(child); }
  }
  await visit(owner); return paths;
}
async function upload(actor, operator) {
  const bytes = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#536f31' } }).jpeg().toBuffer();
  const form = new FormData(); form.set('kind', 'photo'); form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'generated.jpg');
  const result = await api('/api/posts', { token: actor.token, form, key: randomUUID() });
  check(result.status === 200 && result.data.status === 'moderation_pending', 'Generated capture enters private moderation');
  check((await api('/api/operator/decision', { token: operator.token, value: { postId: result.data.postId, action: 'approve', reason: 'Generated pattern reviewed' } })).status === 200, 'Independent operator approves generated capture');
  return uuid(result.data.postId);
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
    if (name === 'peekalo_expire_private_records') return { reports: 0, audits: 0, receipts: 0 };
    assert(requests.some(item => item.requestId === args.p_request)); return call(name, args);
  } });
}
async function subscribe(actor, accountId = actor.id, events = []) {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); clients.push(client);
  await client.realtime.setAuth(actor.token);
  const channel = client.channel(`peekalo:account:${uuid(accountId)}`, { config: { private: true, broadcast: { ack: true } } })
    .on('broadcast', { event: 'invalidate' }, event => events.push(event));
  channels.push({ client, channel });
  const state = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('TIMED_OUT'), 15000);
    channel.subscribe(status => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) { clearTimeout(timer); resolve(status); } });
  });
  return { state, events, channel };
}
async function eventually(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) { check(true, label); return; } await new Promise(resolve => setTimeout(resolve, 50)); }
  check(false, label);
}
try {
  const operator = await user('operator');
  const owner = await user('owner', operator), viewer = await user('viewer', operator), stranger = await user('stranger', operator);
  const received = [], ownerEvents = [];
  const viewerSubscription = await subscribe(viewer, viewer.id, received);
  check(viewerSubscription.state === 'SUBSCRIBED', 'Authenticated native viewer subscribes to own private signal channel');
  check((await subscribe(owner, owner.id, ownerEvents)).state === 'SUBSCRIBED', 'Other account subscribes to its own private channel');
  check(await viewerSubscription.channel.send({ type: 'broadcast', event: 'invalidate', payload: { body: 'Generated forged broadcast attempt' } }) !== 'ok', 'Bearer cannot publish forged content into private signal channel');
  check((await subscribe(stranger, viewer.id)).state !== 'SUBSCRIBED', 'A guessed private topic is not channel authorization');
  check((await viewer.client.from('peekalo_social_items').select('*')).error, 'Bearer cannot bypass social authorization through REST tables');
  const epochBefore = await api('/api/social/epoch', { token: viewer.token, method: 'GET' });
  check(epochBefore.status === 200 && Number.isInteger(epochBefore.data.epoch), 'Authoritative epoch is available without content');
  check((await api('/api/social/conversations', { value: { username: viewer.username, requestKey: randomUUID() } })).status === 401, 'Anonymous conversation creation denied');
  const startKey = randomUUID();
  const started = await api('/api/social/conversations', { token: owner.token, value: { username: viewer.username, requestKey: startKey } });
  check(started.status === 200 && started.data.requestState === 'pending', 'First sender creates durable pending request');
  const conversation = uuid(started.data.conversationId), messages = `/api/social/conversations/${conversation}/messages`;
  check((await api('/api/social/conversations', { token: owner.token, value: { username: viewer.username, requestKey: startKey } })).data.conversationId === conversation, 'Conversation request retry reuses stable identity');
  check((await api(messages, { token: stranger.token, method: 'GET' })).status === 404, 'Guessed conversation cannot expose private messages');
  check((await api(`/api/social/conversations/${conversation}/respond`, { token: owner.token, value: { accept: true } })).status === 404, 'First sender cannot accept their own request');
  check((await api(messages, { token: viewer.token, value: { requestKey: randomUUID(), body: 'Generated premature reply' } })).status === 409, 'Recipient cannot send before request acceptance');
  const firstKey = randomUUID(), firstBody = 'Generated REL-06 first message';
  const first = await api(messages, { token: owner.token, value: { requestKey: firstKey, body: firstBody } });
  check(first.status === 200 && first.data.status === 'moderation_pending', 'Text remains private pending independent safety review');
  const firstId = uuid(first.data.messageId);
  check((await api(messages, { token: owner.token, value: { requestKey: firstKey, body: firstBody } })).data.messageId === firstId, 'Retried send creates no duplicate text');
  check((await api(messages, { token: owner.token, value: { requestKey: randomUUID(), body: 'Generated second request text' } })).status === 409, 'Pending first sender cannot spam a second request message');
  check((await api(messages, { token: viewer.token, method: 'GET' })).data.items.length === 0, 'Recipient receives no unapproved or unaccepted request body');
  const moderation = `/api/operator/social/message/${firstId}`;
  check((await api(moderation, { token: owner.token, method: 'GET' })).status === 403, 'Nonoperator private text inspection denied');
  const queue = await api('/api/operator/social', { token: operator.token, method: 'GET' });
  check(queue.status === 200 && queue.data.items.some(item => item.itemId === firstId), 'Bounded operator queue finds pending text');
  check(!JSON.stringify(queue.data).includes(firstBody), 'Queue metadata does not broadcast clear body');
  check((await api(moderation, { token: operator.token, method: 'GET' })).data.body === firstBody, 'Deliberate audited operator read returns private generated body');
  check((await api(moderation, { token: operator.token, value: { action: 'approve', reason: 'Generated text reviewed' } })).status === 200, 'Independent operator approves first message');
  check((await api(messages, { token: viewer.token, method: 'GET' })).data.items.length === 0, 'Approved request body still requires recipient acceptance');
  check((await api(`/api/social/conversations/${conversation}/respond`, { token: viewer.token, value: { accept: true } })).data.requestState === 'accepted', 'Recipient accepts durable one-to-one request');
  check((await api(messages, { token: viewer.token, method: 'GET' })).data.items.some(item => item.messageId === firstId && item.body === firstBody), 'Accepted participant reads approved message');
  await eventually(() => received.length > 0, 'Real Supabase private broadcast delivers generic durable-change invalidation');
  check(received.every(safeSignal), 'Realtime events contain no bodies, identifiers, references or capabilities');
  check((await api('/api/social/epoch', { token: viewer.token, method: 'GET' })).data.epoch > epochBefore.data.epoch, 'Durable epoch advances with changes');
  const reply = await api(messages, { token: viewer.token, value: { requestKey: randomUUID(), body: 'Generated participant reply' } });
  check(reply.status === 200 && reply.data.status === 'moderation_pending', 'Accepted recipient can compose text through the same safety path');
  check(!(await api(messages, { token: owner.token, method: 'GET' })).data.items.some(item => item.messageId === reply.data.messageId), 'Peer cannot read unreviewed reply');
  check((await api(`/api/operator/social/message/${uuid(reply.data.messageId)}`, { token: operator.token, value: { action: 'approve', reason: 'Generated reply reviewed' } })).status === 200, 'Independent reply review succeeds');
  check((await api(messages, { token: owner.token, method: 'GET' })).data.items.some(item => item.messageId === reply.data.messageId), 'Approved reply remains durable on a fresh authorized fetch');

  const page = await api(`${messages}?limit=1`, { token: viewer.token, method: 'GET' });
  check(page.status === 200 && page.data.items.length === 1 && page.data.nextCursor, 'Message history is bounded with a keyset cursor');
  const next = await api(`${messages}?limit=1&before=${encodeURIComponent(page.data.nextCursor.createdAt)}&beforeId=${page.data.nextCursor.id}`, { token: viewer.token, method: 'GET' });
  check(next.status === 200 && next.data.items.length === 1 && next.data.items[0].messageId !== page.data.items[0].messageId, 'Keyset page reads the next older authorized message without duplication');
  check((await api(messages, { token: owner.token, value: { requestKey: randomUUID(), body: 'Generated attachment attempt', file: 'fixture.jpg' } })).status === 400, 'Chat does not expose a file attachment bypass');
  const concurrentKey = randomUUID(), concurrentInput = { requestKey: concurrentKey, body: 'Generated idempotent concurrency fixture' };
  const concurrent = await Promise.all([api(messages, { token: owner.token, value: concurrentInput }), api(messages, { token: owner.token, value: concurrentInput })]);
  check(concurrent.every(item => item.status === 200) && concurrent[0].data.messageId === concurrent[1].data.messageId, 'Real concurrent HTTP retries persist one durable message');
  const post = await upload(owner, operator), comments = `/api/social/posts/${post}/comments`;
  check((await api(messages, { token: owner.token, value: { requestKey: randomUUID(), postId: post } })).status === 404, 'Reference cannot mint missing recipient grant');
  const grant = await api(`/api/posts/${post}/recipients`, { token: owner.token, value: { username: viewer.username } });
  check(grant.status === 200 && grant.data.accountId === viewer.id, 'Only owner creates explicit existing-moment grant');
  const reference = await api(messages, { token: owner.token, value: { requestKey: randomUUID(), postId: post } });
  check(reference.status === 200 && reference.data.kind === 'moment', 'Owner sends an existing approved moment reference without attachment path');
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: post } })).status === 404, 'Chat acceptance/reference cannot bypass pending moment acceptance');
  check((await api(comments, { token: viewer.token, method: 'GET' })).status === 404, 'Pending audience cannot read discussion');
  check((await api(`/api/inbox/${post}/accept`, { token: viewer.token, value: {} })).status === 200, 'Recipient explicitly accepts owner moment grant');
  check((await api('/api/inbox', { token: viewer.token, method: 'GET' })).data.items.some(item => item.postId === post), 'Existing received-moment Inbox remains available beside chat');
  check((await api(messages, { token: viewer.token, method: 'GET' })).data.items.some(item => item.messageId === reference.data.messageId && item.postId === post), 'Reference uses original post identity after grant acceptance');
  const forwarding = await api('/api/social/conversations', { token: viewer.token, value: { username: stranger.username, requestKey: randomUUID() } });
  check(forwarding.status === 200, 'Separate request can be created without granting content');
  check((await api(`/api/social/conversations/${uuid(forwarding.data.conversationId)}/messages`, { token: viewer.token, value: { requestKey: randomUUID(), postId: post } })).status === 404, 'Recipient cannot forward another owner moment');
  check((await api('/api/view/direct/status', { token: stranger.token, value: { postId: post } })).status === 404, 'Forward attempt creates no third-party reveal right');
  check((await api(comments, { method: 'GET' })).status === 401 && (await api(comments, { value: { requestKey: randomUUID(), body: 'Generated anonymous attempt' } })).status === 401, 'Anonymous browser identities cannot read or write comments');
  check((await api(comments, { token: stranger.token, method: 'GET' })).status === 404, 'Non-audience account cannot read comments');
  const comment = await api(comments, { token: viewer.token, value: { requestKey: randomUUID(), body: 'Generated audience comment' } });
  check(comment.status === 200 && comment.data.status === 'moderation_pending', 'Audience comment awaits manual review');
  const commentId = uuid(comment.data.commentId);
  check((await api(comments, { token: owner.token, method: 'GET' })).data.items.length === 0, 'Owner does not automatically receive unreviewed comment');
  check((await api(`/api/operator/social/comment/${commentId}`, { token: operator.token, value: { action: 'approve', reason: 'Generated comment reviewed' } })).status === 200, 'Independent comment review succeeds');
  check((await api(comments, { token: owner.token, method: 'GET' })).data.items.some(item => item.commentId === commentId), 'Approved flat comment visible to post owner');
  const report = await api('/api/safety/reports', { token: owner.token, value: { commentId, reason: 'privacy', details: 'Generated comment concern' } });
  check(report.status === 200 && report.data.reportId, 'Authorized comment report enters shared operator workflow');
  check((await api('/api/safety/reports', { token: stranger.token, value: { commentId, reason: 'other' } })).status === 404, 'Unauthorized comment report cannot probe target');
  check((await api('/api/safety/reports', { value: { messageId: firstId, reason: 'other' } })).status === 401, 'Anonymous message reporting cannot inspect native content');
  check((await api('/api/safety/reports', { token: viewer.token, value: { messageId: firstId, reason: 'harassment' } })).status === 200, 'Participant can report authorized message target');
  check((await api(`/api/social/comments/${commentId}`, { token: stranger.token, method: 'DELETE' })).status === 404, 'Unrelated account cannot remove comment');
  const ownComment = await api(comments, { token: owner.token, value: { requestKey: randomUUID(), body: 'Generated owner-removable comment' } });
  check(ownComment.status === 200 && (await api(`/api/social/comments/${uuid(ownComment.data.commentId)}`, { token: owner.token, method: 'DELETE' })).status === 200, 'Author can delete own pending comment');
  await sql(`insert into public.peekalo_budgets(post_id,identity,spent_ms) values('${post}','a:${viewer.id}',10000) on conflict(post_id,identity) do update set spent_ms=10000,active_session=null,active_until=null`);
  check((await api('/api/view/direct/status', { token: viewer.token, value: { postId: post } })).data.remainingMs === 0, 'Generated exhausted ledger reflected by authoritative status');
  check((await api(comments, { token: viewer.token, method: 'GET' })).data.items.some(item => item.commentId === commentId), 'Comments remain available after reveal exhaustion while audience remains valid');
  const rename = `${prefix}_renamed`;
  check((await api('/api/profile', { token: owner.token, value: { username: rename } })).data.reviewState === 'pending', 'Generated owner rename enters review');
  const renamedConversation = (await api('/api/social/conversations', { token: viewer.token, method: 'GET' })).data.items.find(item => item.conversationId === conversation);
  check(renamedConversation?.peerAccountId === owner.id && renamedConversation.peerUsername === null, 'Existing conversation retains stable account identity through pending rename');
  check((await api(messages, { token: viewer.token, method: 'GET' })).status === 200, 'Pending profile name does not silently break authorized existing conversation');
  check((await api('/api/operator/profile', { token: operator.token, value: { username: rename, action: 'approve', reason: 'Generated renamed profile reviewed' } })).status === 200, 'Independent renamed profile review succeeds'); owner.username = rename;

  check((await api(`/api/posts/${post}/recipients`, { token: owner.token, method: 'DELETE', value: { accountId: viewer.id } })).status === 200, 'Owner revokes existing moment audience');
  check((await api(comments, { token: viewer.token, method: 'GET' })).status === 404, 'Exhausted discussion becomes unavailable immediately on grant revocation');
  check((await api(messages, { token: viewer.token, method: 'GET' })).data.items.find(item => item.messageId === reference.data.messageId)?.postId === null, 'Reference card loses post capability after grant revocation');
  check((await api(`/api/social/comments/${commentId}`, { token: owner.token, method: 'DELETE' })).status === 200, 'Post owner can remove audience-authored comment');
  check(await sql(`select count(*) from public.peekalo_reports where id='${uuid(report.data.reportId)}' and details='' and resolution is null`) === '1', 'Removed social content scrubs associated report text');
  const signalCount = received.length;
  check((await api('/api/safety/blocks', { token: viewer.token, value: { accountId: owner.id } })).status === 200, 'Identified account creates bilateral block');
  await eventually(() => received.length > signalCount, 'Already-open subscription receives only generic block invalidation');
  check((await api(messages, { token: viewer.token, method: 'GET' })).status === 404 && (await api(messages, { token: owner.token, method: 'GET' })).status === 404, 'Block denies both directions on fresh authorized message reads');
  check((await api(messages, { token: owner.token, value: { requestKey: randomUUID(), body: 'Generated blocked send' } })).status === 404, 'Block denies writes on already-open conversation');
  check(!(await api('/api/social/conversations', { token: owner.token, method: 'GET' })).data.items.some(item => item.conversationId === conversation), 'Blocked conversation absent from current inventory');
  check(received.every(safeSignal), 'Existing subscriptions never receive clear bodies or capabilities after restriction');
  check((await api('/api/safety/blocks', { token: viewer.token, method: 'DELETE', value: { accountId: owner.id } })).status === 200, 'Deliberate unblock works by stable ID');
  check((await api(comments, { token: viewer.token, method: 'GET' })).status === 404, 'Unblock does not silently restore revoked discussion grant');
  check(await sql(`select spent_ms from public.peekalo_budgets where post_id='${post}' and identity='a:${viewer.id}'`) === '10000', 'References, block and unblock never reset viewing budget');

  check((await api(`/api/social/conversations/${uuid(forwarding.data.conversationId)}/respond`, { token: stranger.token, value: { accept: false } })).data.requestState === 'declined', 'Recipient can decline first-sender request');
  check((await api(`/api/social/conversations/${forwarding.data.conversationId}/messages`, { token: viewer.token, value: { requestKey: randomUUID(), body: 'Generated declined retry' } })).status === 404, 'Declined request cannot be silently reopened with text');
  check((await api('/api/operator/account', { token: operator.token, value: { username: owner.username, action: 'suspend', reason: 'Generated suspension fixture' } })).status === 200, 'Safety operator can suspend account used by active session');
  check((await api(messages, { token: viewer.token, method: 'GET' })).status === 404 && (await api('/api/social/epoch', { token: owner.token, method: 'GET' })).status !== 200, 'Suspension denies active peer reads and account epoch refresh');
  check((await subscribe(owner)).state !== 'SUBSCRIBED', 'New private subscription after suspension fails authorization');
  check((await api('/api/operator/account', { token: operator.token, value: { username: owner.username, action: 'restore', reason: 'Generated fixture recovery' } })).status === 200, 'Operator deliberately restores generated account');

  const deletion = await api('/api/account/delete', { token: viewer.token, value: { confirmation: 'DELETE' } });
  check(deletion.status === 202 && deletion.data.status === 'pending', 'Fresh Auth proof begins durable deletion');
  requests.push({ ...deletion.data, actor: viewer.id });
  check((await api('/api/social/conversations', { token: viewer.token, method: 'GET' })).status === 403, 'Disabled active account cannot read social inventory');
  check((await api(messages, { token: owner.token, method: 'GET' })).status === 404, 'Other participant loses deleted membership immediately');
  check(await sql(`select count(*) from public.peekalo_social_items where author_id='${viewer.id}' or conversation_id='${conversation}'`) === '0', 'Deletion scrubs actual social bodies and conversation references before Auth removal');
  check(await sql(`select count(*) from public.peekalo_conversations where sender_id='${viewer.id}' or recipient_id='${viewer.id}'`) === '0', 'Deletion removes actual conversation membership');
  check((await subscribe(viewer)).state !== 'SUBSCRIBED', 'Disabled account cannot authorize a new subscription');
  for (const item of requests) await sql(`update public.peekalo_account_deletions set requested_at=clock_timestamp()-interval '11 minutes',not_before=clock_timestamp()-interval '1 minute' where request_id='${uuid(item.requestId)}' and account_id='${uuid(item.actor)}'`);
  const run = await cleanupFactory(), cleanup = await run(50);
  check(cleanup.completed === 1 && cleanup.pending === 0, 'Real Storage/Auth/deletion maintenance completes generated account');
  check((await db.auth.admin.getUserById(viewer.id)).error?.code === 'user_not_found', 'Generated deleted Auth identity is actually absent');
  check((await api('/api/posts', { token: owner.token, method: 'GET' })).data.items.some(item => item.postId === post), 'Deleting conversation partner preserves unrelated owner moment');
  const checkpoint = JSON.parse(await sql('select public.peekalo_export_recovery_checkpoint()'));
  check(checkpoint.socialRestrictions.some(item => item.kind === 'conversation' && item.itemId === conversation), 'Recovery checkpoint includes removed membership suppression without bodies');
  check(!JSON.stringify(checkpoint).includes(firstBody), 'Recovery journal contains no social body text');
  check(received.every(safeSignal), 'All real delivered invalidations remain generic through deletion');
  const cascadePost = await upload(owner, operator);
  check((await api(`/api/posts/${cascadePost}/recipients`, { token: owner.token, value: { username: stranger.username } })).status === 200, 'Generated physical-delete fixture grants moment deliberately');
  check((await api(`/api/inbox/${cascadePost}/accept`, { token: stranger.token, value: {} })).status === 200, 'Generated physical-delete fixture accepts moment deliberately');
  const cascadeConversation = await api('/api/social/conversations', { token: owner.token, value: { username: stranger.username, requestKey: randomUUID() } });
  check(cascadeConversation.status === 200, 'Separate fixture conversation is durable');
  const cascadeMessages = `/api/social/conversations/${uuid(cascadeConversation.data.conversationId)}/messages`;
  const cascadeReference = await api(cascadeMessages, { token: owner.token, value: { requestKey: randomUUID(), postId: cascadePost } });
  check(cascadeReference.status === 200 && cascadeReference.data.kind === 'moment', 'Physical-delete fixture has an actual owner-sent moment reference');
  check((await api(`/api/social/conversations/${cascadeConversation.data.conversationId}/respond`, { token: stranger.token, value: { accept: true } })).status === 200, 'Separate fixture conversation accepted');
  const preservedText = await api(cascadeMessages, { token: owner.token, value: { requestKey: randomUUID(), body: 'Generated text surviving moment cascade' } });
  check(preservedText.status === 200, 'Independent text exists beside moment reference');
  check((await api(`/api/operator/social/message/${uuid(preservedText.data.messageId)}`, { token: operator.token, value: { action: 'approve', reason: 'Generated cascade fixture reviewed' } })).status === 200, 'Independent text approved before physical moment deletion');
  await sql(`delete from public.peekalo_posts where id='${cascadePost}' and owner_id='${owner.id}'`);
  const afterCascade = await api(cascadeMessages, { token: stranger.token, method: 'GET' });
  check(afterCascade.status === 200 && afterCascade.data.items.some(item => item.messageId === preservedText.data.messageId) && !afterCascade.data.items.some(item => item.messageId === cascadeReference.data.messageId), 'Actual PostgreSQL moment deletion removes obsolete reference while retaining conversation and unrelated text');
  check((await api('/api/posts', { token: owner.token, method: 'GET' })).data.items.some(item => item.postId === post), 'Physical fixture deletion preserves the unrelated original owner moment');
  const logicalPost = await upload(owner, operator);
  check((await api(`/api/posts/${logicalPost}/recipients`, { token: owner.token, value: { username: stranger.username } })).status === 200, 'Logical-delete fixture grants existing moment');
  check((await api(`/api/inbox/${logicalPost}/accept`, { token: stranger.token, value: {} })).status === 200, 'Logical-delete fixture accepts original grant');
  const logicalReference = await api(cascadeMessages, { token: owner.token, value: { requestKey: randomUUID(), postId: logicalPost } });
  const logicalComment = await api(`/api/social/posts/${logicalPost}/comments`, { token: stranger.token, value: { requestKey: randomUUID(), body: 'Generated comment removed with owner moment' } });
  check(logicalReference.status === 200 && logicalComment.status === 200, 'Logical-delete fixture stores reference and comment');
  check((await api(`/api/operator/social/comment/${uuid(logicalComment.data.commentId)}`, { token: operator.token, value: { action: 'approve', reason: 'Generated logical-delete comment reviewed' } })).status === 200, 'Independent operator reviews logical-delete comment');
  check((await api(`/api/posts/${logicalPost}`, { token: owner.token, method: 'DELETE' })).status === 200, 'Owner deletes moment through actual API');
  check(await sql(`select count(*) from public.peekalo_social_items where id in ('${uuid(logicalReference.data.messageId)}','${uuid(logicalComment.data.commentId)}') and status='removed' and body is null and reference_post is null`) === '2', 'Logical moment tombstone immediately scrubs actual reference/comment bodies');
  check((await api(`/api/social/posts/${logicalPost}/comments`, { token: stranger.token, method: 'GET' })).status === 404, 'Deleted moment discussion stays unavailable');
  check((await api(cascadeMessages, { token: stranger.token, method: 'GET' })).data.items.some(item => item.messageId === preservedText.data.messageId), 'Logical moment deletion preserves independent conversation text');
  check((await api('/api/operator/social/epoch', { token: operator.token, method: 'GET' })).status === 200, 'Privileged text fence accepts current independent operator');
  await sql(`update public.peekalo_operators set enabled=false where account_id='${uuid(operator.id)}'`);
  check((await api('/api/social/epoch', { token: operator.token, method: 'GET' })).status === 200, 'Removed operator retains ordinary account eligibility');
  check((await api('/api/operator/social/epoch', { token: operator.token, method: 'GET' })).status === 403, 'Privileged delivery fence rejects freshly revoked operator membership');
  await sql(`update public.peekalo_operators set enabled=true where account_id='${uuid(operator.id)}'`);
  console.log(`PASS ${passed} isolated-local social assertions (generated fixtures only)`);
} finally {
  for (const item of channels) await item.client.removeChannel(item.channel);
  for (const client of clients) { client.auth.stopAutoRefresh(); await client.removeAllChannels(); }
  for (const id of users) {
    const paths = await objects(id); if (paths.length) { const removed = await db.storage.from('peekalo-captures').remove(paths); assert(!removed.error); }
    const removed = await db.auth.admin.deleteUser(id);
    if (removed.error) { const current = await db.auth.admin.getUserById(id); assert(current.error?.code === 'user_not_found'); }
  }
  for (const item of requests) await sql(`delete from public.peekalo_account_deletions where request_id='${uuid(item.requestId)}' and account_id='${uuid(item.actor)}'`);
  if (users.length) await sql(`delete from realtime.messages where topic in (${users.map(id => `'peekalo:account:${uuid(id)}'`).join(',')})`);
}
