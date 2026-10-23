import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Actual native component logic with React/focus/native/Auth adapters. No live
// accounts, media, device APIs or application environment files are accessed.
const source = ts.transpileModule(await readFile(new globalThis.URL('../src/components/received-moment.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const origin = 'https://api.example.invalid';
const epoch = Date.parse('2026-10-23T06:00:00Z');
const leaseId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class SharingError extends Error { constructor(message, code = 'unavailable') { super(message); this.code = code; } }
function fakeClock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  const add = (fn, delay, interval = 0) => { const id = ++sequence; tasks.set(id, { fn, at: now + Math.max(0, Number(delay) || 0), interval }); return id; };
  return {
    now: () => now,
    setTimeout: (fn, delay) => add(fn, delay), setInterval: (fn, delay) => add(fn, delay, delay), clear: id => tasks.delete(id),
    count: () => tasks.size,
    async advance(ms) {
      const end = now + ms; let count = 0;
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert(++count < 10_000, 'Unexpected unbounded timer loop');
        const [id, task] = next; now = task.at;
        if (task.interval) task.at += task.interval; else tasks.delete(id);
        task.fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const text = value => Array.isArray(value) ? value.map(text).join('') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function harness(t, { request, skew = 0, signedIn = true, platform = 'android', protection = {} } = {}) {
  const time = fakeClock(), calls = [], subscribers = new Set(), appListeners = new Map(), hooks = [];
  let session = signedIn ? { user: { id: 'account-a' }, access_token: 'fixture-token-a' } : null;
  let cursor = 0, tree, component, mounted = true, focused = true, renderPending = false;
  const pendingEffects = new Map();
  const scheduleRender = () => {
    if (renderPending || !mounted) return;
    renderPending = true;
    globalThis.queueMicrotask(() => { if (!mounted) return; renderPending = false; render(); });
  };
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const effect = (fn, deps, kind = 'ordinary') => {
    const index = cursor++, previous = hooks[index];
    if (!previous || !same(previous.deps, deps)) {
      hooks[index] = { deps, cleanup: previous?.cleanup, kind, fn, active: previous?.active };
      pendingEffects.set(index, fn);
    }
  };
  const render = () => {
    cursor = 0; tree = component({ postId, kind: 'photo' });
    for (const [index, fn] of pendingEffects) {
      const hook = hooks[index];
      hook.cleanup?.(); hook.cleanup = undefined;
      if (hook.kind !== 'focus' || focused) { hook.cleanup = fn(); hook.active = true; }
    }
    pendingEffects.clear();
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { state: initial };
      return [hooks[index].state, value => {
        if (!mounted) return;
        hooks[index].state = typeof value === 'function' ? value(hooks[index].state) : value;
        scheduleRender();
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect: effect,
    useCallback(fn, deps) { const index = cursor++; if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { fn, deps }; return hooks[index].fn; },
  };
  const AppState = { currentState: 'active', addEventListener(name, listener) {
    const listeners = appListeners.get(name) ?? new Set(); listeners.add(listener); appListeners.set(name, listeners);
    return { remove: () => listeners.delete(listener) };
  } };
  const client = { auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange(listener) { subscribers.add(listener); return { data: { subscription: { unsubscribe: () => subscribers.delete(listener) } } }; },
  } };
  const grant = (patch = {}) => ({ leaseId, mediaUrl: `${origin}/api/view/media/${leaseId}`, grantedMs: 2000, remainingMs: 8000, expiresAt: new Date(epoch + time.now() + 2000).toISOString(), ...patch });
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@expo/vector-icons/Feather': { default: 'Feather' },
    'expo-screen-capture': { ...Object.fromEntries(['preventScreenCaptureAsync', 'allowScreenCaptureAsync', 'enableAppSwitcherProtectionAsync', 'disableAppSwitcherProtectionAsync'].map(key => [key, async () => {}])), ...protection },
    'expo-router': { useFocusEffect: callback => effect(callback, [callback], 'focus') },
    'expo-video': { useVideoPlayer() { throw new Error('Video playback is outside this photo lifecycle test'); }, VideoView: 'VideoView' },
    'react-native': { AppState, Image: 'Image', View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: platform }, StyleSheet: { create: styles => styles, absoluteFill: {} } },
    '../lib/sharing-client': {
      SharingError, newIdempotencyKey: randomUUID, getSharingClient: async () => client, resolveApiUrl: path => `${origin}${path}`,
      apiRequest: async (path, options) => {
        assert.equal(path, '/api/view/direct');
        const entry = { ...options, account: session?.user.id, token: session?.access_token }; calls.push(entry);
        return request ? request(entry, calls.length, { time, grant }) : grant();
      },
    },
    './ui': { colors: {}, tokens: { font: { display: 'fixture-font' } } },
  };
  class ClientDate extends Date { static now() { return epoch + time.now() + skew; } }
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported, require: name => { assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    URL: globalThis.URL, Date: ClientDate, performance: { now: time.now }, AbortController: globalThis.AbortController,
    setTimeout: time.setTimeout, clearTimeout: time.clear, setInterval: time.setInterval, clearInterval: time.clear,
  });
  component = exported.ReceivedMoment;
  render();
  const unfocus = () => { focused = false; for (const hook of hooks) if (hook?.kind === 'focus' && hook.active) { hook.active = false; hook.cleanup?.(); hook.cleanup = undefined; } };
  const refocus = () => { focused = true; for (const hook of hooks) if (hook?.kind === 'focus' && !hook.active) { hook.active = true; hook.cleanup = hook.fn(); } };
  const unmount = () => { if (!mounted) return; mounted = false; for (const hook of hooks) hook?.cleanup?.(); };
  t.after(unmount);
  return {
    time, calls, grant, ready: flush, unmount, unfocus, refocus,
    press() { const card = find(tree, node => Boolean(node.props?.onResponderGrant)); if (card.props.onStartShouldSetResponder()) card.props.onResponderGrant({ nativeEvent: { touches: [{}] } }); },
    release() { find(tree, node => Boolean(node.props?.onResponderRelease)).props.onResponderRelease(); },
    once() { const button = find(tree, node => node.type === 'Pressable' && node.props.onPress); if (!button.props.disabled) button.props.onPress(); },
    blur() { for (const callback of appListeners.get('blur') ?? []) callback(); },
    background() { AppState.currentState = 'background'; for (const callback of appListeners.get('change') ?? []) callback('background'); },
    account(id) { session = id ? { user: { id }, access_token: `fixture-token-${id === 'account-a' ? 'a' : 'b'}` } : null; for (const callback of subscribers) callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session); },
    image: () => find(tree, node => node.type === 'Image'),
    remaining: () => Number.parseFloat(text(find(tree, node => node.type === 'Text' && text(node.props.children).endsWith('s left')).props.children)),
    message: () => find(tree, node => node.props?.accessibilityLiveRegion === 'polite').props.children,
  };
}

for (const interruption of ['release', 'blur', 'background', 'unfocus', 'unmount']) {
  test(`${interruption} aborts a pending direct grant and rejects its late media`, async t => {
    const pending = deferred(); const h = harness(t, { request: () => pending.promise });
    await h.ready(); h.press(); await flush();
    assert.equal(h.calls.length, 1);
    h[interruption](); await flush();
    assert(h.calls[0].signal.aborted);
    pending.resolve(h.grant()); await flush();
    assert(!h.image());
    await h.time.advance(5000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.time.count(), 0);
  });
}

test('an account change hides active media and the next account cannot reuse the old bearer or cached lease', async t => {
  const h = harness(t);
  await h.ready(); h.press(); await flush();
  assert.equal(h.image().props.source.headers.Authorization, 'Bearer fixture-token-a');
  h.account('account-b'); await flush();
  assert(!h.image());
  h.press(); await flush();
  assert.equal(h.calls.length, 2, 'Another account requires a fresh server grant');
  assert.equal(h.calls[1].account, 'account-b');
  assert.equal(h.image().props.source.headers.Authorization, 'Bearer fixture-token-b');
});

test('switching account while a grant is pending aborts it and ignores the old account reply', async t => {
  const pending = deferred(); const h = harness(t, { request: () => pending.promise });
  await h.ready(); h.press(); await flush();
  h.account('account-b'); await flush();
  assert(h.calls[0].signal.aborted);
  pending.resolve(h.grant()); await flush();
  assert(!h.image());
  assert.equal(h.time.count(), 0);
});

test('signing out hides media and cannot start another authenticated grant', async t => {
  const h = harness(t);
  await h.ready(); h.press(); await flush();
  assert(h.image());
  h.account(null); await flush();
  assert(!h.image());
  h.press(); await flush();
  assert.equal(h.calls.length, 1);
});

test('release discards unspent cached entitlement and an early rehold waits hidden for a new grant', async t => {
  const h = harness(t, { request: (_entry, number, { time, grant }) => {
    if (number === 1) return grant();
    if (time.now() < 1250) throw new SharingError('Wait', 'renew_later');
    return grant({ remainingMs: 6000, expiresAt: new Date(epoch + 4000).toISOString() });
  } });
  await h.ready(); h.press(); await flush(); await h.time.advance(100); h.release(); await flush();
  assert(!h.image()); assert.equal(h.remaining(), 8);
  h.press(); await flush();
  assert(!h.image(), 'A rehold cannot redisplay the cached prepaid response');
  await h.time.advance(1800);
  assert(h.image());
  assert(h.calls.length > 2);
});

test('native lease validation rejects malformed timing, budgets and delivery URLs before mounting media', async t => {
  const wrongLease = '33333333-3333-4333-8333-333333333333';
  for (const patch of [
    { grantedMs: 0 }, { grantedMs: 2001 }, { grantedMs: Number.NaN }, { remainingMs: -1 }, { remainingMs: 10_001 }, { remainingMs: Infinity },
    { expiresAt: 'invalid' }, { mediaUrl: `https://untrusted.example.invalid/api/view/media/${leaseId}` },
    { mediaUrl: `${origin}/api/profile` }, { mediaUrl: `${origin}/api/view/media/${wrongLease}` },
    { mediaUrl: `${origin}/api/view/media/${leaseId}?token=fixture` }, { mediaUrl: `${origin}/api/view/media/${leaseId}#fixture` },
  ]) {
    const h = harness(t, { request: (_entry, _number, { grant }) => grant(patch) });
    await h.ready(); h.press(); await flush();
    assert(!h.image(), `Invalid lease must not reveal: ${Object.keys(patch).join(',')}`);
    assert.equal(h.time.count(), 0);
    h.unmount();
  }
});

test('a slow response with a phone clock behind cannot extend the two-second grant from request send time', async t => {
  const pending = deferred(); const h = harness(t, { skew: -60_000, request: () => pending.promise });
  await h.ready(); h.press(); await flush();
  await h.time.advance(1200);
  pending.resolve(h.grant({ remainingMs: 0, expiresAt: new Date(epoch + 2000).toISOString() })); await flush();
  assert(h.image());
  await h.time.advance(801);
  assert(!h.image(), 'The original two-second slice expires even though the phone wall clock lags');
  assert.equal(h.remaining(), 0);
});

test('repeated renew_later responses terminate after a bounded wait without exposing media', async t => {
  const h = harness(t, { request: () => { throw new SharingError('Wait', 'renew_later'); } });
  await h.ready(); h.press(); await flush();
  await h.time.advance(3500);
  assert(!h.image());
  assert.equal(h.time.count(), 0);
  const ended = h.calls.length;
  assert(ended > 1 && ended <= 65);
  await h.time.advance(5000);
  assert.equal(h.calls.length, ended);
});

test('the one-second accessibility interval begins after a successful delayed grant, not during startup', async t => {
  const pending = deferred(); const h = harness(t, { request: () => pending.promise });
  await h.ready(); h.once(); await flush();
  await h.time.advance(1100);
  pending.resolve(h.grant({ expiresAt: new Date(epoch + 2000).toISOString() })); await flush();
  assert(h.image(), 'The valid delayed response still permits its remaining authorized interval');
  await h.time.advance(901);
  assert(!h.image(), 'Server expiry can shorten the accessible interval');
  assert.equal(h.calls.length, 1);
});

test('the one-second accessibility action stops after one visible second without renewing', async t => {
  const h = harness(t);
  await h.ready(); h.once(); await flush();
  assert(h.image());
  await h.time.advance(1001);
  assert(!h.image()); assert.equal(h.remaining(), 8);
  assert.equal(h.calls.length, 1);
});

test('a signed-out recipient cannot request direct media', async t => {
  const h = harness(t, { signedIn: false });
  await h.ready(); h.press(); await flush();
  assert(!h.image()); assert.equal(h.calls.length, 0);
});

test('a continuous native hold exhausts five two-second slices without exceeding ten seconds', async t => {
  let remaining = 10_000, activeUntil = 0;
  const h = harness(t, { request: (_entry, _number, { time, grant }) => {
    assert(remaining > 0, 'An exhausted recipient must not request another slice');
    const duration = Math.min(2000, remaining); remaining -= duration;
    activeUntil = Math.max(time.now(), activeUntil) + duration;
    return grant({ grantedMs: duration, remainingMs: remaining, expiresAt: new Date(epoch + activeUntil).toISOString() });
  } });
  await h.ready(); h.press(); await flush();
  assert(h.image());
  await h.time.advance(10_001);
  assert(!h.image()); assert.equal(h.remaining(), 0);
  assert.equal(h.calls.length, 5); assert.equal(h.time.count(), 0);
  h.press(); await flush();
  assert.equal(h.calls.length, 5);
});

test('native expiry covers media during a pending renewal and starts no parallel grant', async t => {
  const pending = deferred();
  const h = harness(t, { request: (_entry, number, { grant }) => number === 1 ? grant() : pending.promise });
  await h.ready(); h.press(); await flush();
  await h.time.advance(2001);
  assert(!h.image()); assert.equal(h.calls.length, 2);
  pending.resolve(h.grant({ remainingMs: 6000, expiresAt: new Date(epoch + 4000).toISOString() })); await flush();
  assert(h.image()); assert.equal(h.calls.length, 2);
  h.release(); await flush();
  assert(!h.image()); assert.equal(h.time.count(), 0);
});

test('a deferred old protection acquisition cannot disable a newly focused recipient', async t => {
  const first = deferred(), second = deferred(), events = [], keys = new Set();
  let acquisitions = 0;
  const h = harness(t, { protection: {
    preventScreenCaptureAsync: async key => {
      events.push(['prevent', key]); keys.add(key);
      await (++acquisitions === 1 ? first.promise : second.promise);
    },
    allowScreenCaptureAsync: async key => { events.push(['allow', key]); keys.delete(key); },
  } });
  await flush();
  assert.equal(events.length, 1);
  h.unfocus(); await flush(); h.refocus(); await flush();
  assert.equal(events.length, 1, 'Old cleanup and new acquisition must wait behind the pending native transition');
  h.press(); await flush(); assert.equal(h.calls.length, 0);
  first.resolve(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'allow', 'prevent']);
  const firstKey = events[0][1], secondKey = events[2][1];
  assert.notEqual(firstKey, secondKey, 'Each focus owns an independent Expo capture key');
  assert.deepEqual([...keys], [secondKey]);
  h.press(); await flush(); assert.equal(h.calls.length, 0, 'Media waits for the new focus native protection to finish');
  second.resolve(); await flush();
  h.press(); await flush(); assert(h.image());
  assert.deepEqual([...keys], [secondKey], 'A stale startup must not release the current focus key');
  h.unmount(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'allow', 'prevent', 'allow']);
  assert.equal(keys.size, 0);
});

test('iOS serializes old app-switcher cleanup before enabling the next focus', async t => {
  const oldEnable = deferred(), oldDisable = deferred(), events = [];
  let enables = 0, disables = 0, switcherProtected = false;
  const h = harness(t, { platform: 'ios', protection: {
    preventScreenCaptureAsync: async key => { events.push(['prevent', key]); },
    allowScreenCaptureAsync: async key => { events.push(['allow', key]); },
    enableAppSwitcherProtectionAsync: async () => {
      events.push(['enable']);
      if (++enables === 1) await oldEnable.promise;
      switcherProtected = true;
    },
    disableAppSwitcherProtectionAsync: async () => {
      events.push(['disable']);
      if (++disables === 1) await oldDisable.promise;
      switcherProtected = false;
    },
  } });
  await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'enable']);
  h.unfocus(); await flush(); h.refocus(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'enable']);
  oldEnable.resolve(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'enable', 'allow', 'disable']);
  h.press(); await flush(); assert.equal(h.calls.length, 0, 'The next focus cannot reveal during old global cleanup');
  oldDisable.resolve(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'enable', 'allow', 'disable', 'prevent', 'enable']);
  assert.equal(switcherProtected, true);
  h.press(); await flush(); assert(h.image());
  await flush(); assert.equal(switcherProtected, true, 'No late old disable may follow the new enable');
  h.unmount(); await flush();
  assert.deepEqual(events.map(event => event[0]), ['prevent', 'enable', 'allow', 'disable', 'prevent', 'enable', 'allow', 'disable']);
  assert.equal(switcherProtected, false);
});
