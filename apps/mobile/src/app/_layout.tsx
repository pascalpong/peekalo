import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors, tokens } from '../components/ui';

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    // Static workspace asset, bundled by Metro for offline use.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    [tokens.font.display]: require('@peekalo/design/fonts/display.ttf'),
  });
  if (!fontsLoaded && !fontError) return null;
  return <>
    <StatusBar style="light" />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="sample" options={{ presentation: 'modal' }} />
    </Stack>
  </>;
}
