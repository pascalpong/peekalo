/** Opt-in, generated-only Linux resource observation. No backend or credentials.
 * PEEKALO_TEST_RELIABILITY=1 node scripts/test-reliability-capacity.mjs
 * Uses an already built runtime image; override PEEKALO_TEST_IMAGE if needed.
 * Tests actual normalization/admission helpers behind a fixture HTTP adapter,
 * not production authorization, multipart parsing, Storage or Render wakeup.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import ts from 'typescript';

const worker = String.raw`
const { createServer, request: send } = require('node:http');
const { Readable } = require('node:stream');
const { readFile, rm } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const sources = require('/fixture/sources.json');
class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
function load(name) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', sources[name])(
    value => value === './sharing' ? { ApiError } : value === 'sharp' ? require('/app/apps/web/node_modules/sharp') : require(value), module, module.exports);
  return module.exports;
}
const { normalizeCapture } = load('processing');
const { acquireUploadSlot, readUploadBody } = load('admission');
let active = false, received = 0;
const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === '/state') { outgoing.end(JSON.stringify({ active, received })); return; }
  let release;
  const interrupted = new AbortController();
  incoming.once('aborted', () => interrupted.abort());
  try {
    release = acquireUploadSlot(); active = true;
    const request = new Request('http://127.0.0.1/upload', { method: 'POST', body: Readable.toWeb(incoming), duplex: 'half', signal: interrupted.signal });
    const bytes = await readUploadBody(request);
    received++;
    const start = performance.now();
    const normalized = await normalizeCapture(bytes, 'video');
    const elapsedMs = Math.round(performance.now() - start);
    // Decode every frame and validate duration/audio on the actual output.
    const { writeFile } = require('node:fs/promises');
    const output = '/tmp/reliability-normalized.mp4';
    await writeFile(output, normalized.bytes, { mode: 0o600 });
    const probe = JSON.parse(execFileSync('/usr/bin/ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',output], { timeout: 15000, maxBuffer: 16384 }));
    assert(Math.abs(Number(probe.format.duration) - 10) < 0.15);
    assert(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 720 && stream.height === 1280));
    execFileSync('/usr/bin/ffmpeg', ['-nostdin','-v','error','-threads','1','-i',output,'-f','null','-'], { timeout: 60000, maxBuffer: 16384 });
    await rm(output);
    outgoing.end(JSON.stringify({ elapsedMs, outputBytes: normalized.bytes.length }));
  } catch (error) {
    outgoing.statusCode = Number.isInteger(error.status) ? error.status : 500;
    outgoing.end(JSON.stringify({ error: ['processing_busy','request_timeout','invalid_request'].includes(error.code) ? error.code : 'fixture_failed' }));
  } finally { if (release) { active = false; release(); } }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = () => Math.round(performance.now());
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  console.log(JSON.stringify({ event: 'fixture_ready' }));
  const state = async () => (await fetch(base + '/state')).json();
  const request = body => fetch(base + '/upload', { method: 'POST', body, signal: AbortSignal.timeout(150000) });
  // Real loopback HTTP body stalls at one byte under the production 30s reader
  // deadline. A sibling is rejected while this slot is occupied.
  const stalledStart = clock();
  const stalled = send(base + '/upload', { method: 'POST' });
  const stalledResult = new Promise((resolve, reject) => { stalled.once('error', reject); stalled.once('response', response => { let text=''; response.on('data', b => { text += b; }); response.once('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) })); }); });
  stalled.write(Buffer.from([0]));
  while (!(await state()).active) await pause(10);
  const refusedStart = clock(); const refused = await request(Buffer.from([0]));
  assert.equal(refused.status, 429); assert.equal((await refused.json()).error, 'processing_busy');
  const rejectedMs = clock() - refusedStart;
  const timeout = await stalledResult; stalled.destroy();
  assert.equal(timeout.status, 408); assert.equal(timeout.data.error, 'request_timeout');
  const stalledMs = clock() - stalledStart;
  // Aborted HTTP transport also frees the same admission slot, before retry.
  const disconnected = send(base + '/upload', { method: 'POST' });
  disconnected.on('error', () => {}); disconnected.write(Buffer.from([0]));
  while (!(await state()).active) await pause(10);
  const disconnectStart = clock(); disconnected.destroy();
  while ((await state()).active) { assert(clock() - disconnectStart < 5000); await pause(10); }
  const disconnectRecoveryMs = clock() - disconnectStart;
  const input = await readFile('/fixture/generated.mp4');
  const normalizedStart = clock(); const normalized = request(input);
  while ((await state()).received === 0) await pause(10);
  const overlapStart = clock(); const overlap = await request(input);
  assert.equal(overlap.status, 429); assert.equal((await overlap.json()).error, 'processing_busy');
  const overlapRejectedMs = clock() - overlapStart;
  const response = await normalized; assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal((await state()).active, false);
  const usage = (await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).match(/usage_usec (\d+)/)?.[1];
  const peak = Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8'));
  console.log(JSON.stringify({ event: 'fixture_passed', inputBytes: input.length, generatedDurationSeconds: 10,
    ...result, totalNormalizeDecodeHttpMs: clock() - normalizedStart,
    stalledMs, rejectedMs, overlapRejectedMs, disconnectRecoveryMs,
    peakMemoryMiB: Math.round(peak / 1024 / 1024 * 10) / 10, cpuUsageMs: Math.round(Number(usage) / 1000) }));
})().catch(() => { console.log(JSON.stringify({ event: 'fixture_failed' })); process.exitCode = 1; }).finally(() => { server.close(); server.closeAllConnections(); });
`;

let directory;
const containers = new Set();
try {
  assert.equal(process.env.PEEKALO_TEST_RELIABILITY, '1', 'Explicit generated-only test opt-in required');
  const image = process.env.PEEKALO_TEST_IMAGE || 'peekalo-hosting:local';
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const platform = docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]);
  directory = await mkdtemp(path.join(tmpdir(), 'peekalo-reliability-'));
  const sources = {};
  for (const [key, file] of [['processing', 'processing'], ['admission', 'upload-admission']]) {
    sources[key] = ts.transpileModule(await readFile(new URL(`../apps/web/lib/server/${file}.ts`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  }
  await writeFile(path.join(directory, 'sources.json'), JSON.stringify(sources));
  await writeFile(path.join(directory, 'runner.cjs'), worker);
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=720x1280:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','10','-c:v','libx264','-preset','ultrafast','-crf','25','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-map_metadata','-1','-movflags','+faststart',path.join(directory,'generated.mp4')], { timeout: 45_000, stdio: 'ignore' });
  for (const [profile, memory, cpu] of [['free', '512m', '0.1'], ['one_cpu', '2g', '1']]) {
    const name = `peekalo-reliability-${process.pid}-${profile}`;
    containers.add(name);
    const started = performance.now();
    const results = await new Promise((resolve, reject) => {
      const child = spawn('docker', ['run','--rm','--name',name,'--platform',platform,'--network','none',`--memory=${memory}`,`--cpus=${cpu}`,'--tmpfs','/tmp:rw,noexec,nosuid,size=256m,mode=1777','--mount',`type=bind,source=${directory},target=/fixture,readonly`,'--entrypoint','node','-e','FFMPEG_PATH=/usr/bin/ffmpeg','-e','FFPROBE_PATH=/usr/bin/ffprobe',image,'-e',"require('/app/apps/web/node_modules/sharp');require('/fixture/runner.cjs')"], { stdio: ['ignore','pipe','pipe'] });
      const records = []; let buffer = ''; let outputBytes = 0;
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Bounded resource observation timed out')); }, 240_000);
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 8192) { child.kill('SIGTERM'); return; }
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          try { const record = JSON.parse(line); if (record.event === 'fixture_ready') record.coldFixtureReadyMs = Math.round(performance.now() - started); records.push(record); }
          catch { /* Never print arbitrary subprocess output. */ }
        }
      });
      child.stderr.resume();
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(records); else reject(new Error('Resource observation failed')); });
    });
    containers.delete(name);
    assert(results.some(record => record.event === 'fixture_passed'));
    console.log(JSON.stringify({ profile, memoryLimit: memory, cpuLimit: cpu, platform, records: results }));
  }
} catch {
  console.error('Generated reliability capacity observation failed; no backend was contacted.');
  process.exitCode = 1;
} finally {
  for (const name of containers) {
    try { execFileSync('docker', ['rm','--force',name], { timeout: 15_000, stdio: 'ignore' }); }
    catch { console.error('Generated reliability container cleanup needs attention.'); process.exitCode = 1; }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}
