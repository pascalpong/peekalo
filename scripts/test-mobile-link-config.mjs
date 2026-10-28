import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../apps/mobile/app.config.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const base = JSON.parse(await readFile(new URL('../apps/mobile/app.json', import.meta.url), 'utf8')).expo;
function configure(env, config = base) {
  const api = {};
  vm.runInNewContext(source, { exports: api, process: { env }, URL });
  return api.default({ config });
}
const plain = value => JSON.parse(JSON.stringify(value));

test('unset auth origin preserves resolved app config including privacy plugins and permissions', () => {
  assert.equal(configure({}), base);
  assert.equal(configure({ EXPO_PUBLIC_API_URL: 'https://some-api.example' }), base);
});

test('invalid configured auth origin fails the build without exposing its contents', () => {
  for (const value of [' ', 'http://app.peekalo.example', 'https://127.0.0.1', 'https://localhost',
    'https://app.peekalo.example:8443', 'https://user:private@app.peekalo.example', 'https://app.peekalo.example/path',
    'https://app.peekalo.example?secret=value', 'https://app.peekalo.example#secret', 'https://*.peekalo.example',
    'https://app.peekalo.example.']) {
    assert.throws(() => configure({ EXPO_PUBLIC_AUTH_LINK_ORIGIN: value }), error =>
      error.message === 'EXPO_PUBLIC_AUTH_LINK_ORIGIN must be an exact HTTPS domain origin.');
  }
});

test('verified native links accept only exact confirmation and recovery HTTPS paths', () => {
  const before = globalThis.structuredClone(base);
  const result = configure({ EXPO_PUBLIC_AUTH_LINK_ORIGIN: 'https://app.peekalo.example/' });
  assert.deepEqual(plain(result.ios.associatedDomains), ['applinks:app.peekalo.example']);
  assert.deepEqual(plain(result.android.intentFilters), ['/auth/confirm', '/auth/reset-password'].map(path => ({
    action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'],
    data: [{ scheme: 'https', host: 'app.peekalo.example', path }],
  })));
  assert.equal(result.scheme, base.scheme);
  assert.deepEqual(plain(result.plugins), base.plugins);
  assert.deepEqual(plain(result.android.blockedPermissions), base.android.blockedPermissions);
  assert.equal(result.ios.bundleIdentifier, base.ios.bundleIdentifier);
  assert.equal(result.android.package, base.android.package);
  assert.deepEqual(base, before, 'Dynamic config must not mutate app.json/resolved base');
});

test('link configuration preserves independently configured platform settings', () => {
  const config = { ...base, ios: { ...base.ios, usesAppleSignIn: true, associatedDomains: ['webcredentials:other.example'] },
    android: { ...base.android, intentFilters: [{ action: 'custom.action' }] } };
  const result = configure({ EXPO_PUBLIC_AUTH_LINK_ORIGIN: 'https://app.peekalo.example' }, config);
  assert.equal(result.ios.usesAppleSignIn, true);
  assert.deepEqual(plain(result.ios.associatedDomains), ['webcredentials:other.example', 'applinks:app.peekalo.example']);
  assert.deepEqual(plain(result.android.intentFilters[0]), config.android.intentFilters[0]);
});
