import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// The cache contains bytes only. HTTP authorization remains in handlers.ts.
const source = await readFile(new URL('../apps/web/lib/server/private-media-cache.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createPrivateMediaCache } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('private normalized bytes expire and cannot be mutated by producer or reader', () => {
  let clock = 0;
  const cache = createPrivateMediaCache({ ttlMs: 100, now: () => clock });
  try {
    const bytes = Buffer.from('private normalized photo');
    cache.put('attempt/photo', 'photo', bytes);
    bytes.fill(0);
    const first = cache.get('attempt/photo', 'photo');
    assert.equal(first.toString(), 'private normalized photo');
    first.fill(1);
    assert.equal(cache.get('attempt/photo', 'photo').toString(), 'private normalized photo');
    assert.equal(cache.get('attempt/photo', 'video'), undefined);
    assert.equal(cache.get('other-owner/photo', 'photo'), undefined);
    clock = 100;
    assert.equal(cache.get('attempt/photo', 'photo'), undefined);
  } finally { cache.clear(); }
});

test('byte, item and entry bounds evict old data and reject oversized media', () => {
  const cache = createPrivateMediaCache({ maxBytes: 6, maxItemBytes: 4, maxItems: 2 });
  try {
    cache.put('a', 'photo', Buffer.from('1234'));
    cache.put('b', 'video', Buffer.from('5678'));
    assert.equal(cache.get('a', 'photo'), undefined);
    assert.equal(cache.get('b', 'video').toString(), '5678');
    cache.put('c', 'photo', Buffer.from('9'));
    cache.put('d', 'photo', Buffer.from('0'));
    assert.equal(cache.get('b', 'video'), undefined);
    assert.equal(cache.get('c', 'photo').toString(), '9');
    cache.put('c', 'photo', Buffer.alloc(5));
    assert.equal(cache.get('c', 'photo'), undefined);
    cache.remove('d');
    assert.equal(cache.get('d', 'photo'), undefined);
  } finally { cache.clear(); }
});
