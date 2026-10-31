import { ApiError, account, body, endpoint, response, rpc, sameOrigin, uuid } from './sharing';

function origin(request: Request) {
  if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') sameOrigin(request);
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, 'invalid_request');
}
function text(value: unknown, max = 1000): string {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in bounded private text.
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new ApiError(400, 'invalid_request');
  return value.trim();
}
function page(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !['before', 'beforeId', 'limit'].includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1)) throw new ApiError(400, 'invalid_request');
  const before = query.get('before'), beforeId = query.get('beforeId');
  if ((before === null) !== (beforeId === null) || before !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(before) || !Number.isFinite(Date.parse(before)))) throw new ApiError(400, 'invalid_request');
  const limit = query.get('limit');
  if (limit !== null && (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50)) throw new ApiError(400, 'invalid_request');
  return { p_before: before, p_before_id: beforeId === null ? null : uuid(beforeId), p_limit: limit === null ? 30 : Number(limit) };
}
function kind(value: string) {
  if (value !== 'message' && value !== 'comment') throw new ApiError(400, 'invalid_request');
  return value;
}
export const conversations = endpoint(async request => {
  origin(request);
  const actor = await account(request, { requireTerms: request.method !== 'GET' });
  if (request.method === 'GET') return response(await rpc('peekalo_social_conversations', { p_actor: actor, ...page(request) }), request);
  const input = await body(request); fields(input, ['username', 'accountId', 'requestKey']);
  if ([input.username, input.accountId].filter(value => value !== undefined).length !== 1) throw new ApiError(400, 'invalid_request');
  if (input.username !== undefined && (typeof input.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(input.username) || input.username === 'demo')) throw new ApiError(400, 'invalid_username');
  return response(await rpc('peekalo_social_start', { p_actor: actor, p_recipient: input.accountId === undefined ? null : uuid(input.accountId), p_username: input.username ?? null, p_key: uuid(input.requestKey) }), request);
});
export const messages = (conversationId: string) => endpoint(async request => {
  origin(request); const actor = await account(request, { requireTerms: request.method !== 'GET' }); const conversation = uuid(conversationId);
  if (request.method === 'GET') return response(await rpc('peekalo_social_messages', { p_actor: actor, p_conversation: conversation, ...page(request) }), request);
  const input = await body(request); fields(input, ['requestKey', 'body', 'postId']);
  if ([input.body, input.postId].filter(value => value !== undefined).length !== 1) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_social_send', { p_actor: actor, p_conversation: conversation, p_key: uuid(input.requestKey), p_body: input.body === undefined ? null : text(input.body), p_post: input.postId === undefined ? null : uuid(input.postId) }), request);
});
export const respond = (conversationId: string) => endpoint(async request => {
  origin(request); const actor = await account(request, { requireTerms: true }); const input = await body(request); fields(input, ['accept']);
  if (typeof input.accept !== 'boolean') throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_social_request', { p_actor: actor, p_conversation: uuid(conversationId), p_action: input.accept ? 'accept' : 'decline' }), request);
});
export const comments = (postId: string) => endpoint(async request => {
  origin(request); const actor = await account(request, { requireTerms: request.method !== 'GET' }); const post = uuid(postId);
  if (request.method === 'GET') return response(await rpc('peekalo_social_comments', { p_actor: actor, p_post: post, ...page(request) }), request);
  const input = await body(request); fields(input, ['requestKey', 'body']);
  return response(await rpc('peekalo_social_comment', { p_actor: actor, p_post: post, p_key: uuid(input.requestKey), p_body: text(input.body) }), request);
});
export const removeSocial = (itemKind: string, itemId: string) => endpoint(async request => {
  origin(request); const actor = await account(request);
  return response(await rpc('peekalo_social_remove', { p_actor: actor, p_kind: kind(itemKind), p_item: uuid(itemId) }), request);
});
export const socialEpoch = endpoint(async request => {
  origin(request); const actor = await account(request);
  return response(await rpc('peekalo_social_epoch', { p_actor: actor }), request);
});
export const operatorSocialQueue = endpoint(async request => {
  origin(request); const actor = await account(request);
  return response(await rpc('peekalo_social_queue', { p_operator: actor, ...page(request) }), request);
});
export const operatorSocialItem = (itemKind: string, itemId: string) => endpoint(async request => {
  origin(request); const actor = await account(request); const item = uuid(itemId); const targetKind = kind(itemKind);
  if (request.method === 'GET') return response(await rpc('peekalo_social_read', { p_operator: actor, p_kind: targetKind, p_item: item }), request);
  const input = await body(request); fields(input, ['action', 'reason']);
  if (!['approve', 'reject', 'takedown'].includes(String(input.action))) throw new ApiError(400, 'invalid_request');
  return response(await rpc('peekalo_social_review', { p_operator: actor, p_kind: targetKind, p_item: item, p_action: input.action, p_reason: text(input.reason) }), request);
});

export const operatorSocialEpoch = endpoint(async request => {
  origin(request); const actor = await account(request);
  return response(await rpc('peekalo_social_operator_epoch', { p_operator: actor }), request);
});
