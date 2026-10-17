import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
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
export function database() {
  const c = configuration();
  return createClient(c.url, c.service, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store' }) } });
}
export async function account(request: Request) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer || bearer.length > 8192) throw new ApiError(401, 'sign_in_required');
  const { data, error } = await database().auth.getUser(bearer);
  if (error || !data.user) throw new ApiError(401, 'sign_in_required');
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
export async function limitedBody(request: Request, limit: number) {
  const advertised = Number(request.headers.get('content-length'));
  if (advertised > limit) throw new ApiError(413, 'file_too_large');
  if (!request.body) throw new ApiError(400, 'invalid_request');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, 'file_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
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
    const codes: Record<string, [number, string]> = { unavailable: [404, 'unavailable'], recipient: [404, 'recipient_not_found'], claimed: [410, 'already_claimed'], busy: [409, 'viewer_busy'], early: [409, 'renew_later'], exhausted: [410, 'exhausted'], expired: [410, 'expired'], quota: [409, 'active_limit'], conflict: [409, 'conflict'], unauthorized: [401, 'sign_in_required'] };
    const known = codes[error.message];
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
export function endpoint(fn: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    try { return await fn(request); }
    catch (error) {
      const known = error instanceof ApiError ? error : new ApiError(503, 'sharing_unavailable');
      // Deliberately never log request bodies, credentials, database errors or share tokens.
      return response({ error: known.code }, request, known.status);
    }
  };
}
