const bodyLimit = 2048;
const consentVersion = 'early-access-v1';
const requestWindowMs = 60000;
const admittedAt: number[] = [];
let inFlight = 0;

// Bounded, identifier-free admission for this Node process/module instance.
// Restarts and other instances have separate limits; use a trusted edge limiter
// when deploying multiple instances. Never trust a client-supplied IP header.
function admit() {
  const now = Date.now();
  while (admittedAt.length && now - admittedAt[0] >= requestWindowMs) admittedAt.shift();
  if (admittedAt.length >= 30) {
    throw new WaitlistError(429, 'too_many_requests', Math.max(1, Math.ceil((admittedAt[0] + requestWindowMs - now) / 1000)));
  }
  if (inFlight >= 4) throw new WaitlistError(429, 'too_many_requests', 1);
  admittedAt.push(now);
  inFlight++;
  return () => { inFlight--; };
}

class WaitlistError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); }
}

function response(value: { ok: true } | { error: string }, status = 200, retryAfter?: number) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
    },
  });
}

function appOrigin() {
  const configured = process.env.PUBLIC_SITE_URL ?? process.env.PUBLIC_APP_URL;
  if (!configured) throw new WaitlistError(503, 'waitlist_unavailable');
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new WaitlistError(503, 'waitlist_unavailable'); }
}

async function payload(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new WaitlistError(415, 'unsupported_media_type');
  }
  const length = Number(request.headers.get('content-length'));
  if (length > bodyLimit) throw new WaitlistError(413, 'request_too_large');
  if (!request.body) throw new WaitlistError(400, 'invalid_request');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new WaitlistError(408, 'request_timeout'));
      // Cancellation of an arbitrary stream may itself stall or fail. Start it
      // without awaiting so the read deadline always ends the request.
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.length;
      if (size > bodyLimit) {
        void reader.cancel().catch(() => {});
        throw new WaitlistError(413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new WaitlistError(400, 'invalid_request'); }
}

function emailAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 320) throw new WaitlistError(400, 'invalid_email');
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  // A practical ASCII email subset, including plus addressing. Reject controls,
  // quoted mailboxes and malformed domain labels rather than storing arbitrary input.
  if (email.length > 254 || !local || local.length > 64 || !domain || extra !== undefined ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
      !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new WaitlistError(400, 'invalid_email');
  }
  return email;
}

async function persist(email: string) {
  const configured = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!configured || !service) throw new WaitlistError(503, 'waitlist_unavailable');
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new WaitlistError(503, 'waitlist_unavailable');
  }
  // Do not read or overwrite existing entries. Duplicate requests retain the
  // original consent record and get the same response as a newly stored entry.
  const result = await fetch(`${url.origin}/rest/v1/peekalo_waitlist?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify({ email, consent_version: consentVersion }),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new WaitlistError(503, 'waitlist_unavailable');
}

export async function waitlistPost(request: Request) {
  let release: (() => void) | undefined;
  try {
    // Open collection only after the operator has deployed the schema and
    // connected the contact/removal route described in the privacy notice.
    if (process.env.WAITLIST_ENABLED !== 'true') throw new WaitlistError(503, 'waitlist_unavailable');
    const expected = appOrigin();
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== expected || (site && site !== 'same-origin' && site !== 'none')) {
      throw new WaitlistError(403, 'origin_not_allowed');
    }
    release = admit();
    const input = await payload(request);
    if (input.website !== undefined && (typeof input.website !== 'string' || input.website.length > 200)) {
      throw new WaitlistError(400, 'invalid_request');
    }
    if (typeof input.website === 'string' && input.website.trim()) return response({ ok: true });
    if (input.consent !== true) throw new WaitlistError(400, 'consent_required');
    const email = emailAddress(input.email);
    await persist(email);
    return response({ ok: true });
  } catch (error) {
    const known = error instanceof WaitlistError ? error : new WaitlistError(503, 'waitlist_unavailable');
    // Never log bodies, addresses, headers, configuration or upstream errors.
    return response({ error: known.code }, known.status, known.retryAfter);
  } finally { release?.(); }
}
