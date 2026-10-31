import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number) { super(code); }
}
export const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'invalid_request');
  return value.toLowerCase();
};
export function configuration() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.SHARE_TOKEN_SECRET;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!url || !anon || !service || !secret || secret.length < 32 || !appUrl) throw new ApiError(503, 'sharing_unavailable');
  return { url, anon, service, secret, appUrl: new URL(appUrl).origin };
}
// Covers response bodies as well as initial headers; never logs upstream data.
export async function backendFetch(input: Parameters<typeof fetch>[0], init?: RequestInit, timeoutMs = 15_000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, cache: 'no-store', signal });
}
export function database() {
  const c = configuration();
  return createClient(c.url, c.service, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => backendFetch(url, init) } });
}
// Explicit release publication prerequisites. Presence is configuration, not
// evidence of legal review, mailbox delivery, invitation enforcement or coverage.
export function policyReady() {
  const email = (value: string | undefined) => Boolean(value && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value));
  const name = process.env.POLICY_OPERATOR_NAME?.trim();
  const countries = process.env.POLICY_COUNTRIES;
  const age = Number(process.env.POLICY_MINIMUM_AGE);
  return process.env.POLICY_PUBLISHED === 'true' && Boolean(name && name.length <= 200 && !/[\r\n]/.test(name)) &&
    Boolean(countries && /^[A-Z]{2}(?:,[A-Z]{2})*$/.test(countries)) && Number.isInteger(age) && age >= 13 && age <= 120 &&
    email(process.env.SAFETY_SUPPORT_EMAIL) && email(process.env.SAFETY_CHILD_SAFETY_EMAIL) &&
    Boolean(process.env.SAFETY_AGE_POLICY?.trim());
}
export async function account(request: Request, controls: { allowDeleting?: boolean; requireTerms?: boolean } = {}) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer || bearer.length > 8192) throw new ApiError(401, 'sign_in_required');
  const { data, error } = await database().auth.getUser(bearer);
  if (error || !data.user) throw new ApiError(401, 'sign_in_required');
  await admitRequest(request, data.user.id);
  if (!controls.allowDeleting && !await rpc<boolean>('peekalo_account_access', { p_actor: data.user.id })) throw new ApiError(403, 'account_deleting');
  if (controls.requireTerms) {
    if (!policyReady()) throw new ApiError(503, 'policy_unavailable');
    const state = await rpc<{ accepted: boolean }>('peekalo_policy_status', { p_actor: data.user.id, p_terms: '2026-10-29-draft', p_privacy: '2026-10-29-draft' });
    if (!state.accepted) throw new ApiError(403, 'terms_required');
  }
  return data.user.id;
}
export async function body(request: Request) {
  const bytes = await limitedBody(request, 4096);
  try {
    const value: unknown = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_request'); }
}
export async function limitedBody(request: Request, limit: number, timeoutMs = 10_000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ApiError(400, 'invalid_request');
  const length = request.headers.get('content-length');
  const refuse = (error: ApiError): never => { void request.body?.cancel().catch(() => {}); throw error; };
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) refuse(new ApiError(400, 'invalid_request'));
  if (length !== null && Number(length) > limit) refuse(new ApiError(413, 'file_too_large'));
  if (request.signal.aborted) refuse(new ApiError(408, 'request_timeout'));
  if (!request.body) throw new ApiError(400, 'invalid_request');
  const reader = request.body.getReader();
  const bytes = Buffer.allocUnsafe(limit);
  let size = 0; let failure: ApiError | undefined;
  const interrupt = () => { failure ??= new ApiError(408, 'request_timeout'); void reader.cancel().catch(() => {}); };
  const timer = setTimeout(interrupt, timeoutMs);
  const deadline = performance.now() + timeoutMs;
  request.signal.addEventListener('abort', interrupt, { once: true });
  try {
    if (request.signal.aborted) interrupt();
    while (true) {
      const { done, value } = await reader.read();
      if (performance.now() >= deadline) interrupt();
      if (failure) throw failure;
      if (done) break;
      if (value.byteLength > limit - size) { void reader.cancel().catch(() => {}); throw new ApiError(413, 'file_too_large'); }
      bytes.set(value, size); size += value.byteLength;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof ApiError ? error : new ApiError(400, 'invalid_request');
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', interrupt); reader.releaseLock();
  }
}
export function tokenHash(token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, 'unavailable');
  return createHash('sha256').update(token).digest('hex');
}
export function linkToken(owner: string, post: string, nonce: string) {
  return createHmac('sha256', configuration().secret).update(`share:${owner}:${post}:${nonce}`).digest('base64url');
}
export function guest(request: Request, create = false): { identity: string; cookie?: string } {
  const signed = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('peekalo_guest='))?.slice(14);
  if (signed) {
    const [id, signature] = signed.split('.');
    if (/^[0-9a-f-]{36}$/.test(id ?? '') && signature) {
      const expected = createHmac('sha256', configuration().secret).update(`guest:${id}`).digest('base64url');
      const a = Buffer.from(signature); const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return { identity: `g:${id}` };
    }
  }
  if (!create) throw new ApiError(401, 'unavailable');
  const id = randomUUID();
  const signature = createHmac('sha256', configuration().secret).update(`guest:${id}`).digest('base64url');
  const secure = configuration().appUrl.startsWith('https:') ? '; Secure' : '';
  return { identity: `g:${id}`, cookie: `peekalo_guest=${id}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}` };
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = configuration().appUrl;
  if (origin !== expected) throw new ApiError(403, 'origin_not_allowed');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'origin_not_allowed');
}
export async function rpc<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await database().rpc(name, args);
  if (error) {
    const codes: Record<string, [number, string]> = { terms_required: [403, 'terms_required'], request_pending: [409, 'request_pending'], unavailable: [404, 'unavailable'], recipient: [404, 'recipient_not_found'], claimed: [410, 'already_claimed'], busy: [409, 'viewer_busy'], early: [409, 'renew_later'], exhausted: [410, 'exhausted'], expired: [410, 'expired'], quota: [409, 'active_limit'], conflict: [409, 'conflict'], unauthorized: [401, 'sign_in_required'], forbidden: [403, 'operator_required'], moderation_pending: [409, 'moderation_pending'], blocked: [403, 'blocked'], rejected: [403, 'rejected'], taken_down: [403, 'taken_down'], rate_limited: [429, 'rate_limited'] };
    const known = codes[error.message];
    if (error.code === '23505') throw new ApiError(409, 'username_taken');
    if (error.message === 'username_taken') throw new ApiError(409, 'username_taken');
    if (error.message === 'username') throw new ApiError(400, 'invalid_username');
    if (error.message === 'account_deleting') throw new ApiError(403, 'account_deleting');
    if (error.message === 'suspended') throw new ApiError(403, 'suspended');
    throw new ApiError(...(known ?? [503, 'sharing_unavailable']));
  }
  return data as T;
}
export function response(value: unknown, request: Request, status = 200, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  // Native clients have no Origin. Browser credentials are confined to the configured web origin.
  const origin = request.headers.get('origin');
  if (origin && process.env.PUBLIC_APP_URL && origin === new URL(process.env.PUBLIC_APP_URL).origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  return Response.json(value, { status, headers });
}
export function options(request: Request) {
  return response({}, request, 200, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, Range' });
}
// Fixed route classes keep attacker-controlled paths out of the limiter keys.
// Forwarded IP headers are deliberately unused: no trusted ingress contract has
// been configured. The global lane also bounds credential/cookie rotation.
export function abuseLane(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/account/')) return 'deletion';
  if (path.startsWith('/api/operator/') || path.startsWith('/api/safety/')) return 'safety';
  if (path === '/api/posts' && request.method === 'POST') return 'upload';
  if (path.startsWith('/api/view/')) return 'media';
  return 'api';
}
export async function admitRequest(request: Request, actor?: string, call = rpc) {
  const lane = abuseLane(request);
  const admit = async (scope: string, value: string) => {
    const key = scope === 'global' ? '0'.repeat(64) : createHmac('sha256', configuration().secret).update(`abuse:v1:${scope}:${lane}:${value}`).digest('hex');
    const result = await call<{ allowed: boolean; retryAfter: number }>('peekalo_admit_endpoint', { p_scope: scope, p_lane: lane, p_key: key });
    if (!result || typeof result.allowed !== 'boolean' || !Number.isInteger(result.retryAfter) || result.retryAfter < 0 || result.retryAfter > 60) throw new ApiError(503, 'sharing_unavailable');
    if (!result.allowed) throw new ApiError(429, 'rate_limited', Math.max(1, result.retryAfter));
  };
  if (actor) { await admit('account', actor); return; }
  await admit('global', '');
  const bearer = request.headers.get('authorization');
  if (bearer) {
    if (bearer.length > 8192) throw new ApiError(401, 'sign_in_required');
    await admit('credential', bearer);
  } else {
    let identity: string | undefined;
    try { identity = guest(request).identity; } catch (error) { if (!(error instanceof ApiError && error.status === 401)) throw error; }
    if (identity) await admit('guest', identity);
  }
}
export function endpoint(fn: (request: Request) => Promise<Response>, admission: (request: Request) => Promise<void> = admitRequest) {
  return async (request: Request) => {
    try { await admission(request); return await fn(request); }
    catch (error) {
      const known = error instanceof ApiError ? error : new ApiError(503, 'sharing_unavailable');
      // Deliberately never log request bodies, credentials, database errors or share tokens.
      return response({ error: known.code }, request, known.status, known.status === 429 ? { 'Retry-After': String(known.retryAfter ?? 60) } : undefined);
    }
  };
}
