import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateHostingEnvironment } from './check-hosting-runtime.mjs';

// Synthetic values only: this suite never reads application env files or calls Supabase.
const fixture = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'test-public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  SHARE_TOKEN_SECRET: 'synthetic-test-secret-at-least-32-characters',
  PUBLIC_APP_URL: 'https://peekalo.example',
};

test('valid HTTPS configuration and explicit loopback origins', () => {
  assert.deepEqual(validateHostingEnvironment(fixture), { supabaseUrl: fixture.SUPABASE_URL, appUrl: fixture.PUBLIC_APP_URL });
  for (const url of ['http://127.0.0.1:4000', 'http://localhost:3000', 'http://[::1]:4000', 'https://peekalo.example/']) {
    assert.equal(validateHostingEnvironment({ ...fixture, PUBLIC_APP_URL: url }).appUrl, new URL(url).origin);
  }
});

test('every required value must be present and secret must be long enough', () => {
  for (const key of Object.keys(fixture)) {
    for (const value of [undefined, '', ' ']) assert.throws(() => validateHostingEnvironment({ ...fixture, [key]: value }));
  }
  assert.throws(() => validateHostingEnvironment({ ...fixture, SHARE_TOKEN_SECRET: 'x'.repeat(31) }));
  validateHostingEnvironment({ ...fixture, SHARE_TOKEN_SECRET: 'x'.repeat(32) });
});

test('rejects unsafe, ambiguous or non-origin app URLs', () => {
  for (const url of ['http://peekalo.example', 'http://127.0.0.1.evil.example', 'ftp://localhost', 'not-a-url',
    'https://user:password@peekalo.example', 'https://peekalo.example/path', 'https://peekalo.example/?secret=value',
    'https://peekalo.example/#secret', 'https://peekalo.example/?', 'https://peekalo.example/#',
    'https://peekalo.example/a/..', 'https:peekalo.example', ' https://peekalo.example', 'https:\\peekalo.example']) {
    assert.throws(() => validateHostingEnvironment({ ...fixture, PUBLIC_APP_URL: url }));
  }
  for (const url of ['http://localhost:54321', 'not-a-url', 'https://user:password@project.supabase.co', 'https://project.supabase.co/rest/v1']) {
    assert.throws(() => validateHostingEnvironment({ ...fixture, SUPABASE_URL: url }));
  }
});

// D-25 fixes admission at three in SQL; retired env overrides have no effect.

test('CLI failures expose no configuration values or dependency stderr', () => {
  const script = fileURLToPath(new URL('./check-hosting-runtime.mjs', import.meta.url));
  for (const override of [{ PUBLIC_APP_URL: 'https://user:private-sentinel@peekalo.example' }, { FFMPEG_PATH: '/missing/private-sentinel/ffmpeg' }]) {
    const result = spawnSync(process.execPath, [script], { env: { ...fixture, ...override }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Peekalo hosting preflight failed. Check server configuration and runtime dependencies.\n');
  }
});
