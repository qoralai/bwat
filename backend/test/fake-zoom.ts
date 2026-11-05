import { createHmac } from 'node:crypto';
import type { GetSecret } from '../src/config.ts';
import { zoomSecret } from './zoom.ts';

/** The install's test Zoom app credentials, under their tier-2 names. Never real ones. */
export const ZOOM_APP = {
  'zoom.client_id': 'test-sdk-client-id',
  'zoom.client_secret': 'test-sdk-client-secret-0123456789',
};
export const ZOOM_S2S = {
  'zoom.s2s_account_id': 'test-s2s-account',
  'zoom.s2s_client_id': 'test-s2s-client-id',
  'zoom.s2s_client_secret': 'test-s2s-client-secret-0123456789',
};

/**
 * A secret store holding the webhook secret and `values` (by tier-2 name). `values`
 * is read on every call, so a test can change it (a rotation); every read throws while
 * `failing`, and a read of a name in `unreadable` always does. Each read's name is put in
 * `reads`.
 */
export function zoomSecrets(
  values: Record<string, string>,
): GetSecret & { values: Record<string, string>; failing: boolean; unreadable: string[]; reads: string[] } {
  const get = Object.assign(
    async (name: string) => {
      get.reads.push(name);
      if (get.failing || get.unreadable.includes(name)) throw Object.assign(new Error('secret store: unreadable'), { code: 'secret_unavailable' });
      return name in get.values ? get.values[name]! : zoomSecret(name);
    },
    { values, failing: false, unreadable: [] as string[], reads: [] as string[] },
  );
  return get;
}

/** One request the fake Zoom received: its method, URL, and headers and body as sent. */
interface ZoomCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

/** What the fake answers a request with: a status, a JSON body and any extra headers, after `delayMs` and once `held` resolves, if given. */
type ZoomAnswer =
  | { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; held?: Promise<void> }
  | 'network_error';

/**
 * A stand-in for Zoom's OAuth and REST hosts, as an injected fetch. Never calls Zoom. By
 * default the token endpoint grants `access-1`, `access-2`, ... (3600 s), a meeting
 * answers the topic `Quarterly numbers`, its host's email, `passcode` and `recording`
 * (its settings.auto_recording, left out when undefined), and a recording join token answers `recording-<meeting>` (120 s).
 * `answer` overrides any request; `calls` is every request received.
 */
export function fakeZoom() {
  const zoom = {
    calls: [] as ZoomCall[],
    passcode: 'looked-up-pass',
    recording: 'cloud' as 'local' | 'cloud' | 'none' | undefined,
    answer: undefined as ((call: ZoomCall) => ZoomAnswer | undefined) | undefined,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: ZoomCall = {
        method: init?.method ?? 'GET',
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null,
      };
      zoom.calls.push(call);
      const answer = zoom.answer?.(call) ?? zoom.standard(call);
      if (answer === 'network_error') throw new TypeError('fetch failed');
      if (answer.delayMs) await delay(answer.delayMs, init?.signal);
      await answer.held;
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } });
    }) as typeof fetch,
    standard(call: ZoomCall): Exclude<ZoomAnswer, 'network_error'> {
      if (call.url.startsWith('https://zoom.us/oauth/token')) {
        return { status: 200, body: { access_token: `access-${zoom.tokenCalls().length}`, token_type: 'bearer', expires_in: 3600, scope: 'meeting:read:meeting:admin meeting:read:local_recording_token:admin' } };
      }
      const recording = /^https:\/\/api\.zoom\.us\/v2\/meetings\/(\d+)\/jointoken\/local_recording\?bypass_waiting_room=(?:true|false)$/.exec(call.url);
      if (recording) return { status: 200, body: { token: `recording-${recording[1]}`, expire_in: 120 } };
      const meeting = /^https:\/\/api\.zoom\.us\/v2\/meetings\/(\d+)$/.exec(call.url);
      if (meeting) {
        const settings = zoom.recording === undefined ? {} : { settings: { auto_recording: zoom.recording } };
        return { status: 200, body: { id: Number(meeting[1]), topic: 'Quarterly numbers', host_email: 'grace@example.com', password: zoom.passcode, ...settings } };
      }
      return { status: 404, body: { code: 3001, message: 'not found' } };
    },
    /** The requests to the REST API (not the token endpoint). */
    apiCalls: () => zoom.calls.filter((c) => c.url.startsWith('https://api.zoom.us/')),
    tokenCalls: () => zoom.calls.filter((c) => c.url.startsWith('https://zoom.us/oauth/token')),
  };
  return zoom;
}

/** Resolves after `ms`, or rejects as fetch does when `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** A JWT's header and payload, and whether its HS256 signature verifies under `secret`. */
export function decodeJwt(token: string, secret: string) {
  const [header, payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')),
    verified: signature === expected,
  };
}
