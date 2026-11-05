import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { isObject } from '../http.ts';
import { requirePerson, signedInPerson, type AuthenticatePerson } from '../people-auth.ts';
import type { GetSecret } from '../config.ts';
import { SECRET } from '../secret-names.ts';
import { zoomAppContext } from '../zoom-app-context.ts';
import { boardSignIn, pair, startPairing } from '../zoom-board-signin.ts';


/**
 * Sign-in for the board inside Zoom (QOR-4708).
 *
 * POST /zoom/board-session {context}: the web server passes on Zoom's x-zoom-app-context
 * from the board's home request. A member linked to that Zoom user gets {token}, a board
 * bearer; anyone else gets {link_code}, to open in a browser. Either way `occurrence_id`
 * is the meeting the board was opened from (Zoom's meeting UUID), or null. 400 when the context cannot
 * be opened (no secret set, another app's, tampered or expired). Needs no sign-in: the
 * sealed context is itself the proof, and only Zoom can seal one.
 *
 * POST /zoom/pair {for?}: the signed-in person (Google, in a browser) gets {pair_code}, to
 * type into the board inside Zoom, or into the product `for` names (a switched-on plugin,
 * QOR-4806; default 'zoom'): the code is redeemable only there. Only a sign-in proves who
 * asks, never a board or plugin bearer, so no bearer can mint itself a successor. 400 for
 * a `for` this install doesn't run.
 *
 * POST /zoom/link {link_code, pair_code}: the board's link code and the typed pairing
 * code; together they save that Zoom user on the pairing code's member and answer
 * {token}. Neither alone links anything, so a link someone else sends cannot attach their
 * Zoom user to you. 400 without both, 404 when either is unknown, used or expired. A link
 * code takes five tries, then it is retired.
 */
export function zoomBoardRoutes(
  app: FastifyInstance,
  {
    pool,
    signIn,
    getSecret,
    audiences,
  }: {
    pool: pg.Pool;
    /** The sign-in alone (Google, or a local stack's dev and test people): no board or plugin bearer. */
    signIn: AuthenticatePerson;
    getSecret: GetSecret;
    /** What a pairing code may be minted for now: 'zoom' and every switched-on plugin's name. */
    audiences: () => Promise<readonly string[]>;
  },
): void {
  app.post('/zoom/board-session', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const raw = isObject(req.body) && typeof req.body.context === 'string' ? req.body.context : '';
    const secret = (await getSecret(SECRET.zoomBoardClientSecret)) ?? '';
    const ctx = zoomAppContext(raw, secret, Date.now());
    if (!ctx) return reply.code(400).send({ error: 'invalid_context' });
    const result = await boardSignIn(pool, ctx.uid);
    req.log.info({ event: 'token' in result ? 'zoom_board.signed_in' : 'zoom_board.link_offered' }, 'zoom board sign-in');
    // The meeting the board was opened from (Zoom's meeting UUID, null outside a meeting), so the board opens on it.
    const occurrence_id = ctx.mid;
    return 'token' in result ? { token: result.token, occurrence_id } : { link_code: result.linkCode, occurrence_id };
  });

  app.post('/zoom/link', { bodyLimit: 1024 }, async (req, reply) => {
    const body = isObject(req.body) ? req.body : {};
    const { link_code: linkCode, pair_code: pairCode } = body;
    if (typeof linkCode !== 'string' || !linkCode || typeof pairCode !== 'string' || !pairCode) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const token = await pair(pool, linkCode, pairCode);
    if (!token) return reply.code(404).send({ error: 'unknown_code' });
    req.log.info({ event: 'zoom_board.linked' }, 'zoom user linked');
    return { token };
  });

  app.register(async (people) => {
    people.addHook('preHandler', requirePerson(signIn));
    people.post('/zoom/pair', { bodyLimit: 1024 }, async (req, reply) => {
      const audience = isObject(req.body) && req.body.for !== undefined ? req.body.for : 'zoom';
      if (typeof audience !== 'string' || !(await audiences()).includes(audience)) return reply.code(400).send({ error: 'bad_request' });
      return { pair_code: await startPairing(pool, signedInPerson(req).id, audience) };
    });
  });
}
