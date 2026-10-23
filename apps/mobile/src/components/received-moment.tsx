import Feather from '@expo/vector-icons/Feather';
import { preventScreenCaptureAsync, allowScreenCaptureAsync, enableAppSwitcherProtectionAsync, disableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { apiRequest, getSharingClient, newIdempotencyKey, resolveApiUrl, SharingError } from '../lib/sharing-client';
import { colors, tokens } from './ui';

type Lease = { leaseId: string; mediaUrl: string; grantedMs: number; remainingMs: number; expiresAt: string };
type Reveal = { uri: string; authorization: string; deadline: number; remainingMs: number };

// Expo's iOS app-switcher setting is global. Finish an old focus's native
// cleanup before a new focus can enable protection and permit media.
let protectionQueue: Promise<void> = Promise.resolve();
function serializeProtection(operation: () => Promise<void>) {
  const pending = protectionQueue.then(operation);
  protectionQueue = pending.catch(() => undefined);
  return pending;
}

function ReceivedVideo({ reveal, onError, position, pausePlayback }: { reveal: Reveal; onError: () => void; position: { current: number }; pausePlayback: { current: (() => void) | null } }) {
  const player = useVideoPlayer({ uri: reveal.uri, headers: { Authorization: reveal.authorization }, useCaching: false }, p => {
    p.allowsExternalPlayback = false;
    p.loop = false;
    p.currentTime = position.current;
    p.timeUpdateEventInterval = 0.1;
  });
  const pause = useCallback(() => {
    // A failed position read must never prevent the audio pause itself.
    try { const current = player.currentTime; if (Number.isFinite(current) && current >= 0) position.current = current; } catch { /* The native player may already be unavailable. */ }
    try { player.pause(); } catch { /* Already released or interrupted. */ }
  }, [player, position]);
  useLayoutEffect(() => {
    const subscription = player.addListener('statusChange', e => { if (e.status === 'error') onError(); });
    const time = player.addListener('timeUpdate', e => { if (Number.isFinite(e.currentTime) && e.currentTime >= 0) position.current = e.currentTime; });
    return () => {
      // Layout cleanup runs before useVideoPlayer's passive auto-release. The
      // parent may already have captured/reset this position during sign-out.
      if (pausePlayback.current === pause) { pause(); pausePlayback.current = null; }
      else { try { player.pause(); } catch { /* Already stopped/released. */ } }
      subscription.remove(); time.remove();
    };
  }, [onError, pause, pausePlayback, player, position]);
  useLayoutEffect(() => {
    // A fresh grant may arrive in the same commit as local expiry. Resume the
    // existing player only after that grant has restored the callback.
    pausePlayback.current = pause;
    player.play();
  }, [pause, pausePlayback, player, reveal]);
  return <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="contain"
    surfaceType="textureView" allowsPictureInPicture={false} fullscreenOptions={{ enable: false }} />;
}

export function ReceivedMoment({ postId, kind }: { postId: string; kind: 'photo' | 'video' }) {
  const [protectedScreen, setProtectedScreen] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [remaining, setRemaining] = useState(10_000);
  const [message, setMessage] = useState('Hold to reveal. Release to hide.');
  const [busy, setBusy] = useState(false);
  const session = useRef(newIdempotencyKey());
  const videoPosition = useRef(0);
  const pausePlayback = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLease = useRef<Reveal | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bounds = useRef({ width: 0, height: 0 });
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identity = useRef<string | null>(null);
  const mounted = useRef(true);

  const pauseVideo = useCallback(() => {
    const pause = pausePlayback.current;
    pausePlayback.current = null;
    pause?.();
  }, []);
  const stop = useCallback(() => {
    pauseVideo();
    epoch.current++;
    held.current = false;
    abort.current?.abort();
    abort.current = null;
    if (timer.current) clearTimeout(timer.current);
    if (expiry.current) clearTimeout(expiry.current);
    timer.current = null;
    expiry.current = null;
    // Release discards unused prepaid time, without retaining another
    // account's media URL or bearer credential for the next hold.
    const lease = activeLease.current;
    activeLease.current = null;
    if (mounted.current) {
      if (lease) setRemaining(lease.remainingMs);
      setReveal(null);
      setBusy(false);
      setMessage(lease?.remainingMs === 0 ? 'Your viewing time is used up.' : 'Hold to reveal. Release to hide.');
    }
  }, [pauseVideo]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);

  useFocusEffect(useCallback(() => {
    let alive = true;
    let authRevision = 0;
    let unsubscribe: (() => void) | undefined;
    const setup = new AbortController();
    const key = `received-${newIdempotencyKey()}`;
    let released = false;
    const releaseProtection = () => {
      if (released) return;
      released = true;
      void serializeProtection(async () => {
        try { await allowScreenCaptureAsync(key); }
        finally { if (Platform.OS === 'ios') await disableAppSwitcherProtectionAsync(); }
      }).catch(() => undefined);
    };
    setProtectedScreen(false);
    void (async () => {
      try {
        await serializeProtection(async () => {
          await preventScreenCaptureAsync(key);
          if (Platform.OS === 'ios') await enableAppSwitcherProtectionAsync(1);
        });
        if (!alive) return;
        const client = await getSharingClient(setup.signal);
        if (!alive) return;
        const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
          if (!alive) return;
          authRevision++;
          const next = session?.user.id ?? null;
          if (next !== identity.current || event === 'SIGNED_OUT') {
            identity.current = next;
            stop();
            videoPosition.current = 0;
            setRemaining(10_000);
            setMessage(next ? 'Hold to reveal. Release to hide.' : 'Sign in to view this moment.');
          }
        });
        unsubscribe = () => subscription.subscription.unsubscribe();
        const revision = authRevision;
        const { data, error } = await client.auth.getSession();
        if (!alive) return;
        if (error) throw error;
        if (revision === authRevision) identity.current = data.session?.user.id ?? null;
        setMessage(identity.current ? 'Hold to reveal. Release to hide.' : 'Sign in to view this moment.');
        setProtectedScreen(true);
      } catch { releaseProtection(); if (alive) setMessage('Protected viewing couldn’t start. Close and try again.'); }
    })();
    const change = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    const blur = AppState.addEventListener('blur', stop);
    return () => {
      alive = false;
      setup.abort();
      unsubscribe?.();
      stop();
      identity.current = null;
      if (mounted.current) setProtectedScreen(false);
      change.remove(); blur.remove();
      releaseProtection();
    };
  }, [stop]));

  const start = async (duration?: number) => {
    if (!protectedScreen || held.current || AppState.currentState !== 'active') return;
    held.current = true;
    const current = ++epoch.current;
    const viewer = identity.current;
    setBusy(true);
    setMessage('Opening your moment…');
    const controller = new AbortController();
    abort.current = controller;
    const valid = () => mounted.current && held.current && epoch.current === current && identity.current === viewer && !controller.signal.aborted && AppState.currentState === 'active';
    let pending = false;
    let renewalWaitStarted: number | null = null;
    try {
      const client = await getSharingClient(controller.signal);
      const { data, error } = await client.auth.getSession();
      if (!valid()) return;
      if (error || !data.session || data.session.user.id !== viewer) throw new SharingError('Please sign in again.');
      const authorization = `Bearer ${data.session.access_token}`;
      const tick = async () => {
        if (!valid() || pending) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        pending = true;
        const sentAt = performance.now();
        const previous = activeLease.current;
        try {
          const response = await apiRequest<Lease>('/api/view/direct', {
            body: { postId, sessionId: session.current, requestId: newIdempotencyKey() }, signal: controller.signal,
          });
          if (!valid()) return;
          const serverExpires = Date.parse(response.expiresAt);
          if (typeof response.leaseId !== 'string' || !/^[a-f0-9-]{36}$/i.test(response.leaseId) ||
            !Number.isFinite(response.grantedMs) || response.grantedMs <= 0 || response.grantedMs > 2_000 ||
            !Number.isFinite(response.remainingMs) || response.remainingMs < 0 || response.remainingMs > 10_000 || !Number.isFinite(serverExpires)) throw new Error('Invalid viewing allowance');
          const mediaUrl = new URL(response.mediaUrl, resolveApiUrl('/'));
          if (mediaUrl.origin !== new URL(resolveApiUrl('/')).origin || mediaUrl.pathname !== `/api/view/media/${response.leaseId}` || mediaUrl.search || mediaUrl.hash) throw new Error('Invalid delivery path');
          const now = performance.now();
          const deadline = Math.min(Math.max(sentAt, previous?.deadline ?? 0) + response.grantedMs, now + Math.max(0, serverExpires - Date.now()));
          const lease: Reveal = {
            uri: previous && previous.deadline > now ? previous.uri : mediaUrl.toString(),
            authorization, deadline, remainingMs: response.remainingMs,
          };
          activeLease.current = lease;
          renewalWaitStarted = null;
          setRemaining(Math.min(10_000, lease.remainingMs + Math.max(0, deadline - now)));
          if (deadline <= now) { stop(); return; }
          setBusy(false);
          setReveal(lease);
          setMessage('Revealed · release to hide');
          if (expiry.current) clearTimeout(expiry.current);
          expiry.current = setTimeout(() => {
            if (!valid()) return;
            pauseVideo();
            setReveal(null);
            setRemaining(lease.remainingMs);
            if (duration !== undefined || lease.remainingMs === 0) { stop(); return; }
            setBusy(true);
            setMessage('Opening your next glimpse…');
            if (!pending) void tick();
          }, Math.max(0, Math.min(duration ?? Infinity, deadline - performance.now())));
          if (duration === undefined && lease.remainingMs > 0) {
            timer.current = setTimeout(() => { void tick(); }, Math.max(0, deadline - performance.now() - 600));
          }
        } catch (error) {
          if (!valid()) return;
          if (error instanceof SharingError && error.code === 'renew_later') {
            renewalWaitStarted ??= performance.now();
            if (performance.now() - renewalWaitStarted < 3_000) {
              timer.current = setTimeout(() => { void tick(); }, 100);
              return;
            }
          }
          stop();
          setMessage(error instanceof SharingError && error.code === 'exhausted' ? 'Your viewing time is used up.' : 'This moment is unavailable. Try again in a moment.');
          if (error instanceof SharingError && error.code === 'exhausted') setRemaining(0);
        } finally { pending = false; }
      };
      await tick();
    } catch { if (valid()) { stop(); setMessage('Sign in to view this moment.'); } }
  };

  useEffect(() => {
    if (!reveal) return;
    const ticker = setInterval(() => {
      if (!held.current || activeLease.current !== reveal) return;
      const left = reveal.deadline - performance.now();
      setRemaining(Math.max(0, Math.min(10_000, reveal.remainingMs + Math.max(0, left))));
      if (left <= 0) {
        pauseVideo();
        setReveal(null);
        setMessage('Opening your next glimpse…');
      }
    }, 50);
    return () => clearInterval(ticker);
  }, [pauseVideo, reveal]);

  const mediaFailed = useCallback(() => { stop(); setMessage('The moment couldn’t load. Hold to try again.'); }, [stop]);
  return <View style={styles.section}>
    <Text style={styles.budget}>{(Math.ceil(remaining / 100) / 10).toFixed(1)}s left</Text>
    <View style={styles.card} accessible accessibilityRole="button" accessibilityLabel="Hold to reveal this moment"
      accessibilityHint="Release to hide. Ten seconds total across all holds."
      onLayout={e => { bounds.current = e.nativeEvent.layout; }}
      onStartShouldSetResponder={() => protectedScreen && remaining > 0}
      onResponderGrant={e => { if (e.nativeEvent.touches.length === 1) void start(); }}
      onResponderStart={e => { if (e.nativeEvent.touches.length !== 1) stop(); }}
      onResponderRelease={stop} onResponderTerminate={stop} onResponderTerminationRequest={() => true}
      onResponderMove={e => {
        const { locationX: x, locationY: y, touches } = e.nativeEvent;
        if (touches.length !== 1 || x < 0 || y < 0 || x > bounds.current.width || y > bounds.current.height) stop();
      }}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {reveal ? kind === 'photo' ? <Image source={{ uri: reveal.uri, headers: { Authorization: reveal.authorization }, cache: 'reload' }}
          style={StyleSheet.absoluteFill} resizeMode="contain" onError={mediaFailed} /> : <ReceivedVideo reveal={reveal} onError={mediaFailed} position={videoPosition} pausePlayback={pausePlayback} />
          : <View style={styles.cover}><Feather name="eye-off" size={32} color="#fff" /><Text style={styles.prompt}>{busy ? 'Opening…' : remaining <= 0 ? 'Time used up' : 'Hold to reveal'}</Text></View>}
      </View>
    </View>
    <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
    <Pressable accessibilityRole="button" disabled={!protectedScreen || remaining <= 0} style={styles.button} onPress={() => { void start(1000); }}>
      <Text style={styles.buttonText}>Reveal for 1 second</Text>
    </Pressable>
    <Text style={styles.note}>Viewing time is shared across your devices. Revealed content may still be photographed or retained.</Text>
  </View>;
}
const styles = StyleSheet.create({
  section: { gap: 14 }, budget: { textAlign: 'right', color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  card: { width: '100%', aspectRatio: 9 / 16, backgroundColor: colors.background, borderRadius: 20, overflow: 'hidden' },
  cover: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, backgroundColor: colors.elevated }, prompt: { color: colors.text, fontSize: 20, fontFamily: tokens.font.display },
  message: { color: colors.text, textAlign: 'center', fontSize: 13 }, button: { minHeight: 50, borderRadius: 28, backgroundColor: colors.accent, padding: 16, alignItems: 'center' },
  buttonText: { color: colors.onAccent, fontWeight: '600' }, note: { color: colors.muted, fontSize: 11, lineHeight: 17 },
});
