import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../apps/mobile/app.config.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const base = JSON.parse(readFileSync(new URL('../apps/mobile/app.json', import.meta.url), 'utf8')).expo;
// Pure synthetic inputs: neither ownership nor DNS/hosting is checked or claimed.
const fixture = {
  PEEKALO_BUILD_PROFILE: 'store', EXPO_NO_DOTENV: '1',
  EXPO_PUBLIC_API_URL: 'https://app.samplehost.com', EXPO_PUBLIC_AUTH_LINK_ORIGIN: 'https://app.samplehost.com',
  PEEKALO_IOS_BUNDLE_ID: 'com.samplehost.peekalo', PEEKALO_ANDROID_PACKAGE: 'com.samplehost.peekalo',
  PEEKALO_RELEASE_VERSION: '1.0.0', PEEKALO_IOS_BUILD_NUMBER: '2', PEEKALO_ANDROID_VERSION_CODE: '3',
};
function configure(env, config = base) {
  const api = {};
  vm.runInNewContext(source, { exports: api, process: { env }, URL });
  return api.default({ config });
}
const plain = value => JSON.parse(JSON.stringify(value));

test('development config preserves identity and defaults, while mistyped release selectors fail', () => {
  assert.equal(configure({}), base);
  assert.throws(() => configure({ PEEKALO_BUILD_PROFILE: 'production' }), /Unknown PEEKALO_BUILD_PROFILE/);
});

test('store inputs fail closed when any required identity/version/origin is absent', () => {
  for (const key of Object.keys(fixture).filter(key => key !== 'PEEKALO_BUILD_PROFILE')) {
    const env = { ...fixture }; delete env[key];
    assert.throws(() => configure(env), /Store configuration requires valid/);
  }
});

test('placeholder, development, credential-bearing and divergent origins never enter store config', () => {
  for (const value of ['https://rel07-api.invalid', 'https://app.example.com', 'https://app.example', 'https://app.test',
    'https://dev.samplehost.com', 'https://qa.samplehost.com', 'https://staging.samplehost.com', 'https://127.0.0.1',
    'http://app.samplehost.com', 'https://app.samplehost.com/path', 'https://private:secret@app.samplehost.com',
    'https://app.samplehost.com?secret=sensitive-fixture', 'https://other.samplehost.com']) {
    assert.throws(() => configure({ ...fixture, EXPO_PUBLIC_API_URL: value }), error =>
      /Store configuration requires valid/.test(error.message) && !error.message.includes(value) && !error.message.includes('sensitive-fixture'));
  }
});

test('preview/QA identifiers, invalid build numbers and env overrides fail without leaking inputs', () => {
  const cases = [
    ['PEEKALO_IOS_BUNDLE_ID', 'com.peekalo.preview'], ['PEEKALO_ANDROID_PACKAGE', 'com.peekalo.privacyqa'],
    ['PEEKALO_ANDROID_PACKAGE', 'com.samplehost.'], ['PEEKALO_IOS_BUNDLE_ID', 'secret-content'],
    ['PEEKALO_IOS_BUILD_NUMBER', '0'], ['PEEKALO_IOS_BUILD_NUMBER', '10000'],
    ['PEEKALO_ANDROID_VERSION_CODE', '1.5'], ['PEEKALO_ANDROID_VERSION_CODE', '2100000001'],
    ['PEEKALO_ANDROID_VERSION_CODE', '01'], ['PEEKALO_RELEASE_VERSION', '1.0.0-beta'],
    ['EXPO_NO_DOTENV', '0'], ['EXPO_NO_CLIENT_ENV_VARS', '1'], ['EXPO_PUBLIC_PEEKALO_LOCAL_TESTING', 'false'], ['EXPO_PUBLIC_PEEKALO_SIMULATOR_FIXTURES', 'true'],
  ];
  for (const [key, value] of cases) assert.throws(() => configure({ ...fixture, [key]: value }), /Store configuration requires valid/);
});

test('explicit store config preserves guards, camera permissions and original dev identity without mutation', () => {
  const before = globalThis.structuredClone(base);
  const result = plain(configure(fixture));
  assert.equal(result.version, '1.0.0'); assert.equal(result.ios.buildNumber, '2');
  assert.equal(result.android.versionCode, 3); assert.equal(result.android.package, fixture.PEEKALO_ANDROID_PACKAGE);
  assert.equal(result.ios.bundleIdentifier, fixture.PEEKALO_IOS_BUNDLE_ID);
  assert.equal(result.scheme, base.scheme); assert.equal(result.ios.usesAppleSignIn, true);
  assert(result.plugins.includes('./plugins/withAndroidSecureWindow.cjs'));
  assert.deepEqual(result.plugins.find(p => Array.isArray(p) && p[0] === 'expo-camera'), base.plugins.find(p => Array.isArray(p) && p[0] === 'expo-camera'));
  assert.equal(result.plugins.find(p => Array.isArray(p) && p[0] === 'expo-secure-store')[1].faceIDPermission, false);
  const properties = result.plugins.find(p => Array.isArray(p) && p[0] === 'expo-build-properties')[1];
  assert.equal(properties.ios.buildReactNativeFromSource, true);
  assert.equal(properties.android.targetSdkVersion, 36); assert.equal(properties.android.usesCleartextTraffic, false);
  for (const permission of [...base.android.blockedPermissions, 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT', 'android.permission.VIBRATE']) assert(result.android.blockedPermissions.includes(permission));
  assert.deepEqual(base, before); assert.equal(configure({}), base);
});

test('store profile has no automatic submission or remote credential creation configuration', () => {
  const eas = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8'));
  assert.equal(eas.submit, undefined); assert.equal(eas.build.store.distribution, 'store');
  assert.equal(eas.build.store.credentialsSource, 'local'); assert.equal(eas.build.store.developmentClient, false);
  assert.equal(eas.build.store.android.buildType, 'app-bundle'); assert.equal(eas.build.store.ios.simulator, false);
});

test('draft listing respects store text field limits', () => {
  const listing = JSON.parse(readFileSync(new URL('../docs/store/listing.en.json', import.meta.url), 'utf8'));
  for (const [name, limit] of [['name', 30], ['appleSubtitle', 30], ['googleShortDescription', 80], ['description', 4000], ['appleKeywords', 100]]) {
    assert(listing[name].length <= limit, `${name} exceeds ${limit}`);
  }
});

test('pinned Expo native introspection removes development permissions/descriptions and preserves native privacy boundaries', () => {
  const mobile = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
  const cli = fileURLToPath(new URL('../apps/mobile/node_modules/expo/bin/cli', import.meta.url));
  const raw = execFileSync(process.execPath, [cli, 'config', '--type', 'introspect', '--json'], {
    cwd: mobile, env: { ...process.env, ...fixture }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  const config = JSON.parse(raw), { ios, android } = config._internal.modResults;
  const plist = ios.infoPlist;
  for (const key of ['NSFaceIDUsageDescription', 'NSBonjourServices', 'NSLocalNetworkUsageDescription', 'NSPhotoLibraryUsageDescription']) assert.equal(plist[key], undefined, key);
  assert.equal(plist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(plist.NSAppTransportSecurity.NSAllowsLocalNetworking, false);
  assert(plist.NSCameraUsageDescription); assert(plist.NSMicrophoneUsageDescription);
  assert.deepEqual(ios.entitlements['com.apple.developer.applesignin'], ['Default']);
  assert.deepEqual(ios.entitlements['com.apple.developer.associated-domains'], ['applinks:app.samplehost.com']);
  const permissions = android.manifest.manifest['uses-permission'].map(p => p.$);
  for (const permission of config.android.blockedPermissions) assert(permissions.some(p => p['android:name'] === permission && p['tools:node'] === 'remove'), permission);
  for (const permission of ['CAMERA', 'RECORD_AUDIO']) assert(permissions.some(p => p['android:name'] === `android.permission.${permission}` && p['tools:node'] !== 'remove'));
  for (const key of ['android.compileSdkVersion', 'android.targetSdkVersion']) assert(android.gradleProperties.some(p => p.key === key && p.value === '36'));
});
