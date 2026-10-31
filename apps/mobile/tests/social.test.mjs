import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const source = compile('../src/components/social.tsx');
const clientSource = compile('../src/lib/social-client.ts');
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clientModule(apiRequest = () => {}) {
  const exported = {};
  vm.runInNewContext(clientSource, { exports: exported, AbortController, URLSearchParams, WeakMap, Set, Map, require: name => { assert.equal(name, './sharing-client'); return { apiRequest }; } });
  return exported;
}
const social = clientModule();

test('an invalidation clears old text synchronously and rejects delayed stale reads', async () => {
  const reads = [], states = [];
  const gate = social.createSocialResource({ load(signal) { const pending = deferred(); reads.push({ ...pending, signal }); return pending.promise; }, changed: state => states.push(state) });
  const first = gate.refresh(); reads[0].resolve({ body: 'Generated old text' }); await first;
  const old = gate.refresh(); assert.equal(states.at(-1).data, null);
  const fresh = gate.refresh(); assert.equal(reads[1].signal.aborted, true);
  reads[1].resolve({ body: 'Late unauthorized text' }); await old;
  assert.equal(states.at(-1).data, null);
  reads[2].resolve({ body: 'Generated current text' }); await fresh;
  assert.equal(states.at(-1).data.body, 'Generated current text');
  gate.dispose();
});

test('revoked reads fail closed and never expose backend diagnostics or the previous body', async () => {
  const states = []; let blocked = false;
  const gate = social.createSocialResource({ load: async () => { if (blocked) throw new Error('private fixture body'); return { body: 'Generated allowed text' }; }, changed: state => states.push(state) });
  await gate.refresh(); blocked = true; await gate.refresh();
  assert.equal(states.at(-1).data, null); assert(!states.at(-1).error.includes('private fixture'));
  gate.dispose();
});

test('dispose and account interruption abort in-flight mutations and cannot republish old bodies', async () => {
  const states = [], mutation = deferred(); let signal;
  const gate = social.createSocialResource({ load: async () => ({ body: 'Never rendered' }), changed: state => states.push(state) });
  const pending = gate.mutate(value => { signal = value; return mutation.promise; });
  gate.dispose(); assert.equal(signal.aborted, true); const count = states.length;
  mutation.resolve({}); assert.equal(await pending, false); assert.equal(states.length, count);
});

test('double taps execute one mutation; early realtime signal coalesces before confirmed send', async () => {
  let mutations = 0; const pending = deferred(); const states = [];
  const gate = social.createSocialResource({ load: async () => ({ items: [] }), changed: state => states.push(state) });
  const send = () => gate.mutate(() => { mutations++; return pending.promise; });
  const first = send(); assert.equal(await send(), false); assert.equal(mutations, 1);
  assert.equal(await gate.refresh(), false); pending.resolve({}); assert.equal(await first, true); assert.equal(states.at(-1).data.items.length, 0);
  gate.dispose();
});

test('restriction epoch changes on either side of an authorized read discard the result', async () => {
  const calls = [], replies = [{ epoch: 1 }, { body: 'Generated text' }, { epoch: 2 }];
  const module = clientModule(async (path, options) => { calls.push({ path, options }); return replies.shift(); });
  await assert.rejects(module.readSocial('/api/social/comments', 'fixture-account', new AbortController().signal), /stale/);
  assert.equal(calls.length, 3); assert(calls.every(call => call.options.expectedAccountId === 'fixture-account'));
});

test('missing or revoked epoch fails closed; stable epoch permits exhausted-audience discussion data', async () => {
  const replies = [{ epoch: '17' }, { items: [{ body: 'Generated comment' }] }, { epoch: '17' }];
  const module = clientModule(async () => replies.shift());
  const result = await module.readSocial('/api/social/posts/fixture/comments', 'fixture-account', new AbortController().signal);
  assert.equal(result.items[0].body, 'Generated comment');
  const absent = clientModule(async path => path.endsWith('/epoch') ? {} : { items: [] });
  await assert.rejects(absent.readSocial('/fixture', 'fixture-account', new AbortController().signal), /stale/);
});

test('bounded pagination encodes the full stable tuple', () => {
  const url = new URL(social.socialPageUrl('/api/social/conversations', { createdAt: '2026-10-30T10:15:00Z', id: 'fixture-id' }), 'https://fixture.invalid');
  assert.equal(url.searchParams.get('limit'), '30'); assert.equal(url.searchParams.get('before'), '2026-10-30T10:15:00Z'); assert.equal(url.searchParams.get('beforeId'), 'fixture-id');
});

test('panels share one private invalidation subscription and ignore any payload', () => {
  let joined = 0, removed = 0, signal, status; const calls = [];
  const channel = { on(type, filter, callback) { assert.equal(type, 'broadcast'); assert.equal(filter.event, 'invalidate'); signal = callback; return this; }, subscribe(callback) { status = callback; return this; } };
  const client = { channel(topic, config) { joined++; assert.equal(topic, 'peekalo:account:fixture-account'); assert.equal(config.config.private, true); return channel; }, removeChannel() { removed++; } };
  const releaseA = social.subscribeSocialSignals(client, 'fixture-account', () => calls.push('a'));
  const releaseB = social.subscribeSocialSignals(client, 'fixture-account', () => calls.push('b'));
  assert.equal(joined, 1); signal({ payload: { body: 'Ignored malicious fixture payload' } }); assert.equal(calls.join(','), 'a,b');
  releaseA(); status('CHANNEL_ERROR'); assert.equal(calls.join(','), 'a,b,b'); assert.equal(removed, 0);
  releaseB(); releaseB(); assert.equal(removed, 1);
});

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return undefined; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const textContent = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(textContent).join('') : textContent(node.props?.children);
function harness(t, name, props = {}, options = {}) {
  let bootstrapAttempts = 0;
  const cells = [], requests = [], listeners = new Set(), appListeners = new Set(), ticks = new Set();
  let cursor = 0, tree, component, focused, cleanup, mounted = true, counter = 0, signal, status, removed = 0;
  let session = { user: { id: 'fixture-viewer' } };
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const render = () => { cursor = 0; tree = component({ accountId: 'fixture-viewer', postId: 'fixture-post', ...props }); };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { assert(mounted, 'Late social completion after unmount'); cells[index] = typeof value === 'function' ? value(cells[index]) : value; render(); }]; },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++; if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { fn, deps }; return cells[index].fn; },
  };
  const channel = { on(_type, _filter, callback) { signal = callback; return this; }, subscribe(callback) { status = callback; return this; } };
  const client = { channel: () => channel, removeChannel() { removed++; }, auth: { getSession: async () => ({ data: { session } }), onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } }; } } };
  const apiRequest = (path, options = {}) => { const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; };
  const module = clientModule(apiRequest);
  const jsx = (type, props) => ({ type, props });
  const adapters = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'expo-router': { useFocusEffect(callback) { focused = callback; } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value }, AppState: { currentState: 'active', addEventListener(_event, callback) { appListeners.add(callback); return { remove() { appListeners.delete(callback); } }; } } },
    '../lib/sharing-client': { apiRequest, getSharingClient: async () => { bootstrapAttempts++; if (options.failBootstrap && bootstrapAttempts === 1) throw new Error('fixture bootstrap unavailable'); return client; }, newIdempotencyKey: () => `fixture-key-${++counter}` },
    '../lib/social-client': module, './received-moment': { ReceivedMoment: 'ReceivedMoment' }, './ui': { colors: {}, tokens: { space: {}, radius: {}, type: {} }, typography: {} } };
  const exported = {};
  vm.runInNewContext(source + '\nexports.__detail = ConversationDetail; exports.__safety = SocialSafety;', { exports: exported, AbortController, setInterval(callback) { ticks.add(callback); return callback; }, clearInterval(callback) { ticks.delete(callback); }, require: name => { assert(Object.hasOwn(adapters, name), `Unexpected ${name}`); return adapters[name]; } });
  component = exported[name]; render(); cleanup = focused();
  const close = () => { if (!mounted) return; cleanup?.(); cleanup = undefined; mounted = false; };
  t.after(close);
  return { requests,
    async load(data, epoch = '1') {
      await flush(); assert.equal(requests.at(-1).path, '/api/social/epoch'); requests.at(-1).resolve({ epoch });
      await flush(); if (!Object.hasOwn(data, 'epoch')) assert.notEqual(requests.at(-1).path, '/api/social/epoch'); requests.at(-1).resolve(data);
      await flush(); assert.equal(requests.at(-1).path, '/api/social/epoch'); requests.at(-1).resolve({ epoch }); await flush();
    },
    press(label) { const node = find(tree, node => node.props?.label === label || (typeof node.props?.onPress === 'function' && textContent(node) === label)); assert(node, `Missing ${label}`); assert(!node.props.disabled, `Disabled ${label}`); node.props.onPress(); },
    input(label, value) { const node = find(tree, node => node.props?.label === label && node.props?.onChange); assert(node, `Missing input ${label}`); node.props.onChange(value); },
    text: () => textContent(tree), error: () => find(tree, node => node.props?.error)?.props.error, has: label => !!find(tree, node => node.props?.label === label),
    signal(payload = {}) { signal(payload); }, status(value) { status(value); },
    background() { for (const callback of appListeners) callback('background'); }, foreground() { for (const callback of appListeners) callback('active'); },
    auth(id) { session = id ? { user: { id } } : null; for (const callback of listeners) callback(id ? 'SIGNED_IN' : 'SIGNED_OUT', session); },
    tick() { for (const callback of ticks) callback(); }, props(value) { Object.assign(props, value); render(); }, node(predicate) { return find(tree, predicate); }, close, removed: () => removed,
    inputValue(label) { return find(tree, node => node.props?.label === label && node.props?.onChange)?.props.value; },
  };
}
const comment = (extra = {}) => ({ commentId: 'fixture-comment', postId: 'fixture-post', authorAccountId: 'fixture-peer', authorUsername: null, body: 'Generated approved comment', status: 'approved', createdAt: '2026-10-30', ...extra });

test('comments show approved readable text and author identity survives pending username', async t => {
  const h = harness(t, 'MomentComments'); await h.load({ items: [comment()], nextCursor: null });
  assert(h.text().includes('Generated approved comment')); assert(h.text().includes('Account awaiting review')); assert(h.has('Report comment')); assert(!h.has('Delete your comment'));
  assert(h.text().includes('Text is readable without holding'));
});

test('comment author and post owner get distinct deletion controls', async t => {
  const h = harness(t, 'MomentComments', { owner: true }); await h.load({ items: [comment(), comment({ commentId: 'own', authorAccountId: 'fixture-viewer' })], nextCursor: null });
  assert(h.has('Remove comment from your moment')); assert(h.has('Delete your comment'));
  h.press('Remove comment from your moment'); assert.equal(h.requests.at(-1).method, 'DELETE'); assert.equal(h.requests.at(-1).path, '/api/social/comments/fixture-comment'); assert.equal(h.requests.at(-1).expectedAccountId, 'fixture-viewer');
});

test('background drops visible comments and drafts, aborts old read, and foreground reauthorizes', async t => {
  const h = harness(t, 'MomentComments'); await h.load({ items: [comment()], nextCursor: null }); h.input('Write a comment', 'Generated private draft');
  h.signal(); await flush(); const old = h.requests.at(-1); h.background();
  assert.equal(old.signal.aborted, true); assert(!h.text().includes('Generated approved comment')); assert.equal(h.inputValue('Write a comment'), '');
  old.resolve({ epoch: '1' }); await flush(); assert(!h.text().includes('Generated approved comment'));
  h.foreground(); await h.load({ items: [], nextCursor: null }, '2'); assert(h.text().includes('No comments yet.'));
});

test('account switch invalidates an in-flight submission and clears the private draft', async t => {
  const h = harness(t, 'MomentComments'); await h.load({ items: [], nextCursor: null }); h.input('Write a comment', 'Generated private draft'); h.press('Submit comment for review');
  const sent = h.requests.at(-1); assert.equal(sent.body.body, 'Generated private draft'); h.auth('fixture-other'); assert.equal(sent.signal.aborted, true); assert.equal(h.inputValue('Write a comment'), '');
  sent.resolve({}); await flush(); assert(!h.text().includes('Generated private draft')); assert(!h.has('Delete your comment'));
});

test('periodic authorization failure removes already-open discussion text', async t => {
  const h = harness(t, 'MomentComments'); await h.load({ items: [comment()], nextCursor: null }); h.tick(); await flush();
  assert(!h.text().includes('Generated approved comment')); h.requests.at(-1).reject(new Error('fixture denied')); await flush(); assert(h.error().includes('discussion is unavailable'));
});

test('late completions after unmount cannot resurrect text or keep a realtime join', async t => {
  const h = harness(t, 'MomentComments'); await flush(); const pending = h.requests.at(-1); h.close(); assert.equal(pending.signal.aborted, true); pending.resolve({ epoch: '1' }); await flush(); assert.equal(h.removed(), 1);
});

test('new sender request has a stable key on uncertain retry, then rotates after confirmed success', async t => {
  const h = harness(t, 'Conversations'); await h.load({ items: [], nextCursor: null }); h.input('Conversation username', '@fixture_peer'); h.press('Request a conversation');
  const first = h.requests.at(-1); assert.equal(first.body.username, 'fixture_peer'); first.reject(new Error('fixture transient')); await h.load({ items: [], nextCursor: null });
  h.press('Request a conversation'); const retry = h.requests.at(-1); assert.equal(retry.body.requestKey, first.body.requestKey); retry.resolve({ conversationId: 'fixture-chat' }); await h.load({ items: [], nextCursor: null });
  h.input('Conversation username', 'fixture_peer'); h.press('Request a conversation'); assert.notEqual(h.requests.at(-1).body.requestKey, first.body.requestKey);
});

const conversation = { conversationId: 'fixture-conversation', peerAccountId: 'fixture-peer', peerUsername: null, requestState: 'accepted', incoming: true, createdAt: '2026-10-30' };
test('selected conversation stays mounted with an access mask while periodic membership reauthorizes', async t => {
  const h = harness(t, 'Conversations'); await h.load({ items: [conversation], nextCursor: null }); h.press('Open conversation with Account awaiting review');
  const detail = h.node(node => node.props?.conversation); assert.equal(detail.props.authorized, true);
  h.tick(); await flush(); const checking = h.node(node => node.props?.conversation); assert(checking); assert.equal(checking.type, detail.type); assert.equal(checking.props.authorized, false);
  await h.load({ items: [conversation], nextCursor: null }); assert.equal(h.node(node => node.props?.conversation).props.authorized, true);
  h.tick(); await flush(); h.requests.at(-1).reject(new Error('fixture revoked')); await flush(); assert.equal(h.node(node => node.props?.conversation), undefined);
});

test('a selected detail masks drafts during reauthorization, retains them on success and discards on denial', async t => {
  const h = harness(t, '__detail', { conversation, authorized: true }); await h.load({ items: [], nextCursor: null }); h.input('Write a message', 'Generated private draft');
  h.props({ authorized: false }); assert.equal(h.inputValue('Write a message'), undefined); assert(h.text().includes('Checking conversation access'));
  h.props({ authorized: true }); assert.equal(h.inputValue('Write a message'), 'Generated private draft');
  h.tick(); await flush(); h.requests.at(-1).reject(new Error('fixture revoked')); await flush(); assert.equal(h.inputValue('Write a message'), '');
});

test('conversation accept and decline never reuse the moment acceptance endpoint', async t => {
  const h = harness(t, '__detail', { conversation: { ...conversation, requestState: 'pending' }, authorized: true }); await h.load({ items: [], nextCursor: null });
  h.press('Decline conversation'); const pending = h.requests.at(-1); assert.equal(pending.path, '/api/social/conversations/fixture-conversation/respond'); assert.equal(pending.body.accept, false); assert.equal(pending.expectedAccountId, 'fixture-viewer');
});

test('opening an existing-moment reference first checks its original audience and kind without a new grant', async t => {
  const h = harness(t, '__detail', { conversation, authorized: true }); await h.load({ items: [{ messageId: 'fixture-message', conversationId: conversation.conversationId, authorAccountId: 'fixture-peer', body: null, kind: 'moment', postId: 'fixture-post', status: 'approved', createdAt: '2026-10-30' }], nextCursor: null });
  h.press('Open referenced moment'); const status = h.requests.at(-1); assert.equal(status.path, '/api/view/direct/status'); assert.equal(status.body.postId, 'fixture-post');
  status.resolve({ state: 'exhausted', kind: 'video', remainingMs: 0 });
  await h.load({ items: [], nextCursor: null });
  const viewer = h.node(node => node.type === 'ReceivedMoment'); assert.equal(viewer.props.postId, 'fixture-post'); assert.equal(viewer.props.kind, 'video'); assert(!h.requests.some(request => request.path.includes('/recipients') || request.path.includes('/accept')));
});

test('message composer sends native text without attachment fields', async t => {
  const h = harness(t, '__detail', { conversation, authorized: true }); await h.load({ items: [], nextCursor: null }); h.input('Write a message', 'Generated message');
  h.press('Send text for review'); const sent = h.requests.at(-1); assert.equal(sent.body.body, 'Generated message'); assert.equal(sent.body.postId, undefined); assert.equal(sent.body.file, undefined);
});

test('an uncertain message response preserves its draft and request key after fresh audience authorization', async t => {
  const h = harness(t, '__detail', { conversation, authorized: true }); await h.load({ items: [], nextCursor: null }); h.input('Write a message', 'Generated uncertain send'); h.press('Send text for review');
  const first = h.requests.at(-1); first.reject(new Error('fixture response lost'));
  await h.load({ items: [{ messageId: 'fixture-committed', authorAccountId: 'fixture-viewer', body: 'Generated uncertain send', status: 'moderation_pending', kind: 'text', postId: null }], nextCursor: null });
  assert.equal(h.inputValue('Write a message'), 'Generated uncertain send'); h.press('Send text for review'); assert.equal(h.requests.at(-1).body.requestKey, first.body.requestKey);
});

test('own-send realtime arriving before its HTTP response does not abort the send or lose success', async t => {
  const h = harness(t, '__detail', { conversation, authorized: true }); await h.load({ items: [], nextCursor: null }); h.input('Write a message', 'Generated confirmed send'); h.press('Send text for review');
  const sent = h.requests.at(-1); const count = h.requests.length; h.signal(); await flush(); assert.equal(sent.signal.aborted, false); assert.equal(h.requests.length, count);
  sent.resolve({ messageId: 'fixture-message' }); await h.load({ items: [], nextCursor: null }); assert.equal(h.inputValue('Write a message'), '');
});

test('manual retry after failed client bootstrap installs identity protection before reading text', async t => {
  const h = harness(t, 'MomentComments', {}, { failBootstrap: true }); await flush(); assert.equal(h.requests.length, 0); assert(h.error().includes('Cannot connect'));
  h.press('Refresh comments'); await h.load({ items: [comment()], nextCursor: null }); assert(h.text().includes('Generated approved comment'));
  h.auth(null); assert(!h.text().includes('Generated approved comment')); assert.equal(h.removed(), 1);
});

test('comment safety pins its author account for blocks through username changes', async t => {
  const h = harness(t, 'MomentComments'); await h.load({ items: [comment()], nextCursor: null }); h.press('Report comment');
  const safety = h.node(node => node.props?.peerAccountId); assert.equal(safety.props.peerAccountId, 'fixture-peer'); assert.equal(safety.props.target.id, 'fixture-comment');
  safety.props.onBlocked(); await h.load({ items: [], nextCursor: null }, '2'); assert(!h.text().includes('Generated approved comment'));
});

test('content reports require a deliberate reason and author block uses only the stable account id', async t => {
  let blocked = 0;
  const h = harness(t, '__safety', { target: { kind: 'comment', id: 'fixture-comment' }, peerAccountId: 'fixture-peer', onClose() {}, onBlocked() { blocked++; } }); await h.load({ epoch: '1' });
  assert.equal(h.node(node => node.props?.label === 'Submit private report').props.disabled, true);
  h.press('○ Spam or scam'); h.press('Submit private report'); const sent = h.requests.at(-1); assert.equal(sent.body.reason, 'spam'); assert.equal(sent.body.commentId, 'fixture-comment'); assert.equal(sent.body.accountId, undefined);
  sent.resolve({ reportId: 'fixture-report' }); await h.load({ epoch: '1' });
  h.press('Block this account'); h.press('Confirm account block'); const block = h.requests.at(-1); assert.equal(block.path, '/api/safety/blocks'); assert.equal(block.body.accountId, 'fixture-peer'); assert.equal(block.body.username, undefined);
  block.resolve({ blocked: true }); await h.load({ epoch: '2' }, '2'); assert.equal(blocked, 1);
});

test('comment-author account report remains distinct from the comment target', async t => {
  const h = harness(t, '__safety', { target: { kind: 'comment', id: 'fixture-comment' }, peerAccountId: 'fixture-peer', onClose() {}, onBlocked() {} }); await h.load({ epoch: '1' });
  h.press('Report this author account instead'); h.press('○ Harassment or hate'); h.press('Submit private report'); const sent = h.requests.at(-1); assert.equal(sent.body.reason, 'harassment'); assert.equal(sent.body.accountId, 'fixture-peer'); assert.equal(sent.body.commentId, undefined);
});

test('unconfirmed social safety replies never claim a report or account block succeeded', async t => {
  let blocked = 0;
  const h = harness(t, '__safety', { target: { kind: 'comment', id: 'fixture-comment' }, peerAccountId: 'fixture-peer', onClose() {}, onBlocked() { blocked++; } }); await h.load({ epoch: '1' });
  h.press('○ Something else'); h.press('Submit private report'); h.requests.at(-1).resolve({}); await h.load({ epoch: '1' }); assert(!h.text().includes('Report received'));
  h.press('Block this account'); h.press('Confirm account block'); h.requests.at(-1).resolve({ blocked: false }); await h.load({ epoch: '1' }); assert.equal(blocked, 0);
});
