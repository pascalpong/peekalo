import Feather from '@expo/vector-icons/Feather';
import { preventScreenCaptureAsync, allowScreenCaptureAsync, enableAppSwitcherProtectionAsync, disableAppSwitcherProtectionAsync } from 'expo-screen-capture';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { apiRequest, getSharingClient, newIdempotencyKey, resolveApiUrl, SharingError } from '../lib/sharing-client';
import { colors, tokens } from './ui';

type Lease = { leaseId: string; mediaUrl: string; grantedMs: number; remainingMs: number; expiresAt: string };
type Reveal = { uri: string; authorization: string; deadline: number; remainingMs: number };

function ReceivedVideo({ reveal, onError, position }: { reveal: Reveal; onError: () => void; position: { current: number } }) {
  const player = useVideoPlayer({ uri: reveal.uri, headers: { Authorization: reveal.authorization }, useCaching: false }, p => {
    p.allowsExternalPlayback = false;
    p.loop = false;
    p.currentTime = position.current;
    p.timeUpdateEventInterval = 0.1;
    p.play();
  });
  useEffect(() => {
    const subscription = player.addListener('statusChange', e => { if (e.status === 'error') onError(); });
    const time = player.addListener('timeUpdate', e => { position.current = e.currentTime; });
    return () => {
      try { position.current = player.currentTime; player.pause(); } catch { /* Player may already be released. */ }
      subscription.remove(); time.remove();
    };
  }, [onError, player, position]);
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
  const epoch = useRef(0);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLease = useRef<Reveal | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bounds = useRef({ width: 0, height: 0 });
  const accessibleEnd = useRef<number | null>(null);
  const protectionKey = useRef(`received-${newIdempotencyKey()}`);

  const stop = useCallback(() => {
    epoch.current++;
    held.current = false;
    accessibleEnd.current = null;
    abort.current?.abort();
    abort.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setReveal(null);
    setBusy(false);
  }, []);

  useFocusEffect(useCallback(() => {
    let alive = true;
    const key = protectionKey.current;
    void (async () => {
      try {
        await preventScreenCaptureAsync(key);
        if (Platform.OS === 'ios') await enableAppSwitcherProtectionAsync(1);
        if (alive) setProtectedScreen(true);
        else { await allowScreenCaptureAsync(key); if (Platform.OS === 'ios') await disableAppSwitcherProtectionAsync(); }
      } catch { if (alive) setMessage('Protected viewing couldn’t start. Close and try again.'); }
    })();
    const change = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    const blur = AppState.addEventListener('blur', stop);
    return () => {
      alive = false;
      stop();
      setProtectedScreen(false);
      change.remove(); blur.remove();
      void allowScreenCaptureAsync(key).catch(() => undefined);
      if (Platform.OS === 'ios') void disableAppSwitcherProtectionAsync().catch(() => undefined);
    };
  }, [stop]));

  const start = async (duration?: number) => {
    if (!protectedScreen || held.current || AppState.currentState !== 'active') return;
    held.current = true;
    const current = ++epoch.current;
    accessibleEnd.current = duration ? performance.now() + duration : null;
    setBusy(true);
    setMessage('Opening your moment…');
    const controller = new AbortController();
    abort.current = controller;
    const valid = () => held.current && epoch.current === current && !controller.signal.aborted && AppState.currentState === 'active';
    try {
      const client = await getSharingClient();
      const { data } = await client.auth.getSession();
      if (!data.session) throw new SharingError('Please sign in again.');
      const authorization = `Bearer ${data.session.access_token}`;
      const tick = async () => {
        if (!valid()) return;
        const previous = activeLease.current;
        try {
          // Reuse unspent milliseconds of this session after a short release.
          if (!previous || previous.deadline - performance.now() <= 610) {
            const response = await apiRequest<Lease>('/api/view/direct', {
              body: { postId, sessionId: session.current, requestId: newIdempotencyKey() }, signal: controller.signal,
            });
            if (!valid()) return;
            const serverMs = Date.parse(response.expiresAt) - Date.now();
            const deadline = performance.now() + Math.max(0, Math.min(serverMs, (previous ? Math.max(0, previous.deadline - performance.now()) : 0) + response.grantedMs));
            const mediaUrl = new URL(response.mediaUrl, resolveApiUrl('/'));
            if (mediaUrl.origin !== new URL(resolveApiUrl('/')).origin) throw new Error('Invalid delivery origin');
            activeLease.current = {
              uri: previous && previous.deadline > performance.now() ? previous.uri : mediaUrl.toString(),
              authorization, deadline, remainingMs: response.remainingMs,
            };
          }
          const lease = activeLease.current;
          if (!lease || lease.deadline <= performance.now()) { stop(); return; }
          if (!valid()) return;
          setBusy(false);
          setReveal(lease);
          setRemaining(lease.remainingMs + Math.max(0, lease.deadline - performance.now()));
          setMessage('Revealed · release to hide');
          const until = accessibleEnd.current === null ? Infinity : accessibleEnd.current - performance.now();
          if (until <= 0) { stop(); return; }
          if (lease.remainingMs === 0 || until < lease.deadline - performance.now()) {
            timer.current = setTimeout(() => { setRemaining(lease.remainingMs); stop(); }, Math.max(1, Math.min(until, lease.deadline - performance.now())));
          } else timer.current = setTimeout(() => { void tick(); }, Math.max(30, lease.deadline - performance.now() - 600));
        } catch (error) {
          if (!valid()) return;
          if (error instanceof SharingError && error.code === 'renew_later') {
            timer.current = setTimeout(() => { void tick(); }, 50);
            return;
          }
          stop();
          setMessage(error instanceof SharingError && error.code === 'exhausted' ? 'Your viewing time is used up.' : 'This moment is unavailable. Try again in a moment.');
          if (error instanceof SharingError && error.code === 'exhausted') setRemaining(0);
        }
      };
      await tick();
    } catch { if (valid()) { stop(); setMessage('Sign in to view this moment.'); } }
  };

  useEffect(() => {
    if (!reveal) return;
    const timer = setInterval(() => {
      const left = reveal.deadline - performance.now();
      setRemaining(Math.max(0, reveal.remainingMs + left));
      if (left <= 0) {
        // A slow renewal may still be in flight. Cover immediately until it grants a fresh lease.
        setReveal(null);
        setMessage('Opening your next glimpse…');
      }
    }, 50);
    return () => clearInterval(timer);
  }, [reveal, stop]);

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
          style={StyleSheet.absoluteFill} resizeMode="contain" onError={mediaFailed} /> : <ReceivedVideo reveal={reveal} onError={mediaFailed} position={videoPosition} />
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
