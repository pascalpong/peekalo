import { clearPasswordRecoveryStorage, getPasswordRecoveryClient, SharingError } from './sharing-client';

export const passwordRecoveryRedirectUrl = 'peekalo://reset-password';
const invalidLink = () => new SharingError('This reset link is expired or unavailable. Request a new email from Sign in.', 'invalid_recovery');
const cancelled = () => new SharingError('Password recovery was cancelled.', 'cancelled');
let revision = 0;
let pendingCode: string | null = null;
let ready: { revision: number; userId: string } | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.catch(() => undefined).then(operation);
  queue = result.catch(() => undefined);
  return result;
}
function current(id: number, signal?: AbortSignal) {
  if (id !== revision || signal?.aborted) throw cancelled();
}

/** Consume callback data before Expo Router builds a route/navigation state. */
export function receivePasswordRecoveryUrl(path: string) {
  let url: URL;
  try { url = new URL(path); } catch { return false; }
  if (url.protocol !== 'peekalo:' || url.hostname !== 'reset-password') return false;
  revision++;
  ready = null;
  const codes = url.searchParams.getAll('code');
  pendingCode = !url.username && !url.password && !url.port && (!url.pathname || url.pathname === '/') && !url.hash
    && !url.searchParams.has('error') && !url.searchParams.has('error_code')
    && !url.searchParams.has('access_token') && !url.searchParams.has('refresh_token')
    && codes.length === 1 && /^[a-zA-Z0-9_-]{1,2048}$/.test(codes[0]) ? codes[0] : null;
  for (const listener of listeners) listener();
  return true;
}

export const passwordRecoveryRevision = () => revision;
export function subscribePasswordRecovery(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function requestPasswordRecovery(email: string, signal?: AbortSignal) {
  return serialized(async () => {
    if (signal?.aborted) throw cancelled();
    const address = email.trim();
    if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new SharingError('Enter your email address first.');
    try {
      await getPasswordRecoveryClient(signal);
      await clearPasswordRecoveryStorage();
      const client = await getPasswordRecoveryClient(signal);
      const { error } = await client.auth.resetPasswordForEmail(address, { redirectTo: passwordRecoveryRedirectUrl });
      if (signal?.aborted) throw cancelled();
      if (error) throw new SharingError(error.code === 'over_email_send_rate_limit' || error.status === 429
        ? 'Please wait before requesting another reset email.'
        : 'The reset email could not be requested. Please try again later.');
      // Identical wording for existing and unknown accounts; delivery is not promised.
      return 'If an account uses that email, a reset link will be sent. Open it on this device. If it does not arrive, ask the app owner to check email delivery.';
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof SharingError) throw error;
      throw new SharingError('The reset email could not be requested. Please try again later.');
    }
  });
}

export function preparePasswordRecovery(id: number, signal?: AbortSignal) {
  const code = id === revision ? pendingCode : null;
  if (id === revision) pendingCode = null; // Never exchange a callback twice.
  return serialized(async () => {
    try {
      current(id, signal);
      if (!code) throw invalidLink();
      const client = await getPasswordRecoveryClient(signal);
      current(id, signal);
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      current(id, signal);
      // The marker comes from the securely stored PKCE verifier, not URL input.
      // auth-js returns this marker at runtime; AuthTokenResponse's public type
      // omits it in 2.117.3, so missing markers fail closed as well.
      const recoveryData = data as typeof data & { redirectType?: string | null };
      if (error || recoveryData.redirectType !== 'recovery' || !data.session?.user.id) throw invalidLink();
      ready = { revision: id, userId: data.session.user.id };
    } catch (error) {
      await clearPasswordRecoveryStorage();
      if (id !== revision || signal?.aborted) throw cancelled();
      if (error instanceof SharingError) throw error;
      throw invalidLink();
    }
  });
}

export function updateRecoveredPassword(id: number, password: string, signal?: AbortSignal) {
  return serialized(async () => {
    current(id, signal);
    if (password.length < 8) throw new SharingError('Use at least 8 characters for your new password.');
    if (ready?.revision !== id) throw invalidLink();
    try {
      const client = await getPasswordRecoveryClient(signal);
      const { data: restored, error: sessionError } = await client.auth.getSession();
      current(id, signal);
      if (sessionError || restored.session?.user.id !== ready.userId) throw invalidLink();
      const { error } = await client.auth.updateUser({ password });
      current(id, signal);
      if (error) {
        if (error.status === 401 || error.status === 403 || error.code === 'session_not_found') {
          ready = null;
          await clearPasswordRecoveryStorage();
          throw invalidLink();
        }
        throw new SharingError(error.code === 'same_password' ? 'Choose a password different from your old password.' : 'Your password could not be updated. Please try again.');
      }
      ready = null;
      await clearPasswordRecoveryStorage();
      current(id, signal);
      // Require deliberate sign-in; never overwrite another account's login.
    } catch (error) {
      if (id !== revision || signal?.aborted) {
        await clearPasswordRecoveryStorage();
        throw cancelled();
      }
      if (error instanceof SharingError) throw error;
      throw new SharingError('Your password could not be updated. Please try again.');
    }
  });
}

export function cancelPasswordRecovery(id: number) {
  if (id !== revision) return;
  revision++;
  pendingCode = null;
  ready = null;
  // Cleanup follows any in-flight SDK write, including a late code exchange.
  void serialized(clearPasswordRecoveryStorage).catch(() => undefined);
}
