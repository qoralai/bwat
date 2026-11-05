import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type pg from 'pg';
import { envSecret, key32, type Warn } from '../config.ts';
import { open, seal, wellFormed } from './aead.ts';
import { isTier2Name } from '../secret-names.ts';

/**
 * The secret store (D142): one interface, two implementations chosen by
 * BWAT_SECRET_STORE. `local` keeps secrets in bwat.secrets, AES-256-GCM under
 * BWAT_ENC_KEY; `aws` keeps them in Secrets Manager under BWAT_SECRET_PREFIX. Nothing
 * here logs, and no error carries a value, a key or a ciphertext: only a secret's name,
 * which is never content.
 */
export interface SecretStore {
  /**
   * The value, or null when none is stored. Throws SecretUnreadable when one is stored but
   * cannot be read, SecretUnavailable when the store cannot be asked. `tx` as for status.
   */
  get(name: string, tx?: pg.ClientBase): Promise<string | null>;
  /**
   * `tx`: the transaction the change is part of (its audit and version bump). The local
   * store writes in it, so the key and its audit commit or roll back together; the aws
   * store cannot, and is called inside it, before the bump commits.
   */
  put(name: string, value: string, tx?: pg.ClientBase): Promise<void>;
  /**
   * Only whether it is set, where from, and the last 4 characters of a long enough value.
   * `tx`: read in that transaction (the local store), so a change holding the settings
   * lock needs no second connection.
   */
  status(name: string, tx?: pg.ClientBase): Promise<SecretStatus>;
  /** True when something was deleted. `tx` as for put. */
  delete(name: string, tx?: pg.ClientBase): Promise<boolean>;
  /** Whether it keeps this name: a tier-2 one, or one of the plugins' it was given. */
  keeps(name: string): boolean;
}

export interface SecretStatus {
  set: boolean;
  /** `unavailable`: the store could not be asked (an aws error), so whether it is set is unknown. */
  source: 'store' | 'env' | 'unavailable' | null;
  last4: string | null;
}

/** A store that cannot write (no BWAT_ENC_KEY): its put and delete throw this, which routes answer 503. */
export class SecretStoreNotConfigured extends Error {
  readonly code = 'not_configured';
  constructor() {
    super('secret store: not configured');
  }
}

/**
 * The store could not be reached or would not answer: an aws error (access denied, no
 * credentials or region, throttling, the network), or a deletion still running after
 * the retries. Routes answer it 503. Never a value: only the error's name and the
 * secret's name.
 */
export class SecretUnavailable extends Error {
  readonly code = 'secret_unavailable';
}

/**
 * A value is stored but cannot be read (written under another BWAT_ENC_KEY, or a moved
 * row). Not a SecretUnavailable: status shows such a key as set. Routes answer it 503
 * secret_unavailable, as for a store that cannot be reached. Never a value: only the
 * secret's name.
 */
export class SecretUnreadable extends Error {
  readonly code = 'secret_unavailable';
}

// The tier-2 names, kept in secret-names.ts so a module that only names secrets (plugin.ts,
// which `npm run migrate` loads) never pulls in the AWS SDK.
export { isTier2Name, TIER2_NAMES, type Tier2Name } from '../secret-names.ts';
// Shown only for a value of 16 characters or more, so it is never more than a quarter of it.
const LAST4_MIN_LENGTH = 16;

const NOT_SET: SecretStatus = { set: false, source: null, last4: null };
const UNAVAILABLE: SecretStatus = { set: false, source: 'unavailable', last4: null };
export const statusOf = (value: string | null, source: 'store' | 'env'): SecretStatus =>
  value === null ? NOT_SET : { set: true, source, last4: value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : null };

/**
 * The status, for a change that acts on whether a value is stored: throws SecretUnavailable
 * when the store could not be asked, rather than act on an unknown.
 */
export async function knownStatus(store: SecretStore, name: string, tx?: pg.ClientBase): Promise<SecretStatus> {
  const status = await store.status(name, tx);
  if (status.source === 'unavailable') throw new SecretUnavailable(`secret store: cannot tell whether ${name} is stored`);
  return status;
}

function checkValue(value: string): void {
  if (!value) throw new Error('secret store: empty value');
}
const unreadable = (name: string) => new SecretUnreadable(`secret store: unreadable ${name}`);

/**
 * What a store is told it keeps besides the tier-2 names: the switched-in plugins' own
 * secrets (plugin.ts pluginSecretNames), whether or not a plugin is on.
 */
export interface KeptNames {
  pluginNames?: readonly string[];
}

/** The parts every implementation shares: name and value checks, and status from get. */
function storeOf(
  impl: {
    get(name: string, tx?: pg.ClientBase): Promise<string | null>;
    put(name: string, value: string, tx?: pg.ClientBase): Promise<void>;
    delete(name: string, tx?: pg.ClientBase): Promise<boolean>;
  },
  { pluginNames = [] }: KeptNames = {},
): SecretStore {
  const keeps = (name: string) => isTier2Name(name) || pluginNames.includes(name);
  const checkName = (name: string) => {
    if (!keeps(name)) throw new Error('secret store: unknown secret name');
  };
  return {
    keeps,
    async get(name, tx) {
      checkName(name);
      return impl.get(name, tx);
    },
    async put(name, value, tx) {
      checkName(name);
      checkValue(value);
      return impl.put(name, value, tx);
    },
    async status(name, tx) {
      checkName(name);
      try {
        return statusOf(await impl.get(name, tx), 'store');
      } catch (err) {
        // The store could not be asked: unknown, never shown as set.
        if (err instanceof SecretUnavailable) return UNAVAILABLE;
        // Stored, but not readable (another key, a moved row): set, with nothing shown.
        return { set: true, source: 'store', last4: null };
      }
    },
    async delete(name, tx) {
      checkName(name);
      return impl.delete(name, tx);
    },
  };
}

/**
 * The local store: one row per secret, `pk1:<nonce>:<ciphertext+tag>` (base64 parts),
 * the secret's name as associated data, so a ciphertext copied to another name does not
 * decrypt.
 */
export function localSecretStore(db: pg.Pool, key: Buffer, kept: KeptNames = {}): SecretStore {
  const aad = (name: string) => Buffer.from(name, 'utf8');
  const decrypt = (name: string, stored: string): string => {
    const [version, nonceB64, sealedB64, ...rest] = stored.split(':');
    if (version !== 'pk1' || nonceB64 === undefined || sealedB64 === undefined || rest.length > 0) throw unreadable(name);
    const nonce = Buffer.from(nonceB64, 'base64');
    const sealed = Buffer.from(sealedB64, 'base64');
    if (!wellFormed(nonce, sealed)) throw unreadable(name);
    try {
      return open(nonce, sealed, key, aad(name)).toString('utf8');
    } catch {
      throw unreadable(name);
    }
  };
  return storeOf({
    async get(name, tx) {
      let rows: { ciphertext: string }[];
      try {
        ({ rows } = await (tx ?? db).query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE name = $1`, [name]));
      } catch (err) {
        // The database could not be asked: unknown, not "stored but unreadable".
        throw new SecretUnavailable(`secret store: database ${(err as { code?: string }).code ?? 'error'} reading ${name}`);
      }
      return rows[0] ? decrypt(name, rows[0].ciphertext) : null;
    },
    async put(name, value, tx) {
      const { nonce, sealed } = seal(Buffer.from(value, 'utf8'), key, aad(name));
      await (tx ?? db).query(
        `INSERT INTO secrets (name, ciphertext) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
        [name, `pk1:${nonce.toString('base64')}:${sealed.toString('base64')}`],
      );
    },
    async delete(name, tx) {
      const { rowCount } = await (tx ?? db).query(`DELETE FROM secrets WHERE name = $1`, [name]);
      return (rowCount ?? 0) > 0;
    },
  }, kept);
}

/** What the aws store needs of a Secrets Manager client; tests pass a fake. */
export interface SecretsManagerLike {
  send(command: object): Promise<unknown>;
}

const errorName = (err: unknown) => (err as { name?: string }).name ?? 'error';
const notFound = (err: unknown) => errorName(err) === 'ResourceNotFoundException';
// What Secrets Manager answers about a name whose deletion has not finished yet.
const beingDeleted = (err: unknown) => errorName(err) === 'InvalidRequestException';
const unreachable = (err: unknown, op: string, name: string) => new SecretUnavailable(`secret store: aws ${errorName(err)} ${op} ${name}`);

/** The secret `secretId` holds, or null when there is none (or its deletion is still running). */
async function awsRead(client: SecretsManagerLike, secretId: string, name: string): Promise<string | null> {
  try {
    const out = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))) as { SecretString?: string };
    return out.SecretString ?? null;
  } catch (err) {
    if (notFound(err) || beingDeleted(err)) return null;
    throw unreachable(err, 'reading', name);
  }
}

/** Waits between the attempts of a write that meets a deletion still running. */
const RETRY_DELAYS_MS = [100, 200, 400];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The aws store: one Secrets Manager secret per name, `<prefix><name>`. A delete forces
 * no recovery window, but Secrets Manager still deletes asynchronously: until it is
 * done, the name answers InvalidRequestException. A read then means not set; a write
 * waits and retries (`retryDelaysMs`), then gives up as unreachable. The writes run
 * while a model-key change holds the settings lock, so the retries stay short.
 */
export function awsSecretStore(
  client: SecretsManagerLike,
  prefix: string,
  { retryDelaysMs = RETRY_DELAYS_MS, ...kept }: { retryDelaysMs?: number[] } & KeptNames = {},
): SecretStore {
  const id = (name: string) => `${prefix}${name}`;
  /** One write attempt: true when written, false when the name is still being deleted. */
  const write = async (name: string, value: string): Promise<boolean> => {
    try {
      await client.send(new PutSecretValueCommand({ SecretId: id(name), SecretString: value }));
      return true;
    } catch (err) {
      if (beingDeleted(err)) return false;
      if (!notFound(err)) throw unreachable(err, 'writing', name);
    }
    try {
      await client.send(new CreateSecretCommand({ Name: id(name), SecretString: value }));
      return true;
    } catch (err) {
      if (beingDeleted(err)) return false;
      throw unreachable(err, 'creating', name);
    }
  };
  return storeOf({
    get: (name) => awsRead(client, id(name), name),
    async put(name, value) {
      for (const delay of [...retryDelaysMs, null]) {
        if (await write(name, value)) return;
        if (delay === null) break;
        await sleep(delay);
      }
      throw new SecretUnavailable(`secret store: aws ${name} is still being deleted`);
    },
    async delete(name) {
      try {
        await client.send(new DeleteSecretCommand({ SecretId: id(name), ForceDeleteWithoutRecovery: true }));
        return true;
      } catch (err) {
        // Already gone, or already being deleted: nothing more was deleted.
        if (notFound(err) || beingDeleted(err)) return false;
        throw unreachable(err, 'deleting', name);
      }
    },
  }, kept);
}

/** The store with no key: nothing stored, nothing can be. */
const unavailableStore = (kept: KeptNames): SecretStore =>
  storeOf(
    {
      get: async () => null,
      put: async () => {
        throw new SecretStoreNotConfigured();
      },
      delete: async () => {
        throw new SecretStoreNotConfigured();
      },
    },
    kept,
  );

/**
 * A store whose reads fall back to the env only while nothing is stored: `fallbacks` maps
 * a secret name to the env variable (or its *_FILE form) used then. A store that cannot
 * be read throws, and the env never stands in: it may hold a value since rotated away
 * (an old Zoom webhook secret), so falling back would accept it again. The env is read
 * once, here, so a bad *_FILE fails at startup and no request reads a file. A stored
 * value always wins; writes and deletes touch the store only.
 */
export function withEnvFallback(store: SecretStore, fallbacks: Record<string, string>, env: NodeJS.ProcessEnv): SecretStore {
  const fromEnvByName = new Map(Object.entries(fallbacks).map(([name, variable]) => [name, envSecret(env, variable) ?? null]));
  const fromEnv = (name: string) => fromEnvByName.get(name) ?? null;
  return {
    ...store,
    async get(name, tx) {
      return (await store.get(name, tx)) ?? fromEnv(name);
    },
    async status(name, tx) {
      const stored = await store.status(name, tx);
      // Unavailable stays so: the env is not what get would answer.
      if (stored.set || stored.source === 'unavailable' || fromEnv(name) === null) return stored;
      return statusOf(fromEnv(name), 'env');
    },
  };
}

/** BWAT_SECRET_PREFIX, checked: required when BWAT_SECRET_STORE=aws. */
export function awsSecretPrefix(env: NodeJS.ProcessEnv): string {
  const prefix = env.BWAT_SECRET_PREFIX;
  if (!prefix) throw new Error('BWAT_SECRET_PREFIX must be set when BWAT_SECRET_STORE=aws');
  if (!/^[A-Za-z0-9/_+=.@-]{1,256}$/.test(prefix)) throw new Error('BWAT_SECRET_PREFIX has characters a secret name cannot');
  return prefix;
}

/**
 * The tier-1 leg of the aws store (backend/README.md, Secrets): a startup secret read as
 * `<prefix><NAME>`, last after `NAME_FILE` and `NAME` (config.ts startupSecret). Read
 * only, at startup, and apart from SecretStore, whose names are tier 2 only. Null when
 * there is no such secret; any other error throws (without the value).
 */
export function awsStartupSecrets(client: SecretsManagerLike, prefix: string): (name: string) => Promise<string | null> {
  // `||`: an empty startup secret is no secret.
  return async (name) => (await awsRead(client, `${prefix}${name}`, name)) || null;
}

/**
 * The store BWAT_SECRET_STORE names (local when unset). Local without BWAT_ENC_KEY (or
 * BWAT_ENC_KEY_FILE) is a store that holds nothing and refuses writes, so a stack
 * without a key still starts; anything set but wrong refuses to start. BWAT_ENC_KEY is
 * read from the env only and is never written anywhere.
 */
export function secretStoreFromEnv(
  env: NodeJS.ProcessEnv,
  pool: pg.Pool,
  { awsClient, warn, ...kept }: { awsClient?: SecretsManagerLike | undefined; warn?: Warn } & KeptNames = {},
): SecretStore {
  const kind = env.BWAT_SECRET_STORE || 'local';
  if (kind === 'aws') return awsSecretStore(awsClient ?? new SecretsManagerClient({}), awsSecretPrefix(env), kept);
  if (kind !== 'local') throw new Error('BWAT_SECRET_STORE must be local or aws');
  const key = envSecret(env, 'BWAT_ENC_KEY', warn);
  return key === undefined ? unavailableStore(kept) : localSecretStore(pool, key32('BWAT_ENC_KEY', key), kept);
}
