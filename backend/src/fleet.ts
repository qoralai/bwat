import type pg from 'pg';
import type { BusyProtection } from './busy.ts';
import { LIVE_STATES, MAX_ALLOCATIONS, OPEN_STATES, STALE_SECONDS } from './claims.ts';
import type { FleetConfig } from './config.ts';

/**
 * The fleet (QOR-4888): sizes the hosted bot service (ECS) from meeting demand, and makes
 * scale-in safe with ECS task scale-in protection. Reduced from an earlier fleet autoscaler
 * (docs/provenance.md), keeping the failures it learnt from.
 *
 *   desired = clamp(live + waiting + headroom, BWAT_FLEET_MIN, BWAT_FLEET_MAX)
 *
 * Lowering the service's desired count lets ECS stop ANY task. Protection is how a pass
 * chooses which: every busy task is protected, every idle task but one gets a short
 * protection, and that one, the victim, is the only task ECS can stop. A decrease is only
 * as safe as the protection actually in force, so it is read back before UpdateService and
 * any doubt cancels it. Scale-out stops nothing and is applied at once.
 *
 * Protection is desired state, recomputed from the database every pass (fleetLoop in
 * server.ts, every minute), never adjusted event by event: a missed change is corrected by
 * the next pass, a long meeting's protection is renewed, and a finished one's is cleared.
 */

/** Demand must sit below the running count this long before a scale-in. */
export const SCALE_IN_GRACE_SECONDS = 600;

/**
 * Protection for a task holding a meeting. While a deployment rolls out ECS refuses every
 * renewal (DEPLOYMENT_BLOCKED), so the grant in force when the deploy starts is all a live
 * meeting gets: it must outlast a long meeting. Hours, not the 48 h ECS maximum, which would
 * hold a deploy's old task for days after its meeting; every pass clears a task once its
 * meeting is over, and a clear is not blocked by a deploy.
 */
export const BUSY_PROTECTION_MINUTES = 240;

/** Protection for the idle tasks spared during a scale-in: outlives the decrease, then lapses. */
export const SPARE_PROTECTION_MINUTES = 5;

/** A victim still heard from this long after its drain was not the task ECS stopped. */
const VICTIM_DRAIN_SECONDS = 600;

/** Advisory lock key ('bflt' in ASCII) held across a pass, ECS calls included. */
export const FLEET_LOCK = 0x62666c74;

/**
 * What a bot reports (heartbeat `state`) while it is in a room or on its way into one. The
 * claim leaves before the bot does: a recall ends the claim and the bot learns on its next
 * heartbeat, and a bot leaving at a meeting's end is still in the room until it reports
 * idle. Such a bot is held like a busy one, never the victim. Held rather than skipped: a
 * decrease is only safe while the victim is the ONLY unprotected task.
 */
const OCCUPIED_STATES: readonly string[] = ['joining', 'in_meeting', 'waiting_room', 'waiting_for_host'];

interface Demand {
  live: number;
  waiting: number;
}

export interface FleetBot {
  botId: string;
  taskArn: string | null;
  busy: boolean;
  drainingAt: Date | null;
  state: string | null;
}

interface ProtectionPlan {
  /** Tasks to protect for BUSY_PROTECTION_MINUTES, and for SPARE_PROTECTION_MINUTES. */
  busy: string[];
  spared: string[];
  clear: string[];
  victim: { botId: string; taskArn: string } | null;
  unprotectable: string[];
  stopInFlight: boolean;
}

/** A failure ECS reports for one task in an otherwise answered call. */
type EcsFailure = { arn?: string | undefined; reason?: string | undefined };

/** The four ECS calls a pass makes (fleet-ecs.ts). */
export interface FleetEcs {
  getDesiredCount(): Promise<number>;
  setProtection(tasks: string[], enabled: boolean, expiresInMinutes?: number): Promise<EcsFailure[]>;
  getProtection(tasks: string[]): Promise<{ protectedTasks: Array<{ taskArn?: string | undefined; protectionEnabled?: boolean | undefined }>; failures: EcsFailure[] }>;
  setDesiredCount(desiredCount: number): Promise<void>;
}

/**
 * Meetings held under a running lease, and pending ones allocation would still place. A
 * lapsed lease is a gone bot, and a pending claim past its bound or its attempts is about to
 * be refused, so neither keeps the fleet large.
 */
export function countDemand(
  claims: Array<{ state: string; lease_until: Date | null; pending_until: Date; allocation_count: number }>,
  now: Date,
): Demand {
  const t = now.getTime();
  let live = 0;
  let waiting = 0;
  for (const c of claims) {
    if (c.state === 'pending') {
      if (c.pending_until.getTime() > t && c.allocation_count < MAX_ALLOCATIONS) waiting += 1;
    } else if (c.lease_until && c.lease_until.getTime() > t) {
      live += 1;
    }
  }
  return { live, waiting };
}

/** How many bots the fleet should run. max wins a min above it: it is the bound that costs money. */
export function desiredCount(demand: Demand, config: Pick<FleetConfig, 'min' | 'max' | 'headroom'>): number {
  return Math.min(config.max, Math.max(config.min, demand.live + demand.waiting + config.headroom));
}

/**
 * The protection the fleet should be in. Only bots with a task ARN take part; a bot already
 * draining is a stop in flight and is neither protected nor chosen again.
 *
 * A LIVE BOT WITH NO ARN BLOCKS EVERY DECREASE: it is a task ECS may stop and nothing here
 * can protect it (it registered before its image sent one, or its metadata read failed).
 *
 * WHILE A STOP IS IN FLIGHT no pass names a victim or clears anything. The spares' short
 * protection is what makes the victim the only task ECS can stop; a second victim would be
 * a second unprotected idle task, and ECS could stop either.
 */
export function planProtection({ bots, decrease }: { bots: FleetBot[]; decrease: boolean }): ProtectionPlan {
  const fleet = bots.filter((b): b is FleetBot & { taskArn: string } => b.taskArn !== null);
  const unprotectable = bots.filter((b) => b.taskArn === null).map((b) => b.botId);
  const eligible = fleet.filter((b) => !b.drainingAt);
  const stopInFlight = fleet.length !== eligible.length;
  const held = eligible.filter((b) => b.busy || OCCUPIED_STATES.includes(b.state ?? ''));
  const idle = eligible.filter((b) => !held.includes(b));

  const busy = held.map((b) => b.taskArn);
  if (!decrease || !idle.length || unprotectable.length || stopInFlight) {
    return { busy, spared: [], clear: stopInFlight ? [] : idle.map((b) => b.taskArn), victim: null, unprotectable, stopInFlight };
  }
  // The victim's own clear is not in `clear`: a pass sends it last, once nothing can cancel the decrease.
  const [victim, ...spared] = idle;
  return {
    busy,
    spared: spared.map((b) => b.taskArn),
    clear: [],
    victim: { botId: victim!.botId, taskArn: victim!.taskArn },
    unprotectable,
    stopInFlight,
  };
}

/**
 * Runs `fn` under the fleet lock, or not at all when another pass holds it. The lock is the
 * session's, so its connection is closed afterwards rather than pooled: closing releases the
 * lock whatever happened, and a connection still holding it never goes back to the pool.
 * It is unlocked first all the same: closing frees the lock only once Postgres has noticed
 * the connection is gone, and the next pass can get there before it does.
 */
async function withFleetLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await pool.connect();
  let held = false;
  try {
    const { rows } = await client.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [FLEET_LOCK]);
    held = rows[0]!.got;
    if (!held) return { acquired: false };
    return { acquired: true, value: await fn() };
  } finally {
    // If the unlock fails, closing the connection below still frees the lock.
    if (held) await client.query('SELECT pg_advisory_unlock($1)', [FLEET_LOCK]).catch(() => undefined);
    client.release(true);
  }
}

/** Every bot heard from within STALE_SECONDS, oldest registration first (the first idle one is the victim). */
async function readBots(pool: pg.Pool): Promise<FleetBot[]> {
  const { rows } = await pool.query<{ id: string; task_arn: string | null; busy: boolean; draining_at: Date | null; state: string | null }>(
    `SELECT b.id, b.task_arn, b.draining_at, b.status->>'state' AS state,
            EXISTS (SELECT 1 FROM claims c WHERE c.bot_id = b.id AND c.state = ANY($2)) AS busy
       FROM bots b
      WHERE b.last_heartbeat > now() - make_interval(secs => $1)
      ORDER BY b.registered_at, b.id`,
    [STALE_SECONDS, LIVE_STATES],
  );
  return rows.map((r) => ({ botId: r.id, taskArn: r.task_arn, busy: r.busy, drainingAt: r.draining_at, state: r.state }));
}

const setDraining = (pool: pg.Pool, botId: string, draining: boolean) =>
  pool.query(`UPDATE bots SET draining_at = CASE WHEN $2 THEN now() END WHERE id = $1`, [botId, draining]);

export interface FleetDeps {
  pool: pg.Pool;
  ecs: FleetEcs;
  config: FleetConfig;
  /** When demand first fell below the running count; kept by the caller between passes. */
  state: { lowerSince: Date | null };
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', line: Record<string, unknown>) => void;
}

/**
 * One pass. Every query is its own statement, outside any transaction, on purpose: the
 * drain must be visible to allocation the moment it is written. A pass that finds the
 * fleet lock taken (another backend's) is skipped; the next one runs a minute later.
 */
export async function reconcileFleet(d: FleetDeps): Promise<Record<string, unknown>> {
  const { pool, ecs, config } = d;
  const run = await withFleetLock(pool, async () => {
    await pool.query(`UPDATE bots SET draining_at = NULL WHERE draining_at < now() - make_interval(secs => $1)`, [VICTIM_DRAIN_SECONDS]);
    const now = d.now();
    const { rows: claims } = await pool.query(
      `SELECT state, lease_until, pending_until, allocation_count FROM claims WHERE state = ANY($1)`,
      [OPEN_STATES],
    );
    const demand = countDemand(claims, now);
    const desired = desiredCount(demand, config);
    const current = await ecs.getDesiredCount();

    // The grace clock starts the first time demand is below the running count and runs
    // until it is not.
    const lowerSince = desired < current ? (d.state.lowerSince ?? now) : null;
    const decrease = lowerSince !== null && now.getTime() - lowerSince.getTime() >= SCALE_IN_GRACE_SECONDS * 1000;

    const plan = planProtection({ bots: await readBots(pool), decrease });
    let target = Math.max(desired, current);
    if (decrease && plan.victim) target = current - 1; // one step per pass
    let decreaseCancelled: string | null = null;
    let protectionFailures: EcsFailure[] = [];
    let busyUnprotected: string[] = [];
    let spareUnprotected: string[] = [];
    // A busy task whose renewal ECS refused (DEPLOYMENT_BLOCKED during a deploy): the read-back
    // still shows the old grant, so this is the only sign a meeting's protection is running out.
    let busyRenewalRefused: string[] = [];

    if (config.mode === 'on') {
      const { victim } = plan;
      if (victim) await setDraining(pool, victim.botId, true);
      const failures = await applyProtection(ecs, plan);
      const protecting = [...plan.busy, ...plan.spared];
      const readBack = protecting.length ? await ecs.getProtection(protecting) : { protectedTasks: [], failures: [] };

      protectionFailures = [...failures, ...readBack.failures];
      busyRenewalRefused = failures.flatMap((f) => (f.arn && plan.busy.includes(f.arn) ? [f.arn] : []));
      // Every task the plan protected must read back protected: a busy one so ECS cannot stop
      // a meeting, a spare so the victim is the only task ECS may stop.
      const unprotected = (arns: string[]) => arns.filter((arn) => !readBack.protectedTasks.find((t) => t.taskArn === arn)?.protectionEnabled);
      busyUnprotected = unprotected(plan.busy);
      spareUnprotected = unprotected(plan.spared);

      if (victim) {
        if (failures.length) decreaseCancelled = 'protection_set_failed';
        else if (readBack.failures.length) decreaseCancelled = 'protection_read_back_failed';
        else if (busyUnprotected.length) decreaseCancelled = 'busy_task_unprotected';
        else if (spareUnprotected.length) decreaseCancelled = 'spare_task_unprotected';
        else if (await victimHoldsClaim(pool, victim.botId)) decreaseCancelled = 'victim_claimed';

        // Last, once nothing can cancel the decrease: the victim loses its protection.
        if (!decreaseCancelled) {
          const cleared = await ecs.setProtection([victim.taskArn], false);
          if (cleared.length) {
            protectionFailures = [...protectionFailures, ...cleared];
            decreaseCancelled = 'protection_set_failed';
          }
        }
        if (decreaseCancelled) {
          target = current;
          await setDraining(pool, victim.botId, false);
        }
      }
      if (target !== current) await ecs.setDesiredCount(target);
    }

    // Outside the mode gate: a dryrun shows the decrease it would not make.
    if (decrease && !plan.victim && plan.unprotectable.length) decreaseCancelled = 'fleet_bot_without_task_arn';
    // Not a cancellation: the next pass after the stop lands makes it (the grace clock is kept).
    const decreaseDeferred = decrease && plan.stopInFlight ? 'stop_in_flight' : null;

    d.state.lowerSince = lowerSince;
    const result = {
      mode: config.mode,
      ...demand,
      desired,
      current,
      target,
      lowerSince,
      busy: plan.busy,
      spared: plan.spared,
      clear: plan.clear,
      victim: plan.victim,
      decreaseCancelled,
      decreaseDeferred,
      protectionFailures,
      busyUnprotected,
      spareUnprotected,
      busyRenewalRefused,
      unprotectable: plan.unprotectable,
    };
    const level =
      busyUnprotected.length || busyRenewalRefused.length
        ? 'error'
        : protectionFailures.length || spareUnprotected.length || plan.unprotectable.length
          ? 'warn'
          : 'info';
    d.log(level, { event: 'fleet.reconcile', ...result });
    return result;
  });
  if (run.acquired) return run.value;
  // Another backend is running the passes: this one's grace clock no longer says anything.
  d.state.lowerSince = null;
  return { skipped: 'locked' };
}

async function victimHoldsClaim(pool: pg.Pool, botId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM claims WHERE bot_id = $1 AND state = ANY($2)`, [botId, LIVE_STATES]);
  return rowCount !== 0;
}

/** The busy, then the spared, then the clear; every failure ECS reported. */
async function applyProtection(ecs: FleetEcs, plan: ProtectionPlan): Promise<EcsFailure[]> {
  const failures: EcsFailure[] = [];
  if (plan.busy.length) failures.push(...(await ecs.setProtection(plan.busy, true, BUSY_PROTECTION_MINUTES)));
  if (plan.spared.length) failures.push(...(await ecs.setProtection(plan.spared, true, SPARE_PROTECTION_MINUTES)));
  if (plan.clear.length) failures.push(...(await ecs.setProtection(plan.clear, false)));
  return failures;
}

/**
 * The busy seam (busy.ts) on ECS: a bot given a meeting has its task protected at once,
 * not at the next pass. A freed bot's clear is left to the pass, which knows whether a stop
 * is in flight; clearing at once could leave a second unprotected idle task beside the victim.
 * Wired only while the fleet is on (server.ts).
 */
export function ecsBusyProtection(pool: pg.Pool, ecs: FleetEcs): BusyProtection {
  return {
    markBusy: async (botId) => {
      const { rows } = await pool.query<{ task_arn: string | null }>(`SELECT task_arn FROM bots WHERE id = $1`, [botId]);
      const arn = rows[0]?.task_arn;
      if (!arn) return;
      const [failure] = await ecs.setProtection([arn], true, BUSY_PROTECTION_MINUTES);
      if (failure) throw Object.assign(new Error('task protection refused'), { code: failure.reason });
    },
  };
}
