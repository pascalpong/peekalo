import { apiRequest } from './sharing-client';

export type SocialCursor = { createdAt: string; id: string };
export type SocialPage<T> = { items: T[]; nextCursor: SocialCursor | null };
export type Conversation = { conversationId: string; peerAccountId: string; peerUsername: string | null; requestState: 'pending' | 'accepted' | 'declined'; incoming: boolean; createdAt: string };
export type SocialText = { authorAccountId: string; body: string | null; status: 'moderation_pending' | 'approved' | 'rejected' | 'removed'; createdAt: string };
export type Message = SocialText & { messageId: string; conversationId: string; postId: string | null; kind: 'text' | 'moment' };
export type Comment = SocialText & { commentId: string; postId: string; authorUsername: string | null; canRemove?: boolean };
export type SocialSnapshot<T> = { data: T | null; busy: boolean; error: string | null };

export function socialPageUrl(path: string, cursor: SocialCursor | null) {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) { query.set('before', cursor.createdAt); query.set('beforeId', cursor.id); }
  return `${path}?${query.toString()}`;
}

/** A realtime signal is only an instruction to reauthorize. It never carries content. */
export function createSocialResource<T>({ load, changed }: {
  load: (signal: AbortSignal) => Promise<T>;
  changed: (snapshot: SocialSnapshot<T>) => void;
}) {
  let alive = true, epoch = 0;
  let current: AbortController | null = null;
  let mutation = false;
  const clear = () => { epoch++; current?.abort(); current = null; mutation = false; };
  async function run(action?: (signal: AbortSignal) => Promise<unknown>) {
    if (!alive || (action && mutation)) return false;
    clear();
    const revision = epoch;
    const controller = new AbortController(); current = controller;
    mutation = !!action;
    // Drop old bodies before reconnect, refresh, mutation or authorization checks.
    changed({ data: null, busy: true, error: null });
    const valid = () => alive && revision === epoch && !controller.signal.aborted;
    try {
      let uncertain = false;
      if (action) { try { await action(controller.signal); } catch { uncertain = true; } }
      if (!valid()) return false;
      const data = await load(controller.signal);
      if (!valid()) return false;
      changed({ data, busy: false, error: uncertain ? 'This action was not confirmed. Check the discussion before retrying; a retry keeps the same request.' : null });
      return !uncertain;
    } catch {
      if (valid()) changed({ data: null, busy: false, error: 'This discussion is unavailable. Check your connection or refresh to verify access.' });
      return false;
    } finally { if (valid()) { current = null; mutation = false; } }
  }
  return {
    // A committed send may signal before its HTTP response. Coalesce that
    // wake-up: the mutation already ends with a fresh epoch-fenced read.
    refresh: () => mutation ? Promise.resolve(false) : run(),
    mutate: (action: (signal: AbortSignal) => Promise<unknown>) => run(action),
    clear() { if (alive) { clear(); changed({ data: null, busy: false, error: null }); } },
    dispose() { if (alive) { clear(); alive = false; } },
  };
}

/** Check the restriction epoch on both sides of every read, including pagination. */
export async function readSocial<T>(path: string, accountId: string, signal: AbortSignal): Promise<T> {
  const options = { signal, expectedAccountId: accountId };
  const before = await apiRequest<{ epoch: string | number }>('/api/social/epoch', options);
  if (signal.aborted) throw new Error('cancelled');
  const data = await apiRequest<T>(path, options);
  const after = await apiRequest<{ epoch: string | number }>('/api/social/epoch', options);
  if (signal.aborted || before.epoch == null || after.epoch !== before.epoch) throw new Error('stale');
  return data;
}

// Multiple visible discussion panels share one private channel. Distinct hooks
// must not compete for the same Supabase channel topic or leave orphan joins.
type SignalClient = Pick<Awaited<ReturnType<typeof import('./sharing-client').getSharingClient>>, 'channel' | 'removeChannel'>;
const signalClients = new WeakMap<SignalClient, Map<string, { listeners: Set<() => void>; release: () => void }>>();
export function subscribeSocialSignals(client: SignalClient, accountId: string, listener: () => void) {
  let accounts = signalClients.get(client);
  if (!accounts) { accounts = new Map(); signalClients.set(client, accounts); }
  let entry = accounts.get(accountId);
  if (!entry) {
    const listeners = new Set<() => void>();
    const notify = () => { for (const changed of listeners) changed(); };
    const channel = client.channel(`peekalo:account:${accountId}`, { config: { private: true } })
      .on('broadcast', { event: 'invalidate' }, notify)
      .subscribe(status => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) notify(); });
    entry = { listeners, release: () => { void client.removeChannel(channel); } };
    accounts.set(accountId, entry);
  }
  entry.listeners.add(listener);
  let released = false;
  return () => {
    if (released) return; released = true;
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) { accounts.delete(accountId); entry.release(); }
  };
}
