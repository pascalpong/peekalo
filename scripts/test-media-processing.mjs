import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import ts from 'typescript';

// Execute the actual normalization module with closed process/filesystem
// boundaries. No private media, developer credentials or real subprocesses.
const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/processing.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const metadata = { streams: [{ codec_type: 'video', width: 1080, height: 1920 }], format: { duration: '4' } };
class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function fixture({ probe = JSON.stringify(metadata), failure, stage = 'ffmpeg', elapsed = 0, output = Buffer.from('normalized fixture'), readError = false, wait } = {}) {
  let clock = 0;
  let fail = failure;
  const logs = []; const cleaned = []; const calls = []; const writes = [];
  const execFile = () => { throw new Error('Use promisified mock'); };
  execFile[promisify.custom] = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === stage && fail) { const error = fail; fail = undefined; clock += elapsed; throw error; }
    if (command === 'ffprobe') return { stdout: probe, stderr: '' };
    await wait;
    return { stdout: '', stderr: '' };
  };
  const imports = {
    sharp: () => { throw new Error('Photo path outside this video test'); },
    'node:child_process': { execFile }, 'node:util': { promisify },
    'node:perf_hooks': { performance: { now: () => clock } },
    'node:fs/promises': {
      mkdtemp: async () => '/synthetic/private-fixture',
      writeFile: async (...args) => { writes.push(args); },
      readFile: async () => { if (readError) throw new Error('private-secret-path'); return output; },
      rm: async (...args) => { cleaned.push(args); },
    },
    'node:os': { tmpdir: () => '/synthetic' }, 'node:path': path, './sharing': { ApiError },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', 'process', source)(name => {
    assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name];
  }, module, module.exports, { warn: record => { logs.push(record); } }, { env: {} });
  return { run: () => module.exports.normalizeCapture(Buffer.from('synthetic input'), 'video'), logs, cleaned, calls, writes };
}
const secretError = fields => Object.assign(new Error('SECRET_API_KEY /private/user-video.mp4'), {
  stderr: 'PRIVATE_USER_METADATA', stdout: 'PRIVATE_OUTPUT', cmd: 'SECRET_COMMAND', ...fields,
});
function checkCleanup(f) {
  assert.deepEqual(f.cleaned.at(-1), ['/synthetic/private-fixture', { recursive: true, force: true }]);
  assert.equal(f.writes[0][2].mode, 0o600);
}
function checkLog(f, stage, category) {
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].stage, stage); assert.equal(f.logs[0].category, category);
  assert.equal(f.logs[0].event, 'media_processing_failed');
  assert(Number.isSafeInteger(f.logs[0].elapsedMs));
  for (const key of Object.keys(f.logs[0])) assert(['event', 'stage', 'category', 'elapsedMs', 'exitCode', 'signal'].includes(key));
  assert(!/SECRET|PRIVATE|private|fixture/.test(JSON.stringify(f.logs)));
}

test('successful video normalization retains format, bounded commands and private cleanup without logging', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(result, { bytes: Buffer.from('normalized fixture'), extension: 'mp4', contentType: 'video/mp4' });
  assert.deepEqual(f.logs, []); checkCleanup(f);
  assert.deepEqual(f.calls.map(call => call.options.timeout), [15_000, 60_000]);
});

test('confirmed transcode deadline gets retryable-specific API code and never leaks process error content', async () => {
  const f = fixture({ failure: secretError({ killed: true, signal: 'SIGTERM', code: null }), elapsed: 60_003 });
  await assert.rejects(f.run(), { status: 422, code: 'video_processing_timeout' });
  checkLog(f, 'transcode', 'timeout'); checkCleanup(f);
  assert.equal(f.logs[0].signal, 'SIGTERM'); assert(!Object.hasOwn(f.logs[0], 'exitCode'));
  assert.equal((await f.run()).extension, 'mp4', 'Failed attempt releases processing capacity');
});

test('FFmpeg graceful exit 255 after deadline kill is still classified as timeout', async () => {
  const f = fixture({ failure: secretError({ killed: true, signal: null, code: 255 }), elapsed: 60_006 });
  await assert.rejects(f.run(), { code: 'video_processing_timeout' });
  checkLog(f, 'transcode', 'timeout'); checkCleanup(f);
  assert.equal(f.logs[0].exitCode, 255); assert(!Object.hasOwn(f.logs[0], 'signal'));
});

for (const [name, error, elapsed, category] of [
  ['early signal', secretError({ killed: true, signal: 'SIGTERM' }), 100, 'terminated'],
  ['early graceful kill', secretError({ killed: true, signal: null, code: 255 }), 100, 'nonzero_exit'],
  ['late external signal without kill marker', secretError({ signal: 'SIGTERM' }), 60_000, 'terminated'],
  ['nonzero exit', secretError({ code: 1, signal: 'SENSITIVE_SIGNAL' }), 20, 'nonzero_exit'],
  ['unavailable executable', secretError({ code: 'ENOENT' }), 0, 'spawn_unavailable'],
  ['stderr buffer limit', secretError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 4, 'buffer_limit'],
]) test(`${name} is safely distinguished from a local timeout`, async () => {
  const f = fixture({ failure: error, elapsed });
  await assert.rejects(f.run(), { code: 'video_processing_failed' });
  checkLog(f, 'transcode', category); checkCleanup(f);
});

test('probe failures remain invalid_video while exposing only safe failure diagnostics', async () => {
  const f = fixture({ stage: 'ffprobe', failure: secretError({ killed: true, signal: 'SIGTERM' }), elapsed: 15_000 });
  await assert.rejects(f.run(), { code: 'invalid_video' });
  checkLog(f, 'probe', 'timeout'); checkCleanup(f);
  assert.equal(f.calls.length, 1);
});

for (const probe of ['PRIVATE not-json', 'null', '{"streams":{}}', '{"streams":[null]}', JSON.stringify({ ...metadata, format: { duration: '11' } }), JSON.stringify({ ...metadata, streams: [{ codec_type: 'video', width: -1, height: 2 }] })]) {
  test(`malformed or invalid probe ${probe.length} is rejected before encoding`, async () => {
    const f = fixture({ probe });
    await assert.rejects(f.run(), { code: 'invalid_video' });
    checkLog(f, 'validation', 'invalid_metadata'); checkCleanup(f);
    assert.equal(f.calls.length, 1);
  });
}

for (const output of [Buffer.alloc(0), Buffer.alloc(30_000_000)]) test(`output byte limit rejects ${output.length} bytes`, async () => {
  const f = fixture({ output });
  await assert.rejects(f.run(), { code: 'video_processing_failed' });
  checkLog(f, 'output', 'output_limit'); checkCleanup(f);
});

test('output read failure emits safe io classification and cleans up', async () => {
  const f = fixture({ readError: true });
  await assert.rejects(f.run(), { code: 'video_processing_failed' });
  checkLog(f, 'output', 'io_failure'); checkCleanup(f);
});

test('repeated failed normalizations release capacity rather than wedging both slots', async () => {
  const f = fixture({ readError: true });
  for (let attempt = 0; attempt < 4; attempt++) await assert.rejects(f.run(), { code: 'video_processing_failed' });
  assert.equal(f.cleaned.length, 4); assert.equal(f.logs.length, 4);
});

test('two occupied normalizers reject a third and release capacity after completion', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ wait });
  const first = f.run(); const second = f.run();
  await assert.rejects(f.run(), { code: 'processing_busy' });
  release();
  await Promise.all([first, second]);
  await f.run();
  assert.equal(f.cleaned.length, 3); assert.deepEqual(f.logs, []);
});
