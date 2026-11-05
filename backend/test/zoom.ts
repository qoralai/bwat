import { AUTO_JOIN_KEY, AUTO_JOIN_REQUIRE_HOST_KEY } from '../src/auto-join-switch.ts';
import type { GetSecret } from '../src/config.ts';
import { SECRET } from '../src/secret-names.ts';
import { zoomSignature } from '../src/zoom-signature.ts';
import { until, useApp, type TestApp } from './app.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';

/** The webhook secret token the Zoom test apps are configured with. */
export const ZOOM_SECRET = 'zoom-test-secret-token';

/** A secret store holding only the test webhook secret, under its tier-2 name. */
export const zoomSecret: GetSecret = async (name) => (name === SECRET.zoomWebhookSecret ? ZOOM_SECRET : null);

/**
 * POSTs `body` to /callbacks/zoom/events (or `url`) as Zoom would: the exact string sent is the one
 * signed, with the current time unless `at` (epoch seconds) is given. `signature: null` sends none.
 */
export function deliver(
  t: Pick<TestApp, 'app'>,
  body: object | string,
  {
    secret = ZOOM_SECRET,
    at = Math.floor(Date.now() / 1000),
    signature,
    url = '/callbacks/zoom/events',
  }: { secret?: string; at?: number; signature?: string | null; url?: string } = {},
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = signature === undefined ? zoomSignature(secret, String(at), Buffer.from(raw)) : signature;
  return t.app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-zm-request-timestamp': String(at),
      ...(sig === null ? {} : { 'x-zm-signature': sig }),
    },
    payload: raw,
  });
}

let seq = 0;

/** A Zoom meeting event. Each call differs (event_ts), so it is never a re-delivery of another. */
export function zoomEvent(
  event: string,
  object: Record<string, unknown>,
  { eventTs = Date.now() + seq++ }: { eventTs?: number } = {},
) {
  return { event, event_ts: eventTs, payload: { account_id: ZOOM_S2S['zoom.s2s_account_id'], object } };
}

/** What a suite's settings reader answers: the auto-join switch and the require-host key (JSON values), or a failure. */
interface StoredSwitch {
  value: unknown;
  requireHost: unknown;
  failing: boolean;
}

const switches = new WeakMap<TestApp, StoredSwitch>();

/** useApp whose auto-join preference reader is a stand-in the suite sets. */
export function useZoomApp(options: Parameters<typeof useApp>[0]): TestApp {
  const stored: StoredSwitch = { value: undefined, requireHost: undefined, failing: false };
  const t = useApp({
    getSecret: zoomSecret,
    readAutoJoinSwitch: async (key) => {
      if (stored.failing) throw Object.assign(new Error('settings unreadable'), { code: '57P01' });
      if (key === AUTO_JOIN_KEY) return stored.value;
      if (key === AUTO_JOIN_REQUIRE_HOST_KEY) return stored.requireHost;
      throw new Error(`unexpected settings key ${key}`);
    },
    ...options,
  });
  switches.set(t, stored);
  return t;
}

/** The stand-in switch behind a useZoomApp suite. */
export const storedSwitch = (t: TestApp): StoredSwitch => switches.get(t)!;

/** A useAutoJoinApp suite: its fake Zoom, its secret store and every log line it wrote. */
type AutoJoinApp = TestApp & { zoom: ReturnType<typeof fakeZoom>; secrets: ReturnType<typeof zoomSecrets>; lines: string[] };

/**
 * useZoomApp with the S2S app set up against a fake Zoom, whose meetings are scheduled
 * to record to the cloud: auto-join looks every meeting up before it opens a claim. The
 * lookup's retry does not pause.
 */
export function useAutoJoinApp(options: Parameters<typeof useApp>[0]): AutoJoinApp {
  const zoom = fakeZoom();
  const secrets = zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S });
  const lines: string[] = [];
  const t = useZoomApp({
    getSecret: secrets,
    zoomFetch: zoom.fetch,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    // The lookup's pause before its retry: none, so no test waits on a real clock.
    sleep: async () => undefined,
    ...options,
  });
  return Object.assign(t, { zoom, secrets, lines });
}

/** The next `event` record (default `zoom.meeting_lookup`) logged from line `from` on, once it has been. */
export async function lookupLogged(t: Pick<AutoJoinApp, 'lines'>, from = 0, event = 'zoom.meeting_lookup'): Promise<Record<string, unknown>> {
  const found = () => t.lines.slice(from).map((l) => JSON.parse(l)).find((l) => l.event === event);
  if (!(await until(async () => found() !== undefined, { tries: 150, ms: 20 }))) throw new Error(`no ${event} logged`);
  return found();
}

/**
 * Delivers a start or arrival: its status, or, when the meeting is looked up after the
 * answer (`meeting_lookup`), the lookup's outcome once it has finished.
 */
export async function autoJoined(t: AutoJoinApp, event: object): Promise<string> {
  const from = t.lines.length;
  const { status } = (await deliver(t, event)).json();
  return status === 'meeting_lookup' ? String((await lookupLogged(t, from)).outcome) : status;
}
