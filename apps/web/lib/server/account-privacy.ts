import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, account, body, configuration, database, endpoint, policyReady, response, rpc, sameOrigin, uuid } from './sharing';
import { revokeAppleAuthorization } from './apple-revocation';

export const TERMS_VERSION = '2026-10-29-draft';
export const PRIVACY_VERSION = '2026-10-29-draft';
function browserOrigin(request: Request) {
  if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') sameOrigin(request);
}
// getUser verifies this exact bearer at the Auth server before its signed amr is
// read. JWT issuance/refresh time and editable user_metadata are NOT recent auth.
export function requireRecentAuthentication(token: string, actor: string, now = Date.now()) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { throw new ApiError(401, 'recent_auth_required'); }
  if (claims.sub !== actor || !Array.isArray(claims.amr) || !claims.amr.some((amr: { method?: unknown; timestamp?: unknown }) =>
    ['password', 'oauth'].includes(String(amr.method)) && typeof amr.timestamp === 'number' &&
    amr.timestamp <= now / 1000 + 5 && amr.timestamp >= now / 1000 - 300)) throw new ApiError(401, 'recent_auth_required');
}
function receipt(requestId: string) {
  return createHmac('sha256', configuration().secret).update(`account-deletion-receipt:${requestId}`).digest('base64url');
}
export const privacy = endpoint(async request => {
  browserOrigin(request);
  const actor = await account(request, { allowDeleting: true });
  const state = await rpc('peekalo_policy_status', { p_actor: actor, p_terms: TERMS_VERSION, p_privacy: PRIVACY_VERSION });
  return response({ ...state, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, policyReady: policyReady() }, request);
});
export const acceptTerms = endpoint(async request => {
  browserOrigin(request);
  const actor = await account(request); const input = await body(request);
  if (Object.keys(input).some(key => !['termsVersion', 'privacyVersion'].includes(key)) || input.termsVersion !== TERMS_VERSION || input.privacyVersion !== PRIVACY_VERSION) throw new ApiError(409, 'policy_changed');
  if (!policyReady()) throw new ApiError(503, 'policy_unavailable');
  return response(await rpc('peekalo_accept_policy', { p_actor: actor, p_terms: TERMS_VERSION, p_privacy: PRIVACY_VERSION }), request);
});
export const deleteAccount = endpoint(async request => {
  browserOrigin(request);
  const actor = await account(request, { allowDeleting: true });
  const token = request.headers.get('authorization')!.match(/^Bearer (.+)$/i)![1];
  requireRecentAuthentication(token, actor);
  const input = await body(request);
  if (input.confirmation !== 'DELETE' || Object.keys(input).some(key => !['confirmation', 'appleAuthorizationCode'].includes(key)) ||
    (input.appleAuthorizationCode !== undefined && (typeof input.appleAuthorizationCode !== 'string' || !input.appleAuthorizationCode || input.appleAuthorizationCode.length > 2048))) throw new ApiError(400, 'invalid_request');
  const user = await database().auth.getUser(token);
  if (user.error || !user.data.user || user.data.user.id !== actor) throw new ApiError(401, 'sign_in_required');
  const apple = user.data.user.identities?.find(identity => identity.provider === 'apple');
  const result = await rpc<{ status: string; requestId: string }>('peekalo_begin_deletion', { p_actor: actor, p_provider_required: Boolean(apple) });
  // Disable first, then try provider revocation. No authorization code or provider
  // token is persisted/logged. Unconfigured/failed Apple remains a durable task.
  if (apple && typeof input.appleAuthorizationCode === 'string') {
    try {
      await revokeAppleAuthorization(input.appleAuthorizationCode, String(apple.identity_data?.sub ?? apple.id));
      await rpc('peekalo_deletion_progress', { p_request: result.requestId, p_stage: 'provider_revoked', p_error: createHash('sha256').update(String(apple.identity_data?.sub ?? apple.id)).digest('hex') });
    } catch { /* The worker must keep this request pending until revocation succeeds. */ }
  }
  const proof = receipt(result.requestId);
  return response({ status: 'pending', requestId: result.requestId, receipt: proof,
    statusUrl: `${configuration().appUrl}/delete-account#requestId=${result.requestId}&receipt=${proof}` }, request, 202);
});
export const deletionStatus = endpoint(async request => {
  browserOrigin(request);
  const input = await body(request); const id = uuid(input.requestId);
  if (Object.keys(input).some(key => !['requestId', 'receipt'].includes(key)) || typeof input.receipt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.receipt)) throw new ApiError(404, 'unavailable');
  const expected = Buffer.from(receipt(id)); const actual = Buffer.from(input.receipt);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(404, 'unavailable');
  const result = await rpc('peekalo_deletion_status', { p_request: id });
  if (!result) throw new ApiError(404, 'unavailable');
  return response(result, request);
});
