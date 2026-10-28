import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const withAndroidSecureWindow = require('../plugins/withAndroidSecureWindow.cjs');
// Pinned Expo SDK 55 Kotlin onCreate body, independent of ignored native output.
const template = `package com.peekalo.preview

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;
const flag = 'window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)';
async function generate(contents = template, language = 'kt') {
  const config = withAndroidSecureWindow({ name: 'Peekalo', slug: 'peekalo' });
  const result = await config.mods.android.mainActivity({
    ...config,
    modResults: { path: '/unused/MainActivity.kt', language, contents },
    modRequest: { platform: 'android', modName: 'mainActivity' },
  });
  assert.equal(result.modResults.language, language);
  return result.modResults.contents;
}

test('protects before native creation and restores before and after native resume/focus callbacks', async () => {
  const output = await generate();
  const create = output.slice(output.indexOf('override fun onCreate'), output.indexOf('override fun onResume'));
  assert.ok(create.indexOf(flag) < create.indexOf('super.onCreate(null)'));
  assert.equal(create.split(flag).length - 1, 1);
  const resume = output.slice(output.indexOf('override fun onResume'), output.indexOf('override fun onWindowFocusChanged'));
  assert.ok(resume.indexOf(flag) < resume.indexOf('super.onResume()'));
  assert.ok(resume.lastIndexOf(flag) > resume.indexOf('super.onResume()'));
  const focus = output.slice(output.indexOf('override fun onWindowFocusChanged'), output.indexOf('override fun getMainComponentName'));
  assert.equal(focus.split('if (hasFocus)').length - 1, 2);
  assert.ok(focus.indexOf(flag) < focus.indexOf('super.onWindowFocusChanged(hasFocus)'));
  assert.ok(focus.lastIndexOf(flag) > focus.indexOf('super.onWindowFocusChanged(hasFocus)'));
  assert.equal(output.includes('clearFlags'), false);
  assert.ok(output.includes('override fun getMainComponentName(): String = "main"'));
});

test('running the actual Expo mod twice preserves identical protection without duplicate overrides', async () => {
  const first = await generate();
  assert.equal(await generate(first), first);
  assert.equal(first.match(/override fun onCreate/g)?.length, 1);
  assert.equal(first.match(/override fun onResume/g)?.length, 1);
  assert.equal(first.match(/override fun onWindowFocusChanged/g)?.length, 1);
});

test('preserves CRLF line endings and remains idempotent', async () => {
  const first = await generate(template.replace(/\n/g, '\r\n'));
  assert.equal(first.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(await generate(first), first);
});

test('rejects Java and unknown Kotlin templates instead of shipping unprotected', async () => {
  await assert.rejects(generate('public class MainActivity extends ReactActivity {}', 'java'), /unsupported MainActivity language/);
  for (const changed of [
    template.replace('MainActivity : ReactActivity()', 'MainActivity : OtherActivity()'),
    template.replace('super.onCreate(null)', 'super.onCreate(savedInstanceState)'),
    template.replace('setTheme(R.style.AppTheme);', 'setTheme(R.style.AppTheme)\n    anotherNativeStartup()'),
    template.replace('  override fun getMainComponentName()', '  override fun onCreate(other: Bundle?) {}\n  override fun getMainComponentName()'),
  ]) await assert.rejects(generate(changed), /review the Expo SDK 55 Kotlin MainActivity template/);
});

test('rejects existing lifecycle overrides rather than replacing custom behavior', async () => {
  for (const override of [
    'override fun onResume() { super.onResume() }',
    'override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus) }',
  ]) {
    const source = template.replace('  override fun getMainComponentName()', `  ${override}\n  override fun getMainComponentName()`);
    await assert.rejects(generate(source), /conflicting lifecycle override/);
  }
});

test('rejects incomplete, modified and duplicate generated guards', async () => {
  const first = await generate();
  for (const corrupted of [
    first.replace(flag, '// protection removed'),
    first.replace('    super.onResume()\n', '    super.onResume()\n    customResume()\n'),
    first.replace('  override fun getMainComponentName()', '  // Peekalo secure window: unknown fragment\n  override fun getMainComponentName()'),
    first.replace('  override fun getMainComponentName()', `  ${flag}\n  override fun getMainComponentName()`),
  ]) await assert.rejects(generate(corrupted), /generated protection|conflicting lifecycle/);
});

test('rejects independent secure-window mutations that could conflict with global protection', async () => {
  const source = template.replace('    super.onCreate(null)', '    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)\n    super.onCreate(null)');
  await assert.rejects(generate(source), /conflicting lifecycle/);
});
