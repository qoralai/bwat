import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface Secret {
  value: string;
  /** Eventual consistency: what the next `staleReads` reads still answer (null: not found), after a write. */
  stale?: { value: string | null; reads: number };
  /** Deleted without ForceDeleteWithoutRecovery: scheduled, and stays so. */
  scheduled: boolean;
  /** Force-deleted: still being deleted for this many more calls on its name, then gone. */
  pending?: number;
}

/**
 * A stand-in for Secrets Manager that behaves the way the real service does where it
 * matters: a missing secret is ResourceNotFoundException, PutSecretValue needs the
 * secret to exist, and a deleted secret is not gone at once. Without
 * ForceDeleteWithoutRecovery it is scheduled for deletion; with it, the deletion still
 * runs asynchronously, so for a while (`pendingCalls` calls on its name) a read, a
 * write, a create and a delete of the name all answer InvalidRequestException. Reads are
 * eventually consistent when `staleReads` is set: that many reads after a write still
 * answer what was there before it.
 */
export class FakeSecretsManager {
  readonly secrets = new Map<string, Secret>();
  readonly calls: string[] = [];
  /** When set, every call fails with this error name (AccessDenied, throttling, ...). */
  failWith: string | null = null;
  private readonly pendingCalls: number;
  /** How many reads after a write still answer the value from before it (default 0). */
  staleReads: number;

  constructor({ pendingCalls = 2, staleReads = 0 }: { pendingCalls?: number; staleReads?: number } = {}) {
    this.pendingCalls = pendingCalls;
    this.staleReads = staleReads;
  }

  async send(command: object): Promise<unknown> {
    const fail = (name: string) => Object.assign(new Error(name), { name });
    const input = (command as { input: Record<string, unknown> }).input;
    this.calls.push(command.constructor.name);
    if (this.failWith) throw fail(this.failWith);
    const id = (input.SecretId ?? input.Name) as string;
    const found = this.secrets.get(id);
    if (found?.pending !== undefined) {
      if (found.pending === 0) this.secrets.delete(id);
      else found.pending--;
    }
    const s = this.secrets.get(id);
    const busy = s !== undefined && (s.scheduled || s.pending !== undefined);
    if (command instanceof GetSecretValueCommand) {
      if (!s) throw fail('ResourceNotFoundException');
      if (busy) throw fail('InvalidRequestException');
      if (s.stale && s.stale.reads > 0) {
        s.stale.reads--;
        if (s.stale.value === null) throw fail('ResourceNotFoundException');
        return { SecretString: s.stale.value };
      }
      return { SecretString: s.value };
    }
    const stale = (before: string | null) => (this.staleReads > 0 ? { stale: { value: before, reads: this.staleReads } } : {});
    if (command instanceof PutSecretValueCommand) {
      if (!s) throw fail('ResourceNotFoundException');
      if (busy) throw fail('InvalidRequestException');
      Object.assign(s, stale(s.value), { value: input.SecretString as string });
      return {};
    }
    if (command instanceof CreateSecretCommand) {
      if (s) throw fail(busy ? 'InvalidRequestException' : 'ResourceExistsException');
      this.secrets.set(id, { value: input.SecretString as string, scheduled: false, ...stale(null) });
      return {};
    }
    if (command instanceof DeleteSecretCommand) {
      if (!s) throw fail('ResourceNotFoundException');
      if (busy) throw fail('InvalidRequestException');
      if (input.ForceDeleteWithoutRecovery === true) s.pending = this.pendingCalls;
      else s.scheduled = true;
      return {};
    }
    throw new Error(`fake: unexpected ${command.constructor.name}`);
  }
}

const COMMANDS: Record<string, new (input: never) => object> = {
  GetSecretValue: GetSecretValueCommand,
  PutSecretValue: PutSecretValueCommand,
  CreateSecret: CreateSecretCommand,
  DeleteSecret: DeleteSecretCommand,
};

/**
 * `fake` over Secrets Manager's own wire protocol (JSON 1.1, the operation in X-Amz-Target),
 * so a script run as a child process reaches it with the real SDK. `env`: what that child
 * needs to call it (AWS_ENDPOINT_URL_SECRETS_MANAGER, a region and dummy credentials).
 */
export async function serveOverHttp(fake: FakeSecretsManager): Promise<{ env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const op = String(req.headers['x-amz-target']).replace(/^secretsmanager\./, '');
      res.setHeader('content-type', 'application/x-amz-json-1.1');
      try {
        const out = await fake.send(new COMMANDS[op]!(JSON.parse(body || '{}') as never));
        res.end(JSON.stringify(out));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ __type: (err as Error).name, message: (err as Error).name }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    env: {
      AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${port}`,
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
