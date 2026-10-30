import { ACTIVE_MEDIA_LIMIT } from '@peekalo/contracts';
import { ApiError, account, body, configuration, database, endpoint, guest, linkToken, response, rpc, sameOrigin, tokenHash, uuid } from './sharing';
import { normalizeCapture } from './processing';
import { acquireUploadSlot, readUploadBody, UploadAdmissionError } from './upload-admission';
import { privateMediaCache } from './private-media-cache';

export const config = endpoint(async request => {
  try { const c = configuration(); return response({ ready: true, supabaseUrl: c.url, supabaseAnonKey: c.anon }, request); }
  catch { return response({ ready: false }, request); }
});
export const getProfile = endpoint(async request => {
  const id = await account(request);
  const { data, error } = await database().from('peekalo_profiles').select('username,review_state').eq('id', id).maybeSingle();
  if (error) throw new ApiError(503, 'sharing_unavailable');
  return response({ username: data?.username ?? null, reviewState: data?.review_state ?? null }, request);
});
export const saveProfile = endpoint(async request => {
  const id = await account(request); const input = await body(request);
  if (typeof input.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(input.username)) throw new ApiError(400, 'invalid_username');
  if (input.username === 'demo') throw new ApiError(409, 'username_reserved');
  return response(await rpc('peekalo_save_profile', { p_actor: id, p_username: input.username }), request);
});
export const upload = endpoint(async request => {
  const owner = await account(request, { requireTerms: true }); const key = uuid(request.headers.get('idempotency-key'));
  const type = request.headers.get('content-type');
  if (!type?.startsWith('multipart/form-data;')) throw new ApiError(400, 'invalid_request');
  let release: (() => void) | undefined;
  try {
    release = acquireUploadSlot();
    const raw = await readUploadBody(request);
    let form: FormData;
    try { form = await new Response(new Uint8Array(raw), { headers: { 'Content-Type': type } }).formData(); }
    catch { throw new ApiError(400, 'invalid_request'); }
    const file = form.get('file'); const kind = form.get('kind');
    if (!(file instanceof File) || (kind !== 'photo' && kind !== 'video')) throw new ApiError(400, 'invalid_request');
    if (!file.size || file.size > (kind === 'photo' ? 15 : 30) * 1024 * 1024) throw new ApiError(413, 'file_too_large');
    const post = await rpc<{ id: string; status: string; reserved: boolean; upload_attempt?: string }>('peekalo_reserve_post', { p_owner: owner, p_key: key, p_kind: kind, p_limit: ACTIVE_MEDIA_LIMIT });
    if (post.status === 'ready') return response({ postId: post.id, kind, status: 'ready' }, request);
    if (post.status === 'moderation_pending') return response({ postId: post.id, kind, status: 'moderation_pending' }, request);
    if (post.status === 'rejected' || post.status === 'taken_down') throw new ApiError(403, post.status);
    if (!post.reserved) throw new ApiError(409, 'upload_in_progress');
    // A pre-migration gateway fails closed instead of writing an unfenced object.
    if (!post.upload_attempt) throw new ApiError(503, 'sharing_unavailable');
    const attempt = uuid(post.upload_attempt);
    const storage = database().storage.from('peekalo-captures');
    let storagePath: string | undefined;
    let publicationRejected = false;
    let writerStarted = false; let writeSettled = false;
    try {
      const processed = await normalizeCapture(Buffer.from(await file.arrayBuffer()), kind);
      storagePath = `${owner}/${post.id}/${attempt}.${processed.extension}`;
      // Recheck after processing, before any private object write. The deletion
      // worker also waits for bounded in-flight writes and sweeps orphan paths.
      writerStarted = await rpc<boolean>('peekalo_storage_writer', { p_owner: owner, p_attempt: attempt, p_begin: true });
      if (!writerStarted) throw new ApiError(403, 'account_deleting');
      // A late attempt can neither overwrite nor remove a newer retry's object.
      const { error: uploadError } = await storage.upload(storagePath, processed.bytes, { contentType: processed.contentType, upsert: false, cacheControl: '0' });
      if (uploadError) throw new ApiError(503, 'upload_failed');
      writeSettled = true;
      const finished = await rpc<boolean>('peekalo_finish_upload', { p_owner: owner, p_post: post.id, p_attempt: attempt, p_path: storagePath });
      if (!finished) { publicationRejected = true; throw new ApiError(409, 'conflict'); }
      privateMediaCache.put(storagePath, kind, processed.bytes);
      return response({ postId: post.id, kind, status: 'moderation_pending' }, request);
    } catch (error) {
      let failed = false;
      try { failed = await rpc<boolean>('peekalo_fail_upload', { p_owner: owner, p_post: post.id, p_attempt: attempt }); }
      catch { /* An unknown finish result must preserve possibly published bytes. */ }
      // A definitive fenced rejection proves this attempt cannot be published,
      // including deletion while its object was being written. Cleanup remains
      // safe even when the subsequent failure-fence request is unavailable.
      let deleted = false;
      if (storagePath && !failed && !publicationRejected) {
        try { deleted = await rpc<boolean>('peekalo_post_deleted', { p_owner: owner, p_post: post.id }); }
        catch { /* Unknown state preserves bytes rather than risking a published object. */ }
      }
      if (storagePath && (failed || publicationRejected || deleted)) {
        try { await storage.remove([storagePath]); } catch { /* Orphan maintenance is an operational retry. */ }
      }
      throw error;
    } finally {
      // Only a definitive successful Storage reply proves the outbound writer
      // has settled. Ambiguity keeps a durable barrier for operational recovery.
      if (writerStarted && writeSettled) {
        try { await rpc('peekalo_storage_writer', { p_owner: owner, p_attempt: attempt, p_begin: false }); }
        catch { /* A lost release reply remains conservatively pending. */ }
      }
    }
  } catch (error) {
    if (error instanceof UploadAdmissionError) throw new ApiError(error.status, error.code);
    throw error;
  } finally { release?.(); }
});
export const createLink = (postId: string) => endpoint(async request => {
  const owner = await account(request, { requireTerms: true }); const post = uuid(postId); const nonce = uuid(request.headers.get('idempotency-key'));
  const token = linkToken(owner, post, nonce);
  const link = await rpc<{ nonce: string; expires_at: string; revoked: boolean; claimed_identity: string | null }>('peekalo_create_link', { p_owner: owner, p_post: post, p_nonce: nonce, p_hash: tokenHash(token) });
  const state = link.revoked ? 'revoked' : Date.parse(link.expires_at) <= Date.now() ? 'expired' : link.claimed_identity ? 'claimed' : 'active';
  return response({ url: `${configuration().appUrl}/s/view#${linkToken(owner, post, link.nonce)}`, expiresAt: link.expires_at, state }, request);
});
export const recipient = (postId: string) => endpoint(async request => {
  const owner = await account(request, { requireTerms: true }); const input = await body(request);
  if (typeof input.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(input.username)) throw new ApiError(400, 'invalid_username');
  const result = await rpc<{ requestState: string; accountId: string }>('peekalo_grant_target', { p_owner: owner, p_post: uuid(postId), p_username: input.username });
  return response(result, request);
});
export const ownPosts = endpoint(async request => {
  return response(await rpc('peekalo_own_posts', { p_owner: await account(request) }), request);
});
export const publicProfile = (username: string) => endpoint(async request => {
  if (username === 'demo' || !/^[a-z0-9_]{3,24}$/.test(username)) throw new ApiError(404, 'unavailable');
  const viewer = request.headers.has('authorization') ? await account(request) : null;
  return response(await rpc('peekalo_public_profile', { p_username: username, p_viewer: viewer }), request);
});
export const deletePost = (postId: string) => endpoint(async request => {
  const owner = await account(request); const post = uuid(postId);
  // Authorization becomes unavailable atomically before touching Storage. A lost
  // response/failed cleanup can retry this tombstone without recreating access.
  const deleted = await rpc<{ storagePath: string | null }>('peekalo_delete_post', { p_owner: owner, p_post: post });
  let cleanupPending = Boolean(deleted.storagePath);
  if (deleted.storagePath) {
    privateMediaCache.remove(deleted.storagePath);
    try {
      const { error } = await database().storage.from('peekalo-captures').remove([deleted.storagePath]);
      if (!error) {
        await rpc('peekalo_finish_delete', { p_owner: owner, p_post: post, p_path: deleted.storagePath });
        cleanupPending = false;
      }
    } catch { /* Keep the path on the tombstone so a deliberate retry can finish. */ }
  }
  return response({ deleted: true, cleanupPending }, request);
});
export const inbox = endpoint(async request => {
  return response(await rpc('peekalo_inbox', { p_recipient: await account(request) }), request);
});
export const viewStatus = (direct = false) => endpoint(async request => {
  const input = await body(request);
  let identity: string | null = null;
  if (direct || request.headers.has('authorization')) identity = `a:${await account(request)}`;
  else {
    sameOrigin(request);
    // Missing/invalid guest cookies must never mint another identity on a read.
    try { identity = guest(request).identity; } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  }
  return response(await rpc('peekalo_view_status', { p_identity: identity, p_hash: direct ? null : tokenHash(input.token), p_post: direct ? uuid(input.postId) : null }), request);
});
export const accept = (postId: string) => endpoint(async request => {
  const recipientId = await account(request, { requireTerms: true });
  const state = await rpc<string>('peekalo_accept', { p_recipient: recipientId, p_post: uuid(postId) });
  return response({ requestState: state }, request);
});
export const preview = endpoint(async request => {
  const input = await body(request);
  const identity = request.headers.has('authorization') ? `a:${await account(request)}` : null;
  return response(await rpc('peekalo_preview', { p_hash: tokenHash(input.token), p_identity: identity }), request);
});
export const lease = (direct = false) => endpoint(async request => {
  const input = await body(request);
  let identity: string; let cookie: string | undefined;
  if (direct || request.headers.has('authorization')) identity = `a:${await account(request)}`;
  else { sameOrigin(request); const viewer = guest(request, true); identity = viewer.identity; cookie = viewer.cookie; }
  const result = await rpc<{ leaseId: string; grantedMs: number; remainingMs: number; expiresAt: string }>('peekalo_lease', { p_identity: identity, p_session: uuid(input.sessionId), p_request: uuid(input.requestId), p_hash: direct ? null : tokenHash(input.token), p_post: direct ? uuid(input.postId) : null });
  return response({ ...result, mediaUrl: `${configuration().appUrl}/api/view/media/${result.leaseId}` }, request, 200, cookie ? { 'Set-Cookie': cookie } : undefined);
});
export const media = (leaseId: string) => endpoint(async request => {
  const startedAt = performance.now();
  const identity = request.headers.has('authorization') ? `a:${await account(request)}` : guest(request).identity;
  const item = await rpc<{ path: string; kind: 'photo' | 'video'; expiresAt: string }>('peekalo_media', { p_identity: identity, p_lease: uuid(leaseId) });
  const authorizedAt = performance.now();
  const cached = privateMediaCache.get(item.path, item.kind);
  let bytes: Uint8Array<ArrayBuffer>; let status = 200; let contentRange: string | null = null;
  const range = request.headers.get('range');
  let start = 0; let end = 1024 * 1024 - 1;
  if (item.kind === 'video') {
    if (range && !/^bytes=\d+-\d*$/.test(range)) throw new ApiError(416, 'invalid_range');
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    start = Number(match?.[1] ?? 0);
    const requestedEnd = match?.[2] ? Number(match[2]) : start + 1024 * 1024 - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start) throw new ApiError(416, 'invalid_range');
    end = Math.min(requestedEnd, start + 1024 * 1024 - 1);
  }
  if (cached) {
    if (item.kind === 'video') {
      if (start >= cached.length) throw new ApiError(416, 'invalid_range');
      end = Math.min(end, cached.length - 1);
      bytes = new Uint8Array(cached.subarray(start, end + 1));
      contentRange = `bytes ${start}-${end}/${cached.length}`;
      status = 206;
    } else bytes = new Uint8Array(cached);
  } else {
    const c = configuration();
    const headers = new Headers({ apikey: c.service, Authorization: `Bearer ${c.service}` });
    if (item.kind === 'video') headers.set('Range', `bytes=${start}-${end}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetch(`${c.url}/storage/v1/object/authenticated/peekalo-captures/${item.path.split('/').map(encodeURIComponent).join('/')}`, { headers, cache: 'no-store', signal: controller.signal });
      if (!upstream.ok) throw new ApiError(upstream.status === 416 ? 416 : 404, 'unavailable');
      const length = Number(upstream.headers.get('content-length'));
      const cap = item.kind === 'photo' ? 15 * 1024 * 1024 : 1024 * 1024;
      if (Number.isFinite(length) && length > cap) throw new ApiError(503, 'sharing_unavailable');
      bytes = new Uint8Array(await upstream.arrayBuffer());
      if (bytes.byteLength > cap) throw new ApiError(503, 'sharing_unavailable');
      status = upstream.status;
      contentRange = upstream.headers.get('content-range');
    } finally { clearTimeout(timeout); }
  }
  const loadedAt = performance.now();
  // Even a server-private cache hit must recheck expiry/revocation before delivery.
  const current = await rpc<typeof item>('peekalo_media', { p_identity: identity, p_lease: uuid(leaseId) });
  if (current.path !== item.path || current.kind !== item.kind) throw new ApiError(404, 'unavailable');
  if (!cached && item.kind === 'photo') privateMediaCache.put(item.path, item.kind, Buffer.from(bytes));
  const outputHeaders = new Headers({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'Content-Type': item.kind === 'photo' ? 'image/jpeg' : 'video/mp4', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Accept-Ranges': item.kind === 'video' ? 'bytes' : 'none', 'Content-Length': String(bytes.byteLength),
    'Server-Timing': `authorize;dur=${(authorizedAt - startedAt).toFixed(1)}, bytes;dur=${(loadedAt - authorizedAt).toFixed(1)}, recheck;dur=${(performance.now() - loadedAt).toFixed(1)}, private_cache;desc="${cached ? 'hit' : 'miss'}"` });
  if (contentRange) outputHeaders.set('Content-Range', contentRange);
  return new Response(bytes, { status, headers: outputHeaders });
});

export const revoke = (postId: string, direct = false) => endpoint(async request => {
  const owner = await account(request);
  const input = direct ? await body(request) : {};
  if (direct && input.accountId !== undefined) {
    if (input.username !== undefined) throw new ApiError(400, 'invalid_request');
    await rpc('peekalo_revoke_recipient', { p_owner: owner, p_post: uuid(postId), p_recipient: uuid(input.accountId) });
    return response({ revoked: true }, request);
  }
  if (direct && (typeof input.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(input.username))) throw new ApiError(400, 'invalid_username');
  await rpc('peekalo_revoke', { p_owner: owner, p_post: uuid(postId), p_username: direct ? input.username : null });
  return response({ revoked: true }, request);
});
