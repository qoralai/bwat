import { describe, expect, it } from 'vitest';
import { ecsFleet } from '../src/fleet-ecs.ts';

/** Records each command's name and input; answers with `reply(name)`. */
function recordingClient(reply: (name: string) => unknown = () => ({})) {
  const sent: Array<{ name: string; input: unknown }> = [];
  return {
    sent,
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply(command.constructor.name);
    },
  };
}

const NAMES = { cluster: 'bwat', service: 'bwat-bot' };

describe('the fleet\'s ECS calls (QOR-4888)', () => {
  it('reads the service\'s desired count', async () => {
    const client = recordingClient(() => ({ services: [{ desiredCount: 2 }] }));
    expect(await ecsFleet(client, NAMES).getDesiredCount()).toBe(2);
    expect(client.sent).toEqual([{ name: 'DescribeServicesCommand', input: { cluster: 'bwat', services: ['bwat-bot'] } }]);
  });

  it('says so when the service is not there, rather than read it as zero', async () => {
    const client = recordingClient(() => ({ services: [], failures: [{ reason: 'MISSING' }] }));
    await expect(ecsFleet(client, NAMES).getDesiredCount()).rejects.toThrow('bwat-bot not found in bwat: MISSING');
  });

  it('protects with an expiry, clears without one, and returns what ECS refused', async () => {
    const client = recordingClient(() => ({ failures: [{ arn: 'arn:a', reason: 'DEPLOYMENT_BLOCKED' }] }));
    const ecs = ecsFleet(client, NAMES);
    expect(await ecs.setProtection(['arn:a'], true, 240)).toEqual([{ arn: 'arn:a', reason: 'DEPLOYMENT_BLOCKED' }]);
    await ecs.setProtection(['arn:b'], false);
    expect(client.sent).toEqual([
      { name: 'UpdateTaskProtectionCommand', input: { cluster: 'bwat', tasks: ['arn:a'], protectionEnabled: true, expiresInMinutes: 240 } },
      { name: 'UpdateTaskProtectionCommand', input: { cluster: 'bwat', tasks: ['arn:b'], protectionEnabled: false } },
    ]);
  });

  it('reads protection back, and sets the desired count', async () => {
    const client = recordingClient((name) =>
      name === 'GetTaskProtectionCommand' ? { protectedTasks: [{ taskArn: 'arn:a', protectionEnabled: true }] } : {},
    );
    const ecs = ecsFleet(client, NAMES);
    expect(await ecs.getProtection(['arn:a'])).toEqual({ protectedTasks: [{ taskArn: 'arn:a', protectionEnabled: true }], failures: [] });
    await ecs.setDesiredCount(3);
    expect(client.sent.map((s) => s.input)).toEqual([
      { cluster: 'bwat', tasks: ['arn:a'] },
      { cluster: 'bwat', service: 'bwat-bot', desiredCount: 3 },
    ]);
  });
});
