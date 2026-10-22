/** Process-local bytes only. Callers must authorize before and after every read.
 * Never caches grants, failures, raw captures, browser responses or public assets.
 */
export function createPrivateMediaCache({ maxBytes = 12 * 1024 * 1024, maxItemBytes = 4 * 1024 * 1024, maxItems = 8, ttlMs = 60_000, now = Date.now } = {}) {
  const entries = new Map<string, { bytes: Buffer; kind: 'photo' | 'video'; expires: number; timer: ReturnType<typeof setTimeout> }>();
  let size = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    size -= entry.bytes.length;
    entries.delete(key);
  };
  return {
    put(key: string, kind: 'photo' | 'video', bytes: Buffer) {
      remove(key);
      if (!bytes.length || bytes.length > maxItemBytes || bytes.length > maxBytes || maxItems < 1) return;
      for (const [oldKey, entry] of entries) if (entry.expires <= now()) remove(oldKey);
      while (entries.size && (size + bytes.length > maxBytes || entries.size >= maxItems)) remove(entries.keys().next().value!);
      const timer = setTimeout(() => remove(key), ttlMs);
      timer.unref();
      entries.set(key, { bytes: Buffer.from(bytes), kind, expires: now() + ttlMs, timer });
      size += bytes.length;
    },
    get(key: string, kind: 'photo' | 'video'): Buffer | undefined {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.expires <= now()) { remove(key); return; }
      if (entry.kind !== kind) return;
      // Neither producers nor response consumers can mutate retained bytes.
      return Buffer.from(entry.bytes);
    },
    remove,
    clear() { for (const key of entries.keys()) remove(key); },
  };
}

export const privateMediaCache = createPrivateMediaCache();
