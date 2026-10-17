export type RevealSnapshot = Readonly<{
  status: 'hidden' | 'revealing' | 'exhausted';
  remainingMs: number;
}>;

type Options = {
  budgetMs: number;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
};

/** Interaction prototype only. No identities, persistence or server entitlement.
 * Keep one instance per sample for the runtime so navigation cannot refill it.
 * A suspended/modified client can retain pixels; this is not capture protection.
 */
export function createLocalRevealSession({ budgetMs, now, schedule }: Options) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Invalid reveal budget.');
  let snapshot: RevealSnapshot = Object.freeze({ status: 'hidden', remainingMs: budgetMs });
  let enabled = false;
  let previous = 0;
  let stopAt = Infinity;
  let generation = 0;
  let cancelTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function cancel() {
    generation++;
    cancelTimer?.();
    cancelTimer = null;
  }

  function publish(status: RevealSnapshot['status'], remainingMs: number) {
    if (snapshot.status === status && snapshot.remainingMs === remainingMs) return;
    snapshot = Object.freeze({ status, remainingMs });
    listeners.forEach(listener => listener());
  }

  function account() {
    const value = now();
    // Fail closed on an invalid clock; a clock going backwards never refunds time.
    const current = Number.isFinite(value) ? Math.max(previous, value) : Infinity;
    const remaining = Math.max(0, snapshot.remainingMs - (current - previous));
    previous = current;
    return remaining;
  }

  function stop() {
    cancel();
    if (snapshot.status !== 'revealing') return;
    const remaining = account();
    publish(remaining === 0 ? 'exhausted' : 'hidden', remaining);
  }

  function tick() {
    if (snapshot.status !== 'revealing') return;
    const remaining = account();
    if (remaining === 0 || previous >= stopAt) {
      cancel();
      publish(remaining === 0 ? 'exhausted' : 'hidden', remaining);
      return;
    }
    const token = generation;
    publish('revealing', remaining);
    // A listener may synchronously hide/disable the viewer.
    if (snapshot.status !== 'revealing' || token !== generation) return;
    cancelTimer = schedule(() => { if (token === generation) tick(); }, Math.min(50, remaining, stopAt - previous));
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) stop();
    },
    start(maxDurationMs = Infinity) {
      if (!enabled || snapshot.status !== 'hidden' || maxDurationMs <= 0 || Number.isNaN(maxDurationMs)) return false;
      previous = now();
      if (!Number.isFinite(previous)) {
        publish('exhausted', 0);
        return false;
      }
      stopAt = previous + maxDurationMs;
      const token = generation;
      publish('revealing', snapshot.remainingMs);
      if (token === generation) tick();
      return (snapshot as RevealSnapshot).status === 'revealing';
    },
    stop,
  };
}
