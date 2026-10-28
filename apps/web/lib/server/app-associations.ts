type Environment = Record<string, string | undefined>;
type Association = 'apple' | 'android';

function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname);
    return url.protocol === 'https:' && domain && url.hostname.length <= 253 && !url.port && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
      && (value === url.origin || value === `${url.origin}/`) ? url.origin : null;
  } catch { return null; }
}

function fingerprints(value: string | undefined): string[] | null {
  if (!value) return null;
  const values = value.split(',').map(item => item.trim().toUpperCase());
  if (values.length > 8 || values.some(item => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(item))) return null;
  return [...new Set(values)];
}

/** Public signing identifiers only; this never reads a signing key or credential. */
export function appAssociation(kind: Association, env: Environment = process.env) {
  const origin = httpsOrigin(env.AUTH_LINK_ORIGIN);
  if (!origin || origin !== httpsOrigin(env.PUBLIC_APP_URL)) return null;
  if (kind === 'apple') {
    const appID = env.APPLE_APP_ID;
    if (!appID || appID.length > 255 || !/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(appID)) return null;
    return {
      applinks: {
        apps: [],
        details: [{ appIDs: [appID], components: [{ '/': '/auth/confirm' }, { '/': '/auth/reset-password' }] }],
      },
    };
  }
  const packageName = env.ANDROID_APP_ID;
  const certificateFingerprints = fingerprints(env.ANDROID_SHA256_CERT_FINGERPRINTS);
  if (!packageName || packageName.length > 255 || !/^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)+$/.test(packageName)
    || !certificateFingerprints) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: certificateFingerprints },
  }];
}

export function appAssociationResponse(kind: Association) {
  const body = appAssociation(kind);
  return Response.json(body ?? { available: false }, {
    status: body ? 200 : 404,
    // Configuration may be cut over independently of a web build. Never cache
    // an unset association or expose cookies/credentials on these public routes.
    headers: { 'Cache-Control': body ? 'public, max-age=300' : 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
