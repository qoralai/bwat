import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { presentedToken } from './credentials.ts';
import { requireOnboardedPerson, type AuthenticatePerson } from './people-auth.ts';
import { requireCaller } from './routes/bots.ts';

/** The requests the card service's credential let through. */
const admitted = new WeakSet<FastifyRequest>();

/** Whether the card service (its bwc_ credential), not a person, is calling. */
export const isCardService = (req: FastifyRequest): boolean => admitted.has(req);

/**
 * A preHandler for the routes the card service shares with people (GET /fleet and a
 * meeting's transcript, QOR-4662): its credential, on any install, onboarded or not; or a
 * signed-in person on an onboarded install (D149), as on every other people's route.
 */
export function cardServiceOrPerson(pool: pg.Pool, authenticatePerson: AuthenticatePerson) {
  const person = requireOnboardedPerson(pool, authenticatePerson);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (presentedToken(req.headers.authorization)?.kind === 'cards') {
      if (!(await requireCaller(pool, 'cards', req, reply))) return reply;
      admitted.add(req);
      return;
    }
    return person(req, reply);
  };
}
