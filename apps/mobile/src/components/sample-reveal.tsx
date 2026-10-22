import Feather from '@expo/vector-icons/Feather';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { sampleReveal } from '../lib/sample-reveal';
import { colors, tokens, typography } from './ui';

// Metro resolves these static, non-sensitive demo assets at bundle time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hiddenImage = require('../../assets/morning-hidden.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const clearImage = require('../../assets/morning-clear.png');

export function SampleReveal() {
  const snapshot = useSyncExternalStore(sampleReveal.subscribe, sampleReveal.getSnapshot);
  const bounds = useRef({ width: 0, height: 0 });
  const intent = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const revealed = snapshot.status === 'revealing';
  const exhausted = snapshot.status === 'exhausted';
  const seconds = (Math.ceil(snapshot.remainingMs / 100) / 10).toFixed(1);
  const stop = useCallback(() => { intent.current = false; sampleReveal.stop(); }, []);

  useFocusEffect(useCallback(() => {
    sampleReveal.setEnabled(AppState.currentState === 'active');
    const change = AppState.addEventListener('change', state => {
      if (state !== 'active') stop();
      sampleReveal.setEnabled(state === 'active');
    });
    const blur = AppState.addEventListener('blur', () => { stop(); sampleReveal.setEnabled(false); });
    const focus = AppState.addEventListener('focus', () => sampleReveal.setEnabled(AppState.currentState === 'active'));
    return () => {
      stop();
      sampleReveal.setEnabled(false);
      change.remove(); blur.remove(); focus.remove();
    };
  }, [stop]));

  const reveal = (duration?: number) => { if (!failed) sampleReveal.start(duration); };
  return <View style={styles.viewer}>
    <View style={styles.meta}><Text style={styles.tag}>LOCAL DEMO · ILLUSTRATION</Text><Text style={styles.time}>{seconds}s left</Text></View>
    <Pressable style={styles.card} accessible accessibilityRole="button" disabled={exhausted || failed}
      accessibilityLabel={revealed ? 'Sample revealed: a coffee cup, orange and a potted plant' : exhausted ? 'Viewing time used up' : failed ? 'Sample unavailable' : 'Hold to reveal sample'}
      accessibilityHint="Hold still to reveal, release to hide. Activate for up to one second. Each reveal uses the same ten-second total."
      accessibilityState={{ disabled: exhausted || failed }}
      accessibilityActions={[{ name: 'activate', label: 'Reveal for up to one second' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') reveal(1_000); }}
      onLayout={event => { bounds.current = event.nativeEvent.layout; }}
      delayLongPress={180}
      onPressIn={event => {
        const { locationX: x, locationY: y } = event.nativeEvent;
        intent.current = event.nativeEvent.touches.length === 1;
        origin.current = { x, y };
      }}
      onLongPress={() => { if (intent.current) reveal(); }}
      onPressOut={stop}
      onResponderStart={event => { if (event.nativeEvent.touches.length !== 1) stop(); }}
      onTouchStart={event => { if (event.nativeEvent.touches.length !== 1) stop(); }}
      onTouchMove={event => {
        const { locationX: x, locationY: y, touches } = event.nativeEvent;
        if (touches.length !== 1 || x < 0 || y < 0 || x > bounds.current.width || y > bounds.current.height || Math.hypot(x - origin.current.x, y - origin.current.y) > 10) stop();
      }}
      onTouchEnd={stop} onTouchCancel={stop}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Image style={StyleSheet.absoluteFill} source={hiddenImage} resizeMode="cover" />
        {revealed && <Image style={StyleSheet.absoluteFill} source={clearImage} resizeMode="cover"
          onError={() => { sampleReveal.setEnabled(false); setFailed(true); }} />}
        {!revealed && <View style={styles.cover}>
          <View style={styles.circle}><Feather name={exhausted ? 'check' : 'eye'} size={30} color="#fff" /></View>
          <Text style={styles.prompt}>{failed ? 'Sample unavailable' : exhausted ? 'A moment, remembered.' : 'Hold to reveal'}</Text>
          <Text style={styles.hint}>{failed ? 'Close and reopen to try again.' : exhausted ? 'Your viewing time is used up.' : 'Release to hide · Up to 10 seconds total'}</Text>
        </View>}
      </View>
    </Pressable>
    <Text accessibilityLiveRegion="polite" style={styles.status}>{revealed ? 'Revealed · release to hide' : exhausted ? 'Your viewing time is used up.' : failed ? 'Sample couldn’t load.' : 'Hidden · hold the image to reveal'}</Text>
    <Pressable accessibilityRole="button" disabled={exhausted || failed} onPress={() => reveal(1_000)}
      style={[styles.accessibleButton, (exhausted || failed) && styles.disabled]}>
      <Feather name="eye" size={16} color={colors.text} /><Text style={styles.buttonText}>Reveal for 1 second</Text>
    </Pressable>
    <Text style={typography.small}>This button uses the same allowance. Closing this screen keeps the remaining time; restarting the app resets this local demo.</Text>
  </View>;
}

const styles = StyleSheet.create({
  viewer: { gap: 14 },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  tag: { color: colors.muted, fontSize: 9, letterSpacing: 0.8 },
  time: { color: colors.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  card: { width: '100%', aspectRatio: 9 / 16, borderRadius: 20, backgroundColor: '#b99c88', overflow: 'hidden' },
  cover: { flex: 1, backgroundColor: '#080a0966', justifyContent: 'center', alignItems: 'center', gap: 16, padding: 22 },
  circle: { width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: '#ffffff88', alignItems: 'center', justifyContent: 'center' },
  prompt: { color: '#fff', fontFamily: tokens.font.display, fontSize: 23, textAlign: 'center' },
  hint: { color: '#fff', fontSize: 11, textAlign: 'center' },
  status: { color: colors.text, fontSize: 12, textAlign: 'center', minHeight: 20 },
  accessibleButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 28, padding: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, minHeight: 48 },
  buttonText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
