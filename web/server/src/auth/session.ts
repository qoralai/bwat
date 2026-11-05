import { sealedCookie } from './sealed-cookie.ts';

export const SESSION_COOKIE = 'bwat_session';

/**
 * Session lifetime: after 12 h the person signs in again. Also how long a board cookie (Zoom's,
 * and a plugin's when the backend names no expiry) is kept: the backend's board tokens last the
 * same 12 hours (BOARD_TOKEN_TTL_S, backend/src/zoom-board-signin.ts). Change both together.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * What the session cookie holds (D180): the person's Google id_token and refresh_token,
 * and the session's expiry in epoch ms. Only the id_token ever reaches the page.
 */
export interface Session {
  idToken: string;
  refreshToken: string;
  exp: number;
  /**
   * 'code' on a local install: idToken is then the backend's board token (bwz_), good
   * for the whole session, and refreshToken the code session's (bwr_), which signing out ends.
   */
  kind?: 'code';
}

/** The session, or null (signed out) for a missing, tampered, foreign-key or expired cookie; kept for its remaining lifetime. */
export const {
  read: readSession,
  write: writeSession,
  clear: clearSession,
} = sealedCookie<Session>(SESSION_COOKIE, '/', (p) => typeof p.idToken === 'string' && typeof p.refreshToken === 'string');

export const LOGIN_COOKIE = 'bwat_login';

// The login round trip to Google must finish within this, or the person starts again.
export const LOGIN_TTL_S = 600;

/**
 * Signing in to pair a product: `for` is the pairing code's audience ('zoom', or
 * a switched-on plugin's name, which the backend checks again) and `into` its name on the
 * code's page ("Type this code into <its display name>").
 */
export interface PairFor {
  for: string;
  into: string;
}

/** What the login cookie holds between the redirect to Google and /auth/callback. */
export interface Login {
  state: string;
  nonce: string;
  verifier: string;
  /** Where the callback lands: a path on this site (localPath), never another site. */
  back: string;
  /** Signing in to pair the board inside Zoom, or a plugin's product: the callback shows a pairing code worded for it. */
  pairFor?: PairFor;
  exp: number;
}

/** The login, or null for a missing, tampered, foreign-key, expired or malformed cookie. Scoped to
 * /auth: only /auth/callback ever needs it back. */
export const {
  read: readLogin,
  write: writeLogin,
  clear: clearLogin,
} = sealedCookie<Login>(
  LOGIN_COOKIE,
  '/auth',
  (p) => ['state', 'nonce', 'verifier', 'back'].every((k) => typeof p[k] === 'string'),
  LOGIN_TTL_S,
);

export const ZOOM_COOKIE = 'bwat_zoom';

/**
 * What Zoom's app context got the board: a board token for a linked Zoom
 * user, or the one-time code to link one. Never both. `occurrenceId` is the Zoom meeting
 * the board was opened from, so the board opens on it.
 */
export type ZoomSignIn = ({ token: string } | { linkCode: string }) & { occurrenceId?: string | null; exp: number };

/** The Zoom sign-in, or null for a missing, tampered, foreign-key or expired cookie. */
export const {
  read: readZoom,
  write: writeZoom,
  clear: clearZoom,
} = sealedCookie<ZoomSignIn>(ZOOM_COOKIE, '/', (p) => typeof p.token === 'string' || typeof p.linkCode === 'string');
