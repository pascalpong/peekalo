import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual client with native adapters replaced; never call live Auth.
const source = ts.transpileModule(readFileSync(new URL('../src/lib/sharing-client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const config = () => Response.json({ ready: true, supabaseUrl: 'https://auth.example.invalid', supabaseAnonKey: 'public-test-key' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness({ fetch = async () => config(), auth = {}, browser = {}, clock = {}, development = true, env = {} } = {}) {
  const calls = [];
  const logs = [];
  const timers = new Map();
  const client = { auth: {
    getSession: async () => ({ data: { session: { access_token: 'private-test-token', user: { id: 'test-user' } } } }),
    startAutoRefresh() {}, stopAutoRefresh() {},
    signInWithOAuth: async () => ({ data: { url: 'https://auth.example.invalid/authorize' } }),
    exchangeCodeForSession: async () => ({}),
    ...auth,
  } };
  const adapters = {
    'react-native-url-polyfill/auto': {},
    '@supabase/supabase-js': { createClient: () => client, processLock() {} },
    'expo-crypto': { randomUUID },
    'expo-secure-store': {},
    'expo-web-browser': { openAuthSessionAsync: async () => ({ type: 'cancel' }), dismissAuthSession() {}, ...browser },
    'react-native': { AppState: { currentState: 'active', addEventListener() {} } },
  };
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported, require: name => { assert.ok(name in adapters, name); return adapters[name]; },
    URL, FormData, AbortController, __DEV__: development,
    process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.invalid', ...env } },
    console: { warn: (...values) => logs.push(values), log: (...values) => logs.push(values) },
    setTimeout: clock.setTimeout ?? ((fn, delay) => { const key = {}; timers.set(key, { fn, delay }); return key; }),
    clearTimeout: clock.clearTimeout ?? (key => timers.delete(key)),
    fetch: async (...args) => { calls.push(args); return fetch(...args); },
  });
  return { api: exported, client, calls, logs, timers };
}
const cancelled = error => error.code === 'cancelled';

test('cold bootstrap is single-flight with a 90s deadline; closing one waiter leaves another connected', async () => {
  const pending = deferred();
  const h = harness({ fetch: () => pending.promise });
  const screen = new AbortController();
  const closed = h.api.getSharingClient(screen.signal);
  const other = h.api.getSharingClient();
  assert.equal(h.calls.length, 1);
  assert.equal([...h.timers.values()][0].delay, 90_000);
  screen.abort();
  await assert.rejects(closed, cancelled);
  assert.equal(h.calls[0][1].signal.aborted, false);
  pending.resolve(config());
  assert.equal(await other, h.client);
  assert.equal(await h.api.getSharingClient(), h.client);
  assert.equal(h.timers.size, 0);
});

test('bootstrap timeout is sanitized and a later attempt starts fresh', async () => {
  let first = true;
  const h = harness({ fetch: (_url, { signal }) => first ? new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private network diagnostics')));
  }) : config() });
  const initial = h.api.getSharingClient();
  [...h.timers.values()][0].fn();
  await assert.rejects(initial, error => error.message === 'Cannot reach Peekalo. Check your connection and try again.');
  first = false;
  assert.equal(await h.api.getSharingClient(), h.client);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.logs, []);
});

test('an already cancelled action never bootstraps or sends credentials', async () => {
  const h = harness();
  const screen = new AbortController();
  screen.abort();
  await assert.rejects(h.api.apiRequest('/api/posts', { method: 'POST', body: {}, signal: screen.signal }), cancelled);
  assert.equal(h.calls.length, 0);
});

test('cancellation while restoring a session prevents the delayed authenticated upload', async () => {
  const session = deferred();
  const h = harness({ auth: { getSession: () => session.promise } });
  const screen = new AbortController();
  const upload = h.api.apiRequest('/api/posts', { method: 'POST', body: {}, signal: screen.signal });
  await h.api.getSharingClient();
  await Promise.resolve();
  screen.abort();
  session.resolve({ data: { session: { access_token: 'private-test-token' } } });
  await assert.rejects(upload, cancelled);
  assert.equal(h.calls.length, 1);
});

test('abort cancels an in-flight authenticated request and never logs its path or credentials', async () => {
  const started = deferred();
  const h = harness({ fetch: (url, options) => url.endsWith('/config') ? config() : new Promise((_resolve, reject) => {
    started.resolve();
    options.signal.addEventListener('abort', () => reject(new Error('private upload path and token')));
  }) });
  const screen = new AbortController();
  const upload = h.api.apiRequest('/api/posts/private-item', { method: 'POST', body: {}, signal: screen.signal });
  await started.promise;
  screen.abort();
  await assert.rejects(upload, cancelled);
  assert.equal(h.calls[1][1].signal.aborted, true);
  assert.deepEqual(h.logs, []);
});

test('provider lookup distinguishes disabled Google from a failed settings request', async () => {
  const disabled = harness({ fetch: url => url.endsWith('/config') ? config() : Response.json({ external: { google: false, email: true } }) });
  const availability = await disabled.api.getAuthProviders();
  assert.equal(availability.google, false);
  assert.equal(availability.email, true);
  await assert.rejects(disabled.api.signInWithGoogle(), error => error.code === 'not_configured');
  const unknown = harness({ fetch: url => url.endsWith('/config') ? config() : Promise.reject(new Error('offline')) });
  assert.equal((await unknown.api.getAuthProviders()).google, null);
  await assert.rejects(unknown.api.signInWithGoogle(), error => error.code === 'unavailable');
});

test('OAuth callback errors are generic and callback parameters never enter logs', async () => {
  let exchanges = 0;
  const h = harness({
    fetch: url => url.endsWith('/config') ? config() : Response.json({ external: { google: true } }),
    auth: { exchangeCodeForSession: async () => { exchanges++; return {}; } },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?error=denied&error_description=private-address-and-token' }) },
  });
  await assert.rejects(h.api.signInWithGoogle(), error => error.message === 'Google sign-in did not finish. Please try again.');
  assert.equal(exchanges, 0);
  assert.deepEqual(h.logs, []);
});

test('closing an OAuth operation dismisses the browser and rejects a late callback before code exchange', async () => {
  const opened = deferred();
  const result = deferred();
  let dismissals = 0;
  let exchanges = 0;
  const h = harness({
    fetch: url => url.endsWith('/config') ? config() : Response.json({ external: { google: true } }),
    auth: { exchangeCodeForSession: async () => { exchanges++; return {}; } },
    browser: { openAuthSessionAsync: () => { opened.resolve(); return result.promise; }, dismissAuthSession: () => { dismissals++; } },
  });
  const screen = new AbortController();
  const login = h.api.signInWithGoogle(screen.signal);
  await opened.promise;
  screen.abort();
  result.resolve({ type: 'success', url: 'peekalo://auth-callback?code=private-test-code' });
  await assert.rejects(login, cancelled);
  assert.equal(dismissals, 1);
  assert.equal(exchanges, 0);
});

test('only the configured callback can exchange a PKCE code', async () => {
  let redirect = 'https://unrelated.example.invalid/?code=private-test-code';
  const exchanged = [];
  const h = harness({
    fetch: url => url.endsWith('/config') ? config() : Response.json({ external: { google: true } }),
    auth: { exchangeCodeForSession: async code => { exchanged.push(code); return {}; } },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: redirect }) },
  });
  await assert.rejects(h.api.signInWithGoogle(), error => error.code === 'unavailable');
  assert.equal(exchanged.length, 0);
  redirect = 'peekalo://auth-callback?code=private-test-code';
  assert.equal(await h.api.signInWithGoogle(), true);
  assert.deepEqual(exchanged, ['private-test-code']);
  assert.deepEqual(h.logs, []);
});


test('isolated local mode wins over hosted env only in development', async () => {
  const env = { EXPO_PUBLIC_API_URL: 'https://hosted.example.invalid', EXPO_PUBLIC_PEEKALO_LOCAL_TESTING: 'true' };
  const local = harness({ env });
  await local.api.getSharingClient();
  assert.equal(local.calls[0][0], 'http://127.0.0.1:3101/api/shares/config');
  const release = harness({ env, development: false });
  await release.api.getSharingClient();
  assert.equal(release.calls[0][0], 'https://hosted.example.invalid/api/shares/config');
  const ordinary = harness({ env: { ...env, EXPO_PUBLIC_PEEKALO_LOCAL_TESTING: 'false' } });
  await ordinary.api.getSharingClient();
  assert.equal(ordinary.calls[0][0], 'https://hosted.example.invalid/api/shares/config');
});
