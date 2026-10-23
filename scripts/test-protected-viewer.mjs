import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual component, its effect and rendered input callbacks. This
// small hook/JSX host replaces browser/React adapters, not the reveal algorithm.
// No application env, real links, media or remote services are accessed.
const source = ts.transpileModule(await readFile(new URL('../apps/web/components/protected-viewer.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const serverEpoch = Date.parse('2026-10-23T03:00:00.000Z');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function clock() {
  let time = 0, sequence = 0;
  const tasks = new Map();
  const schedule = (fn, delay, interval = 0) => {
    const id = ++sequence;
    tasks.set(id, { fn, at: time + Math.max(0, Number(delay) || 0), interval });
    return id;
  };
  return {
    now: () => time,
    setTimeout: (fn, delay) => schedule(fn, delay),
    setInterval: (fn, delay) => schedule(fn, delay, delay),
    clear: id => tasks.delete(id),
    count: () => tasks.size,
    async advance(ms) {
      const end = time + ms;
      let executions = 0;
      while (true) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert(++executions < 10_000, 'Unexpected unbounded timer loop');
        const [id, task] = due;
        time = task.at;
        if (task.interval) task.at += task.interval;
        else tasks.delete(id);
        task.fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}
function eventTarget(extra = {}) {
  const target = new globalThis.EventTarget();
  return Object.assign(target, extra);
}
function walk(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) { const found = walk(child, predicate); if (found) return found; }
    return undefined;
  }
  return predicate(node) ? node : walk(node.props?.children, predicate);
}
function harness(t, { lease, skew = 0, kind = 'photo' } = {}) {
  const time = clock();
  const requests = [], snapshots = [];
  const window = eventTarget({ location: { hash: '#non-sensitive-fixture-token', origin: 'https://viewer.example.invalid' } });
  const document = eventTarget({ visibilityState: 'visible', hasFocus: () => true });
  const cells = [], effects = [], cleanups = [];
  let cursor = 0, tree, component, mounted = true;
  const render = () => { cursor = 0; tree = component(); };
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], value => {
        assert(mounted, 'State must not update after unmount');
        cells[index] = typeof value === 'function' ? value(cells[index]) : value;
        snapshots.push(cells[index]);
        render();
      }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= { current: initial }; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index], deps)) { cells[index] = deps; effects.push(fn); }
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { fn, deps };
      return cells[index].fn;
    },
  };
  const jsx = (type, props) => ({ type, props });
  const Overlay = () => {};
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './fullscreen-reveal': { FullscreenReveal: Overlay },
    './icons': { Icon: () => {} },
    './protected-viewer.module.css': { default: {} },
  };
  class ClientDate extends Date { static now() { return serverEpoch + time.now() + skew; } }
  const exported = {};
  const granted = ({ remainingMs = 8000, grantedMs = 2000, expiresAt = serverEpoch + time.now() + grantedMs, media = 'fixture-lease', ...rest } = {}) => ({
    leaseId: media, mediaUrl: `${window.location.origin}/api/view/media/${media}`, grantedMs, remainingMs, expiresAt, ...rest,
  });
  vm.runInNewContext(source, {
    exports: exported,
    require: name => { assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    window, document, URL, AbortController: globalThis.AbortController, crypto: { randomUUID },
    Date: ClientDate, performance: { now: time.now },
    setTimeout: time.setTimeout, clearTimeout: time.clear, setInterval: time.setInterval, clearInterval: time.clear,
    fetch: async (url, options) => {
      const entry = { url, ...options, body: JSON.parse(options.body) };
      requests.push(entry);
      if (url === '/api/view/preview') return globalThis.Response.json({ available: true, kind });
      assert.equal(url, '/api/view/lease');
      return lease ? lease(entry, requests.filter(item => item.url.endsWith('/lease')).length, { time, granted }) : globalThis.Response.json(granted());
    },
  });
  component = exported.ProtectedViewer;
  render();
  for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  t.after(unmount);
  const surface = () => walk(tree, node => node.type === 'button' && node.props['aria-describedby'] === 'protected-instructions');
  const pointer = { isPrimary: true, button: 0, pointerId: 1, preventDefault() {}, currentTarget: {
    focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 540 }),
  } };
  return {
    time, requests, snapshots, granted, unmount,
    ready: flush,
    down() { surface().props.onPointerDown(pointer); },
    release() { surface().props.onPointerUp(pointer); },
    blur() { window.dispatchEvent(new globalThis.Event('blur')); },
    hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new globalThis.Event('visibilitychange')); },
    once() { walk(tree, node => node.type === 'button' && node.props.onClick && !node.props['aria-describedby']).props.onClick(); },
    overlay: () => Boolean(walk(tree, node => node.type === Overlay)),
    image: () => walk(tree, node => node.type === 'img'),
    status: () => walk(tree, node => node.props?.role === 'status').props.children,
    remaining: () => Number.parseFloat(walk(tree, node => typeof node.props?.['aria-label'] === 'string' && node.props['aria-label'].endsWith(' seconds remaining')).props.children),
    leaseRequests: () => requests.filter(item => item.url.endsWith('/lease')),
  };
}

test('rapid release/rehold waits hidden through renew_later and resumes within the same server budget', async t => {
  const h = harness(t, { lease: (_request, number, { time, granted }) => {
    if (number === 1) return globalThis.Response.json(granted());
    if (time.now() < 1250) return globalThis.Response.json({ error: 'renew_later' }, { status: 409 });
    return globalThis.Response.json(granted({ remainingMs: 6000, expiresAt: serverEpoch + 4000, media: 'second-lease' }));
  } });
  await h.ready();
  h.down(); await flush();
  assert(h.overlay());
  await h.time.advance(100);
  h.release();
  assert(!h.overlay());
  assert.equal(h.remaining(), 8, 'Release conservatively spends the whole prepaid slice');
  h.down(); await flush();
  assert(!h.overlay(), 'A renewal refusal never exposes stale media');
  assert.doesNotMatch(h.status(), /unavailable|couldn.t load|used up/i, 'Too-early rehold must remain retryable, not become unavailable');
  await h.time.advance(2000);
  assert(h.overlay(), 'An uninterrupted deliberate rehold eventually receives a fresh permitted slice');
  assert.equal(h.image().props.src, '/api/view/media/second-lease');
  assert(h.snapshots.every(state => state.remainingMs >= 0 && state.remainingMs <= 10_000));
});

for (const interruption of ['release', 'blur', 'hide', 'unmount']) {
  test(`${interruption} aborts a pending lease and a late reply cannot reveal media`, async t => {
    const pending = deferred();
    const h = harness(t, { lease: () => pending.promise });
    await h.ready(); h.down(); await flush();
    const request = h.leaseRequests()[0];
    assert(!request.signal.aborted);
    h[interruption]();
    assert(request.signal.aborted);
    pending.resolve(globalThis.Response.json(h.granted()));
    await flush();
    assert(!h.overlay());
    await h.time.advance(2500);
    assert.equal(h.leaseRequests().length, 1, 'An interrupted request cannot start renewal timers');
  });
}

test('a late reply from a released hold cannot replace a newer successful hold', async t => {
  const old = deferred();
  const h = harness(t, { lease: (_request, number, { granted }) => number === 1 ? old.promise : globalThis.Response.json(granted({ media: 'new-lease' })) });
  await h.ready(); h.down(); await flush(); h.release(); h.down(); await flush();
  assert.equal(h.image().props.src, '/api/view/media/new-lease');
  old.resolve(globalThis.Response.json(h.granted({ media: 'old-lease' })));
  await flush();
  assert.equal(h.image().props.src, '/api/view/media/new-lease');
});

test('a continuous hold receives at most ten seconds through two-second grants and hides at exhaustion', async t => {
  let remaining = 10_000, activeUntil = 0;
  const h = harness(t, { lease: (_request, _number, { time, granted }) => {
    assert(remaining > 0, 'The exhausted viewer must not request another grant');
    const duration = Math.min(2000, remaining);
    remaining -= duration;
    activeUntil = Math.max(time.now(), activeUntil) + duration;
    return globalThis.Response.json(granted({ remainingMs: remaining, grantedMs: duration, expiresAt: serverEpoch + activeUntil }));
  } });
  await h.ready(); h.down(); await flush();
  assert(h.overlay());
  await h.time.advance(10_001);
  assert(!h.overlay());
  assert.equal(h.status(), 'Your viewing time is used up.');
  assert.equal(h.remaining(), 0);
  assert.equal(h.leaseRequests().length, 5);
  assert(h.snapshots.every(state => Number.isFinite(state.remainingMs) && state.remainingMs >= 0 && state.remainingMs <= 10_000));
});

test('the accessible one-second action uses the same prepaid allowance without automatic renewal', async t => {
  const h = harness(t);
  await h.ready(); h.once(); await flush();
  assert(h.overlay());
  await h.time.advance(1001);
  assert(!h.overlay());
  assert.equal(h.remaining(), 8);
  assert.equal(h.leaseRequests().length, 1);
});

test('invalid or oversized lease values never mount clear media', async t => {
  for (const patch of [
    { grantedMs: 2001 }, { grantedMs: 0 }, { grantedMs: Number.NaN },
    { remainingMs: -1 }, { remainingMs: 10_001 }, { remainingMs: Number.POSITIVE_INFINITY }, { expiresAt: 'invalid' },
  ]) {
    const h = harness(t, { lease: (_request, _number, { granted }) => globalThis.Response.json(granted(patch)) });
    await h.ready(); h.down(); await flush();
    assert(!h.overlay());
    assert.equal(h.status(), 'The moment couldn’t load. Check your connection and try again.');
    assert.equal(h.time.count(), 0);
    h.unmount();
  }
});

test('a phone clock ahead of the server fails closed instead of revealing beyond an expired deadline', async t => {
  const h = harness(t, { skew: 60_000 });
  await h.ready(); h.down(); await flush();
  assert(!h.overlay());
  assert.equal(h.remaining(), 8);
  await h.time.advance(10_000);
  assert.equal(h.leaseRequests().length, 1);
});

test('a phone clock behind the server cannot stretch one grant beyond its conservative two-second window', async t => {
  const h = harness(t, { skew: -60_000, lease: (_request, _number, { granted }) => globalThis.Response.json(granted({ remainingMs: 0 })) });
  await h.ready(); h.down(); await flush();
  assert(h.overlay());
  await h.time.advance(2001);
  assert(!h.overlay());
  assert.equal(h.remaining(), 0);
  assert.equal(h.leaseRequests().length, 1);
});

for (const interruption of ['release', 'blur']) {
  test(`${interruption} during a too-early retry wait prevents subsequent lease requests`, async t => {
    const h = harness(t, { lease: () => globalThis.Response.json({ error: 'renew_later' }, { status: 409 }) });
    await h.ready(); h.down(); await flush();
    h[interruption]();
    const before = h.leaseRequests().length;
    await h.time.advance(5000);
    assert(!h.overlay());
    assert.equal(h.leaseRequests().length, before);
    assert.equal(h.time.count(), 0);
  });
}

test('persistent renew_later replies stop within a bounded wait and leave a recoverable hidden error', async t => {
  const h = harness(t, { lease: () => globalThis.Response.json({ error: 'renew_later' }, { status: 409 }) });
  await h.ready(); h.down(); await flush();
  assert(!h.overlay());
  await h.time.advance(3500);
  assert(!h.overlay());
  assert.match(h.status(), /couldn.t load|try again/i);
  assert.equal(h.remaining(), 10, 'An early denial cannot invent charged viewing time');
  assert.equal(h.time.count(), 0);
  const stopped = h.leaseRequests().length;
  assert(stopped > 1, 'The temporary denial should receive a retry');
  assert(stopped <= 65, 'A bounded wait must not create a tight retry loop');
  await h.time.advance(5000);
  assert.equal(h.leaseRequests().length, stopped);
});

test('expiry hides media while an in-flight renewal finishes without creating parallel lease requests', async t => {
  const pending = deferred();
  const h = harness(t, { lease: (_request, number, { granted }) => number === 1 ? globalThis.Response.json(granted()) : pending.promise });
  await h.ready(); h.down(); await flush();
  await h.time.advance(2001);
  assert(!h.overlay(), 'Expired local media must be hidden while renewal is pending');
  assert.equal(h.leaseRequests().length, 2, 'Ticker and expiry must share the one pending renewal');
  assert(!h.leaseRequests()[1].signal.aborted);
  pending.resolve(globalThis.Response.json(h.granted({ remainingMs: 6000, expiresAt: serverEpoch + 4000, media: 'renewed-lease' })));
  await flush();
  assert(h.overlay());
  assert.equal(h.image().props.src, '/api/view/media/renewed-lease');
  assert.equal(h.leaseRequests().length, 2);
});
