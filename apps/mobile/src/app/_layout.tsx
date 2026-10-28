import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, tokens } from '../components/ui';
import { acquireAndroidWindowProtection } from '../lib/android-window-protection';
import { captureGuard, captureGuardAllowsReveal } from '../lib/capture-guard';

export default function RootLayout() {
  const [protection, setProtection] = useState(Platform.OS === 'android' ? 'pending' : 'ready');
  const [attempt, setAttempt] = useState(0);
  const [navigationOpened, setNavigationOpened] = useState(Platform.OS !== 'android');
  const guard = useSyncExternalStore(captureGuard.subscribe, captureGuard.getSnapshot, captureGuard.getSnapshot);
  const windowFocused = useRef(true);
  const usable = protection === 'ready' && captureGuardAllowsReveal(guard);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    // Keep the native Activity's baseline through route cleanup/root remounts.
    void acquireAndroidWindowProtection().then(() => {
      if (alive) setProtection('ready');
    }).catch(() => { if (alive) setProtection('failed'); });
    if (windowFocused.current && AppState.currentState === 'active') void captureGuard.refresh();
    else captureGuard.suspend();
    return () => { alive = false; };
  }, [attempt]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const resume = () => {
      if (windowFocused.current && AppState.currentState === 'active') void captureGuard.refresh();
    };
    const change = AppState.addEventListener('change', state => {
      if (state !== 'active') captureGuard.suspend();
      else resume();
    });
    const blur = AppState.addEventListener('blur', () => { windowFocused.current = false; captureGuard.suspend(); });
    const focus = AppState.addEventListener('focus', () => { windowFocused.current = true; resume(); });
    return () => { change.remove(); blur.remove(); focus.remove(); captureGuard.stop(); };
  }, []);
  useEffect(() => { if (usable) setNavigationOpened(true); }, [usable]);
  const [fontsLoaded, fontError] = useFonts({
    // Static workspace asset, bundled by Metro for offline use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    [tokens.font.display]: require('@peekalo/design/fonts/display.ttf'),
  });
  if (!fontsLoaded && !fontError) return null;
  const failed = protection === 'failed' || guard.status === 'unavailable';
  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <StatusBar style="light" />
    {navigationOpened && <View style={{ flex: 1 }} pointerEvents={usable ? 'auto' : 'none'}
      importantForAccessibility={usable ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!usable}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="sample" options={{ presentation: 'modal' }} />
      </Stack>
    </View>}
    {!usable && <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background, justifyContent: 'center', padding: tokens.space.lg }]}
      accessibilityViewIsModal importantForAccessibility="yes">
      <Text style={{ color: colors.text, fontFamily: tokens.font.display, fontSize: tokens.type.section }}>{guard.status === 'recording' ? 'Stop screen recording to use Peekalo.' : failed ? 'Screen protection couldn’t start.' : 'Starting Peekalo…'}</Text>
      {failed && <Pressable accessibilityRole="button" onPress={() => { setProtection('pending'); setAttempt(value => value + 1); }}>
        <Text style={{ color: colors.accent, paddingVertical: tokens.space.md, fontSize: tokens.type.body }}>Try again</Text>
      </Pressable>}
    </View>}
  </View>;
}
