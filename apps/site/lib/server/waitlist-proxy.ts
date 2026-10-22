import { publicOrigin } from '@peekalo/web-ui/origins';

class ProxyError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function reply(value: { ok: true } | { error: string }, status = 200, retryAfter?: string) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'private, no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
  } });
}

async function boundedBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ProxyError(415, 'unsupported_media_type');
  }
  const length = request.headers.get('content-length');
  if (length && !/^\d+$/.test(length)) throw new ProxyError(400, 'invalid_request');
  if (Number(length) > 2048) throw new ProxyError(413, 'request_too_large');
  if (!request.body) throw new ProxyError(400, 'invalid_request');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProxyError(408, 'request_timeout'));
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.length;
      if (size > 2048) { void reader.cancel().catch(() => {}); throw new ProxyError(413, 'request_too_large'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new ProxyError(400, 'invalid_request'); }
}

/** Marketing's only backend bridge. No auth cookies, authorization, user identity
 * headers or database credentials pass through this endpoint. */
export async function waitlistProxyPost(request: Request) {
  try {
    if (process.env.WAITLIST_ENABLED !== 'true') throw new ProxyError(503, 'waitlist_unavailable');
    const dev = process.env.NODE_ENV === 'development';
    const site = publicOrigin(process.env.PUBLIC_SITE_URL ?? (dev ? 'http://127.0.0.1:3100' : undefined));
    const app = publicOrigin(process.env.PUBLIC_APP_URL ?? (dev ? 'http://127.0.0.1:3101' : undefined));
    if (!site || !app || site === app) throw new ProxyError(503, 'waitlist_unavailable');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== site || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
      throw new ProxyError(403, 'origin_not_allowed');
    }
    const body = await boundedBody(request);
    const upstream = await fetch(`${app}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: site, 'Sec-Fetch-Site': 'same-origin' },
      body, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(6000)]),
    });
    if (upstream.ok) {
      const result = await upstream.json();
      if (result?.ok === true) return reply({ ok: true });
    } else {
      // Only structured public error codes/statuses can cross the boundary.
      const result = await upstream.json();
      const codes = ['invalid_request', 'invalid_email', 'consent_required', 'origin_not_allowed',
        'request_too_large', 'unsupported_media_type', 'request_timeout', 'too_many_requests', 'waitlist_unavailable'];
      if ([400, 403, 408, 413, 415, 429, 503].includes(upstream.status) && codes.includes(result?.error)) {
        const retry = upstream.headers.get('retry-after');
        return reply({ error: result.error }, upstream.status, retry && /^\d{1,5}$/.test(retry) ? retry : undefined);
      }
    }
    throw new ProxyError(503, 'waitlist_unavailable');
  } catch (error) {
    const known = error instanceof ProxyError ? error : new ProxyError(503, 'waitlist_unavailable');
    return reply({ error: known.code }, known.status);
  }
}
