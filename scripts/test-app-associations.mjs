import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../apps/web/lib/server/app-associations.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness(env = {}) {
  const api = {};
  vm.runInNewContext(source, { exports: api, process: { env }, URL, Response: globalThis.Response });
  return api;
}
const fingerprint = Array(32).fill('AB').join(':');
const fixture = () => ({ AUTH_LINK_ORIGIN: 'https://app.peekalo.example', PUBLIC_APP_URL: 'https://app.peekalo.example',
  APPLE_APP_ID: 'ABCDE12345.com.peekalo.release', ANDROID_APP_ID: 'com.peekalo.release', ANDROID_SHA256_CERT_FINGERPRINTS: fingerprint });
const plain = value => JSON.parse(JSON.stringify(value));

test('no guessed origin or signing identity produces an association', async () => {
  for (const kind of ['apple', 'android']) {
    const api = harness();
    assert.equal(api.appAssociation(kind), null);
    const response = api.appAssociationResponse(kind);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { available: false });
    assert.equal(response.headers.has('set-cookie'), false);
  }
});

test('association host must be an explicit exact HTTPS product origin', () => {
  const api = harness();
  for (const value of [undefined, '', ' ', 'http://app.peekalo.example', 'https://127.0.0.1', 'https://localhost',
    'https://app.peekalo.example:8443', 'https://user:private@app.peekalo.example', 'https://app.peekalo.example/path',
    'https://app.peekalo.example?private=value', 'https://app.peekalo.example#private', 'https://*.peekalo.example',
    'https://app.peekalo.example.', 'https://evil.example']) {
    for (const kind of ['apple', 'android']) assert.equal(api.appAssociation(kind, { ...fixture(), AUTH_LINK_ORIGIN: value }), null);
  }
  assert.ok(api.appAssociation('apple', { ...fixture(), AUTH_LINK_ORIGIN: `${fixture().AUTH_LINK_ORIGIN}/` }));
  assert.equal(api.appAssociation('apple', { ...fixture(), PUBLIC_APP_URL: 'https://other.peekalo.example' }), null);
});

test('Apple association includes only the two exact auth callback paths', async () => {
  const api = harness(fixture());
  const response = api.appAssociationResponse('apple');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { applinks: { apps: [], details: [{ appIDs: ['ABCDE12345.com.peekalo.release'],
    components: [{ '/': '/auth/confirm' }, { '/': '/auth/reset-password' }] }] } });
  for (const value of ['', 'TEAM.com.peekalo.release', 'ABCDE12345.com.peekalo.*', 'ABCDE12345.com.peekalo/release',
    'ABCDE12345.com..release', `ABCDE12345.${'a'.repeat(256)}`]) {
    assert.equal(api.appAssociation('apple', { ...fixture(), APPLE_APP_ID: value }), null);
  }
});

test('Android association validates explicit package and complete certificate fingerprints', async () => {
  const env = { ...fixture(), ANDROID_SHA256_CERT_FINGERPRINTS: `${fingerprint.toLowerCase()}, ${fingerprint}` };
  const api = harness(env);
  const response = api.appAssociationResponse('android');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'com.peekalo.release', sha256_cert_fingerprints: [fingerprint],
  } }]);
  for (const value of ['', 'AB:CD', fingerprint.replaceAll(':', ''), `${fingerprint},`, `${fingerprint},bad`, Array(9).fill(fingerprint).join(',')]) {
    assert.equal(api.appAssociation('android', { ...fixture(), ANDROID_SHA256_CERT_FINGERPRINTS: value }), null);
  }
  for (const value of ['', 'peekalo', 'com.peekalo-release', 'com.1release', 'com..release', 'com.peekalo.*']) {
    assert.equal(api.appAssociation('android', { ...fixture(), ANDROID_APP_ID: value }), null);
  }
});

test('one unconfigured platform does not fabricate or disable the other platform identity', () => {
  const api = harness();
  const env = { ...fixture(), APPLE_APP_ID: undefined };
  assert.equal(api.appAssociation('apple', env), null);
  assert.ok(api.appAssociation('android', env));
  assert.deepEqual(plain(api.appAssociation('apple', { ...fixture(), ANDROID_APP_ID: undefined })),
    plain(api.appAssociation('apple', fixture())));
});
