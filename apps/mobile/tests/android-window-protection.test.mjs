import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/android-window-protection.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness() {
  const activeTags = new Set(), requestedKeys = [], nativeCalls = [];
  let generated = 0, releaseCalls = 0;
  const imports = {
    'expo-crypto': { randomUUID: () => `fixture-acquisition-${++generated}` },
    'expo-screen-capture': {
      async preventScreenCaptureAsync(key) {
        requestedKeys.push(key);
        // Match pinned Expo behavior: failed native calls retain their tag.
        if (activeTags.has(key)) return;
        activeTags.add(key);
        const call = deferred();
        nativeCalls.push(call);
        await call.promise;
      },
      async allowScreenCaptureAsync() { releaseCalls++; },
    },
  };
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    assert(Object.hasOwn(imports, name), `Unexpected import ${name}`);
    return imports[name];
  } });
  return {
    acquire: exports.acquireAndroidWindowProtection,
    activeTags, requestedKeys, nativeCalls,
    releaseCalls: () => releaseCalls,
  };
}

test('acquisition remains pending until native protection succeeds and concurrent roots share it', async () => {
  const h = harness();
  const first = h.acquire(), concurrent = h.acquire();
  assert.equal(first, concurrent);
  let settled = false;
  void first.then(() => { settled = true; });
  await flush();
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(settled, false);
  h.nativeCalls[0].resolve();
  await first;
  assert.equal(settled, true);
  assert.equal(h.releaseCalls(), 0);
});

test('a failed native acquisition rejects every waiter and retry bypasses the retained Expo tag', async () => {
  const h = harness();
  const first = h.acquire(), concurrent = h.acquire();
  const firstRejected = assert.rejects(first), concurrentRejected = assert.rejects(concurrent);
  await flush();
  h.nativeCalls[0].reject(new Error('Synthetic native protection failure'));
  await Promise.all([firstRejected, concurrentRejected]);
  assert.equal(h.activeTags.size, 1, 'Expo retains the failed acquisition key');

  const retry = h.acquire();
  assert.notEqual(retry, first);
  let settled = false;
  void retry.then(() => { settled = true; });
  await flush();
  assert.equal(h.nativeCalls.length, 2, 'Retry must actually invoke native protection');
  assert.equal(settled, false, 'A retained failed key must not falsely open the navigator');
  assert.notEqual(h.requestedKeys[1], h.requestedKeys[0]);
  h.nativeCalls[1].resolve();
  await retry;
  assert.equal(h.activeTags.size, 2, 'Do not release a possibly established native baseline');
  assert.equal(h.releaseCalls(), 0);
});

test('repeated failures use fresh native attempts while each pending retry is deduplicated', async () => {
  const h = harness();
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = h.acquire();
    assert.equal(h.acquire(), pending);
    const rejected = assert.rejects(pending);
    await flush();
    assert.equal(h.nativeCalls.length, attempt + 1);
    h.nativeCalls[attempt].reject(new Error('Synthetic native protection failure'));
    await rejected;
  }
  assert.equal(new Set(h.requestedKeys).size, 3);
  assert.equal(h.activeTags.size, 3);
  assert.equal(h.releaseCalls(), 0);
});

test('successful protection stays permanent across root remounts and later consumers', async () => {
  const h = harness();
  const initialRoot = h.acquire();
  await flush();
  h.nativeCalls[0].resolve();
  await initialRoot;
  // A root can disappear and remount while the JavaScript process stays alive.
  // There is deliberately no release API or component ownership to hand over.
  for (let remount = 0; remount < 4; remount++) {
    const nextRoot = h.acquire();
    assert.equal(nextRoot, initialRoot);
    await nextRoot;
  }
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.requestedKeys.length, 1);
  assert.equal(h.activeTags.size, 1);
  assert.equal(h.releaseCalls(), 0);
});
