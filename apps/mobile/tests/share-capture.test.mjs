import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Actual modal logic, generated cache references only; no device/service access.
const source = ts.transpileModule(readFileSync(new URL('../src/components/share-capture.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
};
class SharingError extends Error { constructor(message, code = 'unavailable') { super(message); this.code = code; } }
function harness(t, privacy = { accepted: true, policyReady: true, deletionStatus: null }) {
  let now = Date.parse('2026-10-28T00:00:00Z');
  class ClientDate extends Date { static now() { return now; } }
  const hooks = [], effects = new Map(), requests = [], subscribers = new Set(), shares = [];
  let cursor = 0, component, tree, mounted = true, scheduled = false, key = 0;
  let session = { user: { id: 'fixture-owner' } };
  let props = { visible: true, capture: { uri: 'file:///non-sensitive-generated-camera-fixture.jpg', kind: 'photo' }, onClose() {} };
  const jsx = (type, props) => ({ type, props });
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => { if (scheduled || !mounted) return; scheduled = true; queueMicrotask(() => { scheduled = false; if (mounted) render(); }); };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { state: initial }; return [hooks[i].state, value => { assert(mounted, 'Late completion updated unmounted modal'); hooks[i].state = typeof value === 'function' ? value(hooks[i].state) : value; schedule(); }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, prior = hooks[i]; if (!prior || !same(prior.deps, deps)) { hooks[i] = { deps, cleanup: prior?.cleanup }; effects.set(i, fn); } },
  };
  const render = () => { cursor = 0; tree = component(props); for (const [i, fn] of effects) { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); } effects.clear(); };
  const client = { auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange(fn) { subscribers.add(fn); return { data: { subscription: { unsubscribe() { subscribers.delete(fn); } } } }; },
  } };
  class FixtureForm { fields = []; append(...args) { this.fields.push(args); } }
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@expo/vector-icons/AntDesign': { default: 'AntDesign' }, '@expo/vector-icons/Feather': { default: 'Feather' },
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])), Platform: { OS: 'android' }, StyleSheet: { create: value => value }, Share: { dismissedAction: 'dismissed', async share(value) { shares.push(value); return { action: 'dismissed' }; } } },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    '../lib/sharing-client': { SharingError, getSharingClient: async () => client, resolveApiUrl: path => `https://fixture.invalid${path}`, newIdempotencyKey: () => `fixture-key-${++key}`,
      apiRequest(path, options = {}) { if (path === '/api/account/privacy') return Promise.resolve(privacy); const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; } },
    './account-privacy': { TermsAcceptance: 'TermsAcceptance' },
    './apple-sign-in': { AppleSignIn: 'AppleSignIn' },
    '../lib/auth-confirmation': { subscribeEmailConfirmation: () => () => {} },
    '../lib/auth-recovery': { subscribePasswordRecovery: () => () => {} },
    './ui': { colors: {}, tokens: { font: {} } }, './brand': { BrandLogo: 'BrandLogo' },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; }, AbortController, URL, Date: ClientDate, FormData: FixtureForm });
  component = exported.ShareCapture; render();
  const unmount = () => { if (!mounted) return; for (const h of hooks) h?.cleanup?.(); mounted = false; };
  t.after(unmount);
  return {
    requests, shares, unmount,
    advance(ms) { now += ms; },
    async ready(reviewState) { await flush(); assert.equal(requests.at(-1).path, '/api/profile'); requests.at(-1).resolve({ username: 'fixture_owner', reviewState }); await flush(); },
    press(label) { const action = find(tree, node => node.props?.label === label); assert(action, `Missing ${label}`); if (!action.props.disabled) action.props.onPress(); },
    input(value) { find(tree, node => node.props?.accessibilityLabel === 'Recipient username').props.onChangeText(value); },
    inputUsername(value) { find(tree, node => node.props?.accessibilityLabel === 'Your username').props.onChangeText(value); },
    text: () => JSON.stringify(tree, (_key, value) => typeof value === 'function' ? undefined : value),
    visible(value) { props = { ...props, visible: value }; render(); },
    account(id) { session = id ? { user: { id } } : null; for (const fn of subscribers) fn(id ? 'SIGNED_IN' : 'SIGNED_OUT', session); },
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
  };
}

test('failed upload retry reuses its capture key and sends no link before ready', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  const upload = h.requests.at(-1); assert.equal(upload.path, '/api/posts'); assert.equal(upload.expectedAccountId, 'fixture-owner');
  upload.reject(new SharingError('Retry upload', 'upload_failed')); await flush(); h.press('Try the same action again'); await flush();
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], upload.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush();
  assert.equal(h.requests.at(-1).path, '/api/posts/fixture-post/link');
});

test('link failure retries the same saved post and key, and share cancellation mints no replacement', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush(); const link = h.requests.at(-1);
  link.reject(new SharingError('Offline')); await flush(); h.press('Try the same action again'); await flush();
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], link.headers['Idempotency-Key']);
  assert.equal(h.requests.filter(r => r.path === '/api/posts').length, 1);
  h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01' }); await flush();
  h.press('Share link'); await flush();
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], link.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01' }); await flush();
  assert.equal(h.shares.length, 2);
  assert.equal(h.requests.filter(r => r.path.endsWith('/link')).length, 3);
});

test('recipient retry keeps its original target even after editing input, without reuploading', async t => {
  const h = harness(t); await h.ready(); h.input('fixture_recipient'); await flush(); h.press('Send to recipient'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush();
  h.requests.at(-1).reject(new SharingError('Offline')); await flush(); h.input('someone_else'); h.press('Try the same action again'); await flush();
  assert.equal(h.requests.at(-1).body.username, 'fixture_recipient'); assert.equal(h.requests.filter(r => r.path === '/api/posts').length, 1);
});

for (const interruption of ['close', 'unmount', 'account']) test(`${interruption} fences a late upload and prevents a stale share`, async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush(); const pending = h.requests.at(-1);
  if (interruption === 'close') h.visible(false); else if (interruption === 'account') h.account('another-owner'); else h.unmount();
  assert(pending.signal.aborted); pending.resolve({ postId: 'fixture-old-post', status: 'ready' }); await flush();
  assert.equal(h.requests.some(r => r.path.includes('fixture-old-post')), false); assert.equal(h.shares.length, 0);
});

test('closing and reopening retains an ambiguous upload idempotency key', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush(); const first = h.requests.at(-1);
  h.visible(false); first.reject(new SharingError('Cancelled')); await flush(); h.visible(true); await h.ready();
  h.press('Create a single-use link'); await flush(); assert.equal(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});

test('untrusted link responses cannot enter the native share sheet', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush();
  h.requests.at(-1).resolve({ url: `https://other.invalid/s/view#${'x'.repeat(43)}` }); await flush();
  assert.equal(h.shares.length, 0); assert(h.error());
});


test('an expired same-key link offers a deliberate fresh-key retry instead of sharing it', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush(); const first = h.requests.at(-1);
  first.resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2000-01-01T00:00:00Z' }); await flush();
  assert.equal(h.shares.length, 0); assert.match(h.error(), /expired/);
  h.press('Try the same action again'); await flush(); assert.notEqual(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});


test('a cached link expires while sharing is closed and cannot reopen as share-ready', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush();
  h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2026-10-28T00:01:00Z' }); await flush();
  assert.equal(h.shares.length, 1); h.visible(false); h.advance(120_000); h.visible(true); await h.ready();
  h.press('Share link'); await flush(); assert.equal(h.shares.length, 1); assert.match(h.error(), /expired/);
  h.press('Create a single-use link'); await flush(); assert.equal(h.requests.at(-1).path, '/api/posts/fixture-post/link');
});

test('a replayed revoked link requires a deliberate fresh-key retry', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush(); const first = h.requests.at(-1);
  first.resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z', state: 'revoked' }); await flush();
  assert.equal(h.shares.length, 0); assert.match(h.error(), /revoked/);
  h.press('Try the same action again'); await flush(); assert.notEqual(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});


test('each cached share checks current server state and refuses a remotely revoked link', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush(); const first = h.requests.at(-1);
  first.resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z', state: 'active' }); await flush();
  h.press('Share link'); await flush(); assert.equal(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z', state: 'revoked' }); await flush();
  assert.equal(h.shares.length, 1); assert.match(h.error(), /revoked/);
});


test('manual approval retains the uploaded moment and waits without issuing a link', async t => {
  const h = harness(t); await h.ready(); h.press('Create a single-use link'); await flush();
  const upload = h.requests.at(-1);
  upload.resolve({ postId: 'fixture-pending', status: 'moderation_pending' }); await flush();
  assert.equal(h.requests.length, 2); assert(h.error().includes('waiting for safety review'));
  h.press('Try the same action again'); await flush();
  assert.equal(h.requests.at(-1).path, '/api/posts'); assert.equal(h.requests.at(-1).method, undefined);
  h.requests.at(-1).resolve({ items: [{ postId: 'fixture-pending', status: 'moderation_pending' }] }); await flush();
  assert.equal(h.requests.filter(r => r.method === 'POST' && r.path === '/api/posts').length, 1);
  assert.equal(h.requests.filter(r => r.path.endsWith('/link')).length, 0);
  h.press('Try the same action again'); await flush();
  h.requests.at(-1).resolve({ items: [{ postId: 'fixture-pending', status: 'ready' }] }); await flush();
  assert.equal(h.requests.at(-1).path, '/api/posts/fixture-pending/link');
});

for (const status of ['rejected', 'taken_down', 'deleted']) {
  test(`reviewed ${status} upload cannot create a grant or reupload on retry`, async t => {
    const h = harness(t); await h.ready(); h.input('fixture_recipient'); await flush(); h.press('Send to recipient'); await flush();
    h.requests.at(-1).resolve({ postId: 'fixture-pending', status: 'moderation_pending' }); await flush();
    h.press('Try the same action again'); await flush();
    h.requests.at(-1).resolve({ items: [{ postId: 'fixture-pending', status }] }); await flush();
    assert.equal(h.requests.filter(r => r.path.endsWith('/recipients')).length, 0);
    assert.equal(h.requests.filter(r => r.method === 'POST' && r.path === '/api/posts').length, 1);
    assert(h.error());
  });
}


test('rejected username can be replaced while the signed-in account and capture stay available', async t => {
  const h = harness(t); await h.ready('rejected');
  assert(h.text().includes('username was not approved'));
  h.press('Change username'); await flush(); h.inputUsername('fixture_newname'); await flush(); h.press('Save username'); await flush();
  const saved = h.requests.at(-1); assert.equal(saved.path, '/api/profile'); assert.equal(saved.method, 'POST');
  assert.equal(saved.body.username, 'fixture_newname'); assert.equal(saved.expectedAccountId, 'fixture-owner');
  saved.resolve({ username: 'fixture_newname', reviewState: 'pending' }); await flush();
  assert(h.text().includes('waiting for safety approval')); assert(h.text().includes('Signed in as @'));
  h.press('Create a single-use link'); await flush();
  assert.equal(h.requests.at(-1).path, '/api/posts');
  h.requests.at(-1).resolve({ postId: 'fixture-pending', status: 'moderation_pending' }); await flush();
  assert.equal(h.requests.filter(request => request.path.endsWith('/link')).length, 0);
});

test('failed username replacement does not claim approval or discard the name for retry', async t => {
  const h = harness(t); await h.ready('rejected'); h.press('Change username'); await flush();
  h.inputUsername('fixture_newname'); await flush(); h.press('Save username'); await flush();
  h.requests.at(-1).reject(new SharingError('Please sign in again to continue.', 'unauthorized')); await flush();
  assert.equal(h.error(), 'Please sign in again to continue.');
  assert.equal(h.text().includes('username is saved and waiting'), false);
});


test('immediate recipient revocation pins the granted account even after its name changes', async t => {
  const h = harness(t); await h.ready(); h.input('fixture_recipient'); await flush(); h.press('Send to recipient'); await flush();
  h.requests.at(-1).resolve({ postId: 'fixture-post', status: 'ready' }); await flush();
  h.requests.at(-1).resolve({ requestState: 'pending', accountId: 'fixture-original-recipient' }); await flush();
  h.press('Revoke @fixture_recipient access'); await flush();
  assert.equal(h.requests.at(-1).body.accountId, 'fixture-original-recipient'); assert.equal(h.requests.at(-1).body.username, undefined);
});


test('unaccepted or unpublished policies block username setup and upload until acceptance is confirmed', async t => {
  for (const policy of [{ accepted: false, policyReady: true, deletionStatus: null }, { accepted: true, policyReady: false, deletionStatus: null }]) {
    const h = harness(t, policy); await flush();
    assert(h.text().includes('TermsAcceptance')); assert.equal(h.requests.length, 0);
    assert.equal(h.text().includes('Create a single-use link'), false);
  }
});

test('deleting accounts cannot load username or create a capture share', async t => {
  const h = harness(t, { accepted: true, policyReady: true, deletionStatus: 'pending' }); await flush();
  assert(h.error().includes('Account deletion is pending')); assert.equal(h.requests.length, 0);
  assert.equal(h.text().includes('Create a single-use link'), false);
});
