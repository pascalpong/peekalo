import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const execute = promisify(execFile);
const failure = 'Peekalo hosting preflight failed. Check server configuration and runtime dependencies.';

function origin(value, allowLoopback = false) {
  if (typeof value !== 'string' || !/^[a-z][a-z\d+.-]*:\/\/[^/?#]+\/?$/i.test(value) || /[\s\\]/.test(value)) throw new Error(failure);
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:'))) throw new Error(failure);
  return url.origin;
}

export function validateHostingEnvironment(env) {
  try {
    const supabaseUrl = origin(env.SUPABASE_URL);
    const appUrl = origin(env.PUBLIC_APP_URL, true);
    if (typeof env.SUPABASE_ANON_KEY !== 'string' || !env.SUPABASE_ANON_KEY.trim() ||
        typeof env.SUPABASE_SERVICE_ROLE_KEY !== 'string' || !env.SUPABASE_SERVICE_ROLE_KEY.trim() ||
        typeof env.SHARE_TOKEN_SECRET !== 'string' || env.SHARE_TOKEN_SECRET.trim().length < 32) throw new Error(failure);
    if (env.PEEKALO_ACTIVE_POST_LIMIT !== undefined && !/^[1-9]\d?$/.test(env.PEEKALO_ACTIVE_POST_LIMIT)) throw new Error(failure);
    return { supabaseUrl, appUrl };
  } catch { throw new Error(failure); }
}

export async function checkHostingRuntime(env = process.env) {
  let directory;
  let failed = false;
  try {
    validateHostingEnvironment(env);
    const sharp = require('sharp');
    const photo = await sharp({ create: { width: 9, height: 16, channels: 3, background: '#607050' } }).jpeg().toBuffer();
    const metadata = await sharp(photo).metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== 9 || metadata.height !== 16) throw new Error(failure);

    const options = { timeout: 10_000, maxBuffer: 1024 * 1024 };
    const { stdout: encoders } = await execute(env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-encoders'], options);
    if (!/^\s*V\S*\s+libx264\s/m.test(encoders) || !/^\s*A\S*\s+aac\s/m.test(encoders)) throw new Error(failure);
    const { stdout: probe } = await execute(env.FFPROBE_PATH || 'ffprobe', ['-version'], options);
    if (!probe.startsWith('ffprobe version ')) throw new Error(failure);

    directory = await mkdtemp(path.join(tmpdir(), 'peekalo-preflight-'));
    const file = path.join(directory, 'fixture');
    await writeFile(file, photo, { flag: 'wx', mode: 0o600 });
    if (((await stat(directory)).mode & 0o777) !== 0o700 || ((await stat(file)).mode & 0o777) !== 0o600 ||
        !(await readFile(file)).equals(photo)) throw new Error(failure);
  } catch { failed = true; }
  if (directory) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { failed = true; }
  }
  if (failed) throw new Error(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkHostingRuntime();
    console.log('Peekalo hosting preflight passed.');
  } catch {
    console.error(failure);
    process.exitCode = 1;
  }
}
