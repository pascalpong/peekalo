// RN's network Image uses Fresco's independent disk cache on Android, even
// with cache:'reload' and HTTP no-store. Fetch into RN's in-memory Blob store,
// then give Image only a data URI. This avoids that network disk-cache path;
// it does not promise erasure of native/JS memory or already delivered bytes.
// Match the authorized server photo-delivery bound.
const maximumBytes = 15 * 1024 * 1024;
const failure = () => new Error('The private photo could not load.');
type NativeBlob = Blob & { close?: () => void };

function close(blob: NativeBlob | undefined) {
  try { blob?.close?.(); } catch { /* Best effort native memory release. */ }
}

export function loadPrivatePhoto({ uri, authorization, expectedOrigin, signal }: {
  uri: string; authorization: string; expectedOrigin: string; signal: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let blob: NativeBlob | undefined;
    let typedBlob: NativeBlob | undefined;
    let reader: FileReader | undefined;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (reader) {
        const completed = reader;
        reader = undefined;
        completed.onload = null; completed.onerror = null; completed.onabort = null;
        if (value === undefined) { try { completed.abort(); } catch { /* Reader may already be done. */ } }
      }
      if (typedBlob !== blob) close(typedBlob);
      typedBlob = undefined;
      close(blob); blob = undefined;
      if (value === undefined) reject(failure());
      else resolve(value);
    };
    const cancel = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { finish(); return; }
    void (async () => {
      const url = new URL(uri);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(expectedOrigin).origin ||
        url.username || url.password || url.search || url.hash ||
        !/^\/api\/view\/media\/[a-f0-9-]{36}$/i.test(url.pathname) || !authorization.startsWith('Bearer ')) throw failure();
      const response = await fetch(url.toString(), {
        headers: { Authorization: authorization, 'Cache-Control': 'no-store' },
        // RN's pinned whatwg-fetch rewrites GET URLs for cache:'no-store'.
        // Use the HTTP directive without changing the authorized delivery URL.
        credentials: 'omit', redirect: 'error', signal,
      });
      // RN fetch already buffers into a native Blob. Consume/close even a late
      // response or invalid header; never pass its HTTP URL to native Image.
      const received = await response.blob() as NativeBlob;
      if (settled || signal.aborted) { close(received); finish(); return; }
      blob = received;
      const length = response.headers.get('Content-Length');
      const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      // Android RN's native networking Blob omits MIME metadata. Trust only
      // the already validated HTTP type, and reject a conflicting native type.
      const blobType = blob.type.split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || (response.url && response.url !== url.toString()) || contentType !== 'image/jpeg' ||
        !length || !/^[1-9]\d*$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumBytes ||
        !Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > maximumBytes || blob.size !== Number(length) ||
        (blobType !== '' && blobType !== 'image/jpeg')) throw failure();
      const bytes = blob.size;
      // RN slice is a typed view over the same native bytes, not a copy or a
      // file. Both registry references must be closed on every completion path.
      typedBlob = blob.slice(0, bytes, 'image/jpeg') as NativeBlob;
      if (typedBlob.size !== bytes || typedBlob.type !== 'image/jpeg') throw failure();
      reader = new FileReader();
      reader.onerror = cancel; reader.onabort = cancel;
      reader.onload = () => {
        if (settled || signal.aborted) { finish(); return; }
        const value = reader?.result;
        const prefix = 'data:image/jpeg;base64,';
        // Bound and validate FileReader output before it reaches Image. No
        // credentials, network/file/blob URI or decoder-generated text escapes.
        if (typeof value !== 'string' || !value.startsWith(prefix) || value.length !== prefix.length + 4 * Math.ceil(bytes / 3) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(prefix.length))) { finish(); return; }
        const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
        if ((value.length - prefix.length) / 4 * 3 - padding !== bytes) { finish(); return; }
        finish(value);
      };
      reader.readAsDataURL(typedBlob);
    })().catch(() => finish());
  });
}
