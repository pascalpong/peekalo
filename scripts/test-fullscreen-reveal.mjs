import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Run the shared component's actual layout effect, portal and event handlers.
// Browser adapters expose viewport changes without any real links or media.
const source = ts.transpileModule(await readFile(new URL('../packages/web-ui/src/fullscreen-reveal.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
class BrowserWindow extends globalThis.EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) {
    const records = this.listeners.get(type) ?? new Map();
    records.set(listener, options);
    this.listeners.set(type, records);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
}
function harness(t, { width = 400, height = 800, clientWidth = width, orientation = 'portrait-primary', overflow = 'auto', padding = '7px' } = {}) {
  const window = new BrowserWindow();
  Object.assign(window, { innerWidth: width, innerHeight: height, screen: { orientation: { type: orientation } } });
  const root = { style: { overflow, paddingRight: padding }, clientWidth };
  const document = { documentElement: root, body: {} };
  const effects = [];
  const cleanups = [];
  let dismissed = 0;
  const imports = {
    react: { useLayoutEffect: effect => effects.push(effect) },
    'react-dom': { createPortal: (child, container) => ({ child, container }) },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    './fullscreen-reveal.module.css': { default: {} },
    './brand-logo': { BrandLogo: () => {} },
  };
  const exported = {};
  vm.runInNewContext(source, {
    exports: exported,
    require: name => { assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; },
    window, document, screen: window.screen,
    getComputedStyle: element => ({ paddingRight: element.style.paddingRight }),
  });
  const portal = exported.FullscreenReveal({ children: 'non-sensitive fixture', seconds: '8.0', onDismiss: () => dismissed++ });
  for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  const cleanup = () => { for (const stop of cleanups.splice(0)) stop(); };
  t.after(cleanup);
  const dispatch = (type, extra = {}) => {
    const event = Object.assign(new globalThis.Event(type, { cancelable: true }), extra);
    window.dispatchEvent(event);
    return event;
  };
  return {
    window, root, portal, document, cleanup, dispatch,
    dismissed: () => dismissed,
    resize({ width, height, orientation } = {}) {
      if (width !== undefined) window.innerWidth = width;
      if (height !== undefined) window.innerHeight = height;
      if (orientation !== undefined) window.screen.orientation.type = orientation;
      dispatch('resize');
    },
  };
}

test('unchanged and height-only Android browser chrome resizes keep an active reveal visible', t => {
  const h = harness(t, { width: 384, height: 724 });
  // Exact physical Chrome regression: resize fires twice at overlay mount
  // without changing width, height or orientation.
  h.resize({ width: 384, height: 724, orientation: 'portrait-primary' });
  h.resize({ width: 384, height: 724, orientation: 'portrait-primary' });
  assert.equal(h.dismissed(), 0, 'Same-dimension mount resizes must preserve the active hold');
  h.resize({ height: 744 });
  h.resize({ height: 800 });
  assert.equal(h.dismissed(), 0, 'Browser toolbar height changes must not immediately dismiss the overlay');
  assert.equal(h.root.style.overflow, 'hidden');
});

test('a width resize dismisses the reveal', t => {
  const h = harness(t);
  h.resize({ width: 500 });
  assert.equal(h.dismissed(), 1);
});

test('orientation changes detected during resize dismiss even when width is unchanged', t => {
  const h = harness(t);
  h.resize({ orientation: 'portrait-secondary' });
  assert.equal(h.dismissed(), 1);
});

test('an explicit orientationchange event dismisses even before viewport dimensions update', t => {
  const h = harness(t);
  h.dispatch('orientationchange');
  assert.equal(h.dismissed(), 1);
});

test('Escape and navigation keys dismiss while an ordinary character leaves the hold active', t => {
  const h = harness(t);
  h.dispatch('keydown', { key: 'a' });
  assert.equal(h.dismissed(), 0);
  for (const key of ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) h.dispatch('keydown', { key });
  assert.equal(h.dismissed(), 8);
});

test('wheel and touch scrolling are actively prevented while the overlay is mounted', t => {
  const h = harness(t);
  for (const type of ['wheel', 'touchmove']) {
    const registered = [...h.window.listeners.get(type).values()];
    assert.equal(registered.length, 1);
    assert.equal(registered[0].passive, false);
    assert(h.dispatch(type).defaultPrevented);
  }
});

test('cleanup restores root styles and removes all handlers including viewport listeners', t => {
  const h = harness(t, { width: 400, clientWidth: 385, overflow: 'scroll', padding: '7px' });
  assert.equal(h.root.style.overflow, 'hidden');
  assert.equal(h.root.style.paddingRight, '22px');
  h.cleanup();
  assert.equal(h.root.style.overflow, 'scroll');
  assert.equal(h.root.style.paddingRight, '7px');
  assert([...h.window.listeners.values()].every(listeners => listeners.size === 0));
  h.resize({ width: 500, orientation: 'landscape-primary' });
  h.dispatch('orientationchange');
  h.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.dismissed(), 0);
  assert(!h.dispatch('wheel').defaultPrevented);
  assert(!h.dispatch('touchmove').defaultPrevented);
});

test('the portal uses the document body and an explicit new pointer dismisses immediately', t => {
  const h = harness(t);
  assert.equal(h.portal.container, h.document.body);
  let prevented = 0;
  h.portal.child.props.onContextMenu({ preventDefault: () => prevented++ });
  assert.equal(h.dismissed(), 0);
  h.portal.child.props.onPointerDown({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.equal(h.dismissed(), 1);
});
