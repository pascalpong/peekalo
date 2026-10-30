import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from 'node:crypto';
import { backendFetch } from './sharing';

// Native-only Sign in with Apple. These server credentials are distinct from
// the Supabase login provider settings; never ship them to either client.
export async function revokeAppleAuthorization(code: string, expectedSubject: string) {
  const clientId = process.env.APPLE_NATIVE_CLIENT_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_SIGN_IN_KEY_ID;
  const key = process.env.APPLE_SIGN_IN_PRIVATE_KEY;
  if (!clientId || !teamId || !keyId || !key || !expectedSubject) throw new Error('provider_revocation_required');
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: keyId })}.${encode({ iss: teamId, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: clientId })}`;
  const clientSecret = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(key.replaceAll('\\n', '\n')), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  const exchanged = await backendFetch('https://appleid.apple.com/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }) });
  if (!exchanged.ok) throw new Error('provider_revocation_required');
  const data = await exchanged.json();
  if (typeof data.id_token !== 'string' || typeof data.refresh_token !== 'string' || data.refresh_token.length > 8192) throw new Error('provider_revocation_required');
  const parts = data.id_token.split('.');
  if (parts.length !== 3 || data.id_token.length > 16384) throw new Error('provider_revocation_required');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.iss !== 'https://appleid.apple.com' || claims.aud !== clientId ||
      claims.sub !== expectedSubject || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 60) throw new Error('provider_revocation_required');
  const keysResponse = await backendFetch('https://appleid.apple.com/auth/keys');
  if (!keysResponse.ok) throw new Error('provider_revocation_required');
  const keys = await keysResponse.json();
  const jwk = Array.isArray(keys.keys) ? keys.keys.find((item: JsonWebKey & { kid?: string }) => item.kid === header.kid && item.kty === 'RSA') : undefined;
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('provider_revocation_required');
  const revoked = await backendFetch('https://appleid.apple.com/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: data.refresh_token, token_type_hint: 'refresh_token' }) });
  if (!revoked.ok) throw new Error('provider_revocation_required');
}
