import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type CaptureGuardStatus = 'pending' | 'clear' | 'recording' | 'unavailable' | 'unsupported';
export type CaptureGuardSnapshot = Readonly<{ status: CaptureGuardStatus; revision: number }>;
type NativeState = Readonly<{ status: Exclude<CaptureGuardStatus, 'pending'>; revision: number }>;
type NativeGuard = {
  start(): Promise<unknown>;
  addListener(event: 'onCaptureStateChanged', callback: (state: unknown) => void): { remove(): void };
};

function validState(value: unknown): value is NativeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<NativeState>;
  return ['clear', 'recording', 'unavailable', 'unsupported'].includes(state.status ?? '') &&
    typeof state.revision === 'number' && Number.isSafeInteger(state.revision) && state.revision >= 0;
}

// Per-root lifecycle owner. Creating/subscribing does not touch native modules,
// so iOS can retain its existing protection path without Android native calls.
export function createCaptureGuard() {
  let snapshot: CaptureGuardSnapshot = Object.freeze({ status: 'pending', revision: -1 });
  let latest: NativeState | null = null;
  let native: NativeGuard | null = null;
  let subscription: { remove(): void } | null = null;
  let listenerTurn = 0;
  let requestTurn = 0;
  let foreground = false;
  let initialized = false;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function publish(status: CaptureGuardStatus) {
    const revision = latest?.revision ?? -1;
    if (snapshot.status === status && snapshot.revision === revision) return;
    snapshot = Object.freeze({ status, revision });
    listeners.forEach(listener => listener());
  }
  function accept(value: unknown) {
    if (!validState(value)) throw new Error('Invalid capture protection state');
    if (value.status === 'unsupported' && !(typeof Platform.Version === 'number' && Platform.Version < 35)) throw new Error('Capture protection unexpectedly unsupported');
    if (latest && value.revision < latest.revision) return;
    if (latest && value.revision === latest.revision && value.status !== latest.status) throw new Error('Conflicting capture protection state');
    latest = Object.freeze({ status: value.status, revision: value.revision });
  }
  function expose() {
    if (!foreground) { publish('pending'); return; }
    // A recording event closes immediately, including during registration. A
    // clear event alone cannot open UI before start's initial query succeeds.
    if (latest?.status === 'recording') publish('recording');
    else publish(initialized && latest ? latest.status : snapshot.status === 'unavailable' ? 'unavailable' : 'pending');
  }
  function listen() {
    if (subscription) return;
    native = requireOptionalNativeModule<NativeGuard>('PeekaloCaptureGuard');
    if (!native || typeof native.start !== 'function' || typeof native.addListener !== 'function') throw new Error('Capture protection unavailable');
    const turn = ++listenerTurn;
    subscription = native.addListener('onCaptureStateChanged', value => {
      if (turn !== listenerTurn) return;
      try { accept(value); expose(); }
      catch {
        requestTurn++;
        pending = null;
        initialized = false;
        if (foreground) publish('unavailable');
      }
    });
    if (!subscription || typeof subscription.remove !== 'function') throw new Error('Capture protection listener unavailable');
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh(): Promise<void> {
      if (foreground && pending) return pending;
      foreground = true;
      initialized = false;
      publish('pending');
      const turn = ++requestTurn;
      const running = (async () => {
        try {
          // Expo 55 native modules are already EventEmitters. Attach first so a
          // newer recording event can fence an older initial clear snapshot.
          listen();
          const initial = await native!.start();
          if (turn !== requestTurn || !foreground) return;
          accept(initial);
          initialized = true;
          expose();
        } catch {
          if (turn === requestTurn && foreground) { initialized = false; publish('unavailable'); }
        }
      })();
      pending = running;
      void running.then(() => { if (pending === running) pending = null; });
      return running;
    },
    suspend() {
      foreground = false;
      initialized = false;
      requestTurn++;
      pending = null;
      publish('pending');
    },
    stop() {
      foreground = false;
      initialized = false;
      requestTurn++;
      pending = null;
      listenerTurn++;
      try { subscription?.remove(); } catch { /* Native destruction remains covered. */ }
      subscription = null;
      native = null;
      publish('pending');
    },
  };
}

export const captureGuard = createCaptureGuard();

export function captureGuardAllowsReveal(state = captureGuard.getSnapshot()): boolean {
  return Platform.OS !== 'android' || state.status === 'clear' ||
    (state.status === 'unsupported' && typeof Platform.Version === 'number' && Platform.Version < 35);
}
