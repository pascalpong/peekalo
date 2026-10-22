import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const root = fileURLToPath(new URL('../', import.meta.url));
if (!['web', 'mobile'].includes(mode)) throw new Error('Choose web or mobile');
// Metro receives only a public API origin. Never load server credentials there.
const env = { ...process.env };
const args = mode === 'web'
  ? ['--filter', '@peekalo/web', 'exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', '3101']
  : ['--filter', '@peekalo/mobile', 'start', '--port', '8082', ...process.argv.slice(3)];
if (mode === 'web') {
  const local = parseEnv(await readFile(new URL('../apps/web/.env.local-testing', import.meta.url), 'utf8'));
  if (local.SUPABASE_URL !== 'http://127.0.0.1:55321' || local.PUBLIC_APP_URL !== 'http://127.0.0.1:3101') throw new Error('Run pnpm local:setup first');
  Object.assign(env, local);
} else {
  for (const key of Object.keys(env)) if (key.startsWith('SUPABASE_') || key === 'SHARE_TOKEN_SECRET') delete env[key];
  env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:3101';
}
const child = spawn('pnpm', args, { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Local app could not start. Check the local setup and ports.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
