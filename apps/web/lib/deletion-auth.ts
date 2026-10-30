import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const storageKey = 'peekalo-deletion-only';
const verifierKey = `${storageKey}-code-verifier`;
const pendingKey = `${storageKey}-started`;
const lifetime = 10 * 60 * 1000;

/** Only a short-lived PKCE verifier crosses a navigation. Auth tokens stay in memory. */
export function deletionStorage(persistent: Storage, now = () => Date.now()) {
  const memory = new Map<string, string>();
  const verifier = (key: string) => key === verifierKey || (key.startsWith(`${storageKey}-flow`) && key.endsWith('-code-verifier') && key.length < 200);
  return {
    getItem(key: string) {
      if (!verifier(key)) return memory.get(key) ?? null;
      try {
        const record = JSON.parse(persistent.getItem(key) || 'null') as { value?: unknown; expiresAt?: unknown } | null;
        if (record && typeof record.value === 'string' && typeof record.expiresAt === 'number' && record.expiresAt > now() && record.expiresAt <= now() + lifetime) return record.value;
      } catch { /* Missing or malformed verification material fails closed. */ }
      persistent.removeItem(key); return null;
    },
    setItem(key: string, value: string) {
      if (verifier(key)) persistent.setItem(key, JSON.stringify({ value, expiresAt: now() + lifetime }));
      else memory.set(key, value);
    },
    removeItem(key: string) { memory.delete(key); if (verifier(key)) persistent.removeItem(key); },
    clear() {
      memory.clear();
      for (let index = persistent.length - 1; index >= 0; index--) {
        const key = persistent.key(index); if (key && (verifier(key) || key === pendingKey)) persistent.removeItem(key);
      }
    },
    start() { persistent.setItem(pendingKey, String(now())); },
    consumeStart() {
      const value = Number(persistent.getItem(pendingKey)); persistent.removeItem(pendingKey);
      return value > 0 && value <= now() && now() - value < lifetime;
    },
  };
}

export function deletionCallback(url: string) {
  const parsed = new URL(url);
  const query = parsed.searchParams;
  if (!query.size && !parsed.hash) return { present: false, code: null, flowId: null };
  const permitted = new Set(['code', 'sb_flow_id']);
  const valid = !parsed.hash && [...query.keys()].every(key => permitted.has(key) && query.getAll(key).length === 1)
    && /^[A-Za-z0-9_-]{8,2048}$/.test(query.get('code') || '')
    && (!query.has('sb_flow_id') || /^[A-Za-z0-9_-]{8,128}$/.test(query.get('sb_flow_id') || ''));
  return { present: true, code: valid ? query.get('code') : null, flowId: valid ? query.get('sb_flow_id') : null };
}

export type DeletionReceipt = { requestId: string; receipt: string };
export function deletionReceipt(url: string): DeletionReceipt | null {
  const parsed = new URL(url);
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  if (parsed.search || [...fragment.keys()].some(key => !['requestId', 'receipt'].includes(key) || fragment.getAll(key).length !== 1)) return null;
  const requestId = fragment.get('requestId') || ''; const receipt = fragment.get('receipt') || '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) && /^[A-Za-z0-9_-]{32,256}$/.test(receipt) ? { requestId, receipt } : null;
}
export function deletionStatusUrl(value: DeletionReceipt) {
  return `/delete-account#${new URLSearchParams(value).toString()}`;
}

export async function createDeletionClient(persistent: Storage): Promise<{ client: SupabaseClient; storage: ReturnType<typeof deletionStorage> }> {
  const response = await fetch('/api/shares/config', { cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('unavailable');
  const config = await response.json() as { ready?: boolean; supabaseUrl?: string; supabaseAnonKey?: string };
  if (!config.ready || !config.supabaseUrl || !config.supabaseAnonKey) throw new Error('unavailable');
  const storage = deletionStorage(persistent);
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { storageKey, storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce', experimental: { appendPkceFlowIdToRedirects: true } },
    global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) }) },
  });
  return { client, storage };
}
