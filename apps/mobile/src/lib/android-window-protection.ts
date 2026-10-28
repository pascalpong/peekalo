import { randomUUID } from 'expo-crypto';
import { preventScreenCaptureAsync } from 'expo-screen-capture';

// This Android Activity baseline lasts for the JavaScript process. Root remounts
// must neither release it nor leave a gap between protection owners.
let acquisition: Promise<void> | null = null;

export function acquireAndroidWindowProtection(): Promise<void> {
  if (acquisition) return acquisition;

  const pending = Promise.resolve().then(() => {
    // Expo retains a key even when its native acquisition rejects. A fresh key
    // makes retries reach native code instead of resolving from that stale tag.
    return preventScreenCaptureAsync(`peekalo-android-window-${randomUUID()}`);
  });
  acquisition = pending;
  void pending.catch(() => {
    if (acquisition === pending) acquisition = null;
  });
  return pending;
}
