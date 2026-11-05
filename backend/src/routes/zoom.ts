import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AutoJoinSwitch } from '../auto-join-switch.ts';
import type { AutoJoinReadiness } from '../auto-join-readiness.ts';
import type { BusyProtection } from '../busy.ts';
import type { GetSecret, ZoomConfig } from '../config.ts';
import { SECRET } from '../secret-names.ts';
import type { Bucket } from '../rate-limit.ts';
import type { ZoomApi } from '../zoom-api.ts';
import { handleZoomEvent, kindOf, type ZoomDeps } from '../zoom-events.ts';
import { prescreenZoomRequest, urlValidation, verifyZoomRequest } from '../zoom-signature.ts';

/**
 * The named Zoom secrets, every one set; otherwise null after answering 503:
 * `secret_unavailable` when the store cannot be read, `not_configured` when one is not set.
 * Logs the event and `what` only, never a value.
 */
export async function requiredZoomSecrets<const Names extends readonly string[]>(
  getSecret: GetSecret,
  names: Names,
  what: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ [K in keyof Names]: string } | null> {
  let values: (string | null)[];
  try {
    values = await Promise.all(names.map((name) => getSecret(name)));
  } catch {
    req.log.error({ event: 'zoom.secret_unavailable' }, `${what} unreadable`);
    return (await reply.code(503).send({ error: 'secret_unavailable' }), null);
  }
  if (values.some((value) => !value)) {
    req.log.warn({ event: 'zoom.not_configured' }, `${what} not set`);
    return (await reply.code(503).send({ error: 'not_configured' }), null);
  }
  return values as { [K in keyof Names]: string };
}

const Event = z.object({
  event: z.string().max(128),
  event_ts: z.number().optional(),
  payload: z.object({ plainToken: z.string().min(1).max(256).optional(), object: z.unknown().optional() }).passthrough().optional(),
});

/**
 * Zoom's webhook deliveries. Public, so every one is signature-verified before it is
 * read (the raw body is what Zoom signed), and one without a fresh, well-formed
 * signature is refused before the secret store is asked. A body already acted on is answered as a
 * duplicate: its digest is recorded in the transaction that acts on it (see
 * recordDelivery), so one whose handling fails is retried. Logs record the event type
 * and outcome only, never the payload.
 */
export function zoomRoutes(
  app: FastifyInstance,
  {
    pool,
    zoom,
    getSecret,
    autoJoinSwitch,
    autoJoinReadiness,
    busy,
    zoomApi,
    lookups,
    later,
    limit,
    allowedDomains,
  }: {
    pool: pg.Pool;
    zoom: ZoomConfig;
    getSecret: GetSecret;
    autoJoinSwitch: AutoJoinSwitch;
    autoJoinReadiness: AutoJoinReadiness;
    busy: BusyProtection;
    zoomApi: ZoomApi;
    lookups: ZoomDeps['lookups'];
    later: ZoomDeps['later'];
    /** The webhook's per-client-IP bucket (QOR-4625): every delivery counted, before the body is read. */
    limit: Bucket;
    allowedDomains: ZoomDeps['allowedDomains'];
  },
): void {
  app.register(async (scope) => {
    // Keep the body as Zoom sent it, in this scope only: the signature covers its bytes.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

    scope.post('/callbacks/zoom/events', {
      onRequest: async (req) => {
        limit.check(req);
        limit.count(req);
      },
    }, async (req, reply) => {
      const signature = header(req.headers['x-zm-signature']);
      const timestamp = header(req.headers['x-zm-request-timestamp']);
      const nowMs = Date.now();
      const rejected = (code: string) => {
        req.log.info({ event: 'zoom.rejected', code }, 'zoom delivery rejected');
        return reply.code(401).send({ error: 'unauthorized' });
      };
      // A delivery that cannot be Zoom's is refused before the secret store is asked.
      const shape = prescreenZoomRequest({ signature, timestamp, nowMs });
      if (shape !== 'ok') return rejected(shape);

      // Read per delivery, so a secret rotated in the store is used at once.
      const secrets = await requiredZoomSecrets(getSecret, [SECRET.zoomWebhookSecret], 'zoom webhook secret', req, reply);
      if (!secrets) return reply;
      const [secret] = secrets;
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const verdict = verifyZoomRequest({ secret, signature, timestamp, rawBody, nowMs });
      if (verdict !== 'ok') return rejected(verdict);

      let parsed: ReturnType<typeof Event.safeParse>;
      try {
        parsed = Event.safeParse(JSON.parse(rawBody.toString('utf8')));
      } catch {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const body = parsed.data;

      if (body.event === 'endpoint.url_validation') {
        const plainToken = body.payload?.plainToken;
        if (!plainToken) return reply.code(400).send({ error: 'invalid_body' });
        req.log.info({ event: 'zoom.url_validation' }, 'zoom endpoint validated');
        return urlValidation(secret, plainToken);
      }

      const deliveryKey = createHash('sha256').update(rawBody).digest();
      // Evidence must not delay acknowledgement or meeting-end cleanup. A lookup
      // awaits this same promise so the first event can supply its own evidence.
      const deliveryObserved = autoJoinReadiness.observe(body, secret).catch(() => {
        req.log.warn({ event: 'zoom.delivery_evidence_unavailable' }, 'zoom delivery evidence unavailable');
      });
      later(() => deliveryObserved);
      const { outcome, claimId } = await handleZoomEvent(body, { pool, zoom, autoJoinSwitch, autoJoinReadiness, deliveryObserved, busy, log: req.log, deliveryKey, zoomApi, lookups, later, allowedDomains });
      req.log.info({ event: 'zoom.handled', kind: kindOf(body.event), outcome, claim_id: claimId }, 'zoom event handled');
      return { status: outcome };
    });
  });
}

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
