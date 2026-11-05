import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * A local stand-in for Google's signing keys: tests sign ID tokens with it and serve
 * its JWKS from a fake fetch. Tests never call Google.
 */
export interface TestSigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

export function newSigningKey(kid: string): TestSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export const CLIENT_ID = 'test-client.apps.example.com';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The plugin's Desktop client: BWAT_GOOGLE_CLIENT_IDS carries it alongside the web one. */
export const PLUGIN_CLIENT_ID = 'test-plugin-client.apps.example.com';

/** A Google-shaped ID token: valid for CLIENT_ID for the next hour unless claims override it. */
export function idToken(
  key: TestSigningKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'ada@example.com',
    email_verified: true,
    // The Google Workspace domain (D146); a consumer account carries none (`{ hd: undefined }`).
    hd: 'example.com',
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const signingInput = `${b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header })}.${b64(payload)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), key.privateKey).toString('base64url')}`;
}

/** A fetch that serves `keys` as a JWKS, counting calls; max-age in seconds when given. */
export function jwksFetch(keys: () => TestSigningKey[], maxAge?: number) {
  const calls: string[] = [];
  const fetch = async (url: string | URL) => {
    calls.push(String(url));
    const headers = maxAge === undefined ? {} : { 'cache-control': `public, max-age=${maxAge}, must-revalidate` };
    return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), { status: 200, headers });
  };
  return { fetch, calls };
}
