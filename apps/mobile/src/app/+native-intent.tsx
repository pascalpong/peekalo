// The Google sign-in redirect is consumed by expo-web-browser's auth session.
// Without this, Expo Router would also try to open it as a screen and leave the
// camera, which discards the capture being shared.
import { receiveEmailConfirmationUrl } from '../lib/auth-confirmation';
import { receivePasswordRecoveryUrl } from '../lib/auth-recovery';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (receiveEmailConfirmationUrl(path)) return '/confirm-email';
  if (receivePasswordRecoveryUrl(path)) return '/reset-password';
  if (/^peekalo:\/\/auth-callback\b/.test(path)) return initial ? '/' : null;
  return path;
}
