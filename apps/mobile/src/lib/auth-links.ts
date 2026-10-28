// Only this build's configured HTTPS origin can carry email callbacks. Google
// stays in its foreground browser attempt and never resumes from an unsolicited URL.
export function authLinkOrigin() {
  const raw = process.env.EXPO_PUBLIC_AUTH_LINK_ORIGIN;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname);
    if ((raw !== url.origin && raw !== `${url.origin}/`) || !domain || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== '/' || !url.hostname.includes('.') || url.hostname.includes('*')) return null;
    return url.origin;
  } catch { return null; }
}
export const emailRedirectUrl = (kind: 'confirmation' | 'recovery') => {
  const origin = authLinkOrigin();
  return origin ? `${origin}/auth/${kind === 'confirmation' ? 'confirm' : 'reset-password'}`
    : kind === 'confirmation' ? 'peekalo://confirm-email' : 'peekalo://reset-password';
};
export function emailCallback(path: string, kind: 'confirmation' | 'recovery') {
  let url: URL;
  try { url = new URL(path); } catch { return null; }
  const nativeHost = kind === 'confirmation' ? 'confirm-email' : 'reset-password';
  const webPath = kind === 'confirmation' ? '/auth/confirm' : '/auth/reset-password';
  const target = (url.protocol === 'peekalo:' && url.hostname === nativeHost)
    || (authLinkOrigin() !== null && url.origin === authLinkOrigin() && url.pathname === webPath);
  if (!target) return null;
  const codes = url.searchParams.getAll('code');
  const flows = url.searchParams.getAll('sb_flow_id');
  const allowed = new Set(['code', 'sb_flow_id']);
  let unknown = false;
  url.searchParams.forEach((_value, key) => { if (!allowed.has(key)) unknown = true; });
  const valid = !url.username && !url.password && !url.port && !url.hash
    && (url.protocol === 'https:' || !url.pathname || url.pathname === '/')
    && !unknown
    && codes.length === 1 && /^[a-zA-Z0-9_-]{1,2048}$/.test(codes[0])
    && flows.length <= 1 && (flows.length === 0 || /^[a-zA-Z0-9_-]{1,128}$/.test(flows[0]));
  return { code: valid ? codes[0] : null, flowId: valid ? flows[0] : undefined };
}
