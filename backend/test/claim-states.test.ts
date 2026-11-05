import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LIVE_STATES, OPEN_STATES } from '../src/claims.ts';

/** The states in a partial index's `WHERE state IN (...)`, as `migration` writes them. */
function indexStates(index: string, migration = '0002_bots_and_claims.sql'): string[] {
  const sql = readFileSync(join(import.meta.dirname, '..', 'migrations', migration), 'utf8');
  const list = new RegExp(`CREATE (?:UNIQUE )?INDEX ${index} [^;]*WHERE state IN \(([^)]*)\)`).exec(sql)?.[1];
  return list ? [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]!) : [];
}

it('OPEN_STATES and LIVE_STATES are the predicates of migration 0002 partial indexes (QOR-4571 review)', () => {
  expect([...OPEN_STATES]).toEqual(indexStates('claims_one_open_per_meeting'));
  expect([...LIVE_STATES]).toEqual(indexStates('claims_one_live_per_bot'));
});

it('LIVE_STATES is the predicate of migration 0003 lease index, so the retire step can use it (QOR-4571 simplify)', () => {
  expect([...LIVE_STATES]).toEqual(indexStates('claims_live_lease', '0003_claim_lifecycle.sql'));
});
