import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { STALE_SECONDS } from './claims.ts';
import type { GetSecret } from './config.ts';
import { SECRET } from './secret-names.ts';
import { MEETING_NUMBER, retryOnce, transientStatus, ZOOM_EVENT_KINDS, ZoomUnavailable, type ZoomApi } from './zoom-api.ts';

const NAMES = [SECRET.zoomClientId, SECRET.zoomClientSecret, SECRET.zoomWebhookSecret, SECRET.zoomS2sAccountId, SECRET.zoomS2sClientId, SECRET.zoomS2sClientSecret];
const digest = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

export function createAutoJoinReadiness({ pool, getSecret, zoomApi, enabled, now = Date.now }: {
  pool: pg.Pool; getSecret: GetSecret; zoomApi: ZoomApi; enabled: boolean; now?: () => number;
}) {
  // Account-wide events must not hammer OAuth when credentials are wrong. Only
  // failed access checks are held briefly; config changes bypass the one-entry cache.
  let failedAccess: { fingerprint: string; until: number; problems: string[] } | undefined;
  const accessProblems = async (fingerprint: string) => {
    if (failedAccess?.fingerprint === fingerprint && now() < failedAccess.until) return failedAccess.problems;
    let problems: string[];
    try {
      problems = await retryOnce(() => zoomApi.autoJoinAccess(), sleep);
    } catch (error) {
      if (error instanceof ZoomUnavailable && transientStatus(error.status)) return ['Zoom is temporarily unavailable. Automatic joining setup could not be checked. Try again shortly.'];
      problems = ['Zoom could not verify account access. Check that the server-to-server app is activated and its credentials are correct, then retry.'];
    }
    failedAccess = problems.length ? { fingerprint, until: now() + 10_000, problems } : undefined;
    return problems;
  };
  const configuration = async () => {
    const values = await Promise.all(NAMES.map(getSecret));
    const [clientId, clientSecret, webhookSecret, accountId] = values;
    return { clientId, clientSecret, webhookSecret, accountId, fingerprint: digest(values), delivery: digest([webhookSecret, accountId]) };
  };
  return {
    /** After signature verification, outside acknowledgement. A lookup awaits evidence before checking readiness. */
    async observe(event: { event: string; event_ts?: number | undefined; payload?: { account_id?: unknown; object?: unknown } | undefined }, verifiedSecret: string) {
      if (!ZOOM_EVENT_KINDS.has(event.event) || typeof event.event_ts !== 'number' || Math.abs(Date.now() - event.event_ts) > 600_000) return;
      const object = event.payload?.object as { id?: unknown } | undefined;
      if (!MEETING_NUMBER.test(String(object?.id ?? ''))) return;
      const account = await getSecret(SECRET.zoomS2sAccountId);
      if (!account || event.payload?.account_id !== account) return;
      await pool.query(`INSERT INTO auto_join_delivery (configuration, event_kind) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET configuration = EXCLUDED.configuration, event_kind = EXCLUDED.event_kind, received_at = now()
        WHERE auto_join_delivery.configuration <> EXCLUDED.configuration
          OR auto_join_delivery.received_at < now() - interval '1 minute'`,
      [digest([verifiedSecret, account]), event.event]);
    },

    /** Derived each time; grant caching belongs to ZoomApi and is bound to credentials. */
    async check(accountId?: unknown) {
      const problems: string[] = [];
      let fingerprint: string | null = null;
      let lastEventAt: string | null = null;
      if (!enabled) problems.push('Automatic joining is disabled by this installation’s environment.');
      try {
        const config = await configuration();
        fingerprint = config.fingerprint;
        if (accountId !== undefined && accountId !== config.accountId) problems.push('The meeting event belongs to another Zoom account.');
        if (!config.clientId || !config.clientSecret) problems.push('Set the main Zoom app’s Meeting SDK client ID and client secret.');
        if (!config.webhookSecret) problems.push('Set the main Zoom app’s webhook secret token.');
        problems.push(...await accessProblems(fingerprint));
        const evidence = await pool.query<{ received_at: Date }>('SELECT received_at FROM auto_join_delivery WHERE configuration = $1', [config.delivery]);
        lastEventAt = evidence.rows[0]?.received_at.toISOString() ?? null;
        if (!lastEventAt) problems.push('Waiting for a verified meeting event from this Zoom account. Check the main app’s event subscription.');
        if ((await configuration()).fingerprint !== fingerprint) problems.push('Zoom credentials changed during the check. Try again.');
      } catch { problems.push('Zoom setup could not be read. Try again shortly.'); }
      try {
        const bots = await pool.query(`SELECT 1 FROM bots WHERE ready_at IS NOT NULL AND last_heartbeat > now() - interval '${STALE_SECONDS} seconds' LIMIT 1`);
        if (!bots.rowCount) problems.push('No ready bot has checked in recently. Start or repair the meeting bot.');
      } catch { problems.push('Bot availability could not be checked. Try again shortly.'); }
      return { ready: problems.length === 0, problems, lastEventAt, fingerprint };
    },
    /**
     * Advice that never makes automatic joining unready (zoomApi.emailLinkAccess); empty when
     * Zoom cannot be asked. Only the admin panel reads it, never a meeting lookup.
     */
    async notices(): Promise<string[]> {
      return zoomApi.emailLinkAccess().catch(() => []);
    },
    async unchanged(fingerprint: string | null) {
      return fingerprint !== null && (await configuration()).fingerprint === fingerprint;
    },
  };
}

export type AutoJoinReadiness = ReturnType<typeof createAutoJoinReadiness>;
