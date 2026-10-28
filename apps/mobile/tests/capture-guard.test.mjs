import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/capture-guard.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const state = (status, revision) => ({ status, revision });
function harness({ version = 37, platform = 'android', missing = false, listenError = false } = {}) {
  const calls = [], trace = [], listeners = new Set(), staleListeners = [];
  let lookups = 0;
  const native = {
    start() { trace.push('start'); return new Promise((resolve, reject) => calls.push({ resolve, reject })); },
    addListener(name, callback) {
      assert.equal(name, 'onCaptureStateChanged'); trace.push('subscribe');
      if (listenError) throw new Error('Synthetic listener failure');
      listeners.add(callback); staleListeners.push(callback);
      return { remove() { trace.push('remove'); listeners.delete(callback); } };
    },
  };
  const exports = {};
  vm.runInNewContext(source, { exports, require(name) {
    if (name === 'expo') return { requireOptionalNativeModule(moduleName) { assert.equal(moduleName, 'PeekaloCaptureGuard'); lookups++; return missing ? null : native; } };
    if (name === 'react-native') return { Platform: { OS: platform, Version: version } };
    throw new Error(`Unexpected import ${name}`);
  } });
  const guard = exports.captureGuard;
  return { guard, calls, trace, staleListeners, listeners, lookups: () => lookups,
    emit(value) { for (const listener of [...listeners]) listener(value); },
    allowed: () => exports.captureGuardAllowsReveal(),
  };
}

test('construction is lazy; listener precedes native query and clear waits for successful initial state', async () => {
  const h = harness(); assert.equal(h.lookups(), 0); assert.equal(h.allowed(), false);
  const first = h.guard.refresh(); assert.equal(h.guard.refresh(), first);
  assert.deepEqual(h.trace, ['subscribe', 'start']);
  h.emit(state('clear', 2)); assert.equal(h.allowed(), false);
  h.calls[0].resolve(state('clear', 2)); await first;
  assert.equal(h.allowed(), true); assert.equal(h.guard.getSnapshot().revision, 2);
});

test('a newer recording event wins over late initial clear and publishes synchronously', async () => {
  const h = harness(), observed = [];
  h.guard.subscribe(() => observed.push(h.guard.getSnapshot().status));
  const started = h.guard.refresh(); h.emit(state('recording', 4));
  assert.equal(h.guard.getSnapshot().status, 'recording');
  h.calls[0].resolve(state('clear', 3)); await started;
  assert.equal(h.guard.getSnapshot().status, 'recording'); assert.equal(h.allowed(), false);
  h.emit(state('clear', 5)); assert.equal(h.allowed(), true);
  h.emit(state('recording', 4)); assert.equal(h.allowed(), true, 'Older events must not replace newer native state');
  assert(observed.includes('recording'));
});

test('missing module, listener failure and rejected initial query stay unavailable with explicit retry', async () => {
  for (const options of [{ missing: true }, { listenError: true }]) {
    const h = harness(options); await h.guard.refresh();
    assert.equal(h.guard.getSnapshot().status, 'unavailable'); assert.equal(h.allowed(), false);
  }
  const h = harness(); const first = h.guard.refresh();
  h.calls[0].reject(new Error('Synthetic initial query failure')); await first;
  assert.equal(h.guard.getSnapshot().status, 'unavailable');
  h.emit(state('clear', 2));
  assert.equal(h.guard.getSnapshot().status, 'unavailable', 'A native clear alone cannot bypass failed initial registration');
  const retry = h.guard.refresh(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(state('clear', 2)); await retry; assert.equal(h.allowed(), true);
  assert.equal(h.listeners.size, 1);
});

test('suspend invalidates pending replies and needs a fresh successful query before restoring UI', async () => {
  const h = harness(); const initial = h.guard.refresh(); h.guard.suspend();
  h.calls[0].resolve(state('clear', 1)); await initial;
  assert.equal(h.allowed(), false); assert.equal(h.guard.getSnapshot().status, 'pending');
  h.emit(state('clear', 2)); assert.equal(h.allowed(), false);
  const resumed = h.guard.refresh(); h.calls[1].resolve(state('clear', 2)); await resumed;
  assert.equal(h.allowed(), true);
  h.guard.suspend(); assert.equal(h.allowed(), false);
});

test('stop removes listeners, fences old callbacks/replies and permits safe root remount', async () => {
  const h = harness(); const old = h.guard.refresh(); h.guard.stop();
  assert.equal(h.listeners.size, 0);
  const remount = h.guard.refresh(); assert.equal(h.listeners.size, 1);
  h.calls[1].resolve(state('recording', 7)); await remount;
  h.calls[0].resolve(state('clear', 99)); await old;
  h.staleListeners[0](state('clear', 100));
  assert.equal(h.guard.getSnapshot().status, 'recording'); assert.equal(h.guard.getSnapshot().revision, 7);
});

test('unsupported fallback is accepted only on real Android API below 35', async () => {
  for (const version of [34, 35, 37, '34', NaN]) {
    const h = harness({ version }), started = h.guard.refresh();
    h.calls[0].resolve(state('unsupported', 0)); await started;
    assert.equal(h.allowed(), version === 34);
    assert.equal(h.guard.getSnapshot().status, version === 34 ? 'unsupported' : 'unavailable');
  }
});

test('malformed or contradictory native state fails closed and invalidates a pending initial reply', async () => {
  for (const invalid of [null, state('clear', -1), state('clear', 1.5), state('unexpected', 2), state('clear', Infinity)]) {
    const h = harness(), started = h.guard.refresh(); h.emit(invalid);
    h.calls[0].resolve(state('clear', 2)); await started;
    assert.equal(h.guard.getSnapshot().status, 'unavailable'); assert.equal(h.allowed(), false);
  }
  const h = harness(), started = h.guard.refresh();
  h.calls[0].resolve(state('clear', 1)); await started;
  h.emit(state('recording', 1)); assert.equal(h.allowed(), false);
});

test('iOS guard access never resolves Android native modules and preserves its existing path', async () => {
  const h = harness({ platform: 'ios' }); assert.equal(h.allowed(), true);
  const unsubscribe = h.guard.subscribe(() => {}); unsubscribe(); await flush();
  assert.equal(h.lookups(), 0);
});
