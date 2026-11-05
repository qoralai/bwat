import { createHash, randomBytes } from 'node:crypto';
import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** 32 random bytes, base64url: a state, a nonce or a PKCE verifier (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A PKCE pair (RFC 7636, S256). Google sees the challenge; only the server ever holds the verifier. */
export function createPkce(verifier = randomToken()): { verifier: string; challenge: string } {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Where Google sign-in happens. Google's by default; buildApp options override them for tests only. */
export interface GoogleEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Accepted ID-token `iss` values. */
  issuers: string[];
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  // Google documents both forms of its issuer.
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/**
 * The authorization request: code flow with PKCE S256, state and nonce, and offline
 * access (D180) so the server holds a refresh token. Google returns a refresh token only
 * on a consent screen, hence `consent` beside the account chooser.
 */
export function authorizationUrl(
  endpoint: string,
  request: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: 'openid email profile',
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
  }).toString();
  return url.toString();
}

/**
 * Verifies the ID token from the code exchange: signature against Google's published
 * keys, issuer, audience (our client id), expiry, and the nonce from this login's cookie.
 * Membership is the backend's call (GET /v1/me), not this server's. Throws on any failure.
 */
export async function verifyIdToken(
  idToken: string,
  keys: JWTVerifyGetKey,
  expected: { issuers: string[]; audience: string; nonce: string },
): Promise<void> {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: expected.issuers,
    audience: expected.audience,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp'],
  });
  if (payload.nonce !== expected.nonce) throw new Error('ID token: nonce mismatch');
}

/** The ID token's expiry in epoch ms. */
export function idTokenExpiry(idToken: string): number {
  const { exp } = decodeJwt(idToken);
  return (exp ?? 0) * 1000;
}

export interface GoogleTokens {
  idToken: string;
  /** Present on the code exchange (offline access); a refresh usually returns none. */
  refreshToken: string | undefined;
}

/**
 * One call to Google's token endpoint, server-side (client_secret_post): the code
 * exchange or a refresh. Google's access token is dropped unread: this server calls no
 * Google API. Throws on any non-2xx; the message carries Google's error code only.
 */
export async function tokenRequest(tokenEndpoint: string, form: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; refresh_token?: unknown; error?: unknown };
  if (!res.ok) throw new Error(`token request: ${res.status} ${typeof body.error === 'string' ? body.error : ''}`.trim());
  if (typeof body.id_token !== 'string') throw new Error('token request: no id_token');
  return {
    idToken: body.id_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}

// A stalled token endpoint must not hold a request open indefinitely.
const TOKEN_TIMEOUT_MS = 10_000;
