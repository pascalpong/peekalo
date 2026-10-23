import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createPhotoSession } from '../src/lib/photo-session.ts';
import { createVideoSession } from '../src/lib/video-session.ts';

// Run the real screen/controllers with native adapters. Camera readiness and
// recording completions are deliberate events, never assumed from rendering.
const source = ts.transpileModule(readFileSync(new URL('../src/app/(tabs)/index.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return; }
  return predicate(node) ? node : find(node.props?.children, predicate);
};
function harness(t, { microphone = { granted: true, canAskAgain: true }, permissionResult = { granted: true, canAskAgain: true } } = {}) {
  const hooks = [], effects = new Map(), appListeners = new Set(), records = [], photos = [], deleted = [];
  const cameraPermission = { granted: true, canAskAgain: true };
  const getPermission = async () => cameraPermission;
  const jsx = (type, props, key) => ({ type, props, key });
  let cursor = 0, component, tree, mounted = true, scheduled = false, native = null;
  let cameraMounts = 0, cameraUnmounts = 0, stops = 0, micRequests = 0;
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => {
    if (!mounted || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (mounted) render(); });
  };
  const useEffect = (fn, deps) => {
    const index = cursor++, previous = hooks[index];
    if (!previous || !same(previous.deps, deps)) {
      hooks[index] = { deps, cleanup: previous?.cleanup };
      effects.set(index, fn);
    }
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { state: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].state, value => {
        if (!mounted) return;
        const next = typeof value === 'function' ? value(hooks[index].state) : value;
        if (!Object.is(next, hooks[index].state)) { hooks[index].state = next; schedule(); }
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useMemo(fn, deps) { const index = cursor++; if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { deps, value: fn() }; return hooks[index].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect,
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { cleanup: subscribe(schedule) };
      return getSnapshot();
    },
  };
  const AppState = { currentState: 'active', addEventListener: (_event, callback) => {
    appListeners.add(callback); return { remove: () => appListeners.delete(callback) };
  } };
  const render = () => {
    cursor = 0; tree = component();
    const camera = find(tree, node => node.type === 'CameraView');
    if (native && (!camera || camera.key !== native.key)) { cameraUnmounts++; native = null; }
    if (camera) {
      native ??= { key: camera.key, id: ++cameraMounts, recordAsync(options) {
        const pending = deferred(); records.push({ ...pending, options, nativeId: this.id }); return pending.promise;
      }, stopRecording() { stops++; }, takePictureAsync() {
        const pending = deferred(); photos.push(pending); return pending.promise;
      } };
      camera.props.ref.current = native;
    }
    for (const [index, effect] of effects) { hooks[index].cleanup?.(); hooks[index].cleanup = effect(); }
    effects.clear();
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@expo/vector-icons/Feather': { default: 'Feather' },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [cameraPermission, getPermission, getPermission], Camera: {
      getMicrophonePermissionsAsync: async () => microphone,
      requestMicrophonePermissionsAsync: async () => { micRequests++; return permissionResult; },
    } },
    'expo-device': { isDevice: true },
    'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } exists = true; delete() { deleted.push(this.uri); } } },
    'expo-router': { useFocusEffect: callback => useEffect(callback, [callback]) },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'react-native': { AppState, BackHandler: { addEventListener: () => ({ remove() {} }) }, Image: 'Image', Linking: { openSettings: async () => {} }, Platform: { OS: 'android' }, Pressable: 'Pressable', Text: 'Text', View: 'View', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: value => value, absoluteFill: {} }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '../../components/ui': { colors: {}, tokens: { font: {} } },
    '../../components/brand': { BrandLogo: 'BrandLogo' },
    '../../lib/photo-session': { createPhotoSession },
    '../../lib/video-session': { createVideoSession },
    '../../lib/crop-photo': { cropPhoto916: async photo => photo },
    '../../lib/capture-framing': { frame916: () => ({ width: 400, height: 711 }) },
    '../../components/video-review': { VideoReview: 'VideoReview' },
    '../../components/share-capture': { ShareCapture: 'ShareCapture' },
  };
  const exports = {};
  vm.runInNewContext(source, { exports, setTimeout, clearTimeout, setInterval, clearInterval, performance, require: name => {
    assert(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name];
  } });
  component = exports.default; render();
  t.after(() => { mounted = false; for (const hook of hooks) hook?.cleanup?.(); });
  const shutter = () => find(tree, node => node.props?.accessibilityLabel === 'Take photo or hold to record video').props;
  return {
    records, photos, deleted,
    readyCallback: () => find(tree, node => node.type === 'CameraView')?.props.onCameraReady,
    ready() { this.readyCallback()?.(); },
    shutter,
    hold() { shutter().onPressIn(); shutter().onLongPress(); },
    release() { shutter().onPressOut(); shutter().onPress(); },
    tap() { shutter().onPressIn(); shutter().onPressOut(); shutter().onPress(); },
    press(label) { const node = find(tree, node => node.props?.accessibilityLabel === label || find(node.props?.children, child => child.type === 'Text' && child.props.children === label)); assert(node, `Missing ${label}`); node.props.onPress(); },
    mode: () => find(tree, node => node.type === 'CameraView')?.props.mode,
    facing: () => find(tree, node => node.type === 'CameraView')?.props.facing,
    review: () => find(tree, node => node.type === 'VideoReview')?.props.uri,
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
    mounts: () => cameraMounts, unmounts: () => cameraUnmounts, stops: () => stops, micRequests: () => micRequests,
    app(state) { AppState.currentState = state; for (const listener of appListeners) listener(state); },
  };
}

test('mode changes keep one native camera and record only after the video ready event', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  const photoReady = h.readyCallback();
  h.hold(); await flush();
  assert.equal(h.mode(), 'video');
  assert.equal(h.mounts(), 1, 'Mode changes must not create a competing native camera');
  assert.equal(h.unmounts(), 0, 'Old Android cleanup would unbind the new recording');
  assert.equal(h.shutter().disabled, false, 'Release remains attached while video prepares');
  assert.equal(h.records.length, 0);
  photoReady(); await flush();
  assert.equal(h.records.length, 0, 'A stale picture callback must not start video');
  h.ready(); await flush();
  assert.equal(h.records.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.records[0].options)), { maxDuration: 10, maxFileSize: 30 * 1024 * 1024 });
  h.release(); await flush();
  assert.equal(h.stops(), 1);
  assert.equal(h.photos.length, 0, 'A video release must not fall through to photo capture');
  h.records[0].resolve({ uri: 'file:///fixture/video.mp4' }); await flush();
  assert.equal(h.review(), 'file:///fixture/video.mp4');
});

test('failed recording restores photo readiness and allows another hold without remounting', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush(); h.ready(); await flush();
  h.records[0].reject(new Error('Synthetic native recorder failure')); await flush();
  assert.equal(h.mode(), 'picture');
  assert.equal(h.shutter().disabled, true, 'Do not capture before restored picture mode is ready');
  assert.match(h.error(), /Could not record/);
  assert.equal(h.mounts(), 1);
  h.ready(); await flush();
  assert.equal(h.shutter().disabled, false);
  h.hold(); await flush(); h.ready(); await flush();
  assert.equal(h.records.length, 2);
  h.release(); h.records[1].resolve({ uri: 'file:///fixture/retry.mp4' }); await flush();
  assert.equal(h.review(), 'file:///fixture/retry.mp4');
});

test('release during mode preparation cancels recording and restores the same photo camera', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush(); const videoReady = h.readyCallback();
  h.release(); h.ready(); await flush();
  assert.equal(h.records.length, 0);
  assert.equal(h.mode(), 'picture');
  videoReady(); await flush();
  assert.equal(h.shutter().disabled, true, 'An old video event must not enable restored picture capture');
  h.ready(); await flush();
  assert.equal(h.shutter().disabled, false);
  assert.equal(h.mounts(), 1);
});

test('switching facing reconfigures the same native camera and waits for its own readiness', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  const backReady = h.readyCallback();
  h.press('Switch camera'); await flush();
  assert.equal(h.facing(), 'front'); assert.equal(h.mounts(), 1);
  assert.equal(h.shutter().disabled, true);
  backReady(); await flush(); assert.equal(h.shutter().disabled, true);
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
});

test('background interrupts a recording and never reviews its late result', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush(); h.ready(); await flush();
  h.app('background'); await flush();
  assert.equal(h.stops(), 1); assert.equal(h.mode(), undefined);
  h.records[0].resolve({ uri: 'file:///fixture/canceled.mp4' }); await flush();
  assert.equal(h.review(), undefined);
  assert.deepEqual(h.deleted, ['file:///fixture/canceled.mp4']);
  h.app('active'); await flush(); h.ready(); await flush();
  assert.equal(h.shutter().disabled, false);
});

test('first microphone permission hold asks once and requires a new deliberate hold', async t => {
  const h = harness(t, { microphone: { granted: false, canAskAgain: true } });
  await flush(); h.ready(); await flush(); h.hold(); await flush();
  assert.equal(h.micRequests(), 1); assert.equal(h.records.length, 0);
  assert.equal(h.mode(), 'picture'); assert.equal(h.mounts(), 1);
  assert.match(h.error(), /Hold again/);
});
