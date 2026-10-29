import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production Profile screen; Auth/native/share adapters use only
// generated in-memory fixtures. Late promises deliberately ignore cancellation.
const source = ts.transpileModule(readFileSync(new URL('../src/app/(tabs)/profile.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const moment = (postId = 'fixture-post', extra = {}) => ({ postId, kind: 'photo', status: 'ready', cleanupPending: false, createdAt: '2026-10-28T00:00:00Z', link: null, recipients: [], ...extra });
const listing = (items = [moment()]) => ({ items, limit: 3, activeCount: items.filter(item => ['ready', 'uploading'].includes(item.status)).length, availableSlots: 3 - items.filter(item => ['ready', 'uploading'].includes(item.status)).length });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return undefined; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return Array.isArray(node) ? node.map(textContent).join('') : textContent(node.props?.children);
}
class SharingError extends Error {}
function harness(t, { bootstrap, getSession, share } = {}) {
  const cells = [], requests = [], listeners = new Set(), shares = [];
  let cursor = 0, tree, component, focusCallback, cleanup, mounted = true, nextKey = 0;
  let session = { user: { id: 'fixture-owner', email: 'fixture@example.invalid' } };
  const jsx = (type, props) => ({ type, props });
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const render = () => { cursor = 0; tree = component(); };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => {
      assert(mounted, 'Late completion must not update an unmounted Profile');
      cells[index] = typeof value === 'function' ? value(cells[index]) : value; render();
    }]; },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++; if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { fn, deps }; return cells[index].fn; },
  };
  const client = { auth: {
    getSession: () => getSession ? getSession(session) : Promise.resolve({ data: { session } }),
    onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe() { listeners.delete(callback); } } } }; },
  } };
  const adapters = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value }, Share: { dismissedAction: 'dismissed', async share(value) { shares.push(value); return share ? share(value) : { action: 'dismissed' }; } } },
    '@expo/vector-icons/Feather': { default: 'Feather' }, '@peekalo/contracts': { MAX_VIDEO_DURATION_MS: 10000, REVEAL_BUDGET_MS: 10000 },
    'expo-router': { router: { navigate() {}, push() {} }, useFocusEffect: callback => { focusCallback = callback; } },
    '../../components/ui': { Button: 'Button', colors: {}, typography: {}, tokens: { font: {}, radius: {}, type: {} }, Eyebrow: 'Eyebrow', Eyes: 'Eyes', Screen: 'Screen' },
    '../../components/share-capture': { ShareCapture: 'ShareCapture' },
    '../../components/safety': { SafetySettings: 'SafetySettings' },
    '../../lib/sharing-client': {
      SharingError, resolveApiUrl: path => `https://fixture.invalid${path}`, newIdempotencyKey: () => `fixture-key-${++nextKey}`,
      getSharingClient: () => typeof bootstrap === 'function' ? bootstrap(client) : bootstrap ? bootstrap.promise : Promise.resolve(client),
      apiRequest(path, options = {}) { const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; },
    },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, AbortController, URL, Date, require: name => { assert(Object.hasOwn(adapters, name), `Unexpected ${name}`); return adapters[name]; } });
  component = exported.default; render();
  const focus = () => { assert(mounted); cleanup = focusCallback(); };
  const blur = () => { const previous = cleanup; cleanup = undefined; previous?.(); };
  const unmount = () => { if (!mounted) return; blur(); mounted = false; };
  focus(); t.after(unmount);
  return {
    client, requests, shares, focus, blur, unmount,
    async load(items = [moment()], reviewState) {
      await flush(); assert.equal(requests.at(-1).path, '/api/profile'); requests.at(-1).resolve({ username: 'fixture_owner', reviewState });
      await flush(); assert.equal(requests.at(-1).path, '/api/posts'); requests.at(-1).resolve(listing(items)); await flush();
    },
    handler(label) { const found = find(tree, node => typeof node.props?.onPress === 'function' && (node.props.label === label || node.props.accessibilityLabel === label || textContent(node.props.children) === label)); assert(found, `Missing ${label}`); return found.props.onPress; },
    press(label) { this.handler(label)(); },
    input(value) { find(tree, node => node.props?.accessibilityLabel === 'Recipient username').props.onChangeText(value); },
    has: label => !!find(tree, node => node.props?.label === label || node.props?.accessibilityLabel === label || (node.type === 'Text' && textContent(node) === label)),
    text: () => textContent(tree),
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
    auth(id) { session = id ? { user: { id } } : null; for (const callback of listeners) callback(id ? 'SIGNED_IN' : 'SIGNED_OUT', session); },
    listenerCount: () => listeners.size,
  };
}

test('own moments list includes processing/failed states and no media request before selection', async t => {
  const h = harness(t);
  await h.load([moment(), moment('fixture-upload', { status: 'uploading', kind: 'video' }), moment('fixture-failed', { status: 'failed' })]);
  assert(h.text().includes('2 of 3 active · 1 slot available'));
  assert(h.text().includes('Preparing…')); assert(h.text().includes('Upload failed'));
  h.press('Manage photo moment 1');
  assert(h.text().includes('Private · hidden by default'));
  assert.equal(h.requests.length, 2);
});

test('deletion requires explicit confirmation and confirmed success updates listing', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1');
  h.press('Delete moment'); assert.equal(h.requests.length, 2);
  h.press('Keep moment'); assert.equal(h.requests.length, 2);
  h.press('Delete moment'); h.press('Delete this moment permanently');
  assert.equal(h.requests.at(-1).method, 'DELETE'); assert.equal(h.requests.at(-1).path, '/api/posts/fixture-post');
  h.requests.at(-1).resolve({ deleted: true, cleanupPending: false }); await flush();
  assert.equal(h.requests.at(-1).path, '/api/posts'); h.requests.at(-1).resolve(listing([])); await flush();
  assert(h.text().includes('0 of 3 active · 3 slots available'));
  assert.equal(h.has('Manage photo moment 1'), false);
});

test('unconfirmed deletion does not remove owner controls and can be retried', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Delete moment');
  h.press('Delete this moment permanently'); h.requests.at(-1).resolve({ deleted: false }); await flush();
  assert(h.error()); assert(h.has('Delete this moment permanently'));
  h.press('Delete this moment permanently'); assert.equal(h.requests.filter(r => r.method === 'DELETE').length, 2);
});

for (const interruption of ['blur', 'unmount']) {
  test(`late deletion after ${interruption} cannot show old data or share status`, async t => {
    const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Delete moment'); h.press('Delete this moment permanently');
    const pending = h.requests.at(-1); h[interruption](); assert.equal(pending.signal.aborted, true);
    pending.resolve({ deleted: true }); await flush(); assert.equal(h.listenerCount(), 0); assert.equal(h.requests.length, 3);
  });
}

test('account change invalidates recipient mutation and removes owner controls immediately', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.input('@fixture_friend'); h.press('Send on Peekalo');
  const pending = h.requests.at(-1); assert.equal(pending.body.username, 'fixture_friend');
  h.auth('fixture-owner-b'); assert.equal(pending.signal.aborted, true); assert.equal(h.has('Send on Peekalo'), false);
  pending.resolve({ requestState: 'accepted' }); await h.load([moment('fixture-owner-b-post')]);
  assert.equal(h.text().includes('Shared with @fixture_friend'), false);
});

test('recipient request failure preserves input and does not expose service diagnostics', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.input('fixture_friend'); h.press('Send on Peekalo');
  h.requests.at(-1).reject(new Error('secret diagnostic fixture')); await flush();
  assert.equal(h.text().includes('secret diagnostic'), false); assert(h.error()); h.press('Send on Peekalo');
  assert.equal(h.requests.at(-1).body.username, 'fixture_friend');
});

test('rapid repeated recipient presses send one mutation before state updates', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.input('fixture_friend');
  const send = h.handler('Send on Peekalo'); send(); send();
  assert.equal(h.requests.filter(r => r.path.endsWith('/recipients')).length, 1);
});

test('recipient revoke uses owner endpoint and leaves remaining grants intact after refresh', async t => {
  const h = harness(t); await h.load([moment('fixture-post', { recipients: [{ username: 'fixture_friend', requestState: 'accepted', revoked: false }] })]);
  h.press('Manage photo moment 1'); h.press('Revoke @fixture_friend');
  assert.equal(h.requests.at(-1).method, 'DELETE'); assert.equal(h.requests.at(-1).body.username, 'fixture_friend');
  h.requests.at(-1).resolve({ revoked: true }); await flush();
  h.requests.at(-1).resolve(listing([moment('fixture-post', { recipients: [{ username: 'fixture_friend', requestState: 'accepted', revoked: true }] })])); await flush();
  assert.equal(h.has('Revoke @fixture_friend'), false); assert(h.text().includes('@fixture_friend · revoked'));
});

test('link retry retains request key, and sharing cancellation retains usable link without minting another', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
  const first = h.requests.at(-1); first.reject(new Error('offline')); await flush(); h.press('Create a single-use link');
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
  assert.equal(h.shares.length, 1); h.requests.at(-1).resolve(listing([moment('fixture-post', { link: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' } })])); await flush();
  h.press('Share link'); await flush(); assert.equal(h.shares.length, 1, 'Cached links require fresh server confirmation before sharing');
  assert.equal(h.requests.at(-1).path, '/api/posts/fixture-post/link');
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ state: 'active', url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
  assert.equal(h.shares.length, 2);
  assert.equal(h.requests.filter(r => r.path.endsWith('/link')).length, 3);
  h.requests.at(-1).resolve(listing([moment('fixture-post', { link: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' } })])); await flush();
  h.press('Revoke link'); h.requests.at(-1).resolve({ revoked: true }); await flush();
  h.requests.at(-1).resolve(listing([moment()])); await flush(); h.press('Create a single-use link');
  assert.notEqual(h.requests.at(-1).headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});

for (const url of ['https://untrusted.invalid/s/view#' + 'x'.repeat(43), 'https://fixture.invalid/api/private#' + 'x'.repeat(43), 'https://fixture.invalid/s/view?token=fixture#' + 'x'.repeat(43)]) {
  test(`untrusted link response is never passed to platform sharing (${new URL(url).hostname + new URL(url).pathname})`, async t => {
    const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
    h.requests.at(-1).resolve({ url, expiresAt: '2099-01-01T00:00:00Z' }); await flush(); assert.equal(h.shares.length, 0); assert(h.error());
  });
}

test('an old link response after sign-out cannot open platform sharing', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
  const pending = h.requests.at(-1); h.auth(null); pending.resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
  assert.equal(h.shares.length, 0); assert.equal(h.has('Manage photo moment 1'), false); assert.equal(pending.signal.aborted, true);
});

test('late old listing cannot replace the current account', async t => {
  const h = harness(t); await flush(); h.requests.at(-1).resolve({ username: 'fixture_owner' }); await flush();
  const old = h.requests.at(-1); h.auth('fixture-new-owner'); await h.load([moment('fixture-new')]);
  old.resolve(listing([moment('fixture-old')])); await flush(); h.press('Manage photo moment 1'); h.press('Delete moment'); h.press('Delete this moment permanently');
  assert.equal(h.requests.at(-1).path, '/api/posts/fixture-new');
});

test('late client bootstrap after unmount never subscribes or fetches owner data', async t => {
  const bootstrap = deferred(); const h = harness(t, { bootstrap }); h.unmount(); bootstrap.resolve(h.client); await flush();
  assert.equal(h.listenerCount(), 0); assert.equal(h.requests.length, 0);
});


test('pending cleanup tombstones stay deleted and offer only storage cleanup retry', async t => {
  const h = harness(t); await h.load([moment('fixture-deleted', { status: 'deleted', cleanupPending: true })]);
  assert(h.text().includes('0 of 3 active · 3 slots available'));
  assert(h.text().includes('Deleted · storage cleanup pending'));
  h.press('Manage cleanup for deleted photo moment 1');
  assert(h.has('Retry storage cleanup')); assert.equal(h.has('Delete moment'), false);
  assert.equal(h.has('Send on Peekalo'), false); assert.equal(h.has('Create a single-use link'), false);
  h.press('Retry storage cleanup');
  assert.equal(h.requests.at(-1).method, 'DELETE'); assert.equal(h.requests.at(-1).path, '/api/posts/fixture-deleted');
  assert.equal(h.requests.at(-1).expectedAccountId, 'fixture-owner');
  h.requests.at(-1).resolve({ deleted: true, cleanupPending: false }); await flush();
  h.requests.at(-1).resolve(listing([])); await flush();
  assert.equal(h.has('Manage cleanup for deleted photo moment 1'), false);
  assert(h.text().includes('Private storage cleanup completed. The moment remains deleted.'));
});

test('failed cleanup retry keeps the tombstone and authoritative slot count unchanged', async t => {
  const h = harness(t); await h.load([moment('fixture-deleted', { status: 'deleted', cleanupPending: true }), moment('fixture-ready')]);
  h.press('Manage cleanup for deleted photo moment 1'); h.press('Retry storage cleanup');
  h.requests.at(-1).reject(new Error('sensitive storage failure')); await flush();
  assert(h.has('Retry storage cleanup')); assert(h.text().includes('1 of 3 active · 2 slots available'));
  assert.equal(h.text().includes('sensitive storage'), false); assert.equal(h.has('Delete moment'), false);
});

test('confirmed deletion keeps cleanup retry available even when inventory refresh fails', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Delete moment');
  h.press('Delete this moment permanently');
  h.requests.at(-1).resolve({ deleted: true, cleanupPending: true }); await flush();
  assert(h.has('Retry storage cleanup')); assert.equal(h.has('Send on Peekalo'), false);
  // Do not invent new capacity from a local decrement before receiving inventory.
  assert(h.text().includes('1 of 3 active · 2 slots available'));
  h.requests.at(-1).reject(new Error('offline')); await flush();
  assert(h.has('Retry storage cleanup')); assert(h.text().includes('1 of 3 active · 2 slots available'));
  h.press('Retry storage cleanup');
  assert.equal(h.requests.at(-1).method, 'DELETE'); assert.equal(h.requests.at(-1).path, '/api/posts/fixture-post');
  h.requests.at(-1).resolve({ deleted: true, cleanupPending: true }); await flush();
  h.requests.at(-1).resolve({ ...listing([moment('fixture-post', { status: 'deleted', cleanupPending: true })]), activeCount: 2, availableSlots: 1 }); await flush();
  // Full-account server metadata wins even when only one tombstone is listed.
  assert(h.text().includes('2 of 3 active · 1 slot available'));
});

test('account change aborts cleanup retry and late completion cannot restore a tombstone', async t => {
  const h = harness(t); await h.load([moment('fixture-deleted', { status: 'deleted', cleanupPending: true })]);
  h.press('Manage cleanup for deleted photo moment 1'); h.press('Retry storage cleanup');
  const pending = h.requests.at(-1); h.auth('fixture-owner-b'); assert.equal(pending.signal.aborted, true);
  pending.resolve({ deleted: true, cleanupPending: true }); await h.load([]);
  assert.equal(h.has('Retry storage cleanup'), false); assert.equal(h.has('Manage cleanup for deleted photo moment 1'), false);
  assert.equal(h.text().includes('Private storage cleanup is pending'), false);
});


for (const state of ['revoked', 'expired']) {
  for (const inventorySource of ['refresh', 'mutation']) {
    test(`authoritative ${state} link from ${inventorySource} drops cached URL and rotates only the replacement request key`, async t => {
      const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
      const original = h.requests.at(-1);
      original.resolve({ url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
      h.requests.at(-1).resolve(listing([moment('fixture-post', { link: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' } })])); await flush();
      assert.equal(h.shares.length, 1);
      const changed = [moment('fixture-post', { link: { state, expiresAt: '2099-01-01T00:00:00Z' } })];
      if (inventorySource === 'refresh') { h.press('Refresh moments'); await h.load(changed); }
      else {
        h.input('fixture_friend'); h.press('Send on Peekalo'); h.requests.at(-1).resolve({ requestState: 'pending' }); await flush();
        h.requests.at(-1).resolve(listing(changed)); await flush();
      }
      h.press('Create a single-use link');
      const replacement = h.requests.at(-1);
      assert.equal(replacement.path, '/api/posts/fixture-post/link');
      assert.notEqual(replacement.headers['Idempotency-Key'], original.headers['Idempotency-Key']);
      assert.equal(h.shares.length, 1, 'A stale revoked/expired URL must never reach the platform share sheet');
      replacement.reject(new Error('uncertain transport failure')); await flush(); h.press('Create a single-use link');
      assert.equal(h.requests.at(-1).headers['Idempotency-Key'], replacement.headers['Idempotency-Key'], 'Uncertain replacement failures preserve their retry key');
      h.requests.at(-1).resolve({ url: `https://fixture.invalid/s/view#${'y'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
      assert.equal(h.shares.length, 2); assert.equal(h.shares[1].message, `https://fixture.invalid/s/view#${'y'.repeat(43)}`);
    });
  }
}


for (const state of ['revoked', 'expired']) {
  test(`same-key ${state} response is rejected even when inventory reports a different active link`, async t => {
    const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
    const original = h.requests.at(-1); original.reject(new Error('uncertain create response')); await flush();
    h.press('Refresh moments'); await h.load([moment('fixture-post', { link: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' } })]);
    h.press('Share link');
    assert.equal(h.requests.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key'], 'An active inventory cannot resolve which creation key won');
    h.requests.at(-1).resolve({ state, url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
    assert.equal(h.shares.length, 0); assert.match(h.error(), new RegExp(state));
    assert.equal(h.requests.filter(r => r.path.endsWith('/link')).length, 2, 'No automatic replacement claim is created');
    h.press('Share link');
    assert.notEqual(h.requests.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key'], 'A new deliberate action retires the known invalid result');
    h.requests.at(-1).resolve({ state: 'active', url: `https://fixture.invalid/s/view#${'y'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
    assert.equal(h.shares.length, 1); assert.equal(h.shares[0].message, `https://fixture.invalid/s/view#${'y'.repeat(43)}`);
  });
}


test('every deliberate cached-link share revalidates the same key and blocks remote revocation without inventory refresh', async t => {
  const h = harness(t); await h.load(); h.press('Manage photo moment 1'); h.press('Create a single-use link');
  const original = h.requests.at(-1);
  original.resolve({ state: 'active', url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
  h.requests.at(-1).resolve(listing([moment('fixture-post', { link: { state: 'active', expiresAt: '2099-01-01T00:00:00Z' } })])); await flush();
  assert.equal(h.shares.length, 1);
  h.press('Share link');
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key']);
  h.requests.at(-1).reject(new Error('uncertain revalidation transport')); await flush();
  assert.equal(h.shares.length, 1, 'An uncertain failure cannot use the cached URL');
  h.press('Share link');
  assert.equal(h.requests.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key']);
  h.requests.at(-1).resolve({ state: 'revoked', url: `https://fixture.invalid/s/view#${'x'.repeat(43)}`, expiresAt: '2099-01-01T00:00:00Z' }); await flush();
  assert.equal(h.shares.length, 1); assert.match(h.error(), /revoked/);
  const count = h.requests.length; await flush(); assert.equal(h.requests.length, count, 'No replacement is minted automatically');
  h.press('Share link'); assert.notEqual(h.requests.at(-1).headers['Idempotency-Key'], original.headers['Idempotency-Key']);
});


for (const status of ['moderation_pending', 'rejected', 'taken_down']) {
  test(`${status} moments expose deletion and status without sharing controls`, async t => {
    const h = harness(t); await h.load([moment('fixture-safety', { status })]);
    h.press('Manage photo moment 1');
    assert.equal(h.has('Create a single-use link'), false); assert.equal(h.has('Send on Peekalo'), false);
    assert(h.has('Delete moment')); assert(h.text().includes('Sharing is unavailable'));
    assert.equal(h.requests.length, 2);
  });
}


test('rejected username is explained while owner deletion controls remain available', async t => {
  const h = harness(t); await h.load([moment()], 'rejected');
  assert(h.text().includes('username was not approved')); assert(h.text().includes('Change username'));
  h.press('Manage photo moment 1'); assert(h.has('Delete moment'));
});


test('unapproved recipient names stay hidden and revocation uses the stable account id', async t => {
  const h = harness(t); await h.load([moment('fixture-post', { recipients: [{ accountId: 'fixture-recipient-id', username: null, requestState: 'accepted', revoked: false }] })]);
  h.press('Manage photo moment 1'); assert(h.text().includes('Account awaiting review')); assert.equal(h.text().includes('@null'), false);
  h.press('Revoke account access');
  assert.equal(h.requests.at(-1).body.accountId, 'fixture-recipient-id'); assert.equal(h.requests.at(-1).body.username, undefined);
});
