import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../apps/web/lib/auth-return.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
vm.runInNewContext(source, { exports: api, URL });
test('email web fallback transfers only PKCE code and flow ID to the matching native action', () => {
  for (const [kind, path, host] of [['confirmation', 'confirm', 'confirm-email'], ['recovery', 'reset-password', 'reset-password']]) {
    const result = new URL(api.nativeEmailReturn(`https://app.example.invalid/auth/${path}?code=fixture-code&sb_flow_id=flow-fixture`, kind));
    assert.equal(result.protocol, 'peekalo:');
    assert.equal(result.host, host);
    assert.equal(result.searchParams.get('code'), 'fixture-code');
    assert.equal(result.searchParams.get('sb_flow_id'), 'flow-fixture');
    assert.equal([...result.searchParams].length, 2);
  }
});
test('email web fallback rejects token/error/duplicate/malformed/wrong-action/redirect inputs', () => {
  for (const input of ['?code=a&code=b', '?code=a&access_token=secret', '?code=a&refresh_token=secret', '?error=denied', '?code=a&sb_flow_id=x&sb_flow_id=y', '?code=a&next=peekalo://evil', '?code=a#secret', '?code=%0A']) {
    assert.equal(api.nativeEmailReturn(`https://app.example.invalid/auth/confirm${input}`, 'confirmation'), null);
  }
  for (const input of ['https://app.example.invalid/auth/confirm/extra?code=a', 'https://app.example.invalid/auth/reset-password?code=a', 'javascript:alert(1)', 'peekalo://confirm-email?code=a', 'https://user:pass@app.example.invalid/auth/confirm?code=a']) {
    assert.equal(api.nativeEmailReturn(input, 'confirmation'), null);
  }
});

test('web return keeps its consumed callback through React effect replay without rendering the code', () => {
  const component = ts.transpileModule(readFileSync(new URL('../apps/web/components/auth-return.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const hooks = [];
  let cursor = 0, effect, replacements = 0;
  const window = { location: { href: 'https://app.example.invalid/auth/confirm?code=public-fixture-code', pathname: '/auth/confirm' },
    history: { replaceState(_state, _title, path) { replacements++; window.location.href = `https://app.example.invalid${path}`; } } };
  const React = {
    useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = value; return [hooks[index], next => { hooks[index] = next; }]; },
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useEffect(callback) { effect = callback; },
  };
  const exported = {};
  vm.runInNewContext(component, { exports: exported, window, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === '../lib/auth-return') return api;
    throw new Error(`Unexpected module ${name}`);
  } });
  const render = () => { cursor = 0; return exported.AuthReturn({ kind: 'confirmation' }); };
  render(); effect(); render(); effect(); const tree = JSON.stringify(render());
  assert(tree.includes('Open Peekalo'));
  assert(!tree.includes('expired or unavailable'));
  assert(!tree.includes('public-fixture-code'));
  assert.equal(replacements, 1);
  assert.equal(window.location.href, 'https://app.example.invalid/auth/confirm');
});
