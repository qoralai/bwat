import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { checkDbUrl, dbTls, envSecret } from '../config.ts';
import { RUNTIME_ROLE } from './runtime-role.ts';

type Env = NodeJS.ProcessEnv;
type Login = 'owner' | 'runtime' | 'cards';
export type BootstrapRoles = Record<Login, string>;

/** The three logins (backend/README.md). The script always uses these; tests pass their own. */
export const BOOTSTRAP_ROLES: BootstrapRoles = { owner: 'bwat_owner', runtime: RUNTIME_ROLE, cards: 'bwat_cards' };

/** Each login's attributes, as the reference SQL in backend/README.md spells them. */
export const ROLE_ATTRIBUTES: Record<Login, string> = {
  owner: 'LOGIN',
  runtime: 'LOGIN NOBYPASSRLS',
  cards: 'LOGIN NOSUPERUSER NOBYPASSRLS',
};

const PASSWORD_NAMES: Record<Login, string> = {
  owner: 'BWAT_OWNER_PASSWORD',
  runtime: 'BWAT_RUNTIME_PASSWORD',
  cards: 'BWAT_CARDS_PASSWORD',
};

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The SCRAM-SHA-256 verifier Postgres would store for `password` (RFC 7677, 4096
 * iterations, Postgres's default). CREATE ROLE and ALTER ROLE take it in place of the
 * password, so the plaintext never reaches the server: no statement, server log or error
 * can echo it. The verifier itself may appear in server statement logs.
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * A login's password from the env. Printable ASCII only: Postgres normalises other
 * characters (SASLprep) before hashing and node-pg does not, so a verifier made from one
 * might not match what a client sends. Errors name the variable, never the value.
 */
function password(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`${name} must be printable ASCII without spaces`);
  return value;
}

/**
 * The admin connection, from the env alone (NAME_FILE > NAME), never the secret store:
 * BWAT_DB_ADMIN_URL, or when it is unset BWAT_DB_ADMIN_USER, _PASSWORD, _HOST and _PORT,
 * as the RDS master secret's keys arrive, so a password needs no URL escaping. The parts
 * connect to the `postgres` database.
 */
function adminConnection(env: Env): pg.ClientConfig {
  const url = envSecret(env, 'BWAT_DB_ADMIN_URL');
  if (url) return { connectionString: checkDbUrl('BWAT_DB_ADMIN_URL', url) };
  const part = (name: string) => {
    const value = envSecret(env, name);
    if (!value) throw new Error(`BWAT_DB_ADMIN_URL is not set, and neither is ${name}`);
    return value;
  };
  return {
    user: part('BWAT_DB_ADMIN_USER'),
    password: part('BWAT_DB_ADMIN_PASSWORD'),
    host: part('BWAT_DB_ADMIN_HOST'),
    port: Number(part('BWAT_DB_ADMIN_PORT')),
    database: 'postgres',
  };
}

/** Runs `sql`, naming `what` failed in place of the server's own context. */
async function step(client: pg.Client, what: string, sql: string, values?: unknown[]) {
  try {
    return await client.query(sql, values);
  } catch (err) {
    // The message only: the statement and the server's context are never repeated.
    throw new Error(`${what} failed: ${(err as Error).message}`);
  }
}

/**
 * `node dist/scripts/db-bootstrap.js`: from an admin connection (adminConnection: a
 * superuser, or a CREATEROLE CREATEDB login such as the RDS master user), creates the
 * three logins and the database BWAT_DB_NAME (default bwat) owned by the owner, and
 * grants CONNECT on it to the runtime and card logins. Anything that exists is kept and
 * nothing is ever dropped; an existing login only gets its password set again, and
 * existing state it must not keep is refused. `env` is already resolved by startupEnv.
 * Returns one summary line per object, with no password.
 */
export async function dbBootstrap(env: Env, roles: BootstrapRoles = BOOTSTRAP_ROLES): Promise<string[]> {
  const admin = adminConnection(env);
  const passwords = {
    owner: password(env, PASSWORD_NAMES.owner),
    runtime: password(env, PASSWORD_NAMES.runtime),
    cards: password(env, PASSWORD_NAMES.cards),
  };
  const database = env.BWAT_DB_NAME || 'bwat';
  if (!DATABASE_NAME.test(database)) throw new Error('BWAT_DB_NAME must be a lowercase identifier: a-z, 0-9 and _');

  const client = new pg.Client({ ...admin, ssl: dbTls(env), connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const q = (name: string) => client.escapeIdentifier(name);
    const lines: string[] = [];

    const existing = await step(client, `looking up database ${database}`, 'SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    const dbExists = Boolean(existing.rowCount);

    for (const login of ['owner', 'runtime', 'cards'] as const) {
      const role = roles[login];
      const verifier = client.escapeLiteral(scramVerifier(passwords[login]));
      const exists = await step(client, `looking up role ${role}`, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount) {
        await step(client, `setting the password of role ${role}`, `ALTER ROLE ${q(role)} PASSWORD ${verifier}`);
        lines.push(`role ${role}: kept, password set`);
      } else {
        await step(client, `creating role ${role}`, `CREATE ROLE ${q(role)} ${ROLE_ATTRIBUTES[login]} PASSWORD ${verifier}`);
        lines.push(`role ${role}: created`);
      }
    }

    // A non-superuser may only give a database to a role it can SET ROLE to, and grants
    // CONNECT on it as that role. The RDS master user created the owner (so holds ADMIN
    // OPTION on it) and grants it to itself, as RDS documents; it stays a member
    // afterwards. SET is all it needs: a new membership gets no INHERIT, and one of its own
    // that lacks SET gets SET and keeps its INHERIT.
    const who = await step(
      client,
      'checking the admin login',
      `SELECT current_user AS admin, rolsuper OR pg_has_role(current_user, $1, 'SET') AS can,
              EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND m.member = r.oid AND m.grantor = r.oid) AS own
         FROM pg_roles r WHERE rolname = current_user`,
      [roles.owner],
    );
    const { admin, can, own } = who.rows[0] as { admin: string; can: boolean; own: boolean };
    if (!can) {
      const options = own ? 'SET TRUE' : 'INHERIT FALSE, SET TRUE';
      await step(client, `granting role ${roles.owner} to ${admin}`, `GRANT ${q(roles.owner)} TO ${q(admin)} WITH ${options} GRANTED BY CURRENT_USER`);
      lines.push(`role ${roles.owner}: granted to ${admin}`);
    }

    if (dbExists) {
      lines.push(`database ${database}: kept`);
    } else {
      await step(client, `creating database ${database}`, `CREATE DATABASE ${q(database)} OWNER ${q(roles.owner)}`);
      lines.push(`database ${database}: created`);
    }

    for (const role of [roles.runtime, roles.cards]) {
      // An explicit grant, not PUBLIC's default CONNECT, which an install may revoke.
      const hasConnect = async () =>
        (
          await step(
            client,
            `checking CONNECT for ${role}`,
            `SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
              WHERE d.datname = $1 AND a.privilege_type = 'CONNECT' AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $2)`,
            [database, role],
          )
        ).rowCount;
      if (await hasConnect()) {
        lines.push(`connect ${role}: kept`);
        continue;
      }
      // As the owner: a GRANT from a login without grant authority only warns and grants
      // nothing. One implicit transaction, so a failed GRANT also undoes the SET ROLE.
      await step(
        client,
        `granting CONNECT on ${database} to ${role}`,
        `SET ROLE ${q(roles.owner)}; GRANT CONNECT ON DATABASE ${q(database)} TO ${q(role)}; RESET ROLE`,
      );
      if (!(await hasConnect())) throw new Error(`granting CONNECT on ${database} to ${role} did not take effect`);
      lines.push(`connect ${role}: granted`);
    }
    return lines;
  } finally {
    await client.end();
  }
}
