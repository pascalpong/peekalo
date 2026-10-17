import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const [platform, ...args] = process.argv.slice(2);
if (platform !== 'ios' && platform !== 'android') throw new Error('Choose ios or android.');
const options = new Set(args.map(argument => argument.split('=')[0]));
const helpRequested = options.has('--help') || options.has('-h');

const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
const temporary = resolve(root, '.cache/native/tmp');
mkdirSync(temporary, { recursive: true });
env.TMPDIR = `${temporary}/`;
env.CP_HOME_DIR = resolve(root, '.cache/native/cocoapods-home');
env.CP_CACHE_DIR = resolve(root, '.cache/native/cocoapods-downloads');
env.CP_REPOS_DIR = resolve(env.CP_HOME_DIR, 'repos');
const localGems = resolve(root, '.cache/cocoapods');
// Optional local developer tooling; generated/cached tools never ship with the app.
if (platform === 'ios' && existsSync(resolve(localGems, 'bin/pod'))) {
  env.GEM_HOME = localGems;
  env.GEM_PATH = localGems;
  env.PATH = `${resolve(localGems, 'bin')}${delimiter}${env.PATH ?? ''}`;
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (command, parameters, cwd = root) => new Promise((accept, reject) => {
  const child = spawn(command, parameters, { cwd, env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code ?? 'a signal'}.`)));
});

try {
  if (platform === 'ios' && !options.has('--binary') && !helpRequested) {
    // The foundation runner targets Debug simulators. Keeping derived data beside
    // the checkout avoids filling the internal drive of external-volume projects.
    if (options.has('--configuration')) throw new Error('For release/device builds use the Expo CLI directly; pnpm ios targets Debug simulators.');
    await run(pnpm, ['--filter', '@peekalo/mobile', 'exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install']);
    await run('pod', ['install'], resolve(root, 'apps/mobile/ios'));
    env.RCT_NO_LAUNCH_PACKAGER = '1';
    env.SKIP_BUNDLING = '1';
    const derived = resolve(root, '.cache/native/xcode');
    await run('xcodebuild', [
      '-workspace', resolve(root, 'apps/mobile/ios/Peekalo.xcworkspace'),
      '-scheme', 'Peekalo', '-configuration', 'Debug', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived,
      'CODE_SIGNING_ALLOWED=NO', '-quiet', 'build',
    ]);
    args.unshift('--binary', resolve(derived, 'Build/Products/Debug-iphonesimulator/Peekalo.app'), '--no-install');
  }
  await run(pnpm, ['--filter', '@peekalo/mobile', 'exec', 'expo', `run:${platform}`, ...args]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
