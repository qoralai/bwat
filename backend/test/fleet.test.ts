import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FleetConfig } from '../src/config.ts';
import { createPool } from '../src/db/pool.ts';
import {
  BUSY_PROTECTION_MINUTES,
  countDemand,
  desiredCount,
  ecsBusyProtection,
  FLEET_LOCK,
  planProtection,
  reconcileFleet,
  SCALE_IN_GRACE_SECONDS,
  SPARE_PROTECTION_MINUTES,
  type FleetBot,
  type FleetEcs,
} from '../src/fleet.ts';
import { describeDb, useTestDb } from './db/harness.ts';

const ON: FleetConfig = { mode: 'on', min: 1, max: 4, headroom: 1, cluster: 'bwat', service: 'bwat-bot' };
const NOW = new Date('2026-10-19T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('countDemand (QOR-4888)', () => {
  const claim = (row: { state: string; lease_until?: Date; pending_until?: Date; allocation_count?: number }) => ({
    lease_until: null,
    pending_until: later(60),
    allocation_count: 0,
    ...row,
  });

  it('counts held claims under a running lease, and pending claims still placeable', () => {
    expect(
      countDemand(
        [
          claim({ state: 'attending', lease_until: later(30) }),
          claim({ state: 'claimed', lease_until: later(30) }),
          claim({ state: 'attending', lease_until: ago(1) }), // lapsed: its bot is gone
          claim({ state: 'pending' }),
          claim({ state: 'pending', pending_until: ago(1) }), // past its bound
          claim({ state: 'pending', allocation_count: 3 }), // out of attempts
        ],
        NOW,
      ),
    ).toEqual({ live: 2, waiting: 1 });
  });
});

describe('desiredCount (QOR-4888)', () => {
  it('is live + waiting + headroom, within min and max', () => {
    expect(desiredCount({ live: 1, waiting: 1 }, ON)).toBe(3);
    expect(desiredCount({ live: 0, waiting: 0 }, { ...ON, headroom: 0 })).toBe(1);
    expect(desiredCount({ live: 5, waiting: 0 }, ON)).toBe(4);
  });

  it('a min above max resolves to max, the bound that costs money', () => {
    expect(desiredCount({ live: 0, waiting: 0 }, { ...ON, min: 5, max: 2 })).toBe(2);
  });
});

describe('planProtection (QOR-4888)', () => {
  const bot = (id: string, over: Partial<FleetBot> = {}): FleetBot => ({
    botId: id,
    taskArn: `arn:${id}`,
    busy: false,
    drainingAt: null,
    state: 'idle',
    ...over,
  });

  it('protects every busy bot for BUSY_PROTECTION_MINUTES and, with no decrease, clears every idle one', () => {
    const plan = planProtection({ bots: [bot('a', { busy: true }), bot('b'), bot('c')], decrease: false });
    expect(plan).toMatchObject({ busy: ['arn:a'], spared: [], clear: ['arn:b', 'arn:c'] });
    expect(plan.victim).toBeNull();
  });

  it('on a decrease the oldest idle bot is the victim and the other idle bots are spared for a few minutes', () => {
    const plan = planProtection({ bots: [bot('a', { busy: true }), bot('b'), bot('c')], decrease: true });
    expect(plan.victim).toEqual({ botId: 'b', taskArn: 'arn:b' });
    // The victim's clear is not in the plan's: a pass sends it last.
    expect(plan).toMatchObject({ busy: ['arn:a'], spared: ['arn:c'], clear: [] });
  });

  // The claim leaves before the bot does: a recalled bot, or one past its meeting's end, is
  // still in the room until it reports idle.
  for (const state of ['joining', 'in_meeting', 'waiting_room', 'waiting_for_host']) {
    it(`a ${state} bot with no live claim is held like a busy one, never the victim`, () => {
      const plan = planProtection({ bots: [bot('a', { state }), bot('b')], decrease: true });
      expect(plan.busy).toEqual(['arn:a']);
      expect(plan.victim?.botId).toBe('b');
    });
  }

  it('a live bot with no task ARN blocks every decrease: ECS may stop it and nothing can protect it', () => {
    const plan = planProtection({ bots: [bot('a', { taskArn: null }), bot('b')], decrease: true });
    expect(plan.victim).toBeNull();
    expect(plan.unprotectable).toEqual(['a']);
  });

  it('while a stop is in flight it names no new victim and clears nothing, decreasing or not', () => {
    for (const decrease of [true, false]) {
      const plan = planProtection({ bots: [bot('a', { drainingAt: NOW }), bot('b'), bot('c')], decrease });
      expect(plan).toMatchObject({ victim: null, clear: [], stopInFlight: true });
    }
  });
});

/** A stand-in for the service and its tasks' protection, as ECS keeps them. */
function fakeEcs(desired: number) {
  const fake = {
    desired,
    protection: new Map<string, number>(),
    calls: [] as string[],
    refuse: new Set<string>(),
    readsBackOff: new Set<string>(),
    onSet: async (): Promise<void> => {},
    ecs: undefined as unknown as FleetEcs,
  };
  fake.ecs = {
    getDesiredCount: async () => fake.desired,
    setProtection: async (tasks, enabled, minutes) => {
      fake.calls.push(`${enabled ? `protect ${minutes}` : 'clear'} ${tasks.join(',')}`);
      await fake.onSet();
      const failures = tasks.filter((arn) => fake.refuse.has(arn)).map((arn) => ({ arn, reason: 'DEPLOYMENT_BLOCKED' }));
      for (const arn of tasks) {
        if (fake.refuse.has(arn)) continue;
        if (enabled) fake.protection.set(arn, minutes!);
        else fake.protection.delete(arn);
      }
      return failures;
    },
    getProtection: async (tasks) => ({
      protectedTasks: tasks.map((taskArn) => ({ taskArn, protectionEnabled: fake.protection.has(taskArn) && !fake.readsBackOff.has(taskArn) })),
      failures: [],
    }),
    setDesiredCount: async (n) => {
      fake.calls.push(`desired ${n}`);
      fake.desired = n;
    },
  };
  return fake;
}

describeDb('reconcileFleet (QOR-4888)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  let credential: string;
  let meeting = 500000000;
  beforeAll(async () => {
    pool = createPool(db.url('runtime'));
    credential = (
      await pool.query<{ id: string }>(`INSERT INTO fleet_credentials (token_sha256) VALUES ($1) RETURNING id`, [randomBytes(32)])
    ).rows[0]!.id;
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query(`UPDATE claims SET state = 'done', ended_at = now(), lease_until = NULL WHERE state <> 'done'`);
    await pool.query(`UPDATE bots SET last_heartbeat = now() - interval '1 hour'`);
  });

  /** A bot heard from just now, registered `age` seconds ago (older first is the victim). */
  async function bot({ age = 60, arn = true, state = 'idle' } = {}): Promise<{ id: string; arn: string | null }> {
    const taskArn = arn ? `arn:aws:ecs:us-west-2:123456789012:task/bwat/${randomBytes(16).toString('hex')}` : null;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bots (fleet_credential_id, token_sha256, task_arn, ready_at, status, registered_at)
       VALUES ($1, $2, $3, now(), $4, now() - make_interval(secs => $5)) RETURNING id`,
      [credential, randomBytes(32), taskArn, { state }, age],
    );
    return { id: rows[0]!.id, arn: taskArn };
  }

  /** A meeting held by `botId`, or waiting for a bot. */
  async function claim(botId: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO claims (meeting_number, state, bot_id, lease_until) VALUES ($1, $2, $3, $4) RETURNING id`,
      [String(meeting++), botId ? 'attending' : 'pending', botId, botId ? new Date(Date.now() + 60_000) : null],
    );
    return rows[0]!.id;
  }

  const drainingOf = async (id: string) => (await pool.query(`SELECT draining_at FROM bots WHERE id = $1`, [id])).rows[0].draining_at;

  /** One pass at `now`, with the grace clock in `state`; the result and the log line. */
  async function pass(fake: ReturnType<typeof fakeEcs>, { config = ON, now = NOW, state = { lowerSince: null as Date | null } } = {}) {
    const lines: Array<{ level: string; line: Record<string, unknown> }> = [];
    const result = await reconcileFleet({
      pool,
      ecs: fake.ecs,
      config,
      state,
      now: () => now,
      log: (level, line) => void lines.push({ level, line }),
    });
    return { result, lines, state };
  }
  /** A pass whose demand has been below the running count for longer than the grace. */
  const decreasing = (fake: ReturnType<typeof fakeEcs>, config = ON) =>
    pass(fake, { config, state: { lowerSince: ago(SCALE_IN_GRACE_SECONDS) } });

  it('scales out at once: a meeting held and one waiting, with headroom, wants three', async () => {
    const busy = await bot();
    await claim(busy.id);
    await claim(null);
    const fake = fakeEcs(1);
    const { result, lines } = await pass(fake);
    expect(result).toMatchObject({ live: 1, waiting: 1, desired: 3, current: 1, target: 3 });
    expect(fake.calls).toEqual([`protect ${BUSY_PROTECTION_MINUTES} ${busy.arn}`, 'desired 3']);
    expect(lines).toEqual([{ level: 'info', line: expect.objectContaining({ event: 'fleet.reconcile', desired: 3, target: 3 }) }]);
  });

  it('dryrun reads the count and logs what it would do, and writes nothing: no protection, no count, no drain', async () => {
    const busy = await bot({ age: 90 });
    const idle = await bot({ age: 60 });
    await claim(busy.id);
    const fake = fakeEcs(3);
    const { result } = await decreasing(fake, { ...ON, mode: 'dryrun' });
    expect(result).toMatchObject({ mode: 'dryrun', desired: 2, current: 3, target: 2, victim: { botId: idle.id } });
    expect(fake.calls).toEqual([]);
    expect(await drainingOf(idle.id)).toBeNull();
  });

  it('waits out the grace before a decrease, starting the clock the first time demand is lower', async () => {
    await bot();
    const fake = fakeEcs(3);
    const first = await pass(fake);
    expect(first.result).toMatchObject({ desired: 1, current: 3, target: 3, victim: null });
    expect(first.state.lowerSince).toEqual(NOW);
    const second = await pass(fake, { now: later(SCALE_IN_GRACE_SECONDS - 1), state: first.state });
    expect(second.result.target).toBe(3);
    expect(second.state.lowerSince).toEqual(NOW);
    expect(fake.calls.filter((c) => c.startsWith('desired'))).toEqual([]);
  });

  it('demand back at the running count resets the grace clock', async () => {
    const busy = await bot();
    await claim(busy.id);
    const { state } = await pass(fakeEcs(2), { state: { lowerSince: ago(30) } });
    expect(state.lowerSince).toBeNull();
  });

  it('after the grace, steps down ONE task: the oldest idle bot is drained and is the only task left unprotected', async () => {
    const busy = await bot({ age: 300 });
    const victim = await bot({ age: 200 });
    const spare = await bot({ age: 100 });
    await claim(busy.id);
    const fake = fakeEcs(4);
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ desired: 2, current: 4, target: 3, victim: { botId: victim.id }, decreaseCancelled: null });
    expect(await drainingOf(victim.id)).not.toBeNull();
    expect(fake.calls).toEqual([
      `protect ${BUSY_PROTECTION_MINUTES} ${busy.arn}`,
      `protect ${SPARE_PROTECTION_MINUTES} ${spare.arn}`,
      `clear ${victim.arn}`, // last, once nothing can cancel the decrease
      'desired 3',
    ]);
  });

  it('a refused protection cancels the decrease and returns the victim to the pool', async () => {
    const victim = await bot({ age: 200 });
    const spare = await bot({ age: 100 });
    const fake = fakeEcs(3);
    fake.refuse.add(spare.arn!);
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, decreaseCancelled: 'protection_set_failed' });
    expect(fake.calls).not.toContain('desired 2');
    expect(await drainingOf(victim.id)).toBeNull();
  });

  it('a victim whose clear is refused cancels the decrease: ECS could not stop it, so it could stop another', async () => {
    const victim = await bot({ age: 200 });
    await bot({ age: 100 });
    const fake = fakeEcs(3);
    fake.refuse.add(victim.arn!);
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, decreaseCancelled: 'protection_set_failed' });
    expect(fake.calls).not.toContain('desired 2');
    expect(await drainingOf(victim.id)).toBeNull();
  });

  it('a spare that does not read back protected cancels the decrease: ECS could stop it instead', async () => {
    await bot({ age: 200 });
    const spare = await bot({ age: 100 });
    const fake = fakeEcs(3);
    fake.readsBackOff.add(spare.arn!);
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, decreaseCancelled: 'spare_task_unprotected', spareUnprotected: [spare.arn] });
  });

  it('a busy task that does not read back protected cancels the decrease, and is an error', async () => {
    const busy = await bot({ age: 300 });
    await bot({ age: 200 });
    await claim(busy.id);
    const fake = fakeEcs(3);
    fake.readsBackOff.add(busy.arn!);
    const { result, lines } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, decreaseCancelled: 'busy_task_unprotected' });
    expect(lines[0]!.level).toBe('error');
  });

  it('a busy renewal ECS refuses while a deploy rolls out is an error: that meeting is running out of protection', async () => {
    const busy = await bot();
    await claim(busy.id);
    const fake = fakeEcs(2);
    fake.protection.set(busy.arn!, BUSY_PROTECTION_MINUTES); // the grant from before the deploy
    fake.refuse.add(busy.arn!);
    const { result, lines } = await pass(fake);
    expect(result).toMatchObject({ busyRenewalRefused: [busy.arn] });
    expect(lines[0]!.level).toBe('error');
  });

  it('a refused clear of an idle task is a warning, not an error', async () => {
    const idle = await bot();
    const fake = fakeEcs(2);
    fake.refuse.add(idle.arn!);
    const { lines } = await pass(fake);
    expect(lines[0]!.level).toBe('warn');
  });

  it('a victim that takes a meeting mid-pass keeps its protection, and the decrease is cancelled', async () => {
    const victim = await bot({ age: 200 });
    await bot({ age: 100 });
    const fake = fakeEcs(3);
    fake.protection.set(victim.arn!, SPARE_PROTECTION_MINUTES);
    // An allocation that read the free bots before the drain was written.
    fake.onSet = async () => {
      fake.onSet = async () => {};
      await claim(victim.id);
    };
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, decreaseCancelled: 'victim_claimed' });
    expect(fake.calls).not.toContain(`clear ${victim.arn}`);
    expect(fake.protection.has(victim.arn!)).toBe(true);
    expect(await drainingOf(victim.id)).toBeNull();
  });

  it('a live bot with no task ARN cancels the decrease, and says why; it never stops a scale-out', async () => {
    await bot({ age: 200, arn: false });
    await bot({ age: 100 });
    const down = await decreasing(fakeEcs(3));
    expect(down.result).toMatchObject({ target: 3, victim: null, decreaseCancelled: 'fleet_bot_without_task_arn' });
    expect(down.lines[0]!.level).toBe('warn');

    await claim(null);
    await claim(null);
    const fake = fakeEcs(1);
    expect((await pass(fake)).result.target).toBe(3);
    expect(fake.calls).toContain('desired 3');
  });

  it('while a stop is in flight the decrease waits: no second victim, no clear, no UpdateService', async () => {
    const draining = await bot({ age: 300 });
    await pool.query(`UPDATE bots SET draining_at = now() WHERE id = $1`, [draining.id]);
    await bot({ age: 200 });
    await bot({ age: 100 });
    const fake = fakeEcs(3);
    const { result } = await decreasing(fake);
    expect(result).toMatchObject({ target: 3, victim: null, decreaseDeferred: 'stop_in_flight' });
    expect(fake.calls).toEqual([]);
  });

  it('a victim still heard from 10 minutes after its drain was not the task ECS stopped: it goes back to the pool', async () => {
    const survivor = await bot();
    await pool.query(`UPDATE bots SET draining_at = now() - interval '11 minutes' WHERE id = $1`, [survivor.id]);
    await pass(fakeEcs(2));
    expect(await drainingOf(survivor.id)).toBeNull();
  });

  it('skips a pass while another holds the fleet lock', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [FLEET_LOCK]);
      const fake = fakeEcs(1);
      const { result, state } = await pass(fake, { state: { lowerSince: ago(3600) } });
      expect(result).toEqual({ skipped: 'locked' });
      expect(fake.calls).toEqual([]);
      // A clock this backend stopped keeping must not skip the grace when it next runs a pass.
      expect(state.lowerSince).toBeNull();
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [FLEET_LOCK]);
      holder.release();
    }
  });

  it('leaves the fleet lock free after a pass, for a backend on another connection', async () => {
    await pass(fakeEcs(1));
    const other = createPool(db.url('runtime'), { max: 1 });
    try {
      expect((await other.query('SELECT pg_try_advisory_lock($1) AS got', [FLEET_LOCK])).rows[0].got).toBe(true);
    } finally {
      await other.end();
    }
  });

  it('frees the fleet lock before a pass returns, so the next pass is never skipped', async () => {
    const other = await pool.connect();
    try {
      for (let i = 0; i < 20; i++) {
        await pass(fakeEcs(1));
        const { rows } = await other.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [FLEET_LOCK]);
        expect(rows[0]!.got, `pass ${i}`).toBe(true);
        await other.query('SELECT pg_advisory_unlock($1)', [FLEET_LOCK]);
      }
    } finally {
      other.release();
    }
  });

  describe('the busy seam (ecsBusyProtection)', () => {
    it('protects a bot\'s task the moment it is given a meeting', async () => {
      const b = await bot();
      const fake = fakeEcs(1);
      await ecsBusyProtection(pool, fake.ecs).markBusy(b.id);
      expect(fake.calls).toEqual([`protect ${BUSY_PROTECTION_MINUTES} ${b.arn}`]);
    });

    it('writes nothing for a bot with no task', async () => {
      const fake = fakeEcs(1);
      await ecsBusyProtection(pool, fake.ecs).markBusy((await bot({ arn: false })).id);
      expect(fake.calls).toEqual([]);
    });

    it('fails with the refusal\'s code, for the seam to log', async () => {
      const b = await bot();
      const fake = fakeEcs(1);
      fake.refuse.add(b.arn!);
      await expect(ecsBusyProtection(pool, fake.ecs).markBusy(b.id)).rejects.toMatchObject({ code: 'DEPLOYMENT_BLOCKED' });
    });
  });
});
