import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openClaim } from '../src/claims.ts';
import { issueFleetCredential } from '../src/credentials.ts';
import { createPool } from '../src/db/pool.ts';
import { BUSY_PROTECTION_MINUTES } from '../src/fleet.ts';
import { start } from '../src/server.ts';
import { apiBase, bearer, until } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';

const ARN = 'arn:aws:ecs:us-west-2:123456789012:task/bwat/0123456789abcdef0123456789abcdef';

/** An ECS that runs `desired` tasks and keeps the protection it is given. */
function fakeEcsClient(desired: number) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const protectedTasks = new Set<string>();
  return {
    sent,
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const { name } = command.constructor;
      const { input } = command;
      sent.push({ name, input });
      if (name === 'DescribeServicesCommand') return { services: [{ desiredCount: desired }] };
      if (name === 'UpdateServiceCommand') desired = input.desiredCount as number;
      if (name === 'UpdateTaskProtectionCommand') {
        for (const arn of input.tasks as string[]) {
          if (input.protectionEnabled) protectedTasks.add(arn);
          else protectedTasks.delete(arn);
        }
      }
      if (name === 'GetTaskProtectionCommand') {
        return { protectedTasks: (input.tasks as string[]).map((taskArn) => ({ taskArn, protectionEnabled: protectedTasks.has(taskArn) })) };
      }
      return {};
    },
  };
}

describeDb('the fleet in a running backend (QOR-4888)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(db.url('runtime'));
  });
  afterAll(() => pool.end());

  const env = (fleet: Record<string, string>) => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', ...fleet });

  it('off: no ECS call is ever made', async () => {
    const client = fakeEcsClient(1);
    const app = await start(env({}), { ecsClient: client, fleetMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await app.close();
    expect(client.sent).toEqual([]);
  });

  it('on: a bot given a meeting has its task protected at once, and a pass adds a bot for the next meeting', async () => {
    const client = fakeEcsClient(1);
    const fleet = { BWAT_FLEET_AUTOSCALE: 'on', BWAT_FLEET_CLUSTER: 'bwat', BWAT_FLEET_SERVICE: 'bwat-bot' };
    let app: FastifyInstance | undefined;
    try {
      app = apiBase(await start(env(fleet), { ecsClient: client, fleetMs: 1_000 }));
      await openClaim(pool, { meetingNumber: '610000001', briefing: {} });
      const fleetToken = await issueFleetCredential(pool);
      const bot = (await app.inject({ method: 'POST', url: '/bots/register', headers: bearer(fleetToken), payload: { task_arn: ARN } })).json();
      await app.inject({ method: 'POST', url: '/bots/ready', headers: bearer(bot.bot_token) });

      // Protected by the allocation itself, before any pass has looked at the service.
      const protect = client.sent.findIndex((s) => s.name === 'UpdateTaskProtectionCommand');
      expect(client.sent[protect]?.input).toEqual({
        cluster: 'bwat',
        tasks: [ARN],
        protectionEnabled: true,
        expiresInMinutes: BUSY_PROTECTION_MINUTES,
      });
      const firstPass = client.sent.findIndex((s) => s.name === 'DescribeServicesCommand');
      expect(firstPass === -1 || firstPass > protect).toBe(true);
      // One meeting held, headroom 1: two bots.
      expect(await until(async () => client.sent.some((s) => s.name === 'UpdateServiceCommand'), { tries: 120 })).toBe(true);
      expect(client.sent.find((s) => s.name === 'UpdateServiceCommand')!.input).toEqual({
        cluster: 'bwat',
        service: 'bwat-bot',
        desiredCount: 2,
      });
    } finally {
      await app?.close();
    }
  });

  it('dryrun: reads the service but writes nothing, not even a bot\'s protection as it takes a meeting', async () => {
    const client = fakeEcsClient(1);
    const fleet = { BWAT_FLEET_AUTOSCALE: 'dryrun', BWAT_FLEET_CLUSTER: 'bwat', BWAT_FLEET_SERVICE: 'bwat-bot' };
    let app: FastifyInstance | undefined;
    try {
      app = apiBase(await start(env(fleet), { ecsClient: client, fleetMs: 50 }));
      await openClaim(pool, { meetingNumber: '610000002', briefing: {} });
      const fleetToken = await issueFleetCredential(pool);
      const bot = (await app.inject({ method: 'POST', url: '/bots/register', headers: bearer(fleetToken), payload: { task_arn: ARN } })).json();
      await app.inject({ method: 'POST', url: '/bots/ready', headers: bearer(bot.bot_token) });
      expect(await until(async () => client.sent.some((s) => s.name === 'DescribeServicesCommand'))).toBe(true);
      expect(client.sent.map((s) => s.name).filter((name) => name !== 'DescribeServicesCommand')).toEqual([]);
    } finally {
      await app?.close();
    }
  });

  it('refuses to start with a fleet mode but no service to size', async () => {
    await expect(start(env({ BWAT_FLEET_AUTOSCALE: 'dryrun', BWAT_FLEET_CLUSTER: 'bwat' }))).rejects.toThrow(
      'BWAT_FLEET_SERVICE is not set',
    );
  });
});
