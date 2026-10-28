import { clearEmailConfirmationStorage, getEmailConfirmationClient, SharingError } from './sharing-client';
import { emailCallback, emailRedirectUrl } from './auth-links';

let revision = 0;
let pending: ReturnType<typeof emailCallback> = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const invalid = () => new SharingError('This confirmation link is expired or unavailable. Request another email from Sign in.', 'invalid_confirmation');
const cancelled = () => new SharingError('Email confirmation was cancelled.', 'cancelled');
function serialized<T>(action: () => Promise<T>) { const result = queue.catch(() => undefined).then(action); queue = result.catch(() => undefined); return result; }
function current(id: number, signal?: AbortSignal) { if (id !== revision || signal?.aborted) throw cancelled(); }
export function receiveEmailConfirmationUrl(path: string) {
  const value = emailCallback(path, 'confirmation');
  if (!value) return false;
  revision++;
  pending = value;
  for (const listener of listeners) listener();
  return true;
}
export const emailConfirmationRevision = () => revision;
export function subscribeEmailConfirmation(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function requestEmailConfirmation(email: string, password: string | null, signal?: AbortSignal) {
  return serialized(async () => {
    if (signal?.aborted) throw cancelled();
    const address = email.trim();
    if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new SharingError('Enter your email address first.');
    if (password !== null && password.length < 8) throw new SharingError('Use at least 8 characters for your password.');
    try {
      await getEmailConfirmationClient(signal);
      await clearEmailConfirmationStorage();
      const client = await getEmailConfirmationClient(signal);
      const options = { emailRedirectTo: emailRedirectUrl('confirmation') };
      const result = password === null ? await client.auth.resend({ type: 'signup', email: address, options })
        : await client.auth.signUp({ email: address, password, options });
      if (signal?.aborted) throw cancelled();
      if (result.error) throw new SharingError(result.error.status === 429 || result.error.code === 'over_email_send_rate_limit'
        ? 'Please wait before requesting another confirmation email.'
        : 'The confirmation email could not be requested. Please try again later.');
      if (result.data.session) await clearEmailConfirmationStorage();
      // Never reveal whether an existing account was found, or adopt a session
      // if a backend has accidentally disabled confirmation.
      return 'If this email needs confirmation, a link will be sent. Open the newest email on this device, then sign in. Check spam if it does not arrive.';
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof SharingError) throw error;
      throw new SharingError('The confirmation email could not be requested. Please try again later.');
    }
  });
}
export function completeEmailConfirmation(id: number, signal?: AbortSignal) {
  const value = id === revision ? pending : null;
  if (id === revision) pending = null;
  return serialized(async () => {
    try {
      current(id, signal);
      if (!value?.code) throw invalid();
      const client = await getEmailConfirmationClient(signal);
      current(id, signal);
      const result = await client.auth.exchangeCodeForSession(value.code, value.flowId ? { flowId: value.flowId } : undefined);
      current(id, signal);
      const data = result.data as typeof result.data & { redirectType?: string | null };
      if (result.error || data.redirectType === 'recovery' || !data.session?.user.email_confirmed_at) throw invalid();
    } catch (error) {
      if (id !== revision || signal?.aborted) throw cancelled();
      if (error instanceof SharingError) throw error;
      throw invalid();
    } finally { await clearEmailConfirmationStorage(); }
  });
}
export function cancelEmailConfirmation(id: number) {
  if (id !== revision) return;
  revision++; pending = null;
  void serialized(clearEmailConfirmationStorage).catch(() => undefined);
}
