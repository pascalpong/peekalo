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
function harness({ fetch = async () => config(), auth = {}, oauthAuth = {}, browser = {}, clock = {}, development = true, env = {} } = {}) {
  const calls = [];
  const logs = [];
  const oauthClients = [];
  let mainOptions;
  const timers = new Map();
  const client = { auth: {
    getSession: async () => ({ data: { session: { access_token: 'private-test-token', user: { id: 'test-user' } } } }),
    startAutoRefresh() {}, stopAutoRefresh() {},
    signInWithOAuth: async () => ({ data: { url: 'https://auth.example.invalid/authorize', flowId: 'fixture-flow' } }),
    exchangeCodeForSession: async () => ({ data: { session: { access_token: 'oauth-token', refresh_token: 'oauth-refresh', user: { id: 'google-user' } } } }),
    setSession: async tokens => ({ data: { session: tokens } }),
    signOut: async () => ({}),
    ...auth,
  } };
  const adapters = {
    'react-native-url-polyfill/auto': {},
    '@supabase/supabase-js': { createClient: (_url, _key, options) => {
      if (options.auth.storageKey?.startsWith('oauth-')) {
        const isolated = { auth: { ...client.auth, ...oauthAuth }, options };
        oauthClients.push(isolated); return isolated;
      }
      mainOptions = options; return client;
    }, processLock() {} },
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
  return { api: exported, client, calls, logs, timers, oauthClients, get mainOptions() { return mainOptions; } };
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
    auth: { exchangeCodeForSession: async code => { exchanged.push(code); return { data: { session: { access_token: 'fixture-token', refresh_token: 'fixture-refresh' } } }; } },
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

const googleFetch = url => url.endsWith('/config') ? config() : Response.json({ external: { google: true } });
const oauthSession = { access_token: 'fixture-google-token', refresh_token: 'fixture-google-refresh', user: { id: 'fixture-google' } };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

test('Google exchanges in isolated memory using its exact flow ID, then transfers without revoking tokens', async () => {
  const exchanges = [], commits = [], boundaries = [];
  const h = harness({ fetch: googleFetch,
    auth: {
      exchangeCodeForSession() { assert.fail('Ordinary client must not exchange OAuth codes'); },
      setSession: async tokens => { commits.push(tokens); return { data: { session: tokens } }; },
      signOut() { assert.fail('Transferred tokens must not be revoked'); },
    },
    oauthAuth: { exchangeCodeForSession: async (code, options) => {
      exchanges.push([code, options.flowId]);
      h.oauthClients[0].options.auth.storage.setItem('fixture-session', 'private-session');
      h.oauthClients[0].options.auth.storage.setItem('fixture-verifier', 'private-verifier');
      return { data: { session: oauthSession } };
    } },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code&sb_flow_id=fixture-flow' }) },
  });
  assert.equal(await h.api.signInWithGoogle(undefined, value => boundaries.push(value)), true);
  assert.deepEqual(exchanges, [['fixture-code', 'fixture-flow']]);
  assert.equal(commits.length, 1); assert.equal(commits[0].access_token, oauthSession.access_token);
  assert.deepEqual(boundaries, [true, false]);
  const storage = h.oauthClients[0].options.auth.storage;
  assert.equal(await storage.getItem('fixture-session'), null);
  assert.equal(await storage.getItem('fixture-verifier'), null);
  assert.equal(h.oauthClients[0].options.auth.autoRefreshToken, false);
  assert.deepEqual(h.logs, []);
});

test('aborting a pending isolated exchange never changes the ordinary session', async () => {
  const pending = deferred(); let commits = 0;
  const h = harness({ fetch: googleFetch,
    auth: { setSession: async () => { commits++; return {}; }, signOut: async () => { commits++; return {}; } },
    oauthAuth: { exchangeCodeForSession: () => pending.promise },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code' }) },
  });
  const screen = new AbortController();
  const login = h.api.signInWithGoogle(screen.signal); await flush();
  assert.equal(h.oauthClients.length, 1);
  screen.abort(); pending.resolve({ data: { session: oauthSession } });
  await assert.rejects(login, cancelled); assert.equal(commits, 0);
});

test('only one OAuth attempt can run across account modals; closing permits a fresh attempt', async () => {
  const browser = deferred();
  const h = harness({ fetch: googleFetch, browser: { openAuthSessionAsync: () => browser.promise } });
  const first = h.api.signInWithGoogle(); await flush();
  await assert.rejects(h.api.signInWithGoogle(), /already open/);
  assert.equal(h.oauthClients.length, 1);
  browser.resolve({ type: 'cancel' }); assert.equal(await first, false);
  assert.equal(await h.api.signInWithGoogle(), false); assert.equal(h.oauthClients.length, 2);
});

for (const suffix of [
  '?code=a&code=b', '?code=a&error=denied', '?code=a&error_code=denied', '?code=a&error_description=denied',
  '?code=a#fragment', '?code=a&access_token=fixture', '?code=a&refresh_token=fixture', '?code=a&sb_flow_id=other',
  '?code=a&sb_flow_id=fixture-flow&sb_flow_id=fixture-flow', '?code=%20', '?code=%3Cbad%3E', '?code=',
]) test(`invalid Google callback shape is rejected before exchange: ${suffix}`, async () => {
  let exchanges = 0;
  const h = harness({ fetch: googleFetch,
    oauthAuth: { exchangeCodeForSession: async () => { exchanges++; return {}; } },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: `peekalo://auth-callback${suffix}` }) },
  });
  await assert.rejects(h.api.signInWithGoogle(), /did not finish/); assert.equal(exchanges, 0); assert.deepEqual(h.logs, []);
});
for (const url of ['peekalo://user@auth-callback?code=a', 'peekalo://auth-callback:42?code=a', 'peekalo://auth-callback/extra?code=a', 'malformed']) {
  test('callback authority, path and malformed URLs cannot exchange', async () => {
    let exchanges = 0;
    const h = harness({ fetch: googleFetch, oauthAuth: { exchangeCodeForSession: async () => { exchanges++; return {}; } },
      browser: { openAuthSessionAsync: async () => ({ type: 'success', url }) } });
    await assert.rejects(h.api.signInWithGoogle(), /did not finish/); assert.equal(exchanges, 0);
  });
}

test('new email action invalidates an older Google exchange before it can commit', async () => {
  const exchange = deferred(); const mutations = [];
  const h = harness({ fetch: googleFetch, oauthAuth: { exchangeCodeForSession: () => exchange.promise },
    auth: { setSession: async tokens => { mutations.push(tokens.access_token); return { data: { session: tokens } }; } },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code' }) } });
  const google = h.api.signInWithGoogle(); await flush();
  await h.api.performAccountAuth(client => client.auth.setSession({ access_token: 'new-email-token', refresh_token: 'new-email-refresh' }));
  exchange.resolve({ data: { session: oauthSession } }); await assert.rejects(google, cancelled);
  assert.deepEqual(mutations, ['new-email-token']);
});

test('new email action waits for interrupted Google commit compensation and remains the final session', async () => {
  const commit = deferred(); const mutations = [], boundaries = [];
  let session = { access_token: 'previous-token', refresh_token: 'previous-refresh' };
  const h = harness({ fetch: googleFetch,
    auth: {
      getSession: async () => ({ data: { session } }),
      setSession: async tokens => {
        mutations.push(tokens.access_token);
        if (tokens.access_token === oauthSession.access_token) await commit.promise;
        session = tokens; return { data: { session } };
      },
    },
    browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code' }) },
    oauthAuth: { exchangeCodeForSession: async () => ({ data: { session: oauthSession } }) },
  });
  const google = h.api.signInWithGoogle(undefined, value => boundaries.push(value)); await flush();
  assert.deepEqual(boundaries, [true]);
  const email = h.api.performAccountAuth(client => client.auth.setSession({ access_token: 'new-email-token', refresh_token: 'new-email-refresh' }));
  await flush(); assert.equal(mutations.length, 1);
  commit.resolve(); await assert.rejects(google, cancelled); await email;
  assert.deepEqual(mutations, [oauthSession.access_token, 'previous-token', 'new-email-token']);
  assert.equal(session.access_token, 'new-email-token'); assert.deepEqual(boundaries, [true, false]);
});

test('aborted commit with no previous session signs out under the queue before the next action', async () => {
  const commit = deferred(); const mutations = [];
  const h = harness({ auth: {
    getSession: async () => ({ data: { session: null } }),
    setSession: async () => { mutations.push('late-login'); await commit.promise; return {}; },
    signOut: async () => { mutations.push('compensate-signout'); return {}; },
  } });
  const screen = new AbortController();
  const first = h.api.performAccountAuth(client => client.auth.setSession({ access_token: 'late', refresh_token: 'late-refresh' }), screen.signal);
  await flush(); screen.abort();
  const second = h.api.performAccountAuth(async () => { mutations.push('newer-action'); });
  commit.resolve(); await assert.rejects(first, cancelled); await second;
  assert.deepEqual(mutations, ['late-login', 'compensate-signout', 'newer-action']);
});

test('isolated OAuth transport is bounded and aborts its pending network request', async () => {
  let networkSignal;
  const h = harness({ fetch: (url, options) => {
    if (!url.endsWith('/pending-token')) return googleFetch(url);
    networkSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  },
  oauthAuth: { exchangeCodeForSession: async () => h.oauthClients[0].options.global.fetch('https://auth.example.invalid/pending-token') },
  browser: { openAuthSessionAsync: async () => ({ type: 'success', url: 'peekalo://auth-callback?code=fixture-code' }) } });
  const screen = new AbortController(); const pending = h.api.signInWithGoogle(screen.signal); await flush();
  assert(networkSignal); assert([...h.timers.values()].some(timer => timer.delay === 30_000));
  screen.abort(); await assert.rejects(pending); assert.equal(networkSignal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('aborted sign-out never tries to restore a server-revoked refresh token', async () => {
  const pending = deferred(); const changes = [];
  const h = harness({ auth: {
    signOut: async () => { changes.push('signout'); await pending.promise; return {}; },
    setSession: async () => { assert.fail('A revoked refresh token must not be restored'); },
  } });
  const screen = new AbortController();
  const signout = h.api.performAccountAuth(client => client.auth.signOut({ scope: 'local' }), screen.signal, undefined, { restoreOnCancel: false });
  await flush(); screen.abort(); pending.resolve();
  await assert.rejects(signout, cancelled);
  await h.api.performAccountAuth(async () => { changes.push('new-signin'); });
  assert.deepEqual(changes, ['signout', 'new-signin']);
});

test('ordinary Auth transport times out and releases the account commit boundary', async () => {
  let networkSignal; const boundaries = [];
  const h = harness({ fetch: (url, options) => {
    if (!url.endsWith('/pending-login')) return config();
    networkSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  } });
  await h.api.getSharingClient();
  const login = h.api.performAccountAuth(() => h.mainOptions.global.fetch('https://auth.example.invalid/pending-login'), undefined, value => boundaries.push(value));
  await flush(); assert.deepEqual(boundaries, [true]);
  const timeout = [...h.timers.values()].find(timer => timer.delay === 30_000); assert(timeout);
  timeout.fn(); await assert.rejects(login); assert.equal(networkSignal.aborted, true);
  assert.deepEqual(boundaries, [true, false]);
  await h.api.performAccountAuth(async () => {});
});

test('ordinary Auth transport respects an SDK cancellation signal', async () => {
  const h = harness({ fetch: (url, options) => {
    if (!url.endsWith('/pending-login')) return config();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  await h.api.getSharingClient(); const sdk = new AbortController();
  const request = h.mainOptions.global.fetch('https://auth.example.invalid/pending-login', { signal: sdk.signal });
  sdk.abort(); await assert.rejects(request); assert.equal(h.timers.size, 0);
});
