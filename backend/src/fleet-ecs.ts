import {
  DescribeServicesCommand,
  ECSClient,
  GetTaskProtectionCommand,
  UpdateServiceCommand,
  UpdateTaskProtectionCommand,
} from '@aws-sdk/client-ecs';
import type { FleetConfig } from './config.ts';
import type { FleetEcs } from './fleet.ts';

/**
 * The fleet's ECS calls (fleet.ts), over an SDK client. Loaded only when
 * BWAT_FLEET_AUTOSCALE is not off, so an install without the fleet never loads the ECS SDK.
 */

/** Anything that sends an SDK command: the ECS client, or a test's stand-in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EcsSender = { send(command: any): Promise<any> };

/**
 * A pass holds the fleet lock across its ECS calls, so one slow call must not hold it for
 * the SDK's default (3 attempts, no request timeout): 2 attempts of at most 3 s connect
 * and 10 s response.
 */
export const ecsClient = (): EcsSender =>
  new ECSClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } });

export function ecsFleet(client: EcsSender, { cluster, service }: Pick<FleetConfig, 'cluster' | 'service'>): FleetEcs {
  return {
    async getDesiredCount() {
      const res = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
      const svc = res.services?.[0];
      if (!svc) throw new Error(`fleet service ${service} not found in ${cluster}: ${res.failures?.[0]?.reason ?? 'no service'}`);
      return Number(svc.desiredCount);
    },
    async setProtection(tasks, enabled, expiresInMinutes) {
      const input = { cluster, tasks, protectionEnabled: enabled, expiresInMinutes };
      return (await client.send(new UpdateTaskProtectionCommand(input))).failures ?? [];
    },
    async getProtection(tasks) {
      const res = await client.send(new GetTaskProtectionCommand({ cluster, tasks }));
      return { protectedTasks: res.protectedTasks ?? [], failures: res.failures ?? [] };
    },
    async setDesiredCount(desiredCount) {
      await client.send(new UpdateServiceCommand({ cluster, service, desiredCount }));
    },
  };
}
