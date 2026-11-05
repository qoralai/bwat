import { createHash, createHmac } from 'node:crypto';
import type { GetSecret } from './config.ts';
import { SECRET } from './secret-names.ts';
import { SecretUnavailable } from './secrets/store.ts';

/** A Zoom meeting number: 9 to 12 digits. Checked again before one is put in a Zoom API path. */
export const MEETING_NUMBER = /^\d{9,12}$/;

/**
 * How long a Meeting SDK JWT lasts, counted from now: an hour. The SDK refuses a token
 * with 1800 s or less left (SDKAuth answers 15, SDKERR_INTERNAL_ERROR; QOR-4702), so it is
 * minted for an hour and a leaked one is good for an hour at most. iat is back-dated by
 * SDK_JWT_SKEW_SECONDS, as Zoom's samples do, so a Zoom clock a little behind ours still
 * accepts it.
 */
const SDK_JWT_SECONDS = 3600;
const SDK_JWT_SKEW_SECONDS = 30;

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A Meeting SDK JWT (https://developers.zoom.us/docs/meeting-sdk/auth/): HS256 under the
 * app's client secret, for joining `meetingNumber` as a participant (role 0). The client
 * id is sent as both appKey (the current name) and sdkKey (the name native SDKs read).
 * tokenExp equals exp. The secret never leaves this function.
 */
export function meetingSdkJwt(req: { clientId: string; clientSecret: string; meetingNumber: string; nowMs: number }) {
  const now = Math.floor(req.nowMs / 1000);
  const iat = now - SDK_JWT_SKEW_SECONDS;
  const exp = now + SDK_JWT_SECONDS;
  const signing = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
    appKey: req.clientId,
    sdkKey: req.clientId,
    mn: req.meetingNumber,
    role: 0,
    iat,
    exp,
    tokenExp: exp,
  })}`;
  const signature = createHmac('sha256', req.clientSecret).update(signing).digest('base64url');
  return { token: `${signing}.${signature}`, expiresAt: new Date(exp * 1000) };
}

/** The recording-token app's three credentials. */
const ZOOM_S2S_NAMES = [SECRET.zoomS2sAccountId, SECRET.zoomS2sClientId, SECRET.zoomS2sClientSecret];

/** Zoom's OAuth token endpoint and REST base: the only two places this client calls. */
const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_URL = 'https://api.zoom.us/v2';
/** An access token is used until this long before Zoom says it expires (an hour after it is granted). */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Zoom could not be asked or would not answer: a network error, a call slower than the
 * client's timeout, a refused token request or an API error.
 * `status` is Zoom's HTTP status, or null without one; `retryAfterMs` is its Retry-After
 * (whole seconds), or null. Never a body, a token or a credential.
 */
export class ZoomUnavailable extends Error {
  readonly code = 'zoom_unavailable';
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(status: number | null, retryAfterMs: number | null = null) {
    super(`zoom: unavailable${status === null ? '' : ` (HTTP ${status})`}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** How often emailLinkAccess may drop the grant to see a newly added scope. */
const ADVICE_REGRANT_MS = 60_000;

/** What the admin panel says while the S2S app cannot confirm emails (zoomApi.emailLinkAccess). */
export const EMAIL_LINK_SCOPE_NOTICE =
  'Add user:read:user:admin to the Zoom server-to-server app, so bwat can link a person’s Zoom account to their bwat account by email.';

/** The meeting events handled by name: auto-join, its readiness evidence and the event log. */
export const ZOOM_EVENT_KINDS: ReadonlySet<string> = new Set(['meeting.started', 'meeting.ended', 'meeting.participant_joined']);

/** Whether a Zoom failure with this status may pass: no answer (a network error, a timeout), a 429 or a 5xx. */
export const transientStatus = (status: unknown) => status === null || status === 429 || (typeof status === 'number' && status >= 500);

/** The pause before a retry, and the most a Retry-After may stretch it to. */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 5_000;

/**
 * `ask`, asked again once after RETRY_MS (or Zoom's Retry-After, up to RETRY_MAX_MS) when
 * it first fails with a ZoomUnavailable that may pass.
 */
export async function retryOnce<T>(ask: () => Promise<T>, sleep: (ms: number) => Promise<unknown>): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    if (!(err instanceof ZoomUnavailable) || !transientStatus(err.status)) throw err;
    await sleep(Math.min(RETRY_MAX_MS, Math.max(RETRY_MS, err.retryAfterMs ?? 0)));
    return ask();
  }
}

/** A Retry-After header in whole seconds, as ms; null for none or a date. */
function retryAfter(res: Response): number | null {
  const value = res.headers.get('retry-after');
  return value !== null && /^\d{1,6}$/.test(value) ? Number(value) * 1000 : null;
}

/** The meeting number, checked: only digits go into a Zoom API path. */
function checked(meetingNumber: string): string {
  if (!MEETING_NUMBER.test(meetingNumber)) throw new Error('zoom: not a meeting number');
  return meetingNumber;
}

type S2SCredentials = { accountId: string; clientId: string; clientSecret: string };

/**
 * The Zoom REST calls bwat makes, as the install's Server-to-Server OAuth app
 * (https://developers.zoom.us/docs/internal-apps/s2s-oauth/). The credentials are read
 * through `getSecret` on every call (a rotation applies at once; a store that cannot be
 * read fails closed, SecretUnavailable); none set means not configured, and nothing is
 * called. The access token is kept until REFRESH_MARGIN_MS before it expires, for the
 * credentials it was granted to only, and one request for it is in flight at a time; a 401
 * drops it. Every call is bounded by `timeoutMs`. Nothing here logs.
 */
export function zoomApi({
  getSecret,
  fetch = globalThis.fetch,
  now = Date.now,
  timeoutMs = 5_000,
}: {
  getSecret: GetSecret;
  fetch?: typeof globalThis.fetch | undefined;
  now?: () => number;
  timeoutMs?: number;
}) {
  /** The access token (granted or being asked for), the digest of the credentials it is for, and until when it is used. */
  let grant: { key: string; token: Promise<{ accessToken: string; scopes: string[] }>; until: number } | undefined;
  /** When emailLinkAccess last dropped the grant: at most once a minute, so the admin panel never hammers Zoom's OAuth. */
  let adviceDroppedAt = -Infinity;

  const call = async (url: string, init: RequestInit) => {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ZoomUnavailable(null);
    }
  };
  /** A 2xx answer's JSON object; ZoomUnavailable for anything else, or a body that does not arrive in time. */
  const answer = async (res: Response): Promise<Record<string, unknown>> => {
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new ZoomUnavailable(res.status, retryAfter(res));
    }
    const body: unknown = await res.json().catch(() => null);
    if (typeof body !== 'object' || body === null) throw new ZoomUnavailable(res.status);
    return body as Record<string, unknown>;
  };

  async function credentials(): Promise<S2SCredentials | null> {
    let values: (string | null)[];
    try {
      values = await Promise.all(ZOOM_S2S_NAMES.map((name) => getSecret(name)));
    } catch {
      throw new SecretUnavailable('secret store: zoom S2S credentials unreadable');
    }
    const [accountId, clientId, clientSecret] = values;
    return accountId && clientId && clientSecret ? { accountId, clientId, clientSecret } : null;
  }

  async function requestToken(creds: S2SCredentials) {
    const res = await call(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'account_credentials', account_id: creds.accountId }).toString(),
    });
    const body = await answer(res);
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') {
      throw new ZoomUnavailable(res.status);
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in, scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/) : [] };
  }

  /** The kept access token for these credentials, or the one request for a new one. */
  function accessToken(creds: S2SCredentials) {
    const key = createHash('sha256').update(JSON.stringify(creds)).digest('hex');
    if (grant && grant.key === key && now() < grant.until) return grant.token;
    const pending = {
      key,
      until: Infinity,
      token: requestToken(creds).then(({ accessToken, expiresIn, scopes }) => {
        pending.until = now() + expiresIn * 1000 - REFRESH_MARGIN_MS;
        return { accessToken, scopes };
      }),
    };
    // A failed request is not kept: the next call asks again.
    pending.token.catch(() => {
      if (grant === pending) grant = undefined;
    });
    grant = pending;
    return pending.token;
  }

  /**
   * GET `path` under the REST base as the S2S app: the answer, or null when the app is not
   * configured. A 401 drops the kept token (Zoom revoked it early), so the next call asks for a new one.
   */
  async function get(path: string, known?: S2SCredentials): Promise<Response | null> {
    const creds = known ?? (await credentials());
    if (!creds) return null;
    const token = accessToken(creds);
    const res = await call(`${API_URL}${path}`, { headers: { authorization: `Bearer ${(await token).accessToken}` } });
    if (res.status === 401 && grant?.token === token) grant = undefined;
    return res;
  }

  return {
    /** Whether the S2S app's three credentials are set. SecretUnavailable when the store cannot be read. */
    configured: async () => (await credentials()) !== null,

    /** Actual granted permissions, sharing the credential-bound OAuth cache. Never exposes the token. */
    async autoJoinAccess(): Promise<string[]> {
      const creds = await credentials();
      if (!creds) return ['Set the Zoom server-to-server account ID, client ID and client secret.'];
      const token = accessToken(creds);
      const { scopes } = await token;
      if (!scopes.some(Boolean)) {
        if (grant?.token === token) grant = undefined;
        return ['Zoom did not report the granted permissions, so automatic joining setup could not be verified. Check the server-to-server app and retry.'];
      }
      const problems: string[] = [];
      if (!['meeting:read:meeting:admin', 'meeting:read:admin'].some(scope => scopes.includes(scope))) {
        problems.push('Add meeting:read:meeting:admin to the Zoom server-to-server app.');
      }
      if (!['meeting:read:local_recording_token:admin', 'meeting_token:read:admin:local_recording'].some(scope => scopes.includes(scope))) {
        problems.push('Add meeting:read:local_recording_token:admin to the Zoom server-to-server app.');
      }
      // Adding scopes in Zoom does not rotate credentials. Refresh an insufficient
      // grant after the readiness service's short failure cooldown, not in an hour.
      if (problems.length && grant?.token === token) grant = undefined;
      return problems;
    },

    /**
     * Advice, never a readiness problem: linking a Zoom account by email (QOR-5111) needs
     * user:read:user:admin, which is optional. Empty when the S2S app is not configured, holds
     * the scope, or Zoom does not report its scopes (autoJoinAccess says so). Without it the
     * grant is dropped, at most once a minute, so a scope added in Zoom shows within a minute:
     * Zoom does not rotate credentials for it. For the admin panel only: auto-join never asks.
     */
    async emailLinkAccess(): Promise<string[]> {
      const creds = await credentials();
      if (!creds) return [];
      const token = accessToken(creds);
      const { scopes } = await token;
      if (!scopes.some(Boolean) || ['user:read:user:admin', 'user:read:admin'].some((scope) => scopes.includes(scope))) return [];
      if (grant?.token === token && now() - adviceDroppedAt >= ADVICE_REGRANT_MS) {
        grant = undefined;
        adviceDroppedAt = now();
      }
      return [EMAIL_LINK_SCOPE_NOTICE];
    },

    /**
     * A join token that lets a Meeting SDK bot record the meeting locally
     * (GET /meetings/{meetingId}/jointoken/local_recording; Zoom says it lasts 120 s), and
     * with `bypassWaitingRoom` skip the meeting's waiting room, or null when the S2S app is
     * not configured. A meeting the account does not have is ZoomUnavailable with status 404.
     */
    async recordingToken(meetingNumber: string, bypassWaitingRoom: boolean): Promise<{ token: string; expiresAt: Date } | null> {
      const res = await get(`/meetings/${checked(meetingNumber)}/jointoken/local_recording?bypass_waiting_room=${bypassWaitingRoom}`);
      if (!res) return null;
      const body = await answer(res);
      if (typeof body.token !== 'string' || !body.token || typeof body.expire_in !== 'number') throw new ZoomUnavailable(res.status);
      return { token: body.token, expiresAt: new Date(now() + body.expire_in * 1000) };
    },

    /**
     * Resolve a signed Zoom app context's occurrence to join details on this account.
     * Null when S2S is not configured. The passcode is for the allocator, never the browser.
     */
    async meetingForInvite(uuid: string): Promise<{ meetingNumber: string; passcode: string | null } | null> {
      if (!/^[A-Za-z0-9+/=_-]{1,128}$/.test(uuid)) throw new ZoomUnavailable(400);
      // Zoom performs an extra decode before lookup. Encode the whole UUID twice:
      // a single slash anywhere or a plus can otherwise change routing/identity.
      const path = encodeURIComponent(encodeURIComponent(uuid));
      // A live occurrence UUID requires type=live; the default lookup uses meeting numbers.
      const res = await get(`/meetings/${path}?type=live`);
      if (!res) return null;
      const body = await answer(res);
      const meetingNumber = String(body.id ?? '');
      if (!MEETING_NUMBER.test(meetingNumber)) throw new ZoomUnavailable(502);
      // Missing password is not proof that a meeting has none.
      if (typeof body.password !== 'string') throw new ZoomUnavailable(502);
      return { meetingNumber, passcode: body.password || null };
    },

    /**
     * The email of a user on the install's own Zoom account (GET /users/{userId}; needs
     * user:read:user:admin), or null when the S2S app is not configured. ZoomUnavailable for an
     * id that is not a Zoom user id, a user Zoom does not find (404), an answer about another user
     * or another account, or a user not active. Never logged.
     */
    async userEmail(userId: string): Promise<string | null> {
      // `me` would be the S2S app's own owner, never the person asked about.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId) || userId === 'me') throw new ZoomUnavailable(400);
      const creds = await credentials();
      if (!creds) return null;
      const body = await answer((await get(`/users/${userId}`, creds))!);
      // Only an active user: a pending one (invited, its address not yet verified) proves no email.
      if (body.id !== userId || body.account_id !== creds.accountId || body.status !== 'active' || typeof body.email !== 'string' || !body.email) {
        throw new ZoomUnavailable(502);
      }
      return body.email;
    },

    /** Passcode, title, host and scheduled end. Null when S2S is not configured; never logged. */
    async meeting(meetingNumber: string): Promise<({ passcode: string | null } & ZoomMeetingFacts) | null> {
      const res = await get(`/meetings/${checked(meetingNumber)}`);
      if (!res) return null;
      const body = await answer(res);
      const { password, topic, host_email: hostEmail } = body;
      const title = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX) : '';
      return {
        passcode: typeof password === 'string' && password !== '' ? password : null,
        topic: title || null,
        hostEmail: typeof hostEmail === 'string' && hostEmail !== '' ? hostEmail : null,
        scheduledEnd: bookedEnd(body, now()),
      };
    },
  };
}

export type ZoomApi = ReturnType<typeof zoomApi>;

/** The longest title kept from a Zoom topic (Zoom allows 200 characters). */
const TOPIC_MAX = 200;

/** A meeting's title and host as the board shows them, and when it is due to end. Meeting content: never logged. */
type ZoomMeetingFacts = { topic: string | null; hostEmail: string | null; scheduledEnd: string | null };

/** Zoom meeting types with a fixed schedule: one-off (2) and recurring at a fixed time (8). */
const SCHEDULED_TYPES = new Set([2, 8]);

/**
 * When the meeting is due to end: its start plus its scheduled duration, only for a meeting
 * with a fixed schedule. Any other (instant, no fixed time, a personal room) has none, so
 * the bot posts nothing timed in it.
 */
export function scheduledEndOf(object: Record<string, unknown>): string | null {
  const start = typeof object.start_time === 'string' ? Date.parse(object.start_time) : NaN;
  const minutes = object.duration;
  if (!SCHEDULED_TYPES.has(object.type as number) || !Number.isFinite(start) || typeof minutes !== 'number' || minutes <= 0) return null;
  return new Date(start + minutes * 60_000).toISOString();
}

/** How soon a sitting must start to be the one bwat is sent to: a wrong end is worse than none. */
const LOOK_AHEAD_MS = 15 * 60_000;

/**
 * When the sitting a meeting record describes is booked to end: the one in progress at
 * `nowMs`, or one starting within LOOK_AHEAD_MS. For a recurring meeting at a fixed time the
 * record's own start is the series start, so its sittings are its occurrences.
 */
function bookedEnd(meeting: Record<string, unknown>, nowMs: number): string | null {
  const sittings =
    meeting.type === 8 && Array.isArray(meeting.occurrences)
      ? (meeting.occurrences as Record<string, unknown>[])
          // Zoom still lists a cancelled sitting, as deleted: it is not happening.
          .filter((o) => o.status !== 'deleted')
          .map((o) => ({ type: 8, start_time: o.start_time, duration: o.duration ?? meeting.duration }))
      : [meeting];
  const sitting = sittings.find((s) => Date.parse(scheduledEndOf(s) ?? '') > nowMs);
  return sitting && Date.parse(String(sitting.start_time)) - nowMs <= LOOK_AHEAD_MS ? scheduledEndOf(sitting) : null;
}
