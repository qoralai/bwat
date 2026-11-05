/** Shapes a route checks a JSON body or a query against before it reads it. */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UUID } from './members.ts';

/** A JSON object: not null, not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A revision is a Postgres integer: a larger number would be a cast error (a 500).
const REVISION_MAX = 2_147_483_647;

/** The revision a conditional save was read at: null (never saved) or a positive integer. */
export const isRevision = (v: unknown): v is number | null => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= REVISION_MAX);

/** An opaque paging cursor: base64url JSON of the last row's sort key. */
export const encodeCursor = (key: unknown[]): string => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** A `cursor` query parameter that must decode to `key`; anything else fails the query. */
export const Cursor = <K extends z.ZodTypeAny>(key: K) => z.string().max(200).transform(decodeCursor).pipe(key).optional();

/** At most `max` characters, counted as Postgres's char_length counts them (code points, not UTF-16 units). */
export const chars = (max: number) => z.string().refine((s) => [...s].length <= max, `at most ${max} characters`);

/** A route's uuid parameter `name`, or null for one that is not a uuid: answered as an id that does not exist. */
export const idParam = (req: FastifyRequest, name = 'id') => {
  const id = (req.params as Record<string, string>)[name];
  return id && UUID.test(id) ? id : null;
};

/** Cards a board read names at once: a board's page of cards. */
export const CARD_IDS_MAX = 200;
/** `?cards=<id>,<id>`: the card ids, repeats dropped, 1 to CARD_IDS_MAX of them. */
export const CardIdsQuery = z
  .object({ cards: z.string().max(CARD_IDS_MAX * 37) })
  .strict()
  .transform((q) => [...new Set(q.cards.split(',').filter(Boolean))])
  .pipe(z.array(z.string().regex(UUID)).min(1).max(CARD_IDS_MAX));
