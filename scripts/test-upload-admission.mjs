import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual TypeScript helper without Next, environment files or any
// backend connection. Fresh imports model independent Node process admission.
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/upload-admission.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const fresh = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${randomUUID()}`);
const makeRequest = (body, init = {}) => new globalThis.Request('https://peekalo.example/api/posts', {
  method: 'POST', body, duplex: 'half', ...init,
});
const fails = (status, code) => error => error.status === status && error.code === code;

test('one upload slot spans work; duplicate release cannot free another upload', async () => {
  const { acquireUploadSlot } = await fresh();
  const release = acquireUploadSlot();
  assert.throws(acquireUploadSlot, fails(429, 'processing_busy'));
  release();
  const next = acquireUploadSlot();
  release();
  assert.throws(acquireUploadSlot, fails(429, 'processing_busy'));
  next();
  acquireUploadSlot()();
});

test('bounded body reader accepts exact bytes and releases its lock', async () => {
  const { readUploadBody } = await fresh();
  const request = makeRequest('abcd', { headers: { 'Content-Length': '4' } });
  assert.equal((await readUploadBody(request, 4, 1000)).toString(), 'abcd');
  assert.equal(request.body.locked, false);
});

test('rejects advertised oversize/invalid lengths before locking or reading', async () => {
  const { readUploadBody } = await fresh();
  for (const length of ['5', '9007199254740992', '-1', 'nonsense']) {
    const request = makeRequest('a', { headers: { 'Content-Length': length } });
    await assert.rejects(readUploadBody(request, 4, 1000), error => error.status === (['5', '9007199254740992'].includes(length) ? 413 : 400));
    assert.equal(request.body.locked, false);
  }
});

test('streaming cap cancels an oversized body even when its length understates it', async () => {
  const { readUploadBody } = await fresh();
  let cancelled = 0;
  const stream = new globalThis.ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('abcdef')); },
    cancel() { cancelled++; },
  });
  const request = makeRequest(stream, { headers: { 'Content-Length': '1' } });
  await assert.rejects(readUploadBody(request, 4, 1000), fails(413, 'file_too_large'));
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('deadline actively cancels a pending read without waiting on a stalled cancel callback', async () => {
  const { readUploadBody } = await fresh();
  let cancelled = 0;
  const stream = new globalThis.ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
  const started = Date.now();
  await assert.rejects(readUploadBody(makeRequest(stream), 4, 25), fails(408, 'request_timeout'));
  assert(Date.now() - started < 1000, 'The cancellation callback must not extend the read deadline');
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('a stream of immediately available empty chunks cannot starve its wall-clock deadline', async () => {
  const { readUploadBody } = await fresh();
  let cancelled = 0;
  const stream = new globalThis.ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(0)); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  const started = Date.now();
  await assert.rejects(readUploadBody(makeRequest(stream), 4, 25), fails(408, 'request_timeout'));
  assert(Date.now() - started < 1000);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('disconnect cancels the pending source and always returns a sanitized error', async () => {
  const { readUploadBody } = await fresh();
  const controller = new globalThis.AbortController();
  let cancelled = 0;
  const stream = new globalThis.ReadableStream({ cancel() { cancelled++; } });
  const pending = readUploadBody(makeRequest(stream, { signal: controller.signal }), 4, 1000);
  controller.abort(new Error('private-source-failure'));
  await assert.rejects(pending, fails(408, 'request_timeout'));
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('body-source failure releases the reader and does not expose the source error', async () => {
  const { readUploadBody } = await fresh();
  const stream = new globalThis.ReadableStream({ start(controller) { controller.error(new Error('private-source-failure')); } });
  await assert.rejects(readUploadBody(makeRequest(stream), 4, 1000), error => {
    assert.equal(error.message, 'invalid_request');
    return fails(400, 'invalid_request')(error);
  });
  assert.equal(stream.locked, false);
});

test('body deadline failure does not retain the process upload slot when caller unwinds', async () => {
  const { acquireUploadSlot, readUploadBody } = await fresh();
  const release = acquireUploadSlot();
  try {
    await assert.rejects(readUploadBody(makeRequest(new globalThis.ReadableStream()), 4, 25), fails(408, 'request_timeout'));
  } finally { release(); }
  acquireUploadSlot()();
});
