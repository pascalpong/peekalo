import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness(t, platform = 'android', version = 37) {
  const hooks = [], effects = new Map(), requests = [], guardRequests = [], subscribers = new Set(), appListeners = new Map();
  let cursor = 0, tree, component, mounted = true, scheduled = false, navigator = false, mounts = 0, unmounts = 0, listenerStops = 0;
  let snapshot = { status: 'pending', revision: -1 };
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.map(n => find(n, predicate)).find(Boolean);
    if (!node || typeof node !== 'object') return null;
    return predicate(node) ? node : find(node.props?.children, predicate);
  };
  const jsx = (type, props) => ({ type, props });
  const Stack = Object.assign('Stack', { Screen: 'Screen' });
  const render = () => {
    cursor = 0; tree = component();
    const next = !!find(tree, node => node.type === Stack);
    if (next !== navigator) { if (next) mounts++; else unmounts++; navigator = next; }
    for (const [i, fn] of effects) { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); }
    effects.clear();
  };
  const schedule = () => {
    if (!mounted || scheduled) return;
    scheduled = true; queueMicrotask(() => { scheduled = false; if (mounted) render(); });
  };
  const publish = status => { snapshot = { status, revision: snapshot.revision + 1 }; for (const listener of subscribers) listener(); };
  const guard = {
    getSnapshot: () => snapshot,
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    refresh() { publish('pending'); return new Promise(resolve => guardRequests.push(status => { publish(status); resolve(); })); },
    suspend() { publish('pending'); },
    stop() { listenerStops++; publish('pending'); },
  };
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { state: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].state, next => {
        if (!mounted) return;
        const value = typeof next === 'function' ? next(hooks[i].state) : next;
        if (!Object.is(value, hooks[i].state)) { hooks[i].state = value; schedule(); }
      }];
    },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useSyncExternalStore(subscribe, getSnapshot) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { cleanup: subscribe(schedule) };
      return getSnapshot();
    },
    useEffect(fn, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) {
        hooks[i] = { deps, cleanup: old?.cleanup }; effects.set(i, fn);
      }
    },
  };
  const AppState = { currentState: 'active', addEventListener(name, callback) {
    const list = appListeners.get(name) ?? new Set(); list.add(callback); appListeners.set(name, list);
    return { remove: () => list.delete(callback) };
  } };
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-font': { useFonts: () => [true, null] },
    'expo-router': { Stack }, 'expo-status-bar': { StatusBar: 'StatusBar' },
    '../lib/android-window-protection': { acquireAndroidWindowProtection: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) },
    '../lib/capture-guard': { captureGuard: guard, captureGuardAllowsReveal: value => platform !== 'android' || value.status === 'clear' || value.status === 'unsupported' && version < 35 },
    'react-native': { AppState, Platform: { OS: platform, Version: version }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { absoluteFill: {} } },
    '../components/ui': { colors: { background: '#080a09' }, tokens: { font: { display: 'display' }, space: { lg: 24, md: 16 }, type: { section: 18, body: 14 } } },
    '@peekalo/design/fonts/display.ttf': 1,
  };
  const context = { exports: {}, require: name => { assert(name in mocks, name); return mocks[name]; } };
  vm.runInNewContext(source, context); component = context.exports.default; render();
  const unmount = () => { mounted = false; for (const hook of hooks) hook?.cleanup?.(); };
  t.after(unmount);
  return { requests, guardRequests, guard: publish, mounts: () => mounts, unmounts: () => unmounts, unmount,
    listenerStops: () => listenerStops, listenerCount: () => [...appListeners.values()].reduce((sum, list) => sum + list.size, 0),
    hasNavigator: () => !!find(tree, node => node.type === Stack),
    blocked: () => !!find(tree, node => node.props?.accessibilityViewIsModal),
    navigatorProps: () => find(tree, node => node.props?.importantForAccessibility === 'no-hide-descendants')?.props,
    retry: () => { const button = find(tree, node => node.type === 'Pressable'); assert(button); button.props.onPress(); },
    event(name, value) { if (name === 'change') AppState.currentState = value; for (const callback of appListeners.get(name) ?? []) callback(value); },
  };
}

async function ready(h) { h.requests[0].resolve(); h.guardRequests[0]('clear'); await flush(); }

test('Android navigator waits for both baseline acquisition and capture guard initial state', async t => {
  const h = harness(t); assert.equal(h.hasNavigator(), false); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(); await flush(); assert.equal(h.hasNavigator(), false);
  h.guardRequests[0]('clear'); await flush(); assert.equal(h.hasNavigator(), true); assert.equal(h.blocked(), false);
});

test('capture clear cannot bypass failed baseline; explicit retry restores only after both succeed', async t => {
  const h = harness(t); h.guardRequests[0]('clear'); h.requests[0].reject(new Error('Synthetic native unavailable')); await flush();
  assert.equal(h.hasNavigator(), false); h.retry(); await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.guardRequests.length, 2);
  h.requests[1].resolve(); await flush(); assert.equal(h.hasNavigator(), false);
  h.guardRequests[1]('clear'); await flush(); assert.equal(h.hasNavigator(), true);
});

test('initial recording and unavailable remain closed and unavailable permits an explicit retry', async t => {
  const h = harness(t); h.requests[0].resolve(); h.guardRequests[0]('recording'); await flush();
  assert.equal(h.hasNavigator(), false); assert.equal(h.blocked(), true);
  h.guard('unavailable'); await flush(); h.retry(); await flush();
  h.requests[1].resolve(); h.guardRequests[1]('clear'); await flush(); assert.equal(h.hasNavigator(), true);
});

test('after initial readiness, blocked states cover without remounting navigation or losing Share drafts', async t => {
  const h = harness(t); await ready(h); assert.equal(h.mounts(), 1);
  for (const status of ['recording', 'unavailable', 'pending']) {
    h.guard(status); await flush();
    assert.equal(h.hasNavigator(), true); assert.equal(h.blocked(), true);
    assert.equal(h.navigatorProps().pointerEvents, 'none');
    assert.equal(h.navigatorProps().accessibilityElementsHidden, true);
    h.guard('clear'); await flush(); assert.equal(h.blocked(), false);
  }
  assert.equal(h.mounts(), 1); assert.equal(h.unmounts(), 0);
});

test('blur/background cover immediately; resume requires fresh guard response and retains navigator', async t => {
  const h = harness(t); await ready(h);
  h.event('blur'); await flush(); assert.equal(h.blocked(), true); assert.equal(h.hasNavigator(), true);
  h.event('change', 'background'); h.event('focus'); await flush();
  assert.equal(h.guardRequests.length, 1, 'Focus while backgrounded cannot reopen UI');
  h.event('change', 'active'); await flush(); assert.equal(h.guardRequests.length, 2); assert.equal(h.blocked(), true);
  h.guardRequests[1]('clear'); await flush(); assert.equal(h.blocked(), false);
  assert.equal(h.mounts(), 1); assert.equal(h.unmounts(), 0);
});

test('unmount removes lifecycle listeners and a late protection reply cannot mount navigation', async t => {
  const h = harness(t); assert.equal(h.listenerCount(), 3); h.unmount();
  assert.equal(h.listenerCount(), 0); assert.equal(h.listenerStops(), 1);
  h.requests[0].resolve(); await flush(); assert.equal(h.hasNavigator(), false);
});

test('pre-35 Android unsupported fallback still requires the secure baseline', async t => {
  const h = harness(t, 'android', 34); h.guardRequests[0]('unsupported'); await flush(); assert.equal(h.hasNavigator(), false);
  h.requests[0].resolve(); await flush(); assert.equal(h.hasNavigator(), true);
});

test('iOS retains its existing per-view protection without Android native calls', t => {
  const h = harness(t, 'ios'); assert.equal(h.requests.length, 0); assert.equal(h.guardRequests.length, 0);
  assert.equal(h.listenerCount(), 0); assert.equal(h.hasNavigator(), true);
});
