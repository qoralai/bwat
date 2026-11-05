import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { cardServiceOrPerson, isCardService } from '../card-service.ts';
import { listFleet } from '../claims.ts';
import type { AuthenticatePerson } from '../people-auth.ts';

/**
 * GET /fleet: the live bots, one row each. A person's route (Console Status reads it), on
 * an onboarded install (D149); and the card service's (QOR-4662), whose rows add each
 * bot's feed fields.
 */
export function fleetRoutes(
  app: FastifyInstance,
  { pool, authenticatePerson, feedKey }: { pool: pg.Pool; authenticatePerson: AuthenticatePerson; feedKey: Buffer | undefined },
): void {
  app.get('/fleet', { preHandler: cardServiceOrPerson(pool, authenticatePerson) }, async (req) => ({
    fleet: await listFleet(pool, isCardService(req) ? { key: feedKey } : undefined),
  }));
}
