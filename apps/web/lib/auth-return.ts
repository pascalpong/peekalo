/** Translate only the two email-return pages, never tokens or arbitrary destinations. */
export function nativeEmailReturn(raw: string, kind: 'confirmation' | 'recovery') {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const path = kind === 'confirmation' ? '/auth/confirm' : '/auth/reset-password';
  const codes = url.searchParams.getAll('code');
  const flows = url.searchParams.getAll('sb_flow_id');
  if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== path || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => !['code', 'sb_flow_id'].includes(key))
    || codes.length !== 1 || !/^[a-zA-Z0-9_-]{1,2048}$/.test(codes[0])
    || flows.length > 1 || (flows.length === 1 && !/^[a-zA-Z0-9_-]{1,128}$/.test(flows[0]))) return null;
  const native = new URL(kind === 'confirmation' ? 'peekalo://confirm-email' : 'peekalo://reset-password');
  native.searchParams.set('code', codes[0]);
  if (flows.length) native.searchParams.set('sb_flow_id', flows[0]);
  return native.toString();
}
