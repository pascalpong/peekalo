import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const { URLSearchParams, Response, EventTarget, Event } = globalThis;
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const helperSource = await compile('../apps/web/lib/deletion-auth.ts');
const componentSource = await compile('../apps/web/components/account-deletion.tsx');
const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function storage() { const data = new Map(); return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }
function helpers(fetcher = fetch) {
  const exports = {};
  vm.runInNewContext(helperSource, { exports, URL, URLSearchParams, AbortSignal, fetch: fetcher, require(path) { assert.equal(path, '@supabase/supabase-js'); return { createClient }; } });
  return exports;
}
const api = helpers();
const requestId = '11111111-1111-4111-8111-111111111111';
const secret = 'a'.repeat(43);

test('deletion storage persists only expiring verifier slots and keeps Auth sessions in memory', () => {
  const persistent = storage(); let time = 1000;
  persistent.setItem('ordinary-session', 'preserve-this');
  const one = api.deletionStorage(persistent, () => time);
  for (const key of ['peekalo-deletion-only-code-verifier', 'peekalo-deletion-only-flow-123-code-verifier', 'peekalo-deletion-only-flows-code-verifier']) one.setItem(key, 'fixture-verifier');
  one.setItem('peekalo-deletion-only', 'private-session-token');
  assert.equal([...persistent.data.values()].some(value => value.includes('private-session-token')), false);
  const two = api.deletionStorage(persistent, () => time);
  assert.equal(two.getItem('peekalo-deletion-only'), null);
  assert.equal(two.getItem('peekalo-deletion-only-flow-123-code-verifier'), 'fixture-verifier');
  time += 600001; assert.equal(two.getItem('peekalo-deletion-only-code-verifier'), null);
  one.clear(); assert.equal(persistent.length, 1); assert.equal(persistent.getItem('ordinary-session'), 'preserve-this');
});

test('deletion callback rejects duplicate, implicit, recovery and error-bearing callbacks', () => {
  assert.equal(api.deletionCallback('https://peekalo.test/delete-account').present, false);
  assert.equal(api.deletionCallback('https://peekalo.test/delete-account?code=abcdefgh').code, 'abcdefgh');
  for (const suffix of ['?code=abcdefgh&code=abcdefgh', '?code=abcdefgh&type=recovery', '?error=access_denied', '#access_token=secret', '?code=abcdefgh#access_token=secret', '?code=short', '?code=abcdefgh&next=https://evil.test']) assert.equal(api.deletionCallback(`https://peekalo.test/delete-account${suffix}`).code, null);
});

test('receipt capability accepts only a bounded exact fragment; never a query secret', () => {
  const value = { requestId, receipt: secret };
  const url = `https://peekalo.test${api.deletionStatusUrl(value)}`;
  assert.deepEqual(JSON.parse(JSON.stringify(api.deletionReceipt(url))), value);
  assert.equal(api.deletionReceipt(url.replace('#', '?')), null);
  assert.equal(api.deletionReceipt(`${url}&receipt=${secret}`), null);
  assert.equal(api.deletionReceipt(`${url}&other=bad`), null);
  assert.equal(api.deletionReceipt(url.replace(secret, 'short')), null);
});

test('actual Supabase SDK Google PKCE keeps verifier across fresh clients without persisting tokens', async () => {
  const persistent = storage(); let exchangeBody;
  const signature = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: requestId, aud: 'authenticated' })).toString('base64url');
  const token = `eyJhbGciOiJIUzI1NiJ9.${signature}.fixture`;
  const fixtureApi = helpers(async (input, init) => {
    const url = String(input);
    if (url === '/api/shares/config') return Response.json({ ready: true, supabaseUrl: 'https://fixture.supabase.test', supabaseAnonKey: 'public-fixture-key' });
    assert(url.includes('/auth/v1/token?grant_type=pkce'));
    exchangeBody = JSON.parse(init.body);
    return Response.json({ access_token: token, refresh_token: 'fixture-refresh-secret', expires_in: 3600, token_type: 'bearer', user: { id: requestId, email: 'fixture@example.test', aud: 'authenticated' } });
  });
  const first = await fixtureApi.createDeletionClient(persistent);
  first.storage.start();
  const flow = await first.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'https://peekalo.test/delete-account', skipBrowserRedirect: true } });
  assert.equal(flow.error, null); assert(flow.data.flowId); assert([...persistent.data.keys()].some(key => key.includes(`flow-${flow.data.flowId}-code-verifier`)));
  const second = await fixtureApi.createDeletionClient(persistent);
  assert(second.storage.consumeStart()); assert.equal(second.storage.consumeStart(), false);
  const result = await second.client.auth.exchangeCodeForSession('fixture-auth-code', { flowId: flow.data.flowId });
  assert.equal(result.error, null); assert(exchangeBody.code_verifier.length >= 43);
  assert.equal([...persistent.data.values()].some(value => value.includes(token) || value.includes('fixture-refresh-secret')), false);
  second.storage.clear(); assert.equal(persistent.length, 0);
});

function walk(node, predicate) { if (!node || typeof node !== 'object') return undefined; if (Array.isArray(node)) { for (const value of node) { const found = walk(value, predicate); if (found) return found; } return undefined; } return predicate(node) ? node : walk(node.props?.children, predicate); }
function harness(t, { href = 'https://peekalo.test/delete-account', callbackSession, signIn, exchange, fetcher, start = true, initFailure = false } = {}) {
  const cells = [], effects = [], cleanups = [], requests = [], assignments = [], authCalls = [];
  let cursor = 0, component, tree, mounted = true, clears = 0, connections = 0;
  const window = Object.assign(new EventTarget(), { location: { href, pathname: '/delete-account', origin: 'https://peekalo.test', assign: value => assignments.push(value) }, sessionStorage: storage(), history: { replaceState(a, b, path) { window.location.href = `https://peekalo.test${path}`; } } });
  const session = callbackSession ?? { access_token: 'private-fixture-bearer', user: { email: 'fixture@example.test' } };
  const value = { storage: { clear() { clears++; }, start() {}, consumeStart: () => start }, client: { auth: {
    signInWithPassword: async args => { authCalls.push({ method: 'password', ...args }); return signIn ? signIn(args) : { data: { session }, error: null }; },
    signInWithOAuth: async args => { authCalls.push({ method: 'oauth', ...args }); return { data: { url: 'https://accounts.google.test/oauth' }, error: null }; },
    exchangeCodeForSession: async (...args) => { authCalls.push({ method: 'exchange', args }); return exchange ? exchange(...args) : { data: { session }, error: null }; },
  } } };
  const render = () => { cursor = 0; tree = component(); };
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], next => { assert(mounted, 'No updates after unmount'); cells[index] = typeof next === 'function' ? next(cells[index]) : next; render(); }]; },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useEffect(callback, deps) { const index = cursor++; if (!cells[index]) { cells[index] = deps; effects.push(callback); } },
  };
  const exports = {};
  vm.runInNewContext(componentSource, { exports, window, AbortSignal, fetch: async (url, init) => { requests.push({ url, ...init }); return fetcher ? fetcher(url, init) : Response.json({ status: 'pending', requestId, receipt: secret }, { status: 202 }); }, require(path) {
    if (path === 'react') return react;
    if (path === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (path === '../lib/deletion-auth') return { ...api, createDeletionClient: async () => { connections++; if (typeof initFailure === 'function' ? initFailure(connections) : initFailure) throw new Error('fixture init failure'); return value; } };
    throw new Error(path);
  } });
  component = exports.AccountDeletion; render();
  const effect = effects.shift(); cleanups.push(effect());
  const find = predicate => walk(tree, predicate);
  const button = label => find(node => node.type === 'button' && node.props.children === label);
  const change = (type, next) => { const node = find(node => node.type === 'input' && node.props.type === type); assert(node, `Missing input ${type}`); node.props.onChange({ target: type === 'checkbox' ? { checked: next } : { value: next } }); };
  const unmount = () => { if (!mounted) return; for (const cleanup of cleanups) cleanup?.(); mounted = false; };
  t.after(unmount);
  return { requests, assignments, authCalls, window, find, button, change, clears: () => clears, connections: () => connections, text: () => JSON.stringify(tree), unmount, replayEffect() { cleanups.pop()?.(); cleanups.push(effect()); }, async submit() { const form = find(node => node.type === 'form'); assert(form); await form.props.onSubmit({ preventDefault() {} }); await flush(); }, async click(label) { const node = button(label); assert(node, `Missing ${label}`); node.props.onClick(); await flush(); } };
}
async function verify(h) { await flush(); h.change('email', 'fixture@example.test'); h.change('password', 'fixture-password'); await h.submit(); }

test('fresh verified identity still requires separate confirmation; accepted cleanup remains pending and exposes receipt status only', async t => {
  const h = harness(t); await verify(h);
  assert.equal(h.requests.length, 0); assert.equal(h.button('Delete this account permanently').props.disabled, true);
  assert(!h.text().includes('private-fixture-bearer')); assert(!h.text().includes('fixture-password'));
  await h.submit(); assert.equal(h.requests.length, 0);
  h.change('checkbox', true); await h.submit();
  assert.equal(h.requests.length, 1); const request = h.requests[0];
  assert.equal(request.url, '/api/account/delete'); assert.equal(request.headers.Authorization, 'Bearer private-fixture-bearer');
  assert.deepEqual(JSON.parse(request.body), { confirmation: 'DELETE' }); assert.equal(request.cache, 'no-store'); assert.equal(request.referrerPolicy, 'no-referrer');
  assert.match(h.text(), /cleanup is pending/); assert(h.button('Check deletion status')); assert(!h.text().includes('fixture@example.test'));
});

test('wrong password never enables deletion and clears password fields', async t => {
  const h = harness(t, { signIn: async () => ({ data: { session: null }, error: { message: 'never echo backend' } }) });
  await verify(h); assert.equal(h.requests.length, 0); assert(!h.button('Delete this account permanently')); assert(!h.text().includes('fixture-password')); assert(!h.text().includes('never echo backend'));
});

test('uncertain network response keeps same verified request retryable rather than showing success', async t => {
  let count = 0;
  const h = harness(t, { fetcher: async () => { if (!count++) throw new Error('uncertain'); return Response.json({ status: 'pending', requestId, receipt: secret }); } });
  await verify(h); h.change('checkbox', true); await h.submit();
  assert.match(h.text(), /could not be confirmed/); assert(!h.button('Check deletion status'));
  await h.submit(); assert.equal(h.requests.length, 2); assert.equal(h.requests[0].headers.Authorization, h.requests[1].headers.Authorization); assert(h.button('Check deletion status'));
});

test('deferred sign-in result after real unmount cannot update state or submit deletion', async t => {
  const pending = deferred(); const h = harness(t, { signIn: () => pending.promise }); await flush();
  h.change('email', 'fixture@example.test'); h.change('password', 'fixture-password'); const call = h.submit();
  await flush(); h.unmount(); pending.resolve({ data: { session: { access_token: 'secret', user: { email: 'fixture@example.test' } } }, error: null }); await call;
  assert.equal(h.requests.length, 0);
});

test('Google callback cleans URL, exchanges once under effect replay, and never automatically deletes', async t => {
  const h = harness(t, { href: 'https://peekalo.test/delete-account?code=fixture_auth_code&sb_flow_id=1234567890abcdef1234567890abcdef' });
  h.replayEffect(); await flush(); assert.equal(h.window.location.href, 'https://peekalo.test/delete-account');
  assert.equal(h.authCalls.filter(call => call.method === 'exchange').length, 1); assert.equal(h.requests.length, 0);
  assert(h.button('Delete this account permanently')); assert.equal(h.button('Delete this account permanently').props.disabled, true);
});

test('unsolicited or token-bearing Google callback cannot enable deletion', async t => {
  for (const args of [{ href: 'https://peekalo.test/delete-account?code=fixture_auth_code', start: false }, { href: 'https://peekalo.test/delete-account#access_token=secret' }]) {
    const h = harness(t, args); await flush(); assert.equal(h.authCalls.length, 0); assert(!h.button('Delete this account permanently')); assert.equal(h.window.location.href, 'https://peekalo.test/delete-account');
  }
});

test('Google navigation preserves its verifier on pagehide, ordinary pagehide clears credentials', async t => {
  const h = harness(t); await flush(); await h.click('Verify with Google'); const before = h.clears();
  h.window.dispatchEvent(new Event('pagehide')); await flush(); assert.equal(h.clears(), before); assert.equal(h.assignments.length, 1);
  const other = harness(t); await verify(other); const beforeOther = other.clears(); other.window.dispatchEvent(new Event('pagehide')); await flush(); assert(other.clears() > beforeOther);
});

test('receipt page strips capability immediately and waits for deliberate status check; pending Apple differs from complete', async t => {
  let status = 'pending';
  const h = harness(t, { href: `https://peekalo.test/delete-account#requestId=${requestId}&receipt=${secret}`, fetcher: async () => Response.json({ status, needsAppleReauthentication: true }) });
  await flush(); assert.equal(h.window.location.href, 'https://peekalo.test/delete-account'); assert.equal(h.requests.length, 0);
  await h.click('Check deletion status'); assert.equal(h.requests[0].url, '/api/account/deletion-status'); assert.equal(h.requests[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(h.requests[0].body), { requestId, receipt: secret }); assert.match(h.text(), /Reconnect Sign in with Apple/);
  status = 'complete'; await h.click('Check deletion status'); assert.match(h.text(), /cleanup is complete/);
});

test('status outage or expired receipt cannot be rendered as completed deletion', async t => {
  const h = harness(t, { href: `https://peekalo.test/delete-account#requestId=${requestId}&receipt=${secret}`, fetcher: async () => Response.json({ error: 'gone' }, { status: 404 }) });
  await flush(); await h.click('Check deletion status'); assert.match(h.text(), /No completion result could be confirmed/); assert(!h.text().includes('cleanup is complete'));
});


function restorePage(h) {
  h.window.dispatchEvent(new Event('pagehide'));
  const event = new Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true }); h.window.dispatchEvent(event);
}

test('BFCache restore clears confirmed identity and permits only a fresh sign-in and confirmation', async t => {
  const h = harness(t); await verify(h); h.change('checkbox', true);
  restorePage(h); await flush();
  assert(!h.text().includes('fixture@example.test')); assert(!h.text().includes('fixture-password'));
  assert(!h.button('Delete this account permanently')); assert.equal(h.button('Verify with email and password').props.disabled, false);
  assert.equal(h.connections(), 2); assert.equal(h.requests.length, 0);
  await verify(h); assert.equal(h.button('Delete this account permanently').props.disabled, true);
  h.change('checkbox', true); await h.submit(); assert.equal(h.requests.length, 1); assert(h.button('Check deletion status'));
});

test('BFCache restoration fences unfinished password sign-in before a replacement connection', async t => {
  const pending = deferred(); let attempts = 0;
  const h = harness(t, { signIn: () => ++attempts === 1 ? pending.promise : Promise.resolve({ data: { session: { access_token: 'fresh-fixture-token', user: { email: 'fresh@example.test' } } }, error: null }) });
  await flush(); h.change('email', 'stale@example.test'); h.change('password', 'fixture-password');
  const call = h.submit(); await flush(); restorePage(h); await flush();
  assert.equal(h.button('Verify with email and password').props.disabled, true);
  pending.resolve({ data: { session: { access_token: 'stale-token', user: { email: 'stale@example.test' } } }, error: null });
  await call; await flush(); assert(!h.text().includes('stale@example.test'));
  assert.equal(h.button('Verify with email and password').props.disabled, false);
  await verify(h); assert.match(h.text(), /fresh@example.test/); assert.equal(h.requests.length, 0);
});

test('BFCache restoration never adopts a late OAuth callback session or automatically replays it', async t => {
  const pending = deferred();
  const h = harness(t, { href: 'https://peekalo.test/delete-account?code=fixture_auth_code', exchange: () => pending.promise });
  await flush(); restorePage(h); await flush();
  pending.resolve({ data: { session: { access_token: 'stale-token', user: { email: 'stale@example.test' } } }, error: null });
  await flush(); assert(!h.text().includes('stale@example.test')); assert.equal(h.authCalls.filter(call => call.method === 'exchange').length, 1);
  assert.equal(h.button('Verify with email and password').props.disabled, false); assert.equal(h.requests.length, 0);
});

test('a transient config failure can reconnect deliberately without replaying a captured OAuth callback', async t => {
  const h = harness(t, { href: 'https://peekalo.test/delete-account?code=fixture_auth_code', initFailure: attempt => attempt === 1 });
  await flush(); assert(h.button('Reconnect verification')); assert.equal(h.button('Verify with email and password').props.disabled, true);
  await h.click('Reconnect verification');
  assert.equal(h.connections(), 2); assert.equal(h.button('Verify with email and password').props.disabled, false);
  assert.equal(h.authCalls.filter(call => call.method === 'exchange').length, 0);
  await verify(h); assert(h.button('Delete this account permanently')); assert.equal(h.requests.length, 0);
});

test('a saved deletion receipt remains usable after BFCache return with no stale busy state', async t => {
  const pending = deferred(); let checks = 0;
  const h = harness(t, { href: `https://peekalo.test/delete-account#requestId=${requestId}&receipt=${secret}`, fetcher: () => ++checks === 1 ? pending.promise : Promise.resolve(Response.json({ status: 'pending', needsAppleReauthentication: false })) });
  await flush(); const old = h.click('Check deletion status'); await flush(); restorePage(h); await flush();
  assert.equal(h.button('Check deletion status').props.disabled, false);
  pending.resolve(Response.json({ status: 'complete' })); await old; assert(!h.text().includes('cleanup is complete'));
  await h.click('Check deletion status'); assert.match(h.text(), /Deletion remains pending/); assert.equal(h.requests.length, 2);
});
