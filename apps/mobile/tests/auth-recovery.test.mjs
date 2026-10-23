import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real recovery coordinator, secure storage adapter, native intent
// and screen callbacks. Auth/native adapters use only disposable memory data.
const sources = Object.fromEntries([
  ['sharing', '../src/lib/sharing-client.ts'], ['recovery', '../src/lib/auth-recovery.ts'],
  ['intent', '../src/app/+native-intent.tsx'], ['screen', '../src/app/reset-password.tsx'],
  ['share', '../src/components/share-capture.tsx'],
].map(([name, path]) => [name, ts.transpileModule(readFileSync(new globalThis.URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText]));
const flush = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}

function harness({ store = new Map(), exchange, update, request, marker = 'recovery', mainUser = 'existing-main-account' } = {}) {
  const clients = [], calls = [], logs = [], navigation = [];
  const mainSession = mainUser ? { user: { id: mainUser }, access_token: 'ordinary-login' } : null;
  let api;
  let react = {};
  let focusEffect, backHandler;
  const jsx = (type, props) => ({ type, props });
  const modules = {};
  const adapters = {
    'react-native-url-polyfill/auto': {},
    '@supabase/supabase-js': { processLock() {}, createClient(_url, _key, options) {
      const recovery = !!options.auth.storageKey;
      const storageKey = options.auth.storageKey ?? 'normal-session';
      const storage = options.auth.storage;
      const client = { recovery, options, auth: {
        startAutoRefresh() {}, stopAutoRefresh() {},
        async getSession() {
          const value = recovery ? await storage.getItem(storageKey) : null;
          return { data: { session: recovery ? value ? JSON.parse(value) : null : mainSession }, error: null };
        },
        async resetPasswordForEmail(email, options) {
          assert(recovery, 'Reset requests must never use the ordinary auth client');
          calls.push({ method: 'request', email, options });
          await storage.setItem(`${storageKey}-code-verifier`, 'secure-fixture-verifier/recovery');
          await storage.setItem(`${storageKey}-flow-fixture-code-verifier`, 'secure-fixture-verifier/recovery');
          return request ? request() : { error: null };
        },
        async exchangeCodeForSession(code) {
          assert(recovery, 'Recovery must not exchange into the ordinary login');
          calls.push({ method: 'exchange', code });
          const verifier = await storage.getItem(`${storageKey}-code-verifier`);
          if (exchange) await exchange();
          if (verifier !== 'secure-fixture-verifier/recovery' || code !== 'fixture-code') return { data: { session: null }, error: { message: 'private-server-details' } };
          const session = { user: { id: 'recovered-account' }, access_token: 'isolated-token', refresh_token: 'isolated-refresh' };
          await storage.setItem(storageKey, JSON.stringify(session));
          await storage.removeItem(`${storageKey}-code-verifier`);
          return { data: { session, redirectType: marker }, error: null };
        },
        async updateUser(attributes) {
          assert(recovery, 'Password updates must use the isolated session');
          calls.push({ method: 'update', attributes });
          return update ? update() : { data: { user: { id: 'recovered-account' } }, error: null };
        },
        async signOut() { calls.push({ method: recovery ? 'recovery-signout' : 'MAIN-SIGNOUT' }); },
        async setSession() { calls.push({ method: 'MAIN-SETSESSION' }); throw new Error('Recovery must never replace the ordinary login'); },
      } };
      clients.push(client);
      return client;
    } },
    'expo-crypto': { randomUUID },
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only',
      getItemAsync: async key => store.get(key) ?? null,
      setItemAsync: async (key, value) => { store.set(key, value); },
      deleteItemAsync: async key => { store.delete(key); },
    },
    'expo-web-browser': {},
    react: new Proxy({}, { get: (_target, key) => react[key] }),
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': Object.fromEntries(['ActivityIndicator', 'KeyboardAvoidingView', 'Pressable', 'ScrollView', 'Modal', 'Text', 'TextInput', 'View'].map(name => [name, name])),
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    '@expo/vector-icons/AntDesign': { default: 'AntDesign' }, '@expo/vector-icons/Feather': { default: 'Feather' },
    'expo-router': { Stack: { Screen: 'StackScreen' }, useFocusEffect: callback => { focusEffect = callback; }, router: { replace: path => navigation.push(path) } },
    '../components/ui': { colors: {}, Screen: 'Screen', tokens: { font: {} } },
    './ui': { colors: {}, tokens: { font: {} } }, './brand': { BrandLogo: 'BrandLogo' },
  };
  Object.assign(adapters['react-native'], { StyleSheet: { create: value => value }, Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener() {} }, BackHandler: { addEventListener(_event, callback) { backHandler = callback; return { remove() { backHandler = undefined; } }; } } });
  const context = vm.createContext({ URL: globalThis.URL, AbortController: globalThis.AbortController, FormData: globalThis.FormData, Promise, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.invalid' } }, __DEV__: true,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    fetch: async url => url.endsWith('/config')
      ? globalThis.Response.json({ ready: true, supabaseUrl: 'https://auth.example.invalid', supabaseAnonKey: 'fixture-public-key' })
      : globalThis.Response.json({ external: { google: false, email: true } }),
  });
  const load = name => {
    if (modules[name]) return modules[name];
    const exported = {};
    modules[name] = exported;
    const require = path => {
      if (path.endsWith('/sharing-client') || path === './sharing-client') return load('sharing');
      if (path.endsWith('/auth-recovery') || path === './auth-recovery') return load('recovery');
      assert(Object.hasOwn(adapters, path), `Unexpected module ${path}`);
      return adapters[path];
    };
    vm.runInContext(`(function(exports,require){${sources[name]}\n})`, context)(exported, require);
    return exported;
  };
  api = load('recovery');
  return {
    api, store, calls, clients, logs, navigation, sharing: load('sharing'), intent: load('intent'),
    async requested() { return api.requestPasswordRecovery('fixture@example.invalid'); },
    async prepared() {
      await this.requested();
      assert.equal(this.intent.redirectSystemPath({ path: 'peekalo://reset-password?code=fixture-code', initial: true }), '/reset-password');
      const id = api.passwordRecoveryRevision();
      await api.preparePasswordRecovery(id);
      return id;
    },
    mount(t, name = 'screen', props = {}) {
      const hooks = [], effects = new Map();
      let cursor = 0, mounted = true, pending = false, tree, cleanup;
      const same = (a, b) => a?.length === b?.length && a.every((item, i) => Object.is(item, b[i]));
      const schedule = () => {
        if (pending || !mounted) return;
        pending = true;
        globalThis.queueMicrotask(() => { pending = false; if (mounted) render(); });
      };
      react = {
        useState(initial) { const i = cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, value => {
          assert(mounted, 'Stale recovery must not publish into an unmounted screen');
          hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; schedule();
        }]; },
        useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
        useCallback(fn, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { fn, deps }; return hooks[i].fn; },
        useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) { hooks[i] = { deps, cleanup: hooks[i]?.cleanup }; effects.set(i, fn); } },
      };
      const component = name === 'screen' ? load(name).default : load(name).ShareCapture;
      const render = () => {
        cursor = 0; tree = component(props);
        for (const [i, fn] of effects) { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); }
        effects.clear();
      };
      render();
      if (name === 'screen') cleanup = focusEffect();
      const unmount = () => { if (!mounted) return; cleanup?.(); for (const hook of hooks) hook.cleanup?.(); mounted = false; };
      t.after(unmount);
      const lookup = label => find(tree, node => node.props?.accessibilityLabel === label || node.props?.label === label || typeof node.props?.onPress === 'function' && find(node.props?.children, child => child.type === 'Text' && child.props.children === label));
      return {
        unmount,
        blur: () => { cleanup?.(); cleanup = undefined; },
        press(label) { const node = lookup(label); assert(node, `Missing ${label}`); assert(!node.props.disabled, `${label} disabled`); node.props.onPress(); },
        change(label, value) { const node = lookup(label); assert(node?.props.onChangeText, `Missing input ${label}`); node.props.onChangeText(value); },
        has: label => !!lookup(label),
        error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
        disabled: label => lookup(label)?.props.disabled,
        back: () => backHandler?.(),
        gestureEnabled: () => find(tree, node => node.type === 'StackScreen')?.props.options.gestureEnabled,
        text: () => JSON.stringify(tree),
      };
    },
  };
}

test('forgot-password request is generic, PKCE-isolated and leaves the ordinary login untouched', async () => {
  const h = harness();
  const message = await h.requested();
  assert.match(message, /^If an account uses that email/);
  assert.match(message, /Open it on this device/);
  assert.equal(h.calls[0].options.redirectTo, 'peekalo://reset-password');
  assert.equal(h.clients[0].options.auth.flowType, 'pkce');
  assert.equal(h.clients.at(-1).options.auth.autoRefreshToken, false);
  assert.equal((await h.clients[0].auth.getSession()).data.session.user.id, 'existing-main-account');
  assert.deepEqual(h.logs, []);
});

test('cold callback restores only the SecureStore verifier; recovery session never persists or signs in', async () => {
  const store = new Map();
  const first = harness({ store });
  await first.requested();
  const cold = harness({ store });
  assert.equal(cold.intent.redirectSystemPath({ path: 'peekalo://reset-password?code=fixture-code', initial: true }), '/reset-password');
  const id = cold.api.passwordRecoveryRevision();
  await cold.api.preparePasswordRecovery(id);
  assert.equal((await cold.clients.at(-1).auth.getSession()).data.session.user.id, 'recovered-account');
  assert(![...store.values()].some(value => value.includes('isolated-token')));
  assert.equal((await cold.clients[0].auth.getSession()).data.session.user.id, 'existing-main-account');
  await cold.api.updateRecoveredPassword(id, 'new-password-fixture');
  assert.equal(store.size, 0, 'Success removes all stored verifier chunks and indexes');
  assert(!cold.calls.some(call => call.method.startsWith('MAIN-')));
});

test('cold and warm reset intents strip all callback data while preserving Google routing', () => {
  const h = harness();
  for (const initial of [true, false]) {
    const route = h.intent.redirectSystemPath({ path: 'peekalo://reset-password?code=fixture-code', initial });
    assert.equal(route, '/reset-password');
    assert(!route.includes('fixture-code'));
  }
  assert.equal(h.intent.redirectSystemPath({ path: 'peekalo://auth-callback?code=google-code', initial: true }), '/');
  assert.equal(h.intent.redirectSystemPath({ path: 'peekalo://auth-callback?code=google-code', initial: false }), null);
  assert.deepEqual(h.logs, []);
});

test('malformed, token-bearing, error and wrong-path callbacks never exchange a code', async () => {
  for (const suffix of [':123?code=fixture-code', '/unexpected?code=fixture-code', '?code=fixture-code&code=other', '?code=fixture-code#access_token=private', '?code=fixture-code&access_token=private', '?error=expired&error_description=private']) {
    const h = harness();
    assert.equal(h.intent.redirectSystemPath({ path: `peekalo://reset-password${suffix}`, initial: true }), '/reset-password');
    await assert.rejects(h.api.preparePasswordRecovery(h.api.passwordRecoveryRevision()), error => error.code === 'invalid_recovery');
    assert(!h.calls.some(call => call.method === 'exchange'));
    assert.deepEqual(h.logs, []);
  }
});

test('an OAuth verifier cannot be used as password recovery; missing marker fails closed', async () => {
  for (const marker of ['signup', 'oauth', null, undefined]) {
    const h = harness({ marker: marker ?? null });
    await h.requested();
    h.api.receivePasswordRecoveryUrl('peekalo://reset-password?code=fixture-code');
    await assert.rejects(h.api.preparePasswordRecovery(h.api.passwordRecoveryRevision()), error => error.code === 'invalid_recovery');
    assert.equal(h.store.size, 0);
    assert(!h.calls.some(call => call.method === 'update' || call.method.startsWith('MAIN-')));
  }
});

test('expired codes and replayed callbacks fail closed without exposing server details', async () => {
  const h = harness();
  const id = await h.prepared();
  await assert.rejects(h.api.preparePasswordRecovery(id), error => error.code === 'invalid_recovery' && !error.message.includes('private'));
  await assert.rejects(h.api.updateRecoveredPassword(id, 'new-password-fixture'), error => error.code === 'invalid_recovery');
  assert.equal(h.calls.filter(call => call.method === 'exchange').length, 1);
  assert.deepEqual(h.logs, []);
});

test('cancelling a pending exchange cleans late session writes and cannot update a password', async () => {
  const pending = deferred();
  const h = harness({ exchange: () => pending.promise });
  await h.requested();
  h.api.receivePasswordRecoveryUrl('peekalo://reset-password?code=fixture-code');
  const id = h.api.passwordRecoveryRevision();
  const result = h.api.preparePasswordRecovery(id);
  await flush();
  h.api.cancelPasswordRecovery(id);
  pending.resolve();
  await assert.rejects(result, error => error.code === 'cancelled');
  await flush();
  assert.equal(h.store.size, 0);
  await assert.rejects(h.api.updateRecoveredPassword(id, 'new-password-fixture'), error => error.code === 'cancelled');
  assert(!h.calls.some(call => call.method === 'update' || call.method.startsWith('MAIN-')));
});

test('screen requires matching >=8 character passwords and deliberate sign-in after success', async t => {
  const h = harness();
  await h.requested();
  h.api.receivePasswordRecoveryUrl('peekalo://reset-password?code=fixture-code');
  const screen = h.mount(t);
  await flush();
  assert(screen.has('New password'));
  screen.change('New password', 'short'); screen.change('Confirm new password', 'short'); await flush();
  assert(screen.disabled('Update password'));
  screen.change('New password', 'fixture-password'); screen.change('Confirm new password', 'different-password'); await flush();
  screen.press('Update password'); await flush();
  assert.match(screen.error(), /do not match/);
  assert(!h.calls.some(call => call.method === 'update'));
  screen.change('Confirm new password', 'fixture-password'); await flush();
  screen.press('Update password'); await flush();
  assert.match(screen.text(), /Password updated\. Sign in with your new password\./);
  assert(!screen.has('New password'));
  assert(!h.calls.some(call => call.method.startsWith('MAIN-')));
  screen.press('Return to Profile');
  assert.deepEqual(h.navigation, ['/(tabs)/profile']);
});

for (const interruption of ['cancel', 'blur', 'unmount']) {
  test(`${interruption} during exchange prevents stale screen publication and ordinary session changes`, async t => {
    const pending = deferred();
    const h = harness({ exchange: () => pending.promise });
    await h.requested(); h.api.receivePasswordRecoveryUrl('peekalo://reset-password?code=fixture-code');
    const screen = h.mount(t); await flush();
    if (interruption === 'cancel') screen.press('Cancel password reset');
    else screen[interruption]();
    pending.resolve(); await flush();
    assert(!screen.has('New password'));
    assert.equal(h.store.size, 0);
    assert(!h.calls.some(call => call.method.startsWith('MAIN-')));
  });
}

test('a direct reset route without a callback session is unavailable and cannot update', async t => {
  const h = harness({ mainUser: null });
  const screen = h.mount(t); await flush();
  assert.match(screen.error(), /expired or unavailable/);
  assert(!screen.has('New password'));
  assert.equal(h.calls.length, 0);
});

test('saving blocks cancellation, Android Back and iOS gesture dismissal until result', async t => {
  const pending = deferred();
  const h = harness({ update: () => pending.promise });
  await h.requested(); h.api.receivePasswordRecoveryUrl('peekalo://reset-password?code=fixture-code');
  const screen = h.mount(t); await flush();
  screen.change('New password', 'fixture-password'); screen.change('Confirm new password', 'fixture-password'); await flush();
  screen.press('Update password'); await flush();
  assert.equal(screen.disabled('Cancel password reset'), true);
  assert.equal(screen.back(), true);
  assert.equal(screen.gestureEnabled(), false);
  assert.equal(h.navigation.length, 0);
  pending.resolve({ error: null }); await flush();
  assert.match(screen.text(), /Password updated/);
  assert.equal(screen.back(), false);
  assert.equal(screen.gestureEnabled(), true);
  assert.equal(h.store.size, 0);
  assert(!h.calls.some(call => call.method.startsWith('MAIN-')));
});

test('native warm recovery callback closes the account Modal before routing to reset', async t => {
  const h = harness({ mainUser: null });
  let closes = 0;
  const panel = h.mount(t, 'share', { visible: true, capture: null, onClose: () => { closes++; } });
  await flush();
  panel.change('Email', 'fixture@example.invalid'); await flush();
  panel.press('Forgot password?'); await flush();
  assert.match(panel.text(), /If an account uses that email/);
  h.intent.redirectSystemPath({ path: 'peekalo://reset-password?code=fixture-code', initial: false });
  assert.equal(closes, 1);
});
