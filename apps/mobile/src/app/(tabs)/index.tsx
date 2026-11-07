import Feather from '@expo/vector-icons/Feather';
import { Camera, CameraView, useCameraPermissions, type CameraMode, type CameraType } from 'expo-camera';
import { isDevice } from 'expo-device';
import { File } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, BackHandler, Image, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, tokens } from '../../components/ui';
import { BrandLogo } from '../../components/brand';
import { createPhotoSession } from '../../lib/photo-session';
import { createVideoSession } from '../../lib/video-session';
import { cropPhoto916 } from '../../lib/crop-photo';
import { frame916 } from '../../lib/capture-framing';
import { VideoReview } from '../../components/video-review';
import { subscribeAccountDisabled } from '../../lib/account-lifecycle';
import { ShareCapture } from '../../components/share-capture';

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const frame = frame916(window.width, window.height);
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(false);
  const routeFocused = useRef(false);
  const retryWindow = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [windowFocused, setWindowFocused] = useState(true);
  const nativeWindowFocused = useRef(true);
  const windowUsable = useRef(true);
  const windowRevision = useRef(0);
  const [ready, setReady] = useState(false);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const latestRecoveryEpoch = useRef(0);
  const [facing, setFacing] = useState<CameraType>('back');
  const [cameraFailed, setCameraFailed] = useState(false);
  const [permissionFailed, setPermissionFailed] = useState(false);
  const [mode, setMode] = useState<CameraMode>('picture');
  const modeRef = useRef<CameraMode>('picture');
  const generation = useRef(0);
  const [videoHint, setVideoHint] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sharing, setSharing] = useState(false);
  const sharingOpen = useRef(false);
  const longPress = useRef(false);
  const mounted = useRef(true);
  const pendingReady = useRef<{ resolve: (ready: boolean) => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const recordingCamera = useRef<CameraView | null>(null);
  const stopRetry = useRef<ReturnType<typeof setInterval> | null>(null);
  const camera = useRef<CameraView>(null);
  const [session] = useState(() => createPhotoSession(photo => {
    const file = new File(photo.uri);
    if (file.exists) file.delete();
  }));
  const cancelPreparation = useCallback(() => {
    const pending = pendingReady.current;
    pendingReady.current = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(false); }
  }, []);
  const [videoSession] = useState(() => createVideoSession({
    prepare: async () => {
      const preparingGeneration = generation.current;
      if (!routeFocused.current || !windowUsable.current) return false;
      const permission = await Camera.getMicrophonePermissionsAsync();
      if (!permission.granted) {
        const result = permission.canAskAgain ? await Camera.requestMicrophonePermissionsAsync() : permission;
        if (mounted.current) {
          setMicBlocked(!result.granted && !result.canAskAgain);
          setVideoHint(result.granted ? 'Microphone ready. Hold again to record.' : 'Allow microphone access to record videos with sound.');
        }
        return false;
      }
      if (!mounted.current || !routeFocused.current || !windowUsable.current || AppState.currentState !== 'active' || preparingGeneration !== generation.current) return false;
      setVideoHint(null);
      setMicBlocked(false);
      setReady(false);
      return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          pendingReady.current = null;
          resolve(false);
          if (mounted.current) setVideoHint('Video camera couldn’t start. Hold to try again.');
        }, 8000);
        pendingReady.current = { resolve, timer };
        modeRef.current = 'video';
        setMode('video');
      });
    },
    record: () => {
      const current = camera.current;
      if (!current) return Promise.reject(new Error('Camera unavailable'));
      recordingCamera.current = current;
      return current.recordAsync({ maxDuration: 10, maxFileSize: 30 * 1024 * 1024 });
    },
    stop: () => {
      const current = recordingCamera.current;
      if (!current) return;
      const stop = () => {
        try { current.stopRecording(); } catch { /* Camera may already be unmounted. */ }
      };
      stop();
      // iOS starts recording asynchronously; release can arrive before native start.
      if (mounted.current && !stopRetry.current) stopRetry.current = setInterval(stop, 100);
    },
    deleteVideo: uri => { const file = new File(uri); if (file.exists) file.delete(); },
    onRestore: () => {
      if (stopRetry.current) { clearInterval(stopRetry.current); stopRetry.current = null; }
      cancelPreparation();
      recordingCamera.current = null;
      if (mounted.current && modeRef.current !== 'picture') {
        modeRef.current = 'picture';
        setReady(false);
        setMode('picture');
      }
    },
  }));
  const video = useSyncExternalStore(videoSession.subscribe, videoSession.getSnapshot, videoSession.getSnapshot);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const physicalPhone = isDevice && Platform.OS !== 'web';
  const reviewingVideo = video.status === 'review';
  const reviewing = snapshot.status === 'review' || reviewingVideo;
  const videoBusy = video.status === 'preparing' || video.status === 'recording' || video.status === 'stopping';
  const capturing = snapshot.status === 'capturing';
  const showCamera = physicalPhone && permission?.granted && focused && active && windowFocused && !cameraFailed && !reviewing && !sharing;
  const viewIdentity = useMemo(() => ({}), [showCamera, mode, facing, recoveryEpoch]);
  const latestViewIdentity = useRef(viewIdentity);
  latestViewIdentity.current = viewIdentity;
  const canCapture = showCamera && ready && !capturing && !videoBusy && mode === 'picture';
  const interrupt = useCallback(() => {
    generation.current++;
    cancelPreparation();
    if (!sharingOpen.current || videoSession.getSnapshot().status !== 'review') videoSession.interrupt();
    // Keep the local draft while its explicit Share flow is open; hide pixels on interruption.
    if (!sharingOpen.current) session.interrupt();
  }, [cancelPreparation, session, videoSession]);
  const discard = () => { sharingOpen.current = false; setSharing(false); session.discard(); videoSession.discard(); };
  const openShare = () => { sharingOpen.current = true; setSharing(true); };
  const closeShare = () => { sharingOpen.current = false; setSharing(false); };
  const shareCapture = reviewingVideo && video.video ? { uri: video.video.uri, kind: 'video' as const } : snapshot.photo ? { uri: snapshot.photo.uri, kind: 'photo' as const } : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      cancelPreparation();
      videoSession.interrupt();
      if (stopRetry.current) { clearInterval(stopRetry.current); stopRetry.current = null; }
    };
  }, [cancelPreparation, videoSession]);

  useEffect(() => subscribeAccountDisabled(() => {
    generation.current++; cancelPreparation(); sharingOpen.current = false; setSharing(false); session.discard(); videoSession.discard();
  }), [cancelPreparation, session, videoSession]);

  useEffect(() => { if (!showCamera) setReady(false); }, [showCamera]);

  useEffect(() => {
    if (video.status !== 'recording') return;
    const start = performance.now();
    const timer = setInterval(() => setElapsed(Math.min(10, (performance.now() - start) / 1000)), 100);
    return () => clearInterval(timer);
  }, [video.status]);

  useFocusEffect(useCallback(() => {
    routeFocused.current = true;
    setFocused(true);
    retryWindow.current?.();
    return () => {
      routeFocused.current = false;
      setFocused(false);
      setReady(false);
      interrupt();
    };
  }, [interrupt]));

  useEffect(() => {
    let alive = true;
    const resumeWindow = () => {
      if (!routeFocused.current || !nativeWindowFocused.current || AppState.currentState !== 'active') return;
      const revision = ++windowRevision.current;
      setPermissionFailed(false);
      windowUsable.current = false;
      setWindowFocused(false);
      setReady(false);
      const permissionCheck = physicalPhone ? getPermission() : Promise.resolve();
      void permissionCheck.then(() => {
        if (!alive || revision !== windowRevision.current || !routeFocused.current || !nativeWindowFocused.current || AppState.currentState !== 'active') return;
        setPermissionFailed(false);
        windowUsable.current = true;
        // Blur/focus state updates can batch without removing the old view.
        // Recovery needs a fresh native ready event even in that single commit.
        setRecoveryEpoch(++latestRecoveryEpoch.current);
        setWindowFocused(true);
      }).catch(() => { if (alive && revision === windowRevision.current) setPermissionFailed(true); });
    };
    const obscureWindow = () => {
      windowRevision.current++;
      // Android's shade/call overlays can remove window focus while AppState
      // stays active. Fence queued shutter/readiness events before React renders.
      windowUsable.current = false;
      setWindowFocused(false);
      setReady(false);
      interrupt();
    };
    const subscription = AppState.addEventListener('change', state => {
      setActive(state === 'active');
      if (state !== 'active') obscureWindow();
      else resumeWindow();
    });
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', () => {
      nativeWindowFocused.current = false;
      obscureWindow();
    }) : null;
    const focus = Platform.OS === 'android' ? AppState.addEventListener('focus', () => {
      nativeWindowFocused.current = true;
      resumeWindow();
    }) : null;
    retryWindow.current = resumeWindow;
    return () => { alive = false; retryWindow.current = null; windowRevision.current++; subscription.remove(); blur?.remove(); focus?.remove(); interrupt(); };
  }, [getPermission, physicalPhone, interrupt]);

  useEffect(() => {
    if (!focused || (snapshot.status === 'idle' && video.status === 'idle')) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sharingOpen.current) { sharingOpen.current = false; setSharing(false); return true; }
      if (videoBusy) interrupt();
      else { session.discard(); videoSession.discard(); }
      return true;
    });
    return () => subscription.remove();
  }, [focused, interrupt, session, snapshot.status, video.status, videoBusy, videoSession]);

  const askForCamera = async () => {
    setPermissionFailed(false);
    try { await requestPermission(); } catch { setPermissionFailed(true); }
  };
  const openSettings = async () => {
    try { await Linking.openSettings(); } catch { setPermissionFailed(true); }
  };
  const takePhoto = () => {
    if (!canCapture || recoveryEpoch !== latestRecoveryEpoch.current || !routeFocused.current || !windowUsable.current || !camera.current) return;
    const currentCamera = camera.current;
    setVideoHint(null);
    void session.capture(async () => {
      const photo = await currentCamera.takePictureAsync({ quality: 0.9, exif: false, base64: false });
      return cropPhoto916(photo);
    });
  };
  const controlsBottom = 76 + insets.bottom + 24;

  return <View style={styles.screen}>
    {focused && <StatusBar style="light" />}
    <View pointerEvents={reviewing ? 'auto' : 'none'} style={[styles.frame, frame]}>
      {/* Only lifecycle recovery recreates the view. Expo rebinds mode/facing on
          the same native instance; keying those changes can let old Android
          unbindAll() cleanup tear down the new recording. */}
      {showCamera && <CameraView key={recoveryEpoch} ref={camera} style={styles.preview} facing={facing}
        mirror={facing === 'front'} mode={mode} ratio="16:9" videoQuality="1080p" mute={false}
        onCameraReady={() => {
          if (latestViewIdentity.current !== viewIdentity || recoveryEpoch !== latestRecoveryEpoch.current || !showCamera || !routeFocused.current || !windowUsable.current) return;
          setReady(true);
          if (mode === 'video' && pendingReady.current) {
            const pending = pendingReady.current;
            pendingReady.current = null;
            clearTimeout(pending.timer);
            pending.resolve(true);
          }
        }}
        onMountError={() => {
          if (latestViewIdentity.current !== viewIdentity || recoveryEpoch !== latestRecoveryEpoch.current || !showCamera || !routeFocused.current || !windowUsable.current) return;
          setReady(false); setCameraFailed(true); interrupt();
        }} />}
      {reviewing && active && focused && windowFocused && !sharing && snapshot.photo && <Image source={{ uri: snapshot.photo.uri }}
        accessibilityLabel="Your captured photo" style={StyleSheet.absoluteFill} resizeMode="contain" />}
      {reviewingVideo && active && focused && windowFocused && !sharing && video.video && <VideoReview key={video.video.uri} uri={video.video.uri} />}
    </View>

    <View pointerEvents="none" style={[styles.cameraChrome, styles.logoPosition, { top: insets.top + 14, left: Math.max(insets.left, 24) }]}>
      <BrandLogo />
    </View>

    {reviewing ? <>
      <View style={[styles.cameraChrome, styles.reviewBadge, { top: insets.top + 22, right: Math.max(insets.right, 24) }]}>
        <Text style={styles.badgeText}>{reviewingVideo ? 'REVIEW VIDEO' : 'REVIEW PHOTO'}</Text>
      </View>
      <View style={[styles.reviewControls, { bottom: controlsBottom }]}>
        <Text style={styles.reviewHint}>Ready for a little reveal?</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Share this moment" onPress={openShare} style={[styles.primaryButton, styles.shareButton]}>
          <Feather name="send" size={20} color={colors.onAccent} /><Text style={styles.darkButtonText}>Share moment</Text>
        </Pressable>
        <View style={styles.reviewActions}>
          <Pressable accessibilityRole="button" onPress={discard} style={styles.secondaryButton}>
            <Feather name="x" size={18} color="#fff" /><Text style={styles.lightButtonText}>Discard</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={discard} style={styles.secondaryButton}>
            <Feather name="rotate-ccw" size={18} color={colors.text} /><Text style={styles.lightButtonText}>Retake</Text>
          </Pressable>
        </View>
      </View>
    </> : <>
      {!showCamera && <View style={[styles.permissionState, { paddingTop: insets.top + 82, paddingBottom: controlsBottom + 108 }]}>
        <View style={styles.cameraGlyph}><Feather name="camera" size={38} color={colors.accent} /></View>
        <Text accessibilityRole="header" style={styles.stateTitle}>{!physicalPhone ? 'Camera needs a real phone' : cameraFailed ? 'Camera couldn’t start' : 'Let’s open your camera'}</Text>
        <Text style={styles.stateText}>{!physicalPhone ? 'Open Peekalo on your phone to take a photo.' : cameraFailed ? 'Try opening the camera again.' : 'Allow camera access to capture a moment. No gallery imports.'}</Text>
        {physicalPhone && !permission && <ActivityIndicator accessibilityLabel="Checking camera permission" color={colors.accent} />}
        {physicalPhone && permission && !permission.granted && <Pressable accessibilityRole="button" style={styles.primaryButton}
          onPress={() => { void (permission.canAskAgain ? askForCamera() : openSettings()); }}>
          <Text style={styles.darkButtonText}>{permission.canAskAgain ? 'Enable camera' : 'Open camera settings'}</Text>
        </Pressable>}
        {cameraFailed && <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={() => setCameraFailed(false)}>
          <Text style={styles.darkButtonText}>Retry camera</Text>
        </Pressable>}
      </View>}
      <Pressable accessibilityRole="button" accessibilityLabel="Switch camera" accessibilityState={{ disabled: !canCapture }} disabled={!canCapture}
        style={[styles.cameraChrome, styles.flipButton, { top: insets.top + 9, right: Math.max(insets.right, 24) }]} onPress={() => { setReady(false); setFacing(current => current === 'back' ? 'front' : 'back'); }}>
        <Feather name="refresh-cw" size={23} color="#fff" />
      </Pressable>
      <View style={[styles.captureControls, { bottom: controlsBottom + 50 }]}>
        <View style={styles.shutterRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Take photo or hold to record video" accessibilityHint="Tap for photo. Hold for video; release to stop. Maximum ten seconds."
            accessibilityState={{ disabled: !showCamera || capturing || (!ready && !videoBusy), busy: capturing || videoBusy }}
            disabled={!showCamera || capturing || (!ready && !videoBusy)} delayLongPress={300}
            onPressIn={() => { longPress.current = false; }}
            onLongPress={() => {
              if (!canCapture || recoveryEpoch !== latestRecoveryEpoch.current || !routeFocused.current || !windowUsable.current) return;
              longPress.current = true;
              setElapsed(0);
              void videoSession.start();
            }}
            onPressOut={() => { if (longPress.current) videoSession.release(); }}
            onPress={() => { if (!longPress.current) takePhoto(); }}
            style={({ pressed }) => [styles.shutter, !canCapture && !videoBusy && styles.disabledShutter, videoBusy && styles.videoShutter, pressed && styles.pressedShutter]}>
            {capturing || video.status === 'preparing' || video.status === 'stopping' ? <ActivityIndicator color={colors.text} accessibilityLabel="Preparing capture" /> : <View style={[styles.shutterCore, video.status === 'recording' && styles.recordingCore]} />}
          </Pressable>
        </View>
        <View pointerEvents="none" style={styles.captureCaption}>
          <Text style={[styles.photoMode, video.status === 'recording' && styles.recordingMode]}>
            {video.status === 'recording' ? `● ${elapsed.toFixed(1)} / 10s` : video.status === 'preparing' ? 'STARTING VIDEO…' : video.status === 'stopping' ? 'SAVING VIDEO…' : 'Tap for photo · Hold for video'}
          </Text>
          {video.status === 'idle' && <Text style={styles.captureLimit}>Up to 10 seconds</Text>}
        </View>
      </View>
    </>}
    {shareCapture && <ShareCapture visible={sharing} capture={shareCapture} onClose={closeShare} />}
    {(snapshot.error || video.error || permissionFailed || videoHint) && <View style={[styles.errorBanner, { top: insets.top + 76 }]}>
      <Text accessibilityRole="alert" style={styles.errorText}>{snapshot.error ?? videoHint ?? video.error ?? 'Camera access couldn’t be updated. Try again.'}</Text>
      {permissionFailed && <Pressable accessibilityRole="button" onPress={() => retryWindow.current?.()}><Text style={styles.settingsText}>Retry camera access</Text></Pressable>}
      {micBlocked && <Pressable accessibilityRole="button" onPress={() => { void openSettings(); }}><Text style={styles.settingsText}>Open microphone settings</Text></Pressable>}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  frame: { position: 'absolute', overflow: 'hidden', backgroundColor: '#000' },
  preview: { flex: 1 },
  videoShutter: { borderColor: '#FF5E63' },
  recordingCore: { backgroundColor: '#FF5E63', width: 38, height: 38, borderRadius: 10 },
  recordingMode: { color: '#fff', backgroundColor: '#A6222CDD' },
  settingsText: { color: colors.accent, fontSize: 13, paddingTop: 12, fontWeight: '600' },
  cameraChrome: { backgroundColor: 'rgba(21, 22, 24, 0.85)', borderWidth: 1, borderColor: 'rgba(239, 239, 237, 0.26)' },
  logoPosition: { position: 'absolute', zIndex: 2, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 12 },
  permissionState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 18 },
  cameraGlyph: { height: 76, width: 76, borderRadius: 38, backgroundColor: '#FFFFFF12', alignItems: 'center', justifyContent: 'center' },
  stateTitle: { fontSize: 22, fontFamily: tokens.font.display, color: colors.text, textAlign: 'center' },
  stateText: { fontSize: 14, lineHeight: 22, color: colors.muted, textAlign: 'center', maxWidth: 280 },
  captureControls: { zIndex: 3, position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  captureCaption: { position: 'absolute', top: 81, left: 0, right: 0, alignItems: 'center', gap: 3 },
  photoMode: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center', backgroundColor: '#151618e6', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 },
  captureLimit: { color: colors.text, fontSize: 11, backgroundColor: '#151618e6', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10 },
  shutterRow: { width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 36 },
  shutter: { width: 74, height: 74, borderRadius: 37, borderWidth: 2, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF25' },
  shutterCore: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.accent },
  disabledShutter: { opacity: 0.4 },
  pressedShutter: { transform: [{ scale: 0.94 }] },
  flipButton: { position: 'absolute', zIndex: 3, width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  reviewBadge: { position: 'absolute', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
  badgeText: { color: '#fff', fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
  reviewControls: { zIndex: 3, position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 18 },
  reviewHint: { color: '#fff', fontSize: 12, textAlign: 'center', backgroundColor: '#00000099', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16 },
  reviewActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 },
  shareButton: { alignSelf: 'stretch', minHeight: 56 },
  primaryButton: { minHeight: 50, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 28, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  secondaryButton: { minHeight: 50, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 28, backgroundColor: '#00000099', borderWidth: 1, borderColor: '#FFFFFF80', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  lightButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  darkButtonText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  errorBanner: { position: 'absolute', left: 24, right: 24, backgroundColor: '#3F241FEE', borderRadius: 16, padding: 14 },
  errorText: { color: '#fff', fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
