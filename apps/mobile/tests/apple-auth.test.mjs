import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual coordinator with native/Auth adapters. These are synthetic
// credentials only; this suite makes no network or keychain calls.
const source = ts.transpileModule(readFileSync(new URL('../src/lib/sharing-client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const appleSession = { access_token: 'synthetic-apple-token', refresh_token: 'synthetic-apple-refresh', user: { id: 'apple-fixture' } };
const initialSession = { access_token: 'synthetic-existing-token', refresh_token: 'synthetic-existing-refresh', user: { id: 'existing-fixture', email: 'fixture@example.invalid' } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const cancelled = error => error.code === 'cancelled';
function harness({ available = true, provider = true, native, exchange, commit, browser, settingsFailure = false, previous = initialSession, network } = {}) {
  const events = [], logs = [], isolated = [], nativeRequests = [], exchanges = [], timers = new Set();
  let session = previous;
  const main = { auth: {
    startAutoRefresh() {}, stopAutoRefresh() {},
    async getSession() { return { data: { session }, error: null }; },
    async setSession(tokens) {
      events.push(`main:${tokens.access_token}`);
      if (commit) await commit(tokens);
      session = tokens; return { data: { session }, error: null };
    },
    async signOut() { events.push('main:signout'); session = null; return { error: null }; },
  } };
  const adapters = {
    'react-native-url-polyfill/auto': {},
    'react-native': { AppState: { currentState: 'active', addEventListener() {} } },
    'expo-secure-store': {},
    'expo-crypto': { randomUUID, CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, async digestStringAsync(algorithm, value) {
      assert.equal(algorithm, 'SHA-256'); return createHash('sha256').update(value).digest('hex');
    } },
    'expo-web-browser': { openAuthSessionAsync: browser ?? (async () => ({ type: 'cancel' })), dismissAuthSession() {} },
    'expo-apple-authentication': {
      AppleAuthenticationScope: { EMAIL: 1 }, isAvailableAsync: async () => available,
      async signInAsync(options) {
        nativeRequests.push(options); events.push('native');
        return native ? native(options) : { identityToken: 'synthetic-id-token', state: options.state };
      },
    },
    '@supabase/supabase-js': { processLock() {}, createClient(_url, _key, options) {
      if (!options.auth.storageKey) return main;
      const temporary = { options, auth: {
        startAutoRefresh() {}, stopAutoRefresh() { events.push('isolated:stop'); },
        async signInWithPassword(credentials) { exchanges.push(credentials); return exchange ? exchange(credentials, options) : { data: { session: appleSession }, error: null }; },
        async signInWithIdToken(credentials) {
          assert(options.auth.storageKey.startsWith('apple-'));
          exchanges.push(credentials); events.push('isolated:exchange');
          return exchange ? exchange(credentials, options) : { data: { session: appleSession }, error: null };
        },
        async signInWithOAuth() { return { data: { url: 'https://auth.example.invalid/authorize', flowId: 'synthetic-flow' } }; },
        async exchangeCodeForSession() { return { data: { session: appleSession }, error: null }; },
      } };
      isolated.push(temporary); return temporary;
    } },
  };
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported, require: name => { assert(name in adapters, name); return adapters[name]; },
    URL, FormData, AbortController, __DEV__: false, process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.invalid' } },
    console: { warn: (...args) => logs.push(args), log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    setTimeout: (fn, ms) => { const entry = { fn, ms }; timers.add(entry); return entry; }, clearTimeout: entry => timers.delete(entry),
    fetch: async (url, options) => {
      if (url.endsWith('/pending-token') && network) return network(options);
      if (url.endsWith('/config')) return Response.json({ ready: true, supabaseUrl: 'https://auth.example.invalid', supabaseAnonKey: 'synthetic-public-key' });
      if (settingsFailure) throw new Error('synthetic private provider diagnostics');
      return Response.json({ external: { apple: provider, google: true, email: true } });
    },
  });
  return { api: exported, main, events, logs, isolated, nativeRequests, exchanges, timers, get session() { return session; } };
}

test('Apple sends the hashed nonce to native, raw nonce to Auth and commits only the verified isolated session', async () => {
  const h = harness(); const boundaries = [];
  assert.equal(await h.api.signInWithApple(undefined, value => boundaries.push(value)), true);
  assert.equal(h.nativeRequests.length, 1); assert.equal(h.exchanges.length, 1);
  const native = h.nativeRequests[0], exchange = h.exchanges[0];
  assert.equal(native.nonce, createHash('sha256').update(exchange.nonce).digest('hex'));
  assert.notEqual(native.nonce, exchange.nonce); assert.notEqual(native.state, exchange.nonce);
  assert.equal(exchange.provider, 'apple'); assert.equal(exchange.token, 'synthetic-id-token');
  assert.deepEqual([...native.requestedScopes], [1]);
  assert.equal(h.isolated[0].options.auth.persistSession, false);
  assert.equal(h.isolated[0].options.auth.autoRefreshToken, false);
  assert.equal(h.isolated[0].options.auth.detectSessionInUrl, false);
  assert(h.events.indexOf('isolated:exchange') < h.events.indexOf(`main:${appleSession.access_token}`));
  assert.equal(h.session.access_token, appleSession.access_token); assert.deepEqual(boundaries, [true, false]);
  assert.deepEqual(h.logs, []); assert.equal(h.timers.size, 0);
});

for (const [label, credential] of [
  ['missing token', options => ({ state: options.state })],
  ['missing state', () => ({ identityToken: 'synthetic-id-token' })],
  ['mismatched state', () => ({ identityToken: 'synthetic-id-token', state: 'wrong-request' })],
]) test(`Apple rejects ${label} before Auth exchange or ordinary login mutation`, async () => {
  const h = harness({ native: credential });
  await assert.rejects(h.api.signInWithApple(), /did not finish/);
  assert.equal(h.exchanges.length, 0); assert.equal(h.isolated.length, 0); assert.equal(h.session, initialSession);
  assert.deepEqual(h.logs, []);
});

for (const provider of [false, null, undefined]) test(`Apple refuses disabled/unknown provider (${String(provider)}) before the native sheet`, async () => {
  // undefined is explicitly absent in the returned JSON, rather than the harness default.
  const h = harness({ provider: provider === undefined ? 'missing' : provider });
  await assert.rejects(h.api.signInWithApple(), error => error.code === 'not_configured');
  assert.equal(h.nativeRequests.length, 0); assert.equal(h.exchanges.length, 0); assert.equal(h.session, initialSession);
});

test('provider lookup failure is safe, leaves the account intact and does not open Apple', async () => {
  const h = harness({ settingsFailure: true });
  await assert.rejects(h.api.signInWithApple(), /Cannot check Apple/);
  assert.equal(h.nativeRequests.length, 0); assert.equal(h.session, initialSession); assert.deepEqual(h.logs, []);
});

test('unsupported native Apple never contacts the provider or changes ordinary login', async () => {
  const h = harness({ available: false });
  await assert.rejects(h.api.signInWithApple(), /unavailable on this device/);
  assert.deepEqual(h.events, []); assert.equal(h.session, initialSession);
});

test('Apple sheet cancellation returns false, permits retry and never signs in', async () => {
  const h = harness({ native: async () => { throw { code: 'ERR_REQUEST_CANCELED', message: 'synthetic-private-info' }; } });
  assert.equal(await h.api.signInWithApple(), false); assert.equal(await h.api.signInWithApple(), false);
  assert.equal(h.nativeRequests.length, 2); assert.equal(h.exchanges.length, 0); assert.equal(h.session, initialSession); assert.deepEqual(h.logs, []);
});

test('Apple exchange errors and malformed session results are sanitized without ordinary login mutation', async () => {
  for (const result of [{ data: { session: null }, error: { message: 'synthetic-private-info' } }, { data: { session: null }, error: null }]) {
    const h = harness({ exchange: async () => result });
    await assert.rejects(h.api.signInWithApple(), error => error.message === 'Apple sign-in did not finish. Please try again.');
    assert.equal(h.session, initialSession); assert(!h.events.some(event => event.startsWith('main:'))); assert.deepEqual(h.logs, []);
  }
});

test('already aborted Apple does not open a sheet or exchange credentials', async () => {
  const h = harness(); const screen = new AbortController(); screen.abort();
  await assert.rejects(h.api.signInWithApple(screen.signal), cancelled);
  assert.equal(h.nativeRequests.length, 0); assert.equal(h.exchanges.length, 0); assert.equal(h.session, initialSession);
});

test('abort during native UI fences its late successful credential and permits later retry', async () => {
  const native = deferred(); let state; let firstRequest = true;
  const h = harness({ native: options => {
    if (!firstRequest) return { identityToken: 'synthetic-id-token', state: options.state };
    firstRequest = false; state = options.state; return native.promise;
  } });
  const screen = new AbortController(); const first = h.api.signInWithApple(screen.signal); await flush();
  assert.equal(h.nativeRequests.length, 1); screen.abort(); native.resolve({ identityToken: 'synthetic-late-token', state });
  await assert.rejects(first, cancelled); assert.equal(h.exchanges.length, 0); assert.equal(h.session, initialSession);
  assert.equal(await h.api.signInWithApple(), true);
});

test('abort during isolated exchange fences the late session without ordinary login writes', async () => {
  const exchange = deferred(); const h = harness({ exchange: () => exchange.promise });
  const screen = new AbortController(); const first = h.api.signInWithApple(screen.signal); await flush();
  assert.equal(h.exchanges.length, 1); assert(!h.events.some(event => event.startsWith('main:')));
  screen.abort(); exchange.resolve({ data: { session: appleSession }, error: null });
  await assert.rejects(first, cancelled); assert.equal(h.session, initialSession); assert.deepEqual(h.logs, []);
});

test('Apple and Google native/browser attempts are mutually exclusive in either direction', async () => {
  const native = deferred(); const h = harness({ native: () => native.promise });
  const apple = h.api.signInWithApple(); await flush();
  await assert.rejects(h.api.signInWithGoogle(), /already open/); await assert.rejects(h.api.signInWithApple(), /already open/);
  native.resolve({ identityToken: null }); await assert.rejects(apple);
  const browser = deferred(); const second = harness({ browser: () => browser.promise });
  const google = second.api.signInWithGoogle(); await flush();
  await assert.rejects(second.api.signInWithApple(), /already open/);
  browser.resolve({ type: 'cancel' }); assert.equal(await google, false);
});

for (const action of ['email', 'signout']) test(`a newer ${action} invalidates a pending Apple exchange before ordinary login can change`, async () => {
  const exchange = deferred(); const h = harness({ exchange: () => exchange.promise });
  const apple = h.api.signInWithApple(); await flush();
  if (action === 'email') await h.api.performAccountAuth(client => client.auth.setSession({ access_token: 'synthetic-email-token', refresh_token: 'synthetic-email-refresh' }));
  else await h.api.performAccountAuth(client => client.auth.signOut(), undefined, undefined, { restoreOnCancel: false });
  exchange.resolve({ data: { session: appleSession }, error: null }); await assert.rejects(apple, cancelled);
  assert.equal(h.session?.access_token ?? null, action === 'email' ? 'synthetic-email-token' : null);
  assert(!h.events.includes(`main:${appleSession.access_token}`)); assert.deepEqual(h.logs, []);
});

test('interrupted Apple commit compensates before a queued email sign-in becomes final', async () => {
  const commit = deferred(); const h = harness({ commit: tokens => tokens.access_token === appleSession.access_token ? commit.promise : undefined });
  const boundaries = []; const apple = h.api.signInWithApple(undefined, value => boundaries.push(value)); await flush();
  assert.deepEqual(boundaries, [true]);
  const email = h.api.performAccountAuth(client => client.auth.setSession({ access_token: 'synthetic-email-token', refresh_token: 'synthetic-email-refresh' }));
  await flush(); assert.equal(h.session, initialSession);
  commit.resolve(); await assert.rejects(apple, cancelled); await email;
  assert.deepEqual(h.events.filter(event => event.startsWith('main:')), [`main:${appleSession.access_token}`, `main:${initialSession.access_token}`, 'main:synthetic-email-token']);
  assert.equal(h.session.access_token, 'synthetic-email-token'); assert.deepEqual(boundaries, [true, false]);
});

test('abort during Apple final commit signs out its late login when no previous session exists', async () => {
  const commit = deferred(); const h = harness({ previous: null, commit: () => commit.promise });
  const screen = new AbortController(); const apple = h.api.signInWithApple(screen.signal); await flush(); screen.abort();
  commit.resolve(); await assert.rejects(apple, cancelled);
  assert.equal(h.session, null); assert(h.events.includes('main:signout')); assert.deepEqual(h.logs, []);
});


test('Apple isolated Auth transport shares the 30-second timeout and screen abort', async () => {
  let transportSignal;
  const h = harness({
    exchange: (_credentials, options) => options.global.fetch('https://auth.example.invalid/pending-token'),
    network: options => {
      transportSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('synthetic private transport error')), { once: true }));
    },
  });
  const screen = new AbortController(); const apple = h.api.signInWithApple(screen.signal); await flush();
  assert(transportSignal); assert([...h.timers].some(timer => timer.ms === 30_000));
  screen.abort(); await assert.rejects(apple, cancelled);
  assert.equal(transportSignal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.session, initialSession); assert.deepEqual(h.logs, []);
});


test('same-account Apple deletion proof refuses a different account before ordinary login changes', async () => {
  const h = harness();
  await assert.rejects(h.api.signInWithApple(undefined, undefined, 'existing-fixture'), error => error.code === 'account_changed');
  assert.equal(h.session, initialSession); assert.equal(h.events.some(event => event.startsWith('main:')), false);
});

test('Apple deletion authorization code is handed to the caller only after a same-account commit', async () => {
  const h = harness({ native: options => ({ identityToken: 'fixture-id-token', authorizationCode: 'fixture-one-use-code', state: options.state }), exchange: () => ({ data: { session: { ...appleSession, user: initialSession.user } }, error: null }) });
  const codes = [];
  assert.equal(await h.api.signInWithApple(undefined, undefined, 'existing-fixture', code => codes.push(code)), true);
  assert.deepEqual(codes, ['fixture-one-use-code']); assert.deepEqual(h.logs, []);
});

test('isolated password deletion proof rejects wrong account without replacing ordinary session', async () => {
  const h = harness();
  await assert.rejects(h.api.reauthenticateForDeletion('existing-fixture', 'fixture-generated-password'), error => error.code === 'account_changed');
  assert.equal(h.session, initialSession); assert.equal(h.events.some(event => event.startsWith('main:')), false);
  assert.equal(h.isolated[0].options.auth.persistSession, false); assert.deepEqual(h.logs, []);
});

test('isolated password deletion proof can only refresh the current account and never persists the password', async () => {
  const h = harness({ exchange: credentials => {
    assert.equal(credentials.email, 'fixture@example.invalid'); assert.equal(credentials.password, 'fixture-generated-password');
    return { data: { session: { ...appleSession, user: initialSession.user } }, error: null };
  } });
  await h.api.reauthenticateForDeletion('existing-fixture', 'fixture-generated-password');
  assert.equal(h.session.access_token, appleSession.access_token); assert.deepEqual(h.logs, []);
});

test('a newer signout invalidates isolated password proof before it can restore deletion login', async () => {
  const pending = deferred(); const h = harness({ exchange: () => pending.promise });
  const proof = h.api.reauthenticateForDeletion('existing-fixture', 'fixture-generated-password'); await flush();
  await h.api.performAccountAuth(client => client.auth.signOut(), undefined, undefined, { restoreOnCancel: false });
  pending.resolve({ data: { session: { ...appleSession, user: initialSession.user } }, error: null });
  await assert.rejects(proof, cancelled); assert.equal(h.session, null); assert.deepEqual(h.logs, []);
});


test('same-account Google deletion proof refuses a different account before ordinary login changes', async () => {
  const h = harness({ browser: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code&sb_flow_id=synthetic-flow' }) });
  await assert.rejects(h.api.signInWithGoogle(undefined, undefined, 'existing-fixture'), error => error.code === 'account_changed');
  assert.equal(h.session, initialSession); assert.equal(h.events.some(event => event.startsWith('main:')), false); assert.deepEqual(h.logs, []);
});
