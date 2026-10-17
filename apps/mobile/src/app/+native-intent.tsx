// The Google sign-in redirect is consumed by expo-web-browser's auth session.
// Without this, Expo Router would also try to open it as a screen and leave the
// camera, which discards the capture being shared.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (/^peekalo:\/\/auth-callback\b/.test(path)) return initial ? '/' : null;
  return path;
}
