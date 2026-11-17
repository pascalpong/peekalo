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
  const profile = process.env.PEEKALO_BUILD_PROFILE;
  if (profile && profile !== 'store') throw new Error('Unknown PEEKALO_BUILD_PROFILE. Omit it for existing development builds, or use store.');
  const resolved = profile === 'store' ? storeConfiguration(config as ExpoConfig) : config as ExpoConfig;
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

// This validates build inputs, not account ownership, live deployment, device
// privacy, policy approval or permission to submit. Those gates stay on the board.
function storeConfiguration(config: ExpoConfig): ExpoConfig {
  const env = process.env;
  const fail = (field: string): never => { throw new Error(`Store configuration requires valid ${field}; see docs/STORE_SUBMISSION.md.`); };
  if (env.EXPO_NO_DOTENV !== '1') fail('EXPO_NO_DOTENV=1');
  if (env.EXPO_NO_CLIENT_ENV_VARS || env.EXPO_PUBLIC_PEEKALO_LOCAL_TESTING || env.EXPO_PUBLIC_PEEKALO_SIMULATOR_FIXTURES) fail('client environment without development overrides');
  const origin = (value: string | undefined, field: string) => {
    let parsed: URL;
    try { parsed = new URL(authLinkOrigin(value ?? '')); } catch { return fail(field); }
    if (/(^|\.)(invalid|test|example|localhost)$/.test(parsed.hostname)
      || /(^|\.)example\.(com|org|net)$/.test(parsed.hostname)
      || /(^|[.-])(dev|development|staging|preview|qa|fixture|test)([.-]|$)/i.test(parsed.hostname)) fail(field);
    return parsed.origin;
  };
  const api = origin(env.EXPO_PUBLIC_API_URL, 'EXPO_PUBLIC_API_URL');
  const auth = origin(env.EXPO_PUBLIC_AUTH_LINK_ORIGIN, 'EXPO_PUBLIC_AUTH_LINK_ORIGIN');
  // Peekalo currently serves auth associations and the API from the product origin.
  if (api !== auth) fail('matching product API and auth origins');
  const identifier = (value: string | undefined, field: string) => {
    if (!value || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/.test(value)
      || /(^|\.)(preview|debug|test|privacyqa|qa|example|fixture|dev|development)(\.|$)/.test(value)) return fail(field);
    return value;
  };
  const bundle = identifier(env.PEEKALO_IOS_BUNDLE_ID, 'PEEKALO_IOS_BUNDLE_ID');
  const android = identifier(env.PEEKALO_ANDROID_PACKAGE, 'PEEKALO_ANDROID_PACKAGE');
  const version = env.PEEKALO_RELEASE_VERSION;
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail('PEEKALO_RELEASE_VERSION');
  const build = env.PEEKALO_IOS_BUILD_NUMBER;
  if (!build || !/^[1-9]\d{0,3}$/.test(build)) fail('PEEKALO_IOS_BUILD_NUMBER (1–9999)');
  const code = env.PEEKALO_ANDROID_VERSION_CODE;
  if (!code || !/^[1-9]\d*$/.test(code) || !Number.isSafeInteger(Number(code)) || Number(code) > 2100000000) fail('PEEKALO_ANDROID_VERSION_CODE');
  const plugins = (config.plugins ?? []).map(plugin => {
    const name = typeof plugin === 'string' ? plugin : plugin[0];
    const options = typeof plugin === 'string' ? {} : plugin[1] ?? {};
    if (name === 'expo-secure-store') return [name, { ...options, faceIDPermission: false }] as [string, Record<string, unknown>];
    if (name !== 'expo-build-properties') return plugin;
    return [name, { ...options, android: { ...options.android, compileSdkVersion: 36, targetSdkVersion: 36, usesCleartextTraffic: false, networkInspector: false } }] as [string, Record<string, unknown>];
  });
  return {
    ...config, version,
    ios: { ...config.ios, bundleIdentifier: bundle, buildNumber: build },
    android: {
      ...config.android, package: android, versionCode: Number(code),
      blockedPermissions: [...new Set([...(config.android?.blockedPermissions ?? []),
        'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT', 'android.permission.VIBRATE'])],
    },
    plugins: [...plugins, './plugins/withStorePrivacy.cjs'],
  };
}
