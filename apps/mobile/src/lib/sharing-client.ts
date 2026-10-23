import 'react-native-url-polyfill/auto';
import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { AppState } from 'react-native';

export class SharingError extends Error {
  constructor(message: string, readonly code = 'unavailable') { super(message); }
}

export function resolveApiUrl(path: string) {
  // Expo's development env module prefers .env.local over shell API values.
  // A separate development-only flag selects the isolated test backend.
  const localTesting = __DEV__ && process.env.EXPO_PUBLIC_PEEKALO_LOCAL_TESTING === 'true';
  const base = localTesting ? 'http://127.0.0.1:3101' : process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');
  if (!base) throw new SharingError('Sharing is not connected yet. Please try again after the server is configured.', 'not_configured');
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && __DEV__)) {
    throw new SharingError('Sharing needs a secure server connection.', 'not_configured');
  }
  if (!path.startsWith('/') || path.startsWith('//')) throw new SharingError('This request is unavailable.');
  return `${base}${path}`;
}

export const newIdempotencyKey = () => Crypto.randomUUID();

// Keychain values can have a roughly 2 KB limit. Rotate a small manifest only
// after every encrypted chunk is written, so an interrupted write is not read.
const storageOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
type Manifest = { generation: string; count: number };
const storageQueues = new Map<string, Promise<unknown>>();
const storageKey = (key: string) => `peekalo.${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (storageQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  storageQueues.set(key, next);
  void next.finally(() => { if (storageQueues.get(key) === next) storageQueues.delete(key); }).catch(() => undefined);
  return next;
}

async function readManifest(key: string): Promise<Manifest | null> {
  const value = await SecureStore.getItemAsync(key, storageOptions);
  if (!value) return null;
  try {
    const data = JSON.parse(value) as Manifest;
    return /^[a-f0-9-]{36}$/.test(data.generation) && Number.isInteger(data.count) && data.count > 0 && data.count < 256 ? data : null;
  } catch { return null; }
}

async function deleteChunks(key: string, manifest: Manifest | null) {
  if (manifest) await Promise.all(Array.from({ length: manifest.count }, (_, i) =>
    SecureStore.deleteItemAsync(`${key}.${manifest.generation}.${i}`, storageOptions)));
}

const sessionStorage = {
  getItem(key: string) {
    const safeKey = storageKey(key);
    return serialized(safeKey, async () => {
      const manifest = await readManifest(safeKey);
      if (!manifest) return null;
      const chunks = await Promise.all(Array.from({ length: manifest.count }, (_, i) =>
        SecureStore.getItemAsync(`${safeKey}.${manifest.generation}.${i}`, storageOptions)));
      return chunks.some(chunk => chunk === null) ? null : chunks.join('');
    });
  },
  setItem(key: string, value: string) {
    const safeKey = storageKey(key);
    return serialized(safeKey, async () => {
      const previous = await readManifest(safeKey);
      const points = Array.from(value);
      const chunks = Array.from({ length: Math.max(1, Math.ceil(points.length / 450)) }, (_, i) => points.slice(i * 450, (i + 1) * 450).join(''));
      if (chunks.length >= 256) throw new SharingError('Your sign-in could not be saved securely. Please try again.');
      const manifest = { generation: Crypto.randomUUID(), count: chunks.length };
      try {
        for (let i = 0; i < chunks.length; i++) {
          await SecureStore.setItemAsync(`${safeKey}.${manifest.generation}.${i}`, chunks[i], storageOptions);
        }
        await SecureStore.setItemAsync(safeKey, JSON.stringify(manifest), storageOptions);
      } catch {
        await deleteChunks(safeKey, manifest).catch(() => undefined);
        throw new SharingError('Your sign-in could not be saved securely. Please try again.');
      }
      await deleteChunks(safeKey, previous).catch(() => undefined);
    });
  },
  removeItem(key: string) {
    const safeKey = storageKey(key);
    return serialized(safeKey, async () => {
      const previous = await readManifest(safeKey);
      await SecureStore.deleteItemAsync(safeKey, storageOptions);
      await deleteChunks(safeKey, previous);
    });
  },
};

let clientPromise: Promise<SupabaseClient> | undefined;
let authConfig: { supabaseUrl: string; supabaseAnonKey: string } | undefined;
let recoveryClient: SupabaseClient | undefined;
let recoveryStorageKey: string | undefined;
let recoverySession: string | null = null;

// Recovery verifiers survive opening email with the app closed. Its session is
// deliberately memory-only and never becomes the ordinary app's login.
export async function getPasswordRecoveryClient(signal?: AbortSignal) {
  await getSharingClient(signal);
  checkCancelled(signal);
  if (!recoveryClient) {
    recoveryStorageKey = `recovery-${new URL(authConfig!.supabaseUrl).host}`;
    const key = recoveryStorageKey;
    const indexKey = `${key}-stored-keys`;
    const storage = {
      getItem: (name: string) => name === key ? Promise.resolve(recoverySession) : sessionStorage.getItem(name),
      async setItem(name: string, value: string) {
        if (name === key) { recoverySession = value; return; }
        await serialized(indexKey, async () => {
          const keys = JSON.parse(await sessionStorage.getItem(indexKey) ?? '[]') as string[];
          if (!keys.includes(name)) await sessionStorage.setItem(indexKey, JSON.stringify([...keys, name]));
          await sessionStorage.setItem(name, value);
        });
      },
      async removeItem(name: string) {
        if (name === key) recoverySession = null;
        else await sessionStorage.removeItem(name);
      },
    };
    recoveryClient = createClient(authConfig!.supabaseUrl, authConfig!.supabaseAnonKey, {
      auth: { storage, storageKey: key, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', lock: processLock },
    });
    recoveryClient.auth.stopAutoRefresh();
  }
  return recoveryClient;
}

export async function clearPasswordRecoveryStorage() {
  recoverySession = null;
  if (!recoveryStorageKey) return;
  const key = `${recoveryStorageKey}-stored-keys`;
  await serialized(key, async () => {
    const keys = JSON.parse(await sessionStorage.getItem(key) ?? '[]') as string[];
    await Promise.all(keys.map(name => sessionStorage.removeItem(name)));
    await sessionStorage.removeItem(key);
  });
  // Discard the SDK's in-memory session too; it is not used for normal sign-in.
  recoveryClient = undefined;
}

async function requestWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
  if (options.signal?.aborted) throw new SharingError('The request was cancelled.', 'cancelled');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  const signal = options.signal;
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

const cancelled = () => new SharingError('The request was cancelled.', 'cancelled');
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

// A screen may stop waiting without cancelling another screen's shared bootstrap.
function waitForClient(promise: Promise<SupabaseClient>, signal?: AbortSignal): Promise<SupabaseClient> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(cancelled()); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void promise.then(value => {
      signal.removeEventListener('abort', cancel);
      if (!signal.aborted) resolve(value);
    }, error => {
      signal.removeEventListener('abort', cancel);
      if (!signal.aborted) reject(error);
    });
  });
}

export function getSharingClient(signal?: AbortSignal): Promise<SupabaseClient> {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (!clientPromise) {
    clientPromise = (async () => {
      let response: Response;
      try { response = await requestWithTimeout(resolveApiUrl('/api/shares/config'), { cache: 'no-store' }, 90_000); }
      catch (error) {
        if (error instanceof SharingError) throw error;
        throw new SharingError('Cannot reach Peekalo. Check your connection and try again.');
      }
      if (!response.ok) throw new SharingError('Sharing is not available right now. Please try again.');
      const config = await response.json() as { ready?: boolean; supabaseUrl?: string; supabaseAnonKey?: string };
      if (!config.ready || !config.supabaseUrl || !config.supabaseAnonKey || config.supabaseAnonKey.startsWith('sb_secret_')) {
        throw new SharingError('Sharing is not connected yet. Please try again after the server is configured.', 'not_configured');
      }
      authConfig = { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey };
      // PKCE keeps OAuth tokens out of the redirect URL; the verifier stays in secure storage.
      const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce', lock: processLock },
      });
      if (AppState.currentState === 'active') client.auth.startAutoRefresh();
      else client.auth.stopAutoRefresh();
      AppState.addEventListener('change', state => {
        if (state === 'active') client.auth.startAutoRefresh();
        else client.auth.stopAutoRefresh();
      });
      return client;
    })().catch(error => { clientPromise = undefined; throw error; });
  }
  return waitForClient(clientPromise, signal);
}

// Must match an entry in Supabase Auth > URL Configuration > Redirect URLs.
export const authRedirectUrl = 'peekalo://auth-callback';

export type AuthProviders = { google: boolean | null; email: boolean | null };

export async function getAuthProviders(signal?: AbortSignal): Promise<AuthProviders> {
  await getSharingClient(signal);
  checkCancelled(signal);
  try {
    const response = await requestWithTimeout(`${authConfig!.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: authConfig!.supabaseAnonKey }, cache: 'no-store', signal,
    }, 15_000);
    if (!response.ok) return { google: null, email: null };
    const settings = await response.json() as { external?: Record<string, boolean> };
    checkCancelled(signal);
    return {
      google: typeof settings.external?.google === 'boolean' ? settings.external.google : null,
      email: typeof settings.external?.email === 'boolean' ? settings.external.email : null,
    };
  } catch {
    checkCancelled(signal);
    return { google: null, email: null };
  }
}

/** Returns false when the person closes the Google sheet without signing in. */
export async function signInWithGoogle(signal?: AbortSignal): Promise<boolean> {
  const client = await getSharingClient(signal);
  const providers = await getAuthProviders(signal);
  if (providers.google === false) throw new SharingError('Google sign-in is not configured on this test backend yet.', 'not_configured');
  if (providers.google === null) throw new SharingError('Cannot check Google sign-in right now. Check your connection and try again.');
  checkCancelled(signal);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authRedirectUrl, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  checkCancelled(signal);
  if (error || !data.url) throw new SharingError('Google sign-in could not start. Please try again.');
  const dismiss = () => { try { WebBrowser.dismissAuthSession(); } catch { /* The sheet may already be closed. */ } };
  signal?.addEventListener('abort', dismiss, { once: true });
  let result: WebBrowser.WebBrowserAuthSessionResult;
  try { result = await WebBrowser.openAuthSessionAsync(data.url, authRedirectUrl); }
  finally { signal?.removeEventListener('abort', dismiss); }
  checkCancelled(signal);
  if (result.type !== 'success') return false;
  const redirect = new URL(result.url);
  const expected = new URL(authRedirectUrl);
  const code = redirect.searchParams.get('code');
  if (redirect.protocol !== expected.protocol || redirect.host !== expected.host || redirect.pathname !== expected.pathname || !code) {
    throw new SharingError('Google sign-in did not finish. Please try again.');
  }
  const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
  checkCancelled(signal);
  if (exchangeError) throw new SharingError('Google sign-in did not finish. Please try again.');
  return true;
}

const errorMessages: Record<string, string> = {
  unauthorized: 'Please sign in again to continue.',
  sign_in_required: 'Please sign in again to continue.',
  username_taken: 'That username is taken. Please choose another.',
  invalid_username: 'Use 3–24 letters, numbers or underscores for your username.',
  recipient_not_found: 'That username was not found. Check the spelling and try again.',
  cannot_share_with_self: 'Choose someone else’s username.',
  self_recipient: 'Choose someone else’s username.',
  not_found: 'This item is unavailable. Check the username and try again.',
  invalid_media: 'This capture could not be processed. Please retake it.',
  media_too_large: 'This capture is too large. Please try a shorter video.',
  file_too_large: 'This capture is too large. Please try a shorter video.',
  processing_failed: 'This capture could not be processed. Please retake it.',
  upload_in_progress: 'This capture is still being prepared. Wait a moment, then try the same action again.',
  upload_failed: 'The upload did not finish. Check your connection and try the same action again.',
  request_timeout: 'The upload took too long. Check your connection and try the same action again.',
  processing_busy: 'Another capture is being prepared. Wait a moment and try again.',
  sharing_unavailable: 'Peekalo sharing is temporarily unavailable. Please try again.',
  rate_limited: 'Too many attempts. Wait a moment, then try again.',
  limit_reached: 'Your active media limit has been reached.',
  active_limit: 'Your active media limit has been reached.',
  conflict: 'This action changed while it was being retried. Close sharing and try again.',
  idempotency_conflict: 'This action changed while it was being retried. Close sharing and try again.',
};

export async function apiRequest<T>(path: string, options: {
  method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal;
} = {}): Promise<T> {
  checkCancelled(options.signal);
  const client = await getSharingClient(options.signal);
  const { data, error } = await client.auth.getSession();
  checkCancelled(options.signal);
  if (error || !data.session) throw new SharingError(errorMessages.unauthorized, 'unauthorized');
  const multipart = options.body instanceof FormData;
  let response: Response;
  try {
    response = await requestWithTimeout(resolveApiUrl(path), {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(!multipart && options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers, Authorization: `Bearer ${data.session.access_token}`,
      },
      body: options.body === undefined ? undefined : options.body instanceof FormData ? options.body : JSON.stringify(options.body),
      signal: options.signal,
      cache: 'no-store',
    }, multipart ? 120_000 : 30_000);
  } catch (error) {
    if (options.signal?.aborted) throw new SharingError('The request was cancelled.', 'cancelled');
    if (error instanceof SharingError) throw error;
    throw new SharingError('Cannot reach Peekalo. Check your connection and try again.');
  }
  checkCancelled(options.signal);
  const result = await response.json().catch(() => null);
  checkCancelled(options.signal);
  if (!response.ok) {
    const code = response.status === 401 ? 'unauthorized' : typeof result?.error === 'string' ? result.error : typeof result?.code === 'string' ? result.code : 'unavailable';
    throw new SharingError(response.status === 401 ? errorMessages.unauthorized : errorMessages[code] ?? 'This action did not finish. Please try again.', code);
  }
  return result as T;
}
