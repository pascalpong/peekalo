// Run after `docker build -f apps/site/Dockerfile -t peekalo-site:local .`.
// All configuration is synthetic; requests stay on the local published port.
// Opt in to the free-resource smoke with PEEKALO_TEST_PROFILE=free.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const image = process.env.PEEKALO_TEST_IMAGE || 'peekalo-site:local';
const profile = process.env.PEEKALO_TEST_PROFILE || 'default';
assert(['default', 'free'].includes(profile), 'PEEKALO_TEST_PROFILE must be default or free');
const free = profile === 'free';
const resources = [`--memory=${free ? '512m' : '1g'}`, `--cpus=${free ? '0.1' : '1'}`];
const startupTimeoutMs = free ? 180_000 : 60_000;
const requestTimeoutMs = free ? 20_000 : 5_000;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: free ? 60_000 : 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const platform = docker(['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image]);
const fixture = { PUBLIC_SITE_URL: 'https://site.invalid', PUBLIC_APP_URL: 'https://app.invalid', WAITLIST_ENABLED: 'false' };
let container;
try {
  const env = Object.entries(fixture).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  container = docker(['run', '--platform', platform, '--rm', '-d', ...resources,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777', '-p', '127.0.0.1::3000', ...env, image]);
  const port = docker(['port', container, '3000/tcp']).split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  const request = (path, init = {}) => fetch(new URL(path, base), { ...init, redirect: 'manual', signal: AbortSignal.timeout(requestTimeoutMs) });
  let health;
  const startupDeadline = Date.now() + startupTimeoutMs;
  while (Date.now() < startupDeadline) {
    try { health = await request('/api/health'); if (health.ok) break; }
    catch { /* Standalone startup is asynchronous. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(health?.status, 200, 'Marketing starts without database credentials or backend access');
  assert.deepEqual(await health.json(), { ok: true, service: 'peekalo-site' });
  assert.match(health.headers.get('cache-control'), /no-store/);

  const page = await request('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes('A little') && html.includes('Open web app'), 'Marketing renders with its configured product link');
  assert(html.includes(fixture.PUBLIC_APP_URL), 'Product navigation uses the configured public origin');
  const script = html.match(/src="([^"]+\.js[^"]*)"/);
  assert(script, 'Marketing HTML references a standalone script');
  const chunk = new URL(script[1].replaceAll('&amp;', '&'), base);
  assert.equal(chunk.origin, base, 'The asset smoke never fetches an external origin');
  assert.equal((await request(chunk.href)).status, 200, 'Standalone static chunks are included');
  for (const path of ['/marketing/a-little-mystery-poster.webp', '/marketing/little-moment.webp', '/previews/green.svg']) {
    assert.equal((await request(path)).status, 200, `Public marketing asset is packaged: ${path}`);
  }
  const video = await request('/marketing/a-little-mystery.mp4', { headers: { Range: 'bytes=0-31' } });
  assert.equal(video.status, 206, 'The standalone hero video supports byte ranges');
  assert.equal((await video.arrayBuffer()).byteLength, 32);

  for (const path of ['/private', '/api/shares/config', '/api/inbox', '/api/profile']) {
    assert.equal((await request(path)).status, 404, `Product/private route is absent: ${path}`);
  }
  const waitlist = await request('/api/waitlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.PUBLIC_SITE_URL }, body: '{}',
  });
  assert.equal(waitlist.status, 503, 'Waitlist collection stays closed');
  assert.deepEqual(await waitlist.json(), { error: 'waitlist_unavailable' });
  for (const path of ['/s/view', '/u/demo']) {
    const response = await request(path);
    assert.equal(response.status, 307, 'Legacy paths redirect without accessing the product backend');
    assert.equal(response.headers.get('location'), `${fixture.PUBLIC_APP_URL}${path}`);
    assert.equal(new URL(response.headers.get('location')).hash, '', 'Redirect locations preserve browser fragment inheritance');
  }

  assert.equal(docker(['exec', container, 'id', '-u']), '1000', 'Marketing runs as the unprivileged node user');
  const inspectFiles = "const fs=require('node:fs');function scan(p){for(const f of fs.readdirSync(p,{withFileTypes:true})){if(f.name==='.env'||f.name.startsWith('.env.'))process.exit(1);if(f.isDirectory())scan(p+'/'+f.name)}}scan('/app')";
  docker(['exec', container, 'node', '-e', inspectFiles]);
  let memory = 'peak memory unavailable';
  try {
    const bytes = Number(docker(['exec', container, 'cat', '/sys/fs/cgroup/memory.peak']));
    if (Number.isSafeInteger(bytes) && bytes > 0) memory = `cgroup peak ${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  } catch { /* Older cgroups may not expose a peak counter. */ }
  console.log(`Site container smoke passed (${profile}, ${free ? '512 MiB / 0.1 CPU' : '1 GiB / 1 CPU'}, ${memory}): standalone marketing/health/chunks/assets, product isolation, closed waitlist, compatibility redirects, non-root and no env files.`);
} finally {
  if (container) {
    try { docker(['stop', '--timeout', '10', container]); }
    catch (error) {
      if (!error.stderr?.toString().includes('No such container')) {
        console.error('Site container cleanup failed. Stop the test container manually.');
        process.exitCode = 1;
      }
    }
  }
}
