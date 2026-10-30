// Run after `docker build -t peekalo-hosting:local .`. Synthetic config only.
// Opt in to the free-resource smoke with PEEKALO_TEST_PROFILE=free.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const image = process.env.PEEKALO_TEST_IMAGE || 'peekalo-hosting:local';
const profile = process.env.PEEKALO_TEST_PROFILE || 'default';
assert(['default', 'free'].includes(profile), 'PEEKALO_TEST_PROFILE must be default or free');
const free = profile === 'free';
const resources = [`--memory=${free ? '512m' : '2g'}`, `--cpus=${free ? '0.1' : '1'}`];
const startupTimeoutMs = free ? 180_000 : 60_000;
const requestTimeoutMs = free ? 20_000 : 5_000;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: free ? 60_000 : 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Request the built image's platform explicitly when testing under emulation.
const platform = docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]);
const run = args => docker(['run', '--platform', platform, ...args]);
const fixture = {
  PEEKALO_DEPLOYMENT: 'development',
  PEEKALO_EXPECTED_BACKEND_ORIGIN: 'https://backend.invalid',
  PEEKALO_SERVING_ENABLED: 'true',
  SUPABASE_URL: 'https://backend.invalid',
  SUPABASE_ANON_KEY: 'synthetic-public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
  SHARE_TOKEN_SECRET: 'synthetic-container-test-secret-at-least-32',
  PUBLIC_APP_URL: 'http://127.0.0.1:3000',
};
let container;
let startedAt;
try {
  let refused = false;
  try { run(['--rm', ...resources, '--network', 'none', image]); }
  catch (error) {
    assert.equal(error.status, 1);
    assert.equal(error.stderr.toString().trim(), 'Peekalo hosting preflight failed. Check server configuration and runtime dependencies.');
    refused = true;
  }
  assert(refused, 'Missing configuration must prevent startup');
  const env = Object.entries(fixture).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  startedAt = Date.now();
  container = run(['--rm', '-d', ...resources, '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,mode=1777', '-p', '127.0.0.1::3000', ...env, image]);
  const port = docker(['port', container, '3000/tcp']).split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  const request = path => fetch(new URL(path, base), { headers: { Connection: 'close' }, signal: AbortSignal.timeout(requestTimeoutMs) });
  let config;
  const startupDeadline = Date.now() + startupTimeoutMs;
  while (Date.now() < startupDeadline) {
    try { config = await fetch(`${base}/s/demo`, { signal: AbortSignal.timeout(Math.min(free ? requestTimeoutMs : 1000, startupDeadline - Date.now())) }); if (config.ok) break; }
    catch { /* Startup is asynchronous. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(config?.ok, 'Standalone server starts after preflight');
  await config.arrayBuffer();
  const coldReadyMs = Date.now() - startedAt;
  const unavailable = await request('/api/shares/config');
  assert.equal(unavailable.status, 503, 'Unavailable distributed admission must fail closed');
  assert.deepEqual(await unavailable.json(), { error: 'sharing_unavailable' });
  assert.equal(docker(['exec', container, 'node', '-e', "const fs=require('node:fs');if(!fs.statSync('/app/apps/web/account-cleanup.cjs').isFile())process.exit(1);console.log('packaged')"]), 'packaged');
  let runnerRefused = false;
  try { docker(['exec', container, 'node', 'apps/web/account-cleanup.cjs']); }
  catch (error) { runnerRefused = true; assert.equal(error.status, 1); assert.equal(error.stderr.toString().trim(), 'Peekalo operations incomplete; inspect restricted operational state.'); }
  assert(runnerRefused, 'Absent monitor hooks cannot run cleanup');
  // Exercise the actual packaged runner and SDK, with network fully replaced by
  // generated replies. Missing traced/transitive dependencies must fail here.
  const maintenanceFixture = `
    process.env.OPS_HEARTBEAT_URL='https://monitor.invalid/heartbeat';
    process.env.OPS_ALERT_URL='https://monitor.invalid/alert';
    const seen=[];
    globalThis.fetch=async input=>{
      const url=new URL(typeof input==='string'?input:input.url);
      seen.push(url.pathname);
      if(url.hostname==='monitor.invalid')return new Response(null,{status:204});
      if(url.hostname!=='backend.invalid')throw new Error('Unexpected synthetic destination');
      const name=url.pathname.split('/').at(-1);
      if(['peekalo_media_cleanup_jobs','peekalo_deletion_jobs'].includes(name))return Response.json([]);
      if(['peekalo_expire_private_records','peekalo_abuse_expire','peekalo_maintenance_heartbeat'].includes(name))return Response.json(true);
      throw new Error('Unexpected synthetic RPC');
    };
    process.on('beforeExit',()=>{
      for(const name of ['peekalo_media_cleanup_jobs','peekalo_deletion_jobs','peekalo_expire_private_records','peekalo_abuse_expire','peekalo_maintenance_heartbeat']){
        if(!seen.includes('/rest/v1/rpc/'+name))process.exitCode=1;
      }
      if(!seen.includes('/heartbeat'))process.exitCode=1;
    });
    require('./apps/web/account-cleanup.cjs');
  `;
  assert.equal(docker(['exec', container, 'node', '-e', maintenanceFixture]), 'Peekalo operations completed.');

  const health = await request('/api/health');
  assert.equal(health.status, 503, 'Unreachable backend must fail readiness');
  assert.deepEqual(await health.json(), { ready: false });
  assert.match(health.headers.get('cache-control'), /no-store/);
  const page = await request('/s/demo');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(!html.includes(fixture.SUPABASE_SERVICE_ROLE_KEY) && !html.includes(fixture.SHARE_TOKEN_SECRET), 'Private runtime values stay out of rendered pages');
  const script = html.match(/src="([^"]+\.js[^"]*)"/);
  assert(script, 'Standalone HTML references a script');
  const chunk = new URL(script[1].replaceAll('&amp;', '&'), base);
  assert.equal(chunk.origin, base, 'The asset smoke never fetches an external origin');
  assert.equal((await request(chunk.href)).status, 200, 'Standalone static chunks are included');
  assert.equal((await request('/demo/morning-hidden.png')).status, 200, 'Public demo fixtures are included');
  assert.equal(docker(['exec', container, 'id', '-u']), '1000', 'Server runs as the unprivileged node user');
  const inspectFiles = "const fs=require('node:fs');function scan(p){for(const f of fs.readdirSync(p,{withFileTypes:true})){if(f.name==='.env'||f.name.startsWith('.env.'))process.exit(1);if(f.isDirectory())scan(p+'/'+f.name)}}scan('/app')";
  docker(['exec', container, 'node', '-e', inspectFiles]);
  let memory = 'peak memory unavailable';
  try {
    const bytes = Number(docker(['exec', container, 'cat', '/sys/fs/cgroup/memory.peak']));
    if (Number.isSafeInteger(bytes) && bytes > 0) memory = `cgroup peak ${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  } catch { /* Older cgroups may not expose a peak counter. */ }
  console.log(`Container smoke passed (${profile}, ${free ? '512 MiB / 0.1 CPU' : '2 GiB / 1 CPU'}, ${memory}, cold public readiness ${coldReadyMs} ms): fail-closed startup/readiness, standalone page/chunks/fixtures, non-root user and no env files. No upload/transcoding workload was exercised.`);
} finally {
  if (container) {
    try { docker(['stop', '--timeout', '10', container]); }
    catch (error) {
      if (!error.stderr?.toString().includes('No such container')) {
        console.error('Container cleanup failed. Stop the test container manually.');
        process.exitCode = 1;
      }
    }
  }
}
