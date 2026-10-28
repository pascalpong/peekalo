import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/app/_layout.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function harness(platform = 'android') {
  const hooks = [], effects = [], requests = [];
  let cursor = 0, tree, component;
  const jsx = (type, props) => ({ type, props });
  const render = () => { cursor = 0; tree = component(); while (effects.length) effects.shift()(); };
  const acquire = () => new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; queueMicrotask(render); }];
    },
    useEffect(fn, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((v, n) => !Object.is(v, old[n]))) { hooks[i] = deps; effects.push(fn); }
    },
  };
  const Stack = Object.assign('Stack', { Screen: 'Screen' });
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'expo-font': { useFonts: () => [true, null] },
    'expo-router': { Stack }, 'expo-status-bar': { StatusBar: 'StatusBar' },
    '../lib/android-window-protection': { acquireAndroidWindowProtection: acquire },
    'react-native': { Platform: { OS: platform }, View: 'View', Text: 'Text', Pressable: 'Pressable' },
    '../components/ui': { colors: {}, tokens: { font: { display: 'display' } } },
    '@peekalo/design/fonts/display.ttf': 1,
  };
  const context = { exports: {}, require: name => { assert(name in mocks, name); return mocks[name]; } };
  vm.runInNewContext(source, context);
  component = context.exports.default; render();
  const find = (node, type) => {
    if (Array.isArray(node)) return node.map(n => find(n, type)).find(Boolean);
    if (!node || typeof node !== 'object') return null;
    return node.type === type ? node : find(node.props?.children, type);
  };
  return { requests, hasNavigator: () => !!find(tree, Stack), retry: () => find(tree, 'Pressable')?.props.onPress() };
}

test('Android navigator cannot mount before native protection acquisition completes', async () => {
  const h = harness(); assert.equal(h.hasNavigator(), false); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(); await flush(); assert.equal(h.hasNavigator(), true);
});
test('Android protection failure remains closed until a successful explicit retry', async () => {
  const h = harness(); h.requests[0].reject(new Error('native unavailable')); await flush();
  assert.equal(h.hasNavigator(), false); h.retry(); await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.hasNavigator(), false);
  h.requests[1].resolve(); await flush(); assert.equal(h.hasNavigator(), true);
});
test('iOS retains its existing per-view protection without Android startup acquisition', () => {
  const h = harness('ios'); assert.equal(h.requests.length, 0); assert.equal(h.hasNavigator(), true);
});
