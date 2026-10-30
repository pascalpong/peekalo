import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/components/account-privacy.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const status = (extra = {}) => ({ termsVersion: 'fixture-terms', privacyVersion: 'fixture-privacy', accepted: true, policyReady: true, deletionStatus: null, ...extra });
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) { const result = find(item, predicate); if (result) return result; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
};
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
class SharingError extends Error { constructor(message, code) { super(message); this.code = code; } }
function harness(t, name = 'AccountPrivacy', props = {}) {
  const cells = [], effects = new Map(), requests = [], proofs = [], events = [], opened = [];
  let cursor = 0, tree, mounted = true, pending = false, signedOut = false;
  let properties = { accountId: 'fixture-owner', onDisabled() { events.push('callback'); }, status: status({ accepted: false }), onAccepted() { events.push('accepted'); }, ...props };
  const jsx = (type, props) => ({ type, props });
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; if (mounted) render(); }); };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = { state: initial }; return [cells[i].state, value => { assert(mounted, 'Late completion updated unmounted privacy UI'); cells[i].state = typeof value === 'function' ? value(cells[i].state) : value; schedule(); }]; },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, prior = cells[i]; if (!prior || !same(prior.deps, deps)) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.set(i, fn); } },
  };
  const client = { auth: { async getSession() { return { data: { session: { user: { id: properties.accountId } } } }; }, async signOut() { signedOut = true; events.push('signout'); return { error: null }; } } };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'expo-linking': { async openURL(url) { opened.push(url); } },
    'react-native': { Platform: { OS: 'android' }, ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value } },
    './ui': { colors: {}, tokens: { radius: {} }, typography: {} }, './apple-sign-in': { AppleSignIn: 'AppleSignIn' },
    '../lib/account-lifecycle': { notifyAccountDisabled(id) { events.push(`disabled:${id}`); } },
    '../lib/sharing-client': {
      SharingError, resolveApiUrl: path => `https://fixture.invalid${path}`, getAuthProviders: async () => ({ google: true, apple: true, email: true }),
      apiRequest(path, options = {}) { const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; },
      async reauthenticateForDeletion(id, password, signal) { proofs.push({ id, password, signal }); },
      async signInWithGoogle(signal, _commit, id) { proofs.push({ provider: 'google', id, signal }); return true; },
      async performAccountAuth(action) { return action(client); },
    },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; }, AbortController, URL });
  const component = exported[name];
  const render = () => { cursor = 0; tree = component(properties); for (const [i, fn] of effects) { cells[i].cleanup?.(); cells[i].cleanup = fn(); } effects.clear(); };
  render();
  const unmount = () => { if (!mounted) return; for (const cell of cells) cell?.cleanup?.(); mounted = false; };
  t.after(unmount);
  return {
    requests, proofs, events, opened, unmount,
    async loaded(extra) { requests[0].resolve(status(extra)); await flush(); },
    props(value) { properties = { ...properties, ...value }; render(); },
    press(label) { const node = find(tree, node => node.props?.label === label || node.props?.accessibilityLabel === label || (node.type === 'Pressable' && text(node).includes(label))); assert(node, `Missing ${label}`); if (!node.props.disabled) node.props.onPress(); },
    input(label, value) { const node = find(tree, node => node.props?.accessibilityLabel === label); assert(node); node.props.onChangeText(value); },
    text: () => text(tree), signedOut: () => signedOut,
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
  };
}

test('account deletion requires typed confirmation, pins identity and reports pending only after server confirmation', async t => {
  const h = harness(t); await h.loaded(); h.press('Delete my account'); await flush();
  h.press('Permanently delete my account'); assert.equal(h.requests.length, 1);
  h.input('Type DELETE to confirm account deletion', 'DELETE'); await flush(); h.press('Permanently delete my account'); h.press('Permanently delete my account');
  assert.equal(h.requests.length, 2);
  const request = h.requests[1]; assert.equal(request.path, '/api/account/delete'); assert.equal(request.expectedAccountId, 'fixture-owner'); assert.equal(request.body.confirmation, 'DELETE');
  assert.equal(h.signedOut(), false); assert.equal(h.events.length, 0);
  request.resolve({ status: 'pending', requestId: 'fixture-request' }); await flush();
  assert.deepEqual(h.events, ['disabled:fixture-owner', 'signout', 'callback']);
  assert(h.text().includes('cleanup remain pending')); assert.equal(h.text().includes('completed according to the server'), false);
});

test('unconfirmed and failed deletion keep account/session intact and support retry', async t => {
  const h = harness(t); await h.loaded(); h.press('Delete my account'); await flush(); h.input('Type DELETE to confirm account deletion', 'DELETE'); await flush();
  h.press('Permanently delete my account'); h.requests[1].resolve({ status: 'pending' }); await flush(); assert(h.error()); assert.equal(h.signedOut(), false); assert.equal(h.events.length, 0);
  h.press('Permanently delete my account'); h.requests[2].reject(new SharingError('Confirm your identity.', 'recent_auth_required')); await flush(); assert.equal(h.error(), 'Confirm your identity.'); assert.equal(h.signedOut(), false);
});

test('password and OAuth proofs target same account and never submit deletion automatically', async t => {
  const h = harness(t); await h.loaded(); h.press('Delete my account'); await flush();
  h.input('Password for deletion confirmation', 'generated-fixture-password'); await flush(); h.press('Confirm password'); await flush();
  assert.equal(h.proofs[0].id, 'fixture-owner'); assert.equal(h.proofs[0].password, 'generated-fixture-password'); assert.equal(h.requests.length, 1);
  h.press('Confirm with Google'); await flush(); assert.equal(h.proofs[1].id, 'fixture-owner'); assert.equal(h.requests.length, 1);
});

test('closing deletion or changing account aborts requests and fences old success', async t => {
  for (const change of ['unmount', 'account']) {
    const h = harness(t); await h.loaded(); h.press('Delete my account'); await flush(); h.input('Type DELETE to confirm account deletion', 'DELETE'); await flush(); h.press('Permanently delete my account');
    const request = h.requests[1];
    if (change === 'unmount') h.unmount(); else h.props({ accountId: 'fixture-other-owner' });
    assert.equal(request.signal.aborted, true); request.resolve({ status: 'pending', requestId: 'fixture-request' }); await flush(); assert.equal(h.events.length, 0);
  }
});

test('pending account never offers account restoration and cleanup settings failure still leaves deletion accessible', async t => {
  const h = harness(t); await h.loaded({ deletionStatus: 'pending' }); assert(h.text().includes('Deletion pending')); assert.equal(h.text().includes('completed according to the server'), false);
  const unavailable = harness(t); unavailable.requests[0].reject(new Error('fixture private diagnostic')); await flush(); unavailable.press('Delete my account'); await flush(); assert(unavailable.text().includes('Delete your Peekalo account?'));
});

test('terms submission requires deliberate acknowledgement, current versions and confirmed server result', async t => {
  const h = harness(t, 'TermsAcceptance'); h.press('Accept and continue'); assert.equal(h.requests.length, 0);
  h.press('I agree to the terms'); await flush(); h.press('Accept and continue'); h.press('Accept and continue'); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/api/account/terms'); assert.equal(h.requests[0].body.termsVersion, 'fixture-terms'); assert.equal(h.requests[0].body.privacyVersion, 'fixture-privacy'); assert.equal(h.requests[0].expectedAccountId, 'fixture-owner');
  h.requests[0].resolve({}); await flush(); assert(h.error()); assert.equal(h.events.length, 0);
  h.press('Accept and continue'); h.requests[1].resolve({ accepted: true }); await flush(); assert.deepEqual(h.events, ['accepted']);
});

test('unpublished policies never offer acceptance and pending terms requests are fenced on unmount', async t => {
  const closed = harness(t, 'TermsAcceptance', { status: status({ accepted: false, policyReady: false }) });
  assert(closed.text().includes('Sharing remains closed')); assert.equal(closed.requests.length, 0);
  const h = harness(t, 'TermsAcceptance'); h.press('I agree to the terms'); await flush(); h.press('Accept and continue'); const request = h.requests[0]; h.unmount(); assert.equal(request.signal.aborted, true); request.resolve({ accepted: true }); await flush(); assert.equal(h.events.length, 0);
});


test('terms account or version changes abort acceptance so an old response cannot accept for a new identity', async t => {
  const h = harness(t, 'TermsAcceptance'); h.press('I agree to the terms'); await flush(); h.press('Accept and continue'); const request = h.requests[0];
  h.props({ accountId: 'fixture-other-owner', status: status({ termsVersion: 'fixture-new-terms' }) });
  assert.equal(request.signal.aborted, true); request.resolve({ accepted: true }); await flush(); assert.equal(h.events.length, 0);
});

test('deletion keeps a same-origin private status link after local signout and rejects off-origin links', async t => {
  for (const origin of ['https://fixture.invalid', 'https://attacker.invalid']) {
    const h = harness(t); await h.loaded(); h.press('Delete my account'); await flush(); h.input('Type DELETE to confirm account deletion', 'DELETE'); await flush(); h.press('Permanently delete my account');
    const statusUrl = `${origin}/delete-account#requestId=12345678-1234-1234-1234-123456789abc&receipt=${'x'.repeat(43)}`;
    h.requests[1].resolve({ status: 'pending', requestId: 'fixture-request', statusUrl }); await flush();
    h.props({ accountId: null }); await flush();
    assert(h.text().includes('cleanup remain pending'));
    if (origin === 'https://fixture.invalid') { h.press('Check deletion status'); await flush(); assert.equal(h.opened[0], statusUrl); }
    else assert.equal(h.opened.length, 0);
  }
});


test('pending deletion keeps same-account proof and typed retry available for unfinished provider revocation', async t => {
  const h = harness(t); await h.loaded({ deletionStatus: 'pending' }); h.press('Retry account deletion verification'); await flush();
  h.press('Confirm with Google'); await flush(); assert.equal(h.proofs[0].id, 'fixture-owner');
  h.input('Type DELETE to confirm account deletion', 'DELETE'); await flush(); h.press('Permanently delete my account');
  assert.equal(h.requests[1].path, '/api/account/delete'); assert.equal(h.requests[1].expectedAccountId, 'fixture-owner');
});
