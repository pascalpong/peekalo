import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { colors, tokens } from '../components/ui';
import { acquireAndroidWindowProtection } from '../lib/android-window-protection';

export default function RootLayout() {
  const [protection, setProtection] = useState(Platform.OS === 'android' ? 'pending' : 'ready');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let alive = true;
    // Keep the native Activity's baseline through route cleanup/root remounts.
    void acquireAndroidWindowProtection().then(() => {
      if (alive) setProtection('ready');
    }).catch(() => { if (alive) setProtection('failed'); });
    return () => { alive = false; };
  }, [attempt]);
  const [fontsLoaded, fontError] = useFonts({
    // Static workspace asset, bundled by Metro for offline use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    [tokens.font.display]: require('@peekalo/design/fonts/display.ttf'),
  });
  if (!fontsLoaded && !fontError) return null;
  if (protection !== 'ready') return <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: 24 }}>
    <Text style={{ color: colors.text }}>{protection === 'failed' ? 'Screen protection couldn’t start.' : 'Starting Peekalo…'}</Text>
    {protection === 'failed' && <Pressable accessibilityRole="button" onPress={() => { setProtection('pending'); setAttempt(value => value + 1); }}>
      <Text style={{ color: colors.accent, paddingVertical: 16 }}>Try again</Text>
    </Pressable>}
  </View>;
  return <>
    <StatusBar style="light" />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="sample" options={{ presentation: 'modal' }} />
    </Stack>
  </>;
}
