import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { normalEmail } from '../members.ts';
import { codeMatches, codeSignIn, codeTag, endCodeSession, refreshCodeSession } from '../code-signin.ts';
import { isObject } from '../http.ts';

/** A local install's code sign-in (QOR-5007): the sha256 of its code, and who claims the owner role. */
export interface CodeSignInConfig {
  codeDigest: Buffer;
  firstOwnerEmail?: string | undefined;
}

const object = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

/**
 * POST /code-signin {code, email}: the board and the plugin sign in with the install's code on
 * a local install (D202). Answers a board token (bwz_) for 12 hours and a refresh token (bwr_)
 * that mints the next; the person is a member under the email they typed. A wrong code counts
 * against the sign-in bucket (QOR-4625), like a failed Google sign-in. POST /code-signin/refresh
 * {refresh_token} mints a new board token; POST /code-signin/sign-out {refresh_token} ends the
 * session. Not there (404) on an install with no code: every tier but local.
 */
export function codeSignInRoutes(app: FastifyInstance, { pool, codeSignIn: config }: { pool: pg.Pool; codeSignIn?: CodeSignInConfig | undefined }): void {
  if (!config) return;
  const tag = codeTag(config.codeDigest);

  app.post('/code-signin', { bodyLimit: 2048 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = object(req.body);
    const failures = req.server.signInFailures;
    failures.check(req);
    if (typeof body.code !== 'string' || !codeMatches(config.codeDigest, body.code)) {
      failures.count(req);
      req.log.info({ event: 'auth.code_refused' }, 'code sign-in with a wrong code');
      return reply.code(401).send({ error: 'wrong_code' });
    }
    const email = normalEmail(body.email);
    if (!email) return reply.code(400).send({ error: 'bad_email' });
    const signedIn = await codeSignIn(pool, email, { firstOwnerEmail: config.firstOwnerEmail, tag });
    if (signedIn === 'removed') {
      req.log.info({ event: 'auth.removed' }, 'code sign-in by a removed member');
      return reply.code(403).send({ error: 'removed' });
    }
    req.log.info({ event: 'auth.code_signed_in', member_id: signedIn.member.id }, 'signed in with the code');
    return {
      token: signedIn.token,
      expires_at: signedIn.expiresAt.toISOString(),
      refresh_token: signedIn.refreshToken,
      member: signedIn.member,
    };
  });

  app.post('/code-signin/refresh', { bodyLimit: 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { refresh_token: refresh } = object(req.body);
    const renewed = typeof refresh === 'string' && refresh ? await refreshCodeSession(pool, refresh, tag) : null;
    if (!renewed) return reply.code(401).send({ error: 'signed_out' });
    return { token: renewed.token, expires_at: renewed.expiresAt.toISOString() };
  });

  app.post('/code-signin/sign-out', { bodyLimit: 1024 }, async (req, reply) => {
    const { refresh_token: refresh } = object(req.body);
    if (typeof refresh === 'string' && refresh) await endCodeSession(pool, refresh);
    return reply.code(204).send();
  });
}
