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
  const hooks = [], effects = new Map(), appListeners = new Map(), routeEffects = new Set(), records = [], photos = [], deleted = [];
  const cameraPermission = { granted: true, canAskAgain: true };
  let permissionChecks = 0, permissionWait = null;
  const getPermission = async () => {
    permissionChecks++;
    const permission = permissionWait ? await permissionWait.promise : cameraPermission;
    Object.assign(cameraPermission, permission); schedule();
    return permission;
  };
  const jsx = (type, props, key) => ({ type, props, key });
  let cursor = 0, component, tree, mounted = true, scheduled = false, native = null, routeFocused = true, renderPaused = false;
  let cameraMounts = 0, cameraUnmounts = 0, stops = 0, micRequests = 0;
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => {
    if (!mounted || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (mounted && !renderPaused) render(); });
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
  const AppState = { currentState: 'active', addEventListener: (event, callback) => {
    if (!appListeners.has(event)) appListeners.set(event, new Set());
    const listeners = appListeners.get(event);
    listeners.add(callback); return { remove: () => listeners.delete(callback) };
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
      requestMicrophonePermissionsAsync: async () => { micRequests++; Object.assign(microphone, permissionResult); return permissionResult; },
    } },
    'expo-device': { isDevice: true },
    'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } exists = true; delete() { deleted.push(this.uri); } } },
    'expo-router': { useFocusEffect: callback => useEffect(() => {
      const entry = { callback, cleanup: routeFocused ? callback() : null };
      routeEffects.add(entry);
      return () => { entry.cleanup?.(); routeEffects.delete(entry); };
    }, [callback]) },
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
    press(label) { const node = find(tree, node => typeof node.props?.onPress === 'function' && (node.props.accessibilityLabel === label || find(node.props.children, child => child.type === 'Text' && child.props.children === label))); assert(node, `Missing ${label}`); node.props.onPress(); },
    mode: () => find(tree, node => node.type === 'CameraView')?.props.mode,
    facing: () => find(tree, node => node.type === 'CameraView')?.props.facing,
    review: () => find(tree, node => node.type === 'VideoReview')?.props.uri,
    photoReview: () => find(tree, node => node.props?.accessibilityLabel === 'Your captured photo')?.props.source.uri,
    share: () => find(tree, node => node.type === 'ShareCapture')?.props,
    error: () => find(tree, node => node.props?.accessibilityRole === 'alert')?.props.children,
    mounts: () => cameraMounts, unmounts: () => cameraUnmounts, stops: () => stops, micRequests: () => micRequests,
    permissionChecks: () => permissionChecks,
    pauseRendering() { renderPaused = true; },
    commitRendering() { renderPaused = false; render(); },
    deferPermission() { permissionWait = deferred(); return permissionWait; },
    event(name, value) { for (const listener of appListeners.get(name) ?? []) listener(value); },
    app(state) { AppState.currentState = state; this.event('change', state); },
    route(focused) {
      routeFocused = focused;
      for (const entry of routeEffects) {
        if (focused) entry.cleanup = entry.callback();
        else { entry.cleanup?.(); entry.cleanup = null; }
      }
    },
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

test('Android window blur stops recording synchronously and cleans its late result without restarting on focus', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush(); h.ready(); await flush();
  h.event('blur');
  assert.equal(h.stops(), 1, 'Blur must stop the recorder before rendering');
  await flush();
  assert.equal(h.mode(), undefined, 'Preview is unmounted even when AppState stays active');
  h.records[0].resolve({ uri: 'file:///fixture/blurred.mp4' }); await flush();
  assert.equal(h.review(), undefined);
  assert.deepEqual(h.deleted, ['file:///fixture/blurred.mp4']);
  const permission = h.deferPermission();
  h.event('focus'); await flush();
  assert.equal(h.permissionChecks(), 1);
  assert.equal(h.mode(), undefined, 'Await refreshed permission before restoring camera');
  permission.resolve({ granted: true, canAskAgain: true }); await flush();
  assert.equal(h.mode(), 'picture');
  assert.equal(h.shutter().disabled, true, 'Restored native preview must become ready again');
  h.ready(); await flush();
  assert.equal(h.shutter().disabled, false);
  assert.equal(h.records.length, 1, 'Focus cannot restart an interrupted hold');
});

test('Android blur cancels pending preparation and ignores stale readiness and focus permission results', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush();
  const staleReady = h.readyCallback();
  h.event('blur'); staleReady(); await flush();
  assert.equal(h.records.length, 0);
  assert.equal(h.mode(), undefined);
  const permission = h.deferPermission();
  h.event('focus'); await flush(); h.event('blur');
  permission.resolve({ granted: true, canAskAgain: true }); await flush();
  assert.equal(h.mode(), undefined, 'An old focus result cannot uncover a blurred window');
});

for (const kind of ['photo', 'video']) {
  test(`Android blur removes ordinary ${kind} review and deletes its draft`, async t => {
    const h = harness(t); await flush(); h.ready(); await flush();
    const uri = `file:///fixture/review.${kind === 'photo' ? 'jpg' : 'mp4'}`;
    if (kind === 'photo') { h.tap(); h.photos[0].resolve({ uri, width: 900, height: 1600 }); }
    else { h.hold(); await flush(); h.ready(); await flush(); h.release(); h.records[0].resolve({ uri }); }
    await flush();
    assert.equal(kind === 'photo' ? h.photoReview() : h.review(), uri);
    h.event('blur'); await flush();
    assert.equal(h.photoReview(), undefined); assert.equal(h.review(), undefined);
    assert.deepEqual(h.deleted, [uri]);
    h.event('focus'); await flush();
    assert.equal(h.photoReview(), undefined); assert.equal(h.review(), undefined);
  });

  test(`Android blur preserves the explicit Share ${kind} draft while keeping review covered`, async t => {
    const h = harness(t); await flush(); h.ready(); await flush();
    const uri = `file:///fixture/share.${kind === 'photo' ? 'jpg' : 'mp4'}`;
    if (kind === 'photo') { h.tap(); h.photos[0].resolve({ uri, width: 900, height: 1600 }); }
    else { h.hold(); await flush(); h.ready(); await flush(); h.release(); h.records[0].resolve({ uri }); }
    await flush(); h.press('Share this moment'); await flush();
    h.event('blur'); await flush();
    assert.equal(h.share().capture.uri, uri); assert.equal(h.share().visible, true);
    assert.equal(h.photoReview(), undefined); assert.equal(h.review(), undefined);
    assert.deepEqual(h.deleted, []);
    h.share().onClose(); await flush();
    assert.equal(h.photoReview(), undefined); assert.equal(h.review(), undefined, 'Closing Share while blurred cannot uncover review');
    h.event('focus'); await flush();
    assert.equal(kind === 'photo' ? h.photoReview() : h.review(), uri);
    h.press('Discard'); await flush(); assert.deepEqual(h.deleted, [uri]);
  });
}

test('Android blur rejects a late photo and stale shutter callbacks before rendering', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  const shutter = h.shutter();
  h.event('blur'); shutter.onPress(); shutter.onLongPress(); await flush();
  assert.equal(h.photos.length, 0); assert.equal(h.records.length, 0);
  h.event('focus'); await flush(); h.ready(); await flush(); h.tap();
  h.event('blur'); h.photos[0].resolve({ uri: 'file:///fixture/late.jpg', width: 900, height: 1600 }); await flush();
  assert.equal(h.photoReview(), undefined);
  assert.deepEqual(h.deleted, ['file:///fixture/late.jpg']);
});

test('focus permission refresh respects revoked camera access and a later Settings recovery', async t => {
  const h = harness(t); await flush(); h.ready(); await flush(); h.event('blur'); await flush();
  const denied = h.deferPermission(); h.event('focus');
  denied.resolve({ granted: false, canAskAgain: false }); await flush();
  assert.equal(h.mode(), undefined); assert.equal(h.shutter().disabled, true);
  h.event('blur'); const granted = h.deferPermission(); h.event('focus');
  granted.resolve({ granted: true, canAskAgain: true }); await flush();
  assert.equal(h.mode(), 'picture'); assert.equal(h.shutter().disabled, true);
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
  assert.equal(h.photos.length, 0); assert.equal(h.records.length, 0);
});

for (const order of [['focus', 'active'], ['active', 'focus']]) {
  test(`window resumes safely when Android sends ${order.join(' then ')} after background`, async t => {
    const h = harness(t); await flush(); h.ready(); await flush();
    h.event('blur'); h.app('background'); await flush();
    for (const event of order) { if (event === 'active') h.app('active'); else h.event(event); await flush(); }
    assert.equal(h.mode(), 'picture'); assert.equal(h.shutter().disabled, true);
    h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
    assert.equal(h.photos.length, 0); assert.equal(h.records.length, 0);
  });
}

test('route cleanup synchronously fences queued shutters before navigation renders', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  const shutter = h.shutter();
  h.route(false); shutter.onPress(); shutter.onLongPress(); await flush();
  assert.equal(h.photos.length, 0); assert.equal(h.records.length, 0);
  assert.equal(h.mode(), undefined);
  h.route(true); await flush();
  assert.equal(h.shutter().disabled, true);
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
});

test('route cleanup rejects stale preparation readiness without restarting on return', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.hold(); await flush(); const staleReady = h.readyCallback();
  h.route(false); staleReady(); await flush();
  assert.equal(h.records.length, 0); assert.equal(h.mode(), undefined);
  h.route(true); await flush(); h.ready(); await flush();
  assert.equal(h.records.length, 0); assert.equal(h.mode(), 'picture');
});

test('failed focus permission refresh offers an explicit retry and waits covered for success', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.event('blur'); const failed = h.deferPermission(); h.event('focus');
  failed.reject(new Error('Synthetic permission transport failure')); await flush();
  assert.equal(h.mode(), undefined); assert.equal(h.shutter().disabled, true);
  const retry = h.deferPermission(); h.press('Retry camera access'); await flush();
  assert.equal(h.permissionChecks(), 2); assert.equal(h.mode(), undefined);
  retry.resolve({ granted: true, canAskAgain: true }); await flush();
  assert.equal(h.mode(), 'picture'); assert.equal(h.shutter().disabled, true);
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
});

test('a retried permission refresh cannot restore capture after another interruption', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  h.event('blur'); const failed = h.deferPermission(); h.event('focus');
  failed.reject(new Error('Synthetic permission transport failure')); await flush();
  const retry = h.deferPermission(); h.press('Retry camera access');
  h.event('blur'); h.app('background');
  retry.resolve({ granted: true, canAskAgain: true }); await flush();
  assert.equal(h.mode(), undefined); assert.equal(h.shutter().disabled, true);
  assert.equal(h.photos.length, 0); assert.equal(h.records.length, 0);
});

test('batched blur and permission-restored focus recreate the camera and reject the old readiness callback', async t => {
  const h = harness(t); await flush(); h.ready(); await flush();
  const oldReady = h.readyCallback();
  const oldShutter = h.shutter();
  h.pauseRendering(); h.event('blur'); h.event('focus'); await flush();
  assert.equal(h.mounts(), 1, 'React has not committed the intermediate hidden camera');
  oldReady(); await flush();
  oldShutter.onPress(); oldShutter.onLongPress(); await flush();
  assert.equal(h.photos.length, 0, 'Queued old capture handlers cannot use a pre-recovery native instance');
  h.commitRendering(); await flush();
  assert.equal(h.mounts(), 2, 'A batched hidden-to-visible transition still needs a fresh native ready event');
  assert.equal(h.unmounts(), 1); assert.equal(h.shutter().disabled, true);
  oldReady(); await flush(); assert.equal(h.shutter().disabled, true, 'Old native readiness must not enable the recovered camera');
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
  oldShutter.onPress(); oldShutter.onLongPress(); await flush();
  assert.equal(h.records.length, 0); assert.equal(h.photos.length, 0);
});

test('microphone permission recovery remains usable when blur/focus rendering is batched', async t => {
  const h = harness(t, { microphone: { granted: false, canAskAgain: true } });
  await flush(); h.ready(); await flush(); h.hold(); await flush();
  assert.equal(h.micRequests(), 1); assert.equal(h.records.length, 0);
  h.pauseRendering(); h.event('blur'); h.event('focus'); await flush(); h.commitRendering(); await flush();
  assert.equal(h.mounts(), 2); assert.equal(h.shutter().disabled, true);
  h.ready(); await flush(); assert.equal(h.shutter().disabled, false);
  h.hold(); await flush(); assert.equal(h.mode(), 'video');
  assert.equal(h.mounts(), 2, 'Uninterrupted mode changes retain the recovered native camera');
  h.ready(); await flush(); assert.equal(h.records.length, 1);
  h.release(); h.records[0].resolve({ uri: 'file:///fixture/permission-recovered.mp4' }); await flush();
  assert.equal(h.review(), 'file:///fixture/permission-recovered.mp4');
  h.press('Discard'); await flush(); assert.deepEqual(h.deleted, ['file:///fixture/permission-recovered.mp4']);
});
