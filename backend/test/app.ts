import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { issueFleetCredential } from '../src/credentials.ts';
import { createPool } from '../src/db/pool.ts';
import type { AuthenticatePerson } from '../src/people-auth.ts';
import type { SecretStore } from '../src/secrets/store.ts';
import { API_PREFIX, buildServer, type ServerOptions } from '../src/server.ts';
import { useTestDb, type TestDb } from './db/harness.ts';

/** Signs in anyone presenting this header; what the panel's real sign-in will replace. */
export const PERSON = { authorization: 'Bearer test-person' };
export const signedIn: AuthenticatePerson = async (req) =>
  req.headers.authorization === PERSON.authorization ? { id: 'test-person' } : null;

/**
 * Every API route is under /v1 (QOR-4588), /health at the root. Makes `app.inject` add the
 * prefix, so tests name routes as the README's tables do. test/server-edge.test.ts uses
 * the real paths.
 */
export function apiBase<T extends FastifyInstance>(app: T): T {
  const inject = app.inject.bind(app) as (options: InjectOptions) => ReturnType<FastifyInstance['inject']>;
  const prefixed = (url: string) => (url.startsWith('/health') ? url : `${API_PREFIX}${url}`);
  app.inject = ((options: InjectOptions) => inject({ ...options, url: prefixed(options.url as string) })) as T['inject'];
  return app;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly db: TestDb;
}

/** A fresh migrated database and the app on it, logged in as the runtime role, for the enclosing suite. */
export function useApp(
  options: Omit<ServerOptions, 'pool' | 'secrets'> & {
    /** The secret store, built on the suite's pool. */
    secrets?: (pool: pg.Pool) => SecretStore;
  } = {
    authenticatePerson: signedIn,
  },
): TestApp {
  const db = useTestDb();
  let app: FastifyInstance | undefined;
  let pool: pg.Pool | undefined;
  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    const { secrets, ...rest } = options;
    app = apiBase(buildServer({ pool, ...rest, ...(secrets && { secrets: secrets(pool) }) }));
    // An onboarded install (D149): people's routes answer 403 not_onboarded until an activated owner exists.
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ('owner@test.invalid', 'owner', now())`);
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });
  return {
    get app() {
      return app!;
    },
    get pool() {
      return pool!;
    },
    db,
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A new fleet credential, then a bot registered with it: ready unless told otherwise. */
export async function registerBot(t: TestApp, { ready = true } = {}): Promise<{ bot_id: string; bot_token: string }> {
  const fleet = await issueFleetCredential(t.pool);
  const bot = (await t.app.inject({ method: 'POST', url: '/bots/register', headers: bearer(fleet) })).json();
  if (ready) await t.app.inject({ method: 'POST', url: '/bots/ready', headers: bearer(bot.bot_token) });
  return bot;
}

/** POST /allocations, signed in as PERSON unless other headers are given. */
export const postAllocation = (t: TestApp, payload: object, headers: Record<string, string> = PERSON) =>
  t.app.inject({ method: 'POST', url: '/allocations', headers, payload });

/** No open claim and no ready bot. */
export async function resetAllocations(t: TestApp): Promise<void> {
  await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE state <> 'done'`);
  await t.pool.query(`UPDATE bots SET ready_at = NULL`);
}

/** Before each test of the enclosing suite: resetAllocations. */
export function resetAllocationsBeforeEach(t: TestApp): void {
  beforeEach(() => resetAllocations(t));
}

/** A claim's row as stored. */
export const claimRow = async (t: TestApp, id: string) => (await t.pool.query(`SELECT * FROM claims WHERE id = $1`, [id])).rows[0];

/** A ready bot holding a fresh claim for `meeting`, generation 1 (with no other ready bot about). */
export async function heldClaim(t: TestApp, meeting: string) {
  const bot = await registerBot(t);
  const sent = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${meeting}` })).json();
  return { bot, claimId: sent.id as string };
}

/** A bot's POST to one of its routes, with its token. */
export const botPost = (t: TestApp, url: string, token: string, payload: object) =>
  t.app.inject({ method: 'POST', url, headers: bearer(token), payload });

/** A Zoom occurrence UUID: base64, so it carries '/', '+' and '='. Unique per call. */
export const occurrenceUuid = () => `${randomBytes(15).toString('base64').slice(0, 18)}/+A==`;

/** Polls `done` up to `tries` times, `ms` apart; its last answer. */
export async function until(done: () => Promise<boolean>, { tries = 60, ms = 50 } = {}): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return done();
}

/** Shortens the claim's lease, so a heartbeat that renews it shows. */
export const shortLease = (t: TestApp, id: string) =>
  t.pool.query(`UPDATE claims SET lease_until = now() + interval '5 seconds' WHERE id = $1`, [id]);

/** The claim's lease is still the short one shortLease set. */
export const expectNotRenewed = async (t: TestApp, id: string) =>
  expect((await claimRow(t, id)).lease_until.getTime()).toBeLessThan(Date.now() + 10_000);

/**
 * Holds `lock` (a statement taking row locks) in its own transaction while `race` runs,
 * until `race` waits on it; then runs `meanwhile` and commits. `race`'s answer.
 */
export async function raceBehindLock<T>(
  t: TestApp,
  lock: { sql: string; params: unknown[] },
  race: () => Promise<T>,
  meanwhile: (holder: pg.PoolClient) => Promise<unknown> = async () => {},
): Promise<T> {
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await holder.query(lock.sql, lock.params);
    const racing = race();
    const waiting = await until(
      async () =>
        (
          await t.pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE pid <> $1 AND wait_event_type = 'Lock' AND datname = current_database()`,
            [pid],
          )
        ).rows.length > 0,
      { tries: 200, ms: 10 },
    );
    if (!waiting) throw new Error('the race never waited on the lock');
    await meanwhile(holder);
    await holder.query('COMMIT');
    return await racing;
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}

/** Waits until `n` connections to this database wait on a lock (a row's or an advisory one); throws if they never do. */
export async function untilWaiting(t: TestApp, n: number): Promise<void> {
  const waiting = async () =>
    (
      await t.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      )
    ).rows[0]!.n >= n;
  if (!(await until(waiting, { tries: 200, ms: 10 }))) throw new Error(`never ${n} waiting on a lock`);
}

/** Gives the claim a lease of `ms` from now: the clock, not the transaction. */
export const lapsingLease = (t: TestApp, id: string, ms: number) =>
  t.pool.query(`UPDATE claims SET lease_until = clock_timestamp() + make_interval(secs => $2) WHERE id = $1`, [id, ms / 1000]);

/** Waits until the claim's lease has lapsed. */
export const untilLapsed = (t: TestApp, id: string) =>
  until(
    async () => (await t.pool.query(`SELECT lease_until <= clock_timestamp() AS lapsed FROM claims WHERE id = $1`, [id])).rows[0].lapsed,
    { tries: 200, ms: 25 },
  );

/**
 * Starts `requests` together: each is held at its first read of members until all are
 * waiting there, then all go at once. Without the members lock they would each see the
 * membership as it was before any of them changed it.
 */
export async function race<T>(db: TestDb, requests: (() => Promise<T>)[]): Promise<T[]> {
  const gate = await db.connect('runtime');
  try {
    await gate.query('BEGIN');
    await gate.query('LOCK TABLE bwat.members IN ACCESS EXCLUSIVE MODE');
    const racing = Promise.all(requests.map((r) => r()));
    const waiting = () =>
      gate.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = 'bwat.members'::regclass`);
    const deadline = Date.now() + 3_000;
    while ((await waiting()).rows[0].n < requests.length) {
      if (Date.now() > deadline) throw new Error('race: the requests never reached members');
      await new Promise((r) => setTimeout(r, 10));
    }
    await gate.query('COMMIT');
    return await racing;
  } finally {
    await gate.end();
  }
}

/** Turns a registered plugin on, as an admin's switch would; call before the suite's first request. */
export async function switchOn(pool: pg.Pool, name: string): Promise<void> {
  await pool.query(`INSERT INTO settings (key, value, revision) VALUES ($1, 'true', 1) ON CONFLICT (key) DO UPDATE SET value = 'true'`, [`plugin_${name}`]);
}
