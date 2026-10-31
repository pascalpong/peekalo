import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ask the actual pinned Expo config resolver; never print its full result,
// environment, child output or exception (which may contain private values).
try {
  const mobile = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
  const cli = fileURLToPath(new URL('../apps/mobile/node_modules/expo/bin/cli', import.meta.url));
  const raw = execFileSync(process.execPath, [cli, 'config', '--json'], {
    cwd: mobile, env: { ...process.env, EXPO_NO_DOTENV: '1', PEEKALO_BUILD_PROFILE: 'store' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  const config = JSON.parse(raw);
  console.log(JSON.stringify({
    status: 'build-inputs-valid-only', submission: 'BLOCKED: consult all REL-01–08 gates in docs/BUILD_BOARD.md',
    version: config.version, ios: { bundleIdentifier: config.ios.bundleIdentifier, buildNumber: config.ios.buildNumber },
    android: { package: config.android.package, versionCode: config.android.versionCode },
  }, null, 2));
} catch {
  console.error('Store build inputs are incomplete or invalid. See docs/STORE_SUBMISSION.md; existing preview settings were not changed.');
  process.exitCode = 1;
}
