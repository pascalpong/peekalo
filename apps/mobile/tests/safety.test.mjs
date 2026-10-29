import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Actual safety event handlers with generated identities and a stubbed transport.
// This verifies request fencing and confirmation; server policy has separate tests.
const source = ts.transpileModule(readFileSync(new URL('../src/components/safety.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
};
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
class SharingError extends Error {}
function harness(t, name = 'SafetyPanel', target = { postId: 'fixture-moment', username: 'fixture_sender' }) {
  const cells = [], effects = new Map(), requests = [], fetches = [], opened = [];
  let tree, cursor = 0, mounted = true, component, blocked = 0;
  const jsx = (type, props) => ({ type, props });
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = { state: initial }; return [cells[i].state, value => {
      assert(mounted, 'Late safety response updated unmounted UI'); cells[i].state = typeof value === 'function' ? value(cells[i].state) : value; render();
    }]; },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++, prior = cells[i]; if (!prior || !same(prior.deps, deps)) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.set(i, fn); } },
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'expo-linking': { async openURL(url) { opened.push(url); } },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', StyleSheet: { create: value => value } },
    './ui': { colors: {}, typography: {}, tokens: { radius: {} } },
    '../lib/sharing-client': { SharingError, resolveApiUrl: path => `https://fixture.invalid${path}`, apiRequest(path, options = {}) { const pending = deferred(); requests.push({ path, ...options, ...pending }); return pending.promise; } },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, AbortController, URL, setTimeout, clearTimeout,
    fetch(url, options = {}) { const pending = deferred(); fetches.push({ url, ...options, ...pending }); return pending.promise; },
    require: name => { assert(Object.hasOwn(imports, name), name); return imports[name]; },
  });
  const props = { target, accountId: 'fixture-reporter', onClose() {}, onBlocked() { blocked++; } };
  component = exported[name];
  const render = () => { cursor = 0; tree = component(props); for (const [i, fn] of effects) { cells[i].cleanup?.(); cells[i].cleanup = fn(); } effects.clear(); };
  render();
  const unmount = () => { if (!mounted) return; for (const cell of cells) cell?.cleanup?.(); mounted = false; };
  t.after(unmount);
  return {
    requests, fetches, opened, unmount, blocked: () => blocked, text: () => text(tree),
    handler(label) { const node = find(tree, node => node.props?.label === label || node.props?.accessibilityLabel === label || (node.type === 'Pressable' && text(node) === label)); assert(node, `Missing ${label}`); return node.props.onPress; },
    press(label) { this.handler(label)(); },
    details(value) { find(tree, node => node.props?.accessibilityLabel === 'Optional report details').props.onChangeText(value); },
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
    detailsValue: () => find(tree, node => node.props?.accessibilityLabel === 'Optional report details')?.props.value,
  };
}

test('moment report pins the account, sends the reason/context and clears context only on confirmation', async t => {
  const h = harness(t); h.press('○ Harassment or hate'); h.details(' fixture context ');
  const submit = h.handler('Submit report'); submit(); submit();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.path, '/api/safety/reports'); assert.equal(request.expectedAccountId, 'fixture-reporter');
  assert.equal(request.body.postId, 'fixture-moment'); assert.equal(request.body.username, undefined);
  assert.equal(request.body.reason, 'harassment'); assert.equal(request.body.details, 'fixture context');
  request.resolve({ reportId: 'fixture-report' }); await flush();
  assert.equal(h.detailsValue(), ''); assert(h.text().includes('Report received'));
});

test('account report has no post capability and unconfirmed response does not claim success', async t => {
  const h = harness(t); h.press('Report this account'); h.details('fixture context'); h.press('Submit report');
  assert.equal(h.requests[0].body.username, 'fixture_sender'); assert.equal(h.requests[0].body.postId, undefined);
  h.requests[0].resolve({}); await flush(); assert(h.error()); assert.equal(h.detailsValue(), 'fixture context');
  assert.equal(h.text().includes('Report received'), false);
  h.press('Submit report'); h.requests[1].reject(new Error('private diagnostic fixture')); await flush();
  assert.equal(h.error(), 'This action was not confirmed. Please try again.');
});

test('block requires deliberate confirmation and only confirmed result removes the sender', async t => {
  const h = harness(t); h.press('Block @fixture_sender'); assert.equal(h.requests.length, 0);
  h.press('Cancel block'); assert.equal(h.requests.length, 0);
  h.press('Block @fixture_sender'); h.press('Confirm block @fixture_sender');
  assert.equal(h.requests[0].path, '/api/safety/blocks'); assert.equal(h.requests[0].body.username, 'fixture_sender');
  h.requests[0].resolve({ blocked: false }); await flush(); assert.equal(h.blocked(), 0); assert(h.error());
  h.press('Confirm block @fixture_sender'); h.requests[1].resolve({ blocked: true }); await flush(); assert.equal(h.blocked(), 1);
});

for (const block of [true, false]) {
  test(`closing safety aborts pending ${block ? 'block' : 'report'} and fences late result`, async t => {
    const h = harness(t);
    if (block) { h.press('Block @fixture_sender'); h.press('Confirm block @fixture_sender'); } else h.press('Submit report');
    const request = h.requests[0]; h.unmount(); assert.equal(request.signal.aborted, true);
    request.resolve(block ? { blocked: true } : { reportId: 'fixture-report' }); await flush(); assert.equal(h.blocked(), 0);
  });
}

test('block list is private and deliberate; unblocking never claims restored grants', async t => {
  const h = harness(t, 'SafetySettings'); assert.equal(h.requests.length, 0);
  h.fetches[0].resolve({ ok: true, json: async () => ({ standardsUrl: 'https://fixture.invalid/safety', supportUrl: 'https://fixture.invalid/support', contactConfigured: false, agePolicyConfigured: false, manualApproval: true }) }); await flush();
  assert(h.text().includes('contact is still pending')); assert(h.text().includes('age policy is still pending'));
  h.press('Manage blocked accounts'); assert.equal(h.requests[0].expectedAccountId, 'fixture-reporter');
  h.requests[0].resolve({ items: [{ username: 'fixture_sender', createdAt: '2026-10-29' }] }); await flush();
  h.press('Unblock @fixture_sender'); assert.equal(h.requests[1].method, 'DELETE');
  h.requests[1].resolve({ blocked: false }); await flush(); assert(h.text().includes('Previous grants and links remain revoked'));
  h.press('Safety and child-safety standards'); await flush(); assert.equal(h.opened[0], 'https://fixture.invalid/safety');
});

test('unconfirmed unblock keeps the account listed and late config/block results are aborted on close', async t => {
  const h = harness(t, 'SafetySettings'); h.press('Manage blocked accounts');
  h.requests[0].resolve({ items: [{ username: 'fixture_sender', createdAt: '2026-10-29' }] }); await flush();
  h.press('Unblock @fixture_sender'); h.requests[1].resolve({}); await flush(); assert(h.error()); h.handler('Unblock @fixture_sender');
  h.press('Refresh blocked accounts'); const request = h.requests.at(-1); h.unmount();
  assert.equal(request.signal.aborted, true); assert.equal(h.fetches[0].signal.aborted, true);
  request.resolve({ items: [] }); h.fetches[0].resolve({ ok: true, json: async () => ({}) }); await flush();
});


test('account report and block pin a stable account when its username is hidden or changed', async t => {
  const h = harness(t, 'SafetyPanel', { postId: 'fixture-moment', accountId: 'fixture-target-id', username: null });
  assert(h.text().includes('Account awaiting review')); assert.equal(h.text().includes('@null'), false);
  h.press('Report this account'); h.press('Submit report');
  assert.equal(h.requests[0].body.accountId, 'fixture-target-id'); assert.equal(h.requests[0].body.username, undefined);
  h.requests[0].resolve({ reportId: 'fixture-report' }); await flush();
  h.press('Block Account awaiting review'); h.press('Confirm block Account awaiting review');
  assert.equal(h.requests[1].body.accountId, 'fixture-target-id'); assert.equal(h.requests[1].body.username, undefined);
});

test('unapproved blocked usernames stay hidden and unblock targets the original account id', async t => {
  const h = harness(t, 'SafetySettings'); h.press('Manage blocked accounts');
  h.requests[0].resolve({ items: [{ accountId: 'fixture-original-account', username: null, createdAt: '2026-10-29' }] }); await flush();
  assert(h.text().includes('Account awaiting review')); assert.equal(h.text().includes('@null'), false);
  h.press('Unblock account'); assert.equal(h.requests[1].body.accountId, 'fixture-original-account');
  assert.equal(h.requests[1].body.username, undefined);
});
