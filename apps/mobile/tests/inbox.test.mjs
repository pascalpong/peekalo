import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual screen and event handlers. Native views, navigation and Auth
// are adapters; all requests use disposable in-memory fixtures, never a service.
const source = ts.transpileModule(readFileSync(new URL('../src/app/(tabs)/inbox.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const item = (postId = 'fixture-a', requestState = 'pending') => ({ postId, requestState, kind: 'photo', senderUsername: 'fixture_sender' });
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
    return undefined;
  }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function harness(t, { bootstrap, getSession } = {}) {
  const cells = [], requests = [], listeners = new Set();
  const jsx = (type, props) => ({ type, props });
  const ReceivedMoment = () => {}, ShareCapture = () => {}, Button = () => {};
  let cursor = 0, tree, component, focusCallback, cleanup, mounted = true;
  let session = { user: { id: 'fixture-account-a' } }, unsubscribed = 0;
  const render = () => { cursor = 0; tree = component(); };
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], value => {
        assert(mounted, 'Async completion must not update an unmounted Inbox');
        cells[index] = typeof value === 'function' ? value(cells[index]) : value;
        render();
      }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { fn, deps };
      return cells[index].fn;
    },
  };
  const client = { auth: {
    getSession: () => getSession ? getSession(session) : Promise.resolve({ data: { session } }),
    onAuthStateChange(callback) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe() { listeners.delete(callback); unsubscribed++; } } } };
    },
  } };
  const adapters = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: value => value } },
    '@expo/vector-icons/Feather': { default: 'Feather' },
    'expo-router': { router: { navigate() {} }, useFocusEffect: callback => { focusCallback = callback; } },
    '../../components/ui': { Button, colors: {}, typography: {}, Eyebrow: 'Eyebrow', Screen: 'Screen' },
    '../../components/share-capture': { ShareCapture },
    '../../components/received-moment': { ReceivedMoment },
    '../../lib/sharing-client': {
      getSharingClient: () => typeof bootstrap === 'function' ? bootstrap(client) : bootstrap ? bootstrap.promise : Promise.resolve(client),
      apiRequest(path, options = {}) {
        const pending = deferred();
        requests.push({ path, ...options, ...pending });
        // Deliberately allow late resolutions after abort to exercise guards too.
        return pending.promise;
      },
    },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, AbortController, require: name => {
    assert(Object.hasOwn(adapters, name), `Unexpected import ${name}`);
    return adapters[name];
  } });
  component = exported.default;
  render();
  const focus = () => { assert(mounted); cleanup = focusCallback(); };
  const blur = () => { const previous = cleanup; cleanup = undefined; previous?.(); };
  const unmount = () => { if (!mounted) return; blur(); mounted = false; };
  focus();
  t.after(unmount);
  return {
    client, requests, focus, blur, unmount,
    async load(items = [item()]) { await flush(); requests.at(-1).resolve({ items }); await flush(); },
    handler(label) {
      const button = find(tree, node => typeof node.props?.onPress === 'function' && (
        node.props.label === label || node.props.accessibilityLabel === label ||
        find(node.props.children, child => child.type === 'Text' && child.props.children === label)
      ));
      assert(button, `Missing ${label}`);
      return button.props.onPress;
    },
    press(label) { this.handler(label)(); },
    closeAccount: () => find(tree, node => node.type === ShareCapture).props.onClose(),
    auth(accountId) {
      session = accountId ? { user: { id: accountId } } : null;
      for (const callback of listeners) callback(accountId ? 'SIGNED_IN' : 'SIGNED_OUT', session);
    },
    selected: () => find(tree, node => node.type === ReceivedMoment)?.props.postId,
    has: label => Boolean(find(tree, node => node.props?.label === label)),
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
    listenerCount: () => listeners.size,
    unsubscribed: () => unsubscribed,
  };
}

test('accepted inbox entries open and focus loss clears the selected moment', async t => {
  const h = harness(t);
  await h.load([item('fixture-accepted', 'accepted')]);
  h.press('Open moment');
  assert.equal(h.selected(), 'fixture-accepted');
  h.blur();
  assert.equal(h.selected(), undefined);
});

test('a confirmed acceptance opens the moment and updates its Inbox entry', async t => {
  const h = harness(t);
  await h.load();
  h.press('Accept request');
  assert.equal(h.selected(), undefined);
  assert.equal(h.requests.at(-1).path, '/api/inbox/fixture-a/accept');
  h.requests.at(-1).resolve({ requestState: 'accepted' });
  await flush();
  assert.equal(h.selected(), 'fixture-a');
  h.press('Back to inbox');
  assert(h.has('Open moment'));
  assert.equal(h.has('Accept request'), false);
});

for (const response of [{ requestState: 'pending' }, { requestState: 'declined' }, {}]) {
  test(`unconfirmed acceptance ${JSON.stringify(response)} never opens media`, async t => {
    const h = harness(t);
    await h.load();
    h.press('Accept request');
    h.requests.at(-1).resolve(response);
    await flush();
    assert.equal(h.selected(), undefined);
    assert.equal(h.error(), 'The request could not be accepted. Please try again.');
  });
}

test('failed acceptance stays hidden and is retryable without exposing diagnostics', async t => {
  const h = harness(t);
  await h.load();
  h.press('Accept request');
  h.requests.at(-1).reject(new Error('sensitive diagnostic fixture'));
  await flush();
  assert.equal(h.selected(), undefined);
  assert.equal(h.error(), 'The request could not be accepted. Please try again.');
  h.press('Accept request');
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 2);
});

test('rapid repeated acceptance sends only one mutation before React can update', async t => {
  const h = harness(t);
  await h.load();
  const queuedPress = h.handler('Accept request');
  queuedPress();
  queuedPress();
  assert.equal(h.requests.filter(request => request.path.endsWith('/accept')).length, 1);
});

for (const interruption of ['blur', 'unmount']) {
  test(`a late acceptance after ${interruption} is aborted and cannot reopen media`, async t => {
    const h = harness(t);
    await h.load();
    h.press('Accept request');
    const pending = h.requests.at(-1);
    h[interruption]();
    assert.equal(pending.signal.aborted, true);
    pending.resolve({ requestState: 'accepted' });
    await flush();
    assert.equal(h.selected(), undefined);
    assert.equal(h.listenerCount(), 0);
    assert.equal(h.unsubscribed(), 1);
  });
}

test('a new refresh wins over an older response and older finalization cannot unlock it', async t => {
  const h = harness(t);
  await flush();
  const older = h.requests[0];
  h.press('Refresh inbox');
  await flush();
  const newer = h.requests.at(-1);
  assert.notEqual(older, newer);
  assert.equal(older.signal.aborted, true);
  older.resolve({ items: [item('stale', 'accepted')] });
  await flush();
  assert.equal(h.has('Open moment'), false);
  newer.resolve({ items: [item('current', 'accepted')] });
  await flush();
  h.press('Open moment');
  assert.equal(h.selected(), 'current');
});

test('an account change clears a selected moment and old Inbox items immediately', async t => {
  const h = harness(t);
  await h.load([item('old-account', 'accepted')]);
  h.press('Open moment');
  h.auth('fixture-account-b');
  assert.equal(h.selected(), undefined);
  assert.equal(h.has('Open moment'), false);
  await flush();
  h.requests.at(-1).resolve({ items: [item('new-account', 'accepted')] });
  await flush();
  h.press('Open moment');
  assert.equal(h.selected(), 'new-account');
});

test('account switching invalidates both old acceptance and old Inbox replies', async t => {
  const h = harness(t);
  await h.load();
  h.press('Accept request');
  const acceptance = h.requests.at(-1);
  h.auth('fixture-account-b');
  assert.equal(acceptance.signal.aborted, true);
  await flush();
  const accountB = h.requests.at(-1);
  h.auth('fixture-account-c');
  assert.equal(accountB.signal.aborted, true);
  await flush();
  h.requests.at(-1).resolve({ items: [item('account-c', 'accepted')] });
  await flush();
  accountB.resolve({ items: [item('account-b', 'accepted')] });
  acceptance.resolve({ requestState: 'accepted' });
  await flush();
  assert.equal(h.selected(), undefined);
  h.press('Open moment');
  assert.equal(h.selected(), 'account-c');
});

test('signing out clears entries without requesting an authenticated Inbox', async t => {
  const h = harness(t);
  await h.load([item('old-account', 'accepted')]);
  const count = h.requests.length;
  h.auth(null);
  await flush();
  assert.equal(h.has('Open moment'), false);
  assert.equal(h.has('Sign in'), true);
  assert.equal(h.requests.length, count);
});

test('a stale session restoration cannot replace a newer account refresh', async t => {
  const firstSession = deferred();
  let calls = 0;
  const h = harness(t, { getSession: session => ++calls === 1 ? firstSession.promise : Promise.resolve({ data: { session } }) });
  await flush();
  h.auth('fixture-account-b');
  await flush();
  h.requests.at(-1).resolve({ items: [item('account-b', 'accepted')] });
  await flush();
  firstSession.resolve({ data: { session: { user: { id: 'fixture-account-a' } } } });
  await flush();
  assert.equal(h.requests.length, 1);
  h.press('Open moment');
  assert.equal(h.selected(), 'account-b');
});

test('closing account management refreshes the Inbox and focus cleanup unsubscribes', async t => {
  const h = harness(t);
  await h.load([]);
  h.press('Your account');
  h.closeAccount();
  await flush();
  assert.equal(h.requests.length, 2);
  h.blur();
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.requests.at(-1).signal.aborted, true);
  h.focus();
  await flush();
  assert.equal(h.listenerCount(), 1);
  assert.equal(h.requests.length, 3);
});

test('late client bootstrap after unmount does not install Auth listeners or request Inbox', async t => {
  const bootstrap = deferred();
  const h = harness(t, { bootstrap });
  h.unmount();
  bootstrap.resolve(h.client);
  await flush();
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.requests.length, 0);
});


test('manual retry after bootstrap failure still installs identity-change protection', async t => {
  let attempts = 0;
  const h = harness(t, { bootstrap: client => ++attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(client) });
  await flush();
  assert.equal(h.error(), 'Cannot load your inbox. Check your connection and try again.');
  h.press('Refresh inbox');
  await h.load([item('recovered', 'accepted')]);
  assert.equal(h.listenerCount(), 1);
  h.press('Open moment');
  h.auth(null);
  await flush();
  assert.equal(h.selected(), undefined);
  assert.equal(h.has('Open moment'), false);
});
