import type { ConfigContext, ExpoConfig } from 'expo/config';

// An explicit release origin only: never infer a trusted auth host from an
// incoming URL or enable verification for arbitrary API development hosts.
function authLinkOrigin(value: string): string {
  try {
    const url = new URL(value);
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname);
    if (url.protocol === 'https:' && domain && url.hostname.length <= 253 && !url.port && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
      && (value === url.origin || value === `${url.origin}/`)) return url.origin;
  } catch { /* Do not include invalid configuration values in diagnostics. */ }
  throw new Error('EXPO_PUBLIC_AUTH_LINK_ORIGIN must be an exact HTTPS domain origin.');
}

export default function configure({ config }: ConfigContext): ExpoConfig {
  if (!config.name || !config.slug) throw new Error('Peekalo app configuration needs its existing name and slug.');
  // Expo types the resolved input as partial, although app.json supplies both
  // required values. Validate rather than silently inventing a build identity.
  const resolved = config as ExpoConfig;
  const value = process.env.EXPO_PUBLIC_AUTH_LINK_ORIGIN;
  if (!value) return resolved;
  const host = new URL(authLinkOrigin(value)).hostname;
  return {
    ...resolved,
    ios: { ...resolved.ios, associatedDomains: [...(resolved.ios?.associatedDomains ?? []), `applinks:${host}`] },
    android: {
      ...resolved.android,
      intentFilters: [
        ...(resolved.android?.intentFilters ?? []),
        // Each filter has one exact path so Android's merged data matching
        // cannot widen this to share links, profiles or all auth paths.
        ...['/auth/confirm', '/auth/reset-password'].map(path => ({
          action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'],
          data: [{ scheme: 'https', host, path }],
        })),
      ],
    },
  };
}
