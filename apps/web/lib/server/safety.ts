import { ApiError, account, backendFetch, body, configuration, endpoint, guest, response, rpc, sameOrigin, tokenHash, uuid } from './sharing';

// These are public, human-supplied operational values, never account credentials.
function publicEmail(value: string | undefined) {
  return value && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) ? value : undefined;
}
export const safetyConfig = endpoint(async request => {
  const { appUrl } = configuration();
  const supportEmail = publicEmail(process.env.SAFETY_SUPPORT_EMAIL);
  const childSafetyEmail = publicEmail(process.env.SAFETY_CHILD_SAFETY_EMAIL);
  const configuredAge = process.env.SAFETY_AGE_POLICY?.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters in public operational copy.
  const agePolicy = configuredAge && configuredAge.length <= 300 && !/[\x00-\x1f]/.test(configuredAge) ? configuredAge : undefined;
  return response({ manualApproval: true, contactConfigured: Boolean(supportEmail && childSafetyEmail), agePolicyConfigured: Boolean(agePolicy),
    ...(supportEmail ? { supportEmail } : {}), ...(childSafetyEmail ? { childSafetyEmail } : {}), ...(agePolicy ? { agePolicy } : {}),
    standardsUrl: `${appUrl}/safety`, supportUrl: `${appUrl}/support` }, request);
});
function browserOrigin(request: Request) {
  if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') sameOrigin(request);
}
function username(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9_]{3,24}$/.test(value) || value === 'demo') throw new ApiError(400, 'invalid_username');
  return value;
}
function text(value: unknown, required = false) {
  if (value === undefined && !required) return '';
  // eslint-disable-next-line no-control-regex -- Bounded report text must not contain terminal/control bytes.
  if (typeof value !== 'string' || value.length > 1000 || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new ApiError(400, 'invalid_request');
  return value.trim();
}
export const reports = endpoint(async request => {
  browserOrigin(request);
  const input = await body(request);
  const reasons = ['child_safety', 'sexual_content', 'violence', 'harassment', 'privacy', 'spam', 'other'];
  if (typeof input.reason !== 'string' || !reasons.includes(input.reason) ||
      Object.keys(input).some(key => !['postId', 'accountId', 'username', 'token', 'messageId', 'commentId', 'reason', 'details'].includes(key)) ||
      [input.postId, input.accountId, input.username, input.token, input.messageId, input.commentId].filter(value => value !== undefined).length !== 1) throw new ApiError(400, 'invalid_request');
  const details = text(input.details);
  let identity: string; let cookie: string | undefined;
  if (request.headers.has('authorization')) identity = `a:${await account(request)}`;
  else { sameOrigin(request); const viewer = guest(request, true); identity = viewer.identity; cookie = viewer.cookie; }
  if ((input.accountId !== undefined || input.messageId !== undefined || input.commentId !== undefined) && !identity.startsWith('a:')) throw new ApiError(401, 'sign_in_required');
  if (input.messageId !== undefined || input.commentId !== undefined) {
    return response(await rpc('peekalo_social_report', { p_actor: identity.slice(2), p_kind: input.messageId === undefined ? 'comment' : 'message',
      p_item: uuid(input.messageId ?? input.commentId), p_reason: input.reason, p_details: details }), request);
  }
  const result = await rpc('peekalo_report', { p_identity: identity, p_kind: input.username === undefined && input.accountId === undefined ? 'post' : 'account',
    p_reason: input.reason, p_details: details, p_post: input.postId === undefined ? null : uuid(input.postId),
    p_username: input.username === undefined ? null : username(input.username), p_hash: input.token === undefined ? null : tokenHash(input.token),
    p_account: input.accountId === undefined ? null : uuid(input.accountId) });
  return response(result, request, 200, cookie ? { 'Set-Cookie': cookie } : undefined);
});
export const blocks = endpoint(async request => {
  browserOrigin(request);
  const actor = await account(request);
  if (request.method === 'GET') return response(await rpc('peekalo_blocks', { p_actor: actor }), request);
  const input = await body(request);
  if ([input.username, input.accountId].filter(value => value !== undefined).length !== 1) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_block', { p_actor: actor, p_username: input.username === undefined ? null : username(input.username),
    p_target: input.accountId === undefined ? null : uuid(input.accountId), p_blocked: request.method !== 'DELETE' }), request);
});
export const operatorQueue = endpoint(async request => {
  browserOrigin(request);
  return response(await rpc('peekalo_moderation_queue', { p_operator: await account(request) }), request);
});
export const operatorAudit = endpoint(async request => {
  browserOrigin(request);
  return response(await rpc('peekalo_moderation_audit', { p_operator: await account(request) }), request);
});
export const operatorDecision = endpoint(async request => {
  browserOrigin(request);
  const operator = await account(request); const input = await body(request);
  if (!['approve', 'reject', 'takedown'].includes(String(input.action))) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_moderate', { p_operator: operator, p_post: uuid(input.postId), p_action: input.action, p_reason: text(input.reason, true) }), request);
});
export const operatorProfile = endpoint(async request => {
  browserOrigin(request);
  const operator = await account(request); const input = await body(request);
  if (!['approve', 'reject'].includes(String(input.action))) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_moderate_profile', { p_operator: operator, p_username: username(input.username), p_action: input.action, p_reason: text(input.reason, true) }), request);
});
export const operatorAccount = endpoint(async request => {
  browserOrigin(request);
  const operator = await account(request); const input = await body(request);
  if (!['suspend', 'restore'].includes(String(input.action))) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_moderate_account', { p_operator: operator, p_username: username(input.username), p_action: input.action, p_reason: text(input.reason, true) }), request);
});
export const operatorReport = (reportId: string) => endpoint(async request => {
  browserOrigin(request);
  const operator = await account(request); const input = await body(request);
  if (!['resolved', 'dismissed'].includes(String(input.state))) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_resolve_report', { p_operator: operator, p_report: uuid(reportId), p_state: input.state, p_resolution: text(input.note, true) }), request);
});
// Deliberate operator inspection only. Each request audits authorization before
// reading Storage and checks again after IO. No signed/public original URL exists.
export const operatorMedia = (postId: string) => endpoint(async request => {
  browserOrigin(request);
  const operator = await account(request); const post = uuid(postId);
  const args = { p_operator: operator, p_post: post };
  const item = await rpc<{ path: string; kind: 'photo' | 'video' }>('peekalo_moderation_media', args);
  if (!['photo', 'video'].includes(item.kind) || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?\.(?:jpg|mp4)$/.test(item.path)) throw new ApiError(404, 'unavailable');
  const c = configuration();
  const upstream = await backendFetch(`${c.url}/storage/v1/object/authenticated/peekalo-captures/${item.path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: c.service, Authorization: `Bearer ${c.service}` } }, 15_000);
  if (!upstream.ok || !upstream.body) throw new ApiError(404, 'unavailable');
  const cap = (item.kind === 'photo' ? 15 : 30) * 1024 * 1024;
  if (Number(upstream.headers.get('content-length')) > cap) { await upstream.body.cancel(); throw new ApiError(404, 'unavailable'); }
  const reader = upstream.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > cap) { await reader.cancel(); throw new ApiError(404, 'unavailable'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const current = await rpc<{ path: string; kind: string }>('peekalo_moderation_media', args);
  if (current.path !== item.path || current.kind !== item.kind) throw new ApiError(404, 'unavailable');
  const headers = response({}, request).headers;
  headers.set('Content-Type', item.kind === 'photo' ? 'image/jpeg' : 'video/mp4');
  headers.set('Content-Disposition', 'inline');
  headers.set('Content-Length', String(size));
  return new Response(new Uint8Array(Buffer.concat(chunks)), { headers });
});
