import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/lib/private-photo.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const origin = 'https://api.example.invalid';
const uri = `${origin}/api/view/media/11111111-1111-4111-8111-111111111111`;
const data = 'data:image/jpeg;base64,/9j/';

function harness({ fetcher, response = {}, readerThrow = false } = {}) {
  const calls = [], readers = [], blobs = [];
  function blob(overrides = {}) {
    const value = { size: 3, type: 'image/jpeg', closed: 0, close() { this.closed++; }, slice(start, end, type) { return blob({ size: end - start, type }); }, ...overrides };
    blobs.push(value); return value;
  }
  const defaultBlob = blob();
  const reply = overrides => ({ status: 200, url: uri, headers: new Headers({ 'Content-Type': 'image/jpeg', 'Content-Length': '3' }), blob: async () => defaultBlob, ...overrides });
  class Reader {
    result = null; onload = null; onabort = null; onerror = null; aborted = 0;
    constructor() { readers.push(this); }
    readAsDataURL(value) { this.blob = value; if (readerThrow) throw new Error('private native failure'); }
    abort() { this.aborted++; this.onabort?.(); }
    complete(value = data) { this.result = value; this.onload?.(); }
    fail() { this.onerror?.(); }
  }
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL, FileReader: Reader,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(reply) : reply(response); },
  });
  const controller = new AbortController();
  const load = (options = {}) => exports.loadPrivatePhoto({ uri, authorization: 'Bearer generated-fixture-token', expectedOrigin: origin, signal: controller.signal, ...options });
  return { calls, readers, blobs, blob, reply, controller, load };
}

test('private photo uses authorized no-store fetch and closes its memory blob after data decoding', async () => {
  const h = harness(); const pending = h.load(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, uri);
  const options = h.calls[0].options;
  assert.equal(options.headers.Authorization, 'Bearer generated-fixture-token');
  assert.equal(options.headers['Cache-Control'], 'no-store');
  assert.equal(options.cache, undefined); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
  assert.equal(options.signal, h.controller.signal);
  assert.equal(h.blobs[0].closed, 0);
  h.readers[0].complete();
  assert.equal(await pending, data); assert.equal(h.blobs[0].closed, 1);
  h.controller.abort(); assert.equal(h.blobs[0].closed, 1);
  assert.equal(h.readers[0].onload, null);
});

test('the pinned native fetch polyfill preserves the exact authorized URL and decodes its successful Blob response', async () => {
  // Execute RN's actual installed Request/fetch implementation. A plain fetch
  // spy misses whatwg-fetch's cache:'no-store' query-string rewrite.
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(require.resolve('react-native/package.json'));
  const polyfill = readFileSync(nativeRequire.resolve('whatwg-fetch'), 'utf8');
  const requests = [], bodies = [];
  class NativeBlob {
    constructor(parts = [], { type = '' } = {}) {
      this.size = parts.reduce((size, part) => size + part.byteLength, 0); this.type = type; this.closed = 0;
    }
    close() { this.closed++; }
    slice(start, end, type) { return new NativeBlob([new Uint8Array(end - start)], { type }); }
  }
  class Reader {
    readAsDataURL(blob) { assert.equal(blob.size, 3); this.result = data; queueMicrotask(() => this.onload?.()); }
    abort() { this.onabort?.(); }
  }
  class XHR {
    responseType = ''; readyState = 0; headers = {}; status = 200; statusText = 'OK';
    constructor() { requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    getAllResponseHeaders() { return 'Content-Type: image/jpeg\r\nContent-Length: 3\r\nCache-Control: private, no-store, max-age=0\r\n'; }
    send() {
      this.responseURL = this.url;
      this.response = new NativeBlob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });
      bodies.push(this.response);
      queueMicrotask(() => { this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); });
    }
    abort() { this.onabort?.(); }
  }
  const context = vm.createContext({ exports: {}, module: {}, URL, URLSearchParams, Blob: NativeBlob, FileReader: Reader, XMLHttpRequest: XHR, setTimeout, clearTimeout });
  vm.runInContext(polyfill, context);
  const nativeRequest = context.exports.Request;
  assert.notEqual(new nativeRequest(uri, { cache: 'no-store' }).url, uri, 'Exercise the pinned cache-option URL rewrite rather than a browser fetch stub');
  context.exports = {};
  vm.runInContext(source, context);
  const controller = new AbortController();
  assert.equal(await context.exports.loadPrivatePhoto({ uri, authorization: 'Bearer generated-fixture-token', expectedOrigin: origin, signal: controller.signal }), data);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, uri); assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.authorization, 'Bearer generated-fixture-token');
  assert.equal(requests[0].headers['cache-control'], 'no-store');
  assert.equal(requests[0].withCredentials, false); assert.equal(requests[0].responseType, 'blob');
  assert.equal(bodies[0].closed, 1);
});

function nativeBlobHarness({ deferRead = false } = {}) {
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(require.resolve('react-native/package.json'));
  const nativeRoot = pathToFileURL(nativeRequire.resolve('react-native/package.json'));
  const babel = nativeRequire('@babel/core');
  const modules = new Map(), memory = new Map(), released = [], reads = [], requests = [];
  const gate = deferred();
  const attributes = new WeakMap();
  const eventAttributes = {
    getEventHandlerAttribute(target, name) { return attributes.get(target)?.[name] ?? null; },
    setEventHandlerAttribute(target, name, listener) {
      const previous = attributes.get(target) ?? {};
      if (previous[name]) target.removeEventListener(name, previous[name]);
      previous[name] = listener; attributes.set(target, previous);
      if (listener) target.addEventListener(name, listener);
    },
  };
  const nativeBlob = {
    createFromParts(parts, id) { memory.set(id, Buffer.from(parts.map(part => part.data).join(''))); },
    release(id) { released.push(id); memory.delete(id); },
  };
  const nativeReader = {
    readAsDataURL(metadata) {
      reads.push({ ...metadata, references: load('BlobRegistry').has(metadata.blobId) });
      const bytes = memory.get(metadata.blobId).subarray(metadata.offset, metadata.offset + metadata.size);
      // Match pinned Android FileReaderModule's missing-type fallback.
      const value = `data:${metadata.type || 'application/octet-stream'};base64,${bytes.toString('base64')}`;
      return deferRead ? gate.promise.then(() => value) : Promise.resolve(value);
    },
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const exports = {}; modules.set(name, exports);
    const code = babel.transformSync(readFileSync(new URL(`./Libraries/Blob/${name}.js`, nativeRoot), 'utf8'), {
      babelrc: false, configFile: false,
      plugins: [nativeRequire.resolve('@babel/plugin-transform-flow-strip-types'), nativeRequire.resolve('@babel/plugin-transform-modules-commonjs')],
    }).code;
    vm.runInNewContext(code, { exports, global: {}, require(dependency) {
      if (dependency === './NativeBlobModule') return nativeBlob;
      if (dependency === './NativeFileReaderModule') return nativeReader;
      if (dependency.endsWith('/EventTarget')) return EventTarget;
      if (dependency.endsWith('/Event')) return Event;
      if (dependency.endsWith('/EventHandlerAttributes')) return eventAttributes;
      if (dependency.startsWith('./')) return load(dependency.slice(2));
      return nativeRequire(dependency);
    } });
    return exports;
  }
  const Blob = load('Blob').default, FileReader = load('FileReader').default, manager = load('BlobManager').default;
  class XHR {
    responseType = ''; status = 200; statusText = 'OK'; headers = {};
    open(method, url) { this.method = method; this.url = url; requests.push(this); }
    setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    getAllResponseHeaders() { return 'Content-Type: image/jpeg\r\nContent-Length: 3\r\nCache-Control: private, no-store\r\n'; }
    send() {
      memory.set('generated-android-response', Buffer.from([255, 216, 255]));
      // Match BlobModule networkingResponseHandler.toResponseData: Android
      // sends blobId/offset/size, with no MIME field. Use the real RN Blob getter,
      // slice, manager, registry and FileReader rather than browser Blob defaults.
      this.response = manager.createFromOptions({ blobId: 'generated-android-response', offset: 0, size: 3 });
      assert.equal(this.response.type, '');
      this.responseURL = this.url;
      queueMicrotask(() => { this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); });
    }
    abort() { this.onabort?.(); }
  }
  const context = vm.createContext({ exports: {}, module: {}, Blob, FileReader, XMLHttpRequest: XHR, URL, URLSearchParams, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(nativeRequire.resolve('whatwg-fetch'), 'utf8'), context);
  context.exports = {}; vm.runInContext(source, context);
  const controller = new AbortController();
  const begin = () => context.exports.loadPrivatePhoto({ uri, authorization: 'Bearer generated-fixture-token', expectedOrigin: origin, signal: controller.signal });
  return { begin, controller, gate, requests, reads, released, memory, registry: load('BlobRegistry') };
}

test('pinned Android RN Blob/FileReader normalize missing native MIME through a shared typed slice and release both references', async () => {
  const h = nativeBlobHarness();
  assert.equal(await h.begin(), data);
  assert.equal(h.requests[0].url, uri);
  assert.equal(h.reads.length, 1); assert.equal(h.reads[0].type, 'image/jpeg');
  assert.equal(h.reads[0].blobId, 'generated-android-response');
  assert.equal(h.reads[0].references, 2, 'Original and typed view share the same native memory registration');
  assert.equal(h.registry.has('generated-android-response'), false);
  assert.equal(h.released.filter(id => id === 'generated-android-response').length, 1);
  assert.equal(h.memory.has('generated-android-response'), false);
});

test('abort during pinned RN FileReader work closes the original and typed-slice registry references before late native completion', async () => {
  const h = nativeBlobHarness({ deferRead: true });
  const pending = h.begin(); const rejected = assert.rejects(pending);
  // whatwg-fetch completes through its actual asynchronous XHR load handler.
  for (let n = 0; n < 20 && h.reads.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.reads.length, 1); assert.equal(h.registry.has('generated-android-response'), 2);
  h.controller.abort(); await rejected;
  assert.equal(h.registry.has('generated-android-response'), false);
  assert.equal(h.released.filter(id => id === 'generated-android-response').length, 1);
  h.gate.resolve(); await flush();
  assert.equal(h.released.filter(id => id === 'generated-android-response').length, 1);
});

for (const [name, patch] of [
  ['foreign origin', { uri: 'https://other.example.invalid/api/view/media/11111111-1111-4111-8111-111111111111' }],
  ['embedded user info', { uri: uri.replace('https://', 'https://user:password@') }],
  ['query capability', { uri: `${uri}?token=fixture` }], ['fragment', { uri: `${uri}#fixture` }],
  ['non-media path', { uri: `${origin}/api/posts` }], ['local file', { uri: 'file:///private/photo.jpg' }],
  ['data URL', { uri: data }], ['missing bearer', { authorization: '' }],
]) {
  test(`rejects ${name} before any transport or native decode`, async () => {
    const h = harness(); await assert.rejects(h.load(patch), /private photo could not load/);
    assert.equal(h.calls.length, 0); assert.equal(h.readers.length, 0);
  });
}

test('decodes a complete photo whose size is declared independently of transport framing', async () => {
  const h = harness({ fetcher: reply => reply({ headers: new Headers({ 'Content-Type': 'image/jpeg', 'X-Peekalo-Media-Length': '3' }) }) });
  const pending = h.load(); await flush();
  h.readers[0].result = data;
  h.readers[0].onload();
  assert.equal(await pending, data);
});

for (const [name, response, blob] of [
  ['denied status', { status: 403 }], ['partial status', { status: 206 }],
  ['redirected response', { url: `${origin}/other` }],
  ['wrong MIME', { headers: new Headers({ 'Content-Type': 'image/png', 'Content-Length': '3' }) }],
  ['missing length', { headers: new Headers({ 'Content-Type': 'image/jpeg' }) }],
  ['conflicting length headers', { headers: new Headers({ 'Content-Type': 'image/jpeg', 'Content-Length': '2', 'X-Peekalo-Media-Length': '3' }) }],
  ['invalid length', { headers: new Headers({ 'Content-Type': 'image/jpeg', 'Content-Length': 'NaN' }) }],
  ['oversized advertised body', { headers: new Headers({ 'Content-Type': 'image/jpeg', 'Content-Length': String(15 * 1024 * 1024 + 1) }) }],
  ['oversized actual body', {}, { size: 15 * 1024 * 1024 + 1 }],
  ['length mismatch', {}, { size: 2 }], ['empty body', {}, { size: 0 }],
  ['wrong blob type', {}, { type: 'text/html' }],
]) {
  test(`rejects ${name}, closes native body and never begins Image decoding`, async () => {
    const h = harness({ fetcher: reply => reply({ ...response, blob: async () => h.blob(blob) }) });
    await assert.rejects(h.load(), /private photo could not load/);
    assert.equal(h.blobs.at(-1).closed, 1); assert.equal(h.readers.length, 0);
  });
}

test('already aborted operation performs no transport', async () => {
  const h = harness(); h.controller.abort(); await assert.rejects(h.load()); assert.equal(h.calls.length, 0);
});

for (const stage of ['fetch', 'body']) {
  test(`abort during ${stage} rejects promptly and closes a late native Blob`, async () => {
    const late = deferred();
    const h = harness({ fetcher: reply => stage === 'fetch' ? late.promise : reply({ blob: () => late.promise }) });
    const pending = h.load(); const rejected = assert.rejects(pending); await flush();
    h.controller.abort(); await rejected;
    late.resolve(stage === 'fetch' ? h.reply() : h.blobs[0]); await flush();
    assert.equal(h.calls[0].options.signal.aborted, true); assert.equal(h.blobs[0].closed, 1); assert.equal(h.readers.length, 0);
  });
}

test('abort during FileReader closes native memory, aborts the reader and ignores queued completion', async () => {
  const h = harness(); const pending = h.load(); const rejected = assert.rejects(pending); await flush();
  const reader = h.readers[0], oldLoad = reader.onload;
  h.controller.abort(); await rejected;
  assert.equal(reader.aborted, 1); assert.equal(h.blobs[0].closed, 1);
  reader.result = data; oldLoad(); await flush();
  assert.equal(h.blobs[0].closed, 1);
});

for (const result of ['https://private.example.invalid/photo', 'file:///photo.jpg', 'data:image/png;base64,/9j/', 'data:image/jpeg;base64,####', 'data:image/jpeg;base64,AAA=', 'data:image/jpeg;base64,', null]) {
  test(`invalid FileReader result ${String(result).slice(0, 24)} never reaches Image`, async () => {
    const h = harness(); const pending = h.load(); const rejected = assert.rejects(pending); await flush();
    h.readers[0].complete(result); await rejected; assert.equal(h.blobs[0].closed, 1);
  });
}

test('reader failure and synchronous native exceptions release Blob and expose only a fixed error', async () => {
  for (const readerThrow of [false, true]) {
    const h = harness({ readerThrow }); const pending = h.load(); const rejected = assert.rejects(pending, error => error.message === 'The private photo could not load.'); await flush();
    if (!readerThrow) h.readers[0].fail();
    await rejected; assert.equal(h.blobs[0].closed, 1);
  }
});
