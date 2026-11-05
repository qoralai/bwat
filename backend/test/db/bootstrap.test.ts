import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOTSTRAP_ROLES, dbBootstrap, ROLE_ATTRIBUTES, type BootstrapRoles } from '../../src/db/bootstrap.ts';
import { migrateDatabase, MIGRATIONS_DIR } from '../../src/db/migrate.ts';
import { STARTUP_NAMES, startupEnv } from '../../src/config.ts';
import { asSuperuser, describeDb, ROLE_NAMES, superuserUrl } from './harness.ts';
import { runNpmScript } from '../npm-script.ts';

// QOR-4626: `node dist/scripts/db-bootstrap.js` makes the three logins and the database
// from an admin connection. Roles are cluster-wide and the harness's own bwat_owner,
// bwat_runtime and bwat_cards are shared with every other test (and other runs on the
// same server), so these tests pass their own throwaway names through the test seam and
// drop them afterwards. The script itself always uses the fixed names.

const pw = () => randomBytes(12).toString('hex');

/** The URL `user` logs in with to `database`. */
function loginUrl(user: string, password: string, database: string): string {
  const u = new URL(superuserUrl(database));
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Logs in once as `user`: 'ok', or the SQLSTATE it is refused with. */
async function login(user: string, password: string, database: string): Promise<string> {
  const client = new pg.Client({ connectionString: loginUrl(user, password, database) });
  try {
    await client.connect();
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe('npm run db-bootstrap without a password (QOR-4626)', () => {
  it('fails, naming the missing variable, and prints no other secret', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, BWAT_DB_ADMIN_URL: 'postgres://admin:admin-secret-value@127.0.0.1:1/postgres', BWAT_OWNER_PASSWORD: 'owner-secret-value', BWAT_CARDS_PASSWORD: 'cards-secret-value' };
    delete env.BWAT_RUNTIME_PASSWORD;
    delete env.BWAT_RUNTIME_PASSWORD_FILE;
    const run = await runNpmScript('db-bootstrap', env);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('db-bootstrap failed: BWAT_RUNTIME_PASSWORD is not set');
    for (const secret of ['admin-secret-value', 'owner-secret-value', 'cards-secret-value']) expect(run.stdout + run.stderr).not.toContain(secret);
  }, 30_000);
});

describe('db-bootstrap and the secret store (QOR-4642)', () => {
  it('reads the admin login from the env only: a store that refuses it is never asked', async () => {
    const asked: string[] = [];
    const refuses = {
      async send(command: object) {
        asked.push((command as { input: { SecretId: string } }).input.SecretId);
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      },
    };
    const env = { BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/', BWAT_DB_ADMIN_USER: 'admin', BWAT_DB_ADMIN_PASSWORD: 'x', BWAT_DB_ADMIN_HOST: 'db', BWAT_DB_ADMIN_PORT: '5432', BWAT_OWNER_PASSWORD: 'a', BWAT_RUNTIME_PASSWORD: 'b', BWAT_CARDS_PASSWORD: 'c' };
    await expect(startupEnv(env, STARTUP_NAMES.dbBootstrap, { awsClient: refuses })).resolves.toMatchObject({ BWAT_DB_ADMIN_USER: 'admin' });
    expect(asked.filter((id) => id.includes('BWAT_DB_ADMIN'))).toEqual([]);
  });
});

describe('db-bootstrap and the README (QOR-4626)', () => {
  it('makes each login with exactly the attributes the reference SQL in the README gives it', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    const documented = Object.fromEntries([...readme.matchAll(/^CREATE ROLE (\w+) +(.+?) PASSWORD '\.\.\.';$/gm)].map((m) => [m[1], m[2]]));
    const made = Object.fromEntries((['owner', 'runtime', 'cards'] as const).map((login) => [BOOTSTRAP_ROLES[login], ROLE_ATTRIBUTES[login]]));
    expect(made).toEqual(documented);
  });
});

describeDb('db-bootstrap (QOR-4626)', () => {
  const prefix = `bwat_boot_${randomBytes(4).toString('hex')}`;
  const roles: BootstrapRoles = { owner: `${prefix}_owner`, runtime: `${prefix}_runtime`, cards: `${prefix}_cards` };
  const admin = `${prefix}_admin`;
  const database = `${prefix}_db`;
  // Everything a run printed or threw, in this test.
  let output = '';

  /** One run through the seam, recording its summary, its error and anything it logged. */
  async function bootstrap(env: NodeJS.ProcessEnv): Promise<string[]> {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void (output += `${args.join(' ')}\n`)),
    );
    try {
      const lines = await dbBootstrap(env, roles);
      output += `${lines.join('\n')}\n`;
      return lines;
    } catch (err) {
      output += `${(err as Error).message}\n${(err as Error).stack}\n`;
      throw err;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  const envFor = (passwords: { owner: string; runtime: string; cards: string }, adminUrl = superuserUrl('postgres')) => ({
    BWAT_DB_ADMIN_URL: adminUrl,
    BWAT_DB_NAME: database,
    BWAT_OWNER_PASSWORD: passwords.owner,
    BWAT_RUNTIME_PASSWORD: passwords.runtime,
    BWAT_CARDS_PASSWORD: passwords.cards,
  });

  afterEach(async () => {
    output = '';
    await asSuperuser(async (su) => {
      await su.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const role of [...Object.values(roles), admin]) await su.query(`DROP ROLE IF EXISTS ${role}`);
    });
  }, 30_000);

  const roleAttributes = () =>
    asSuperuser(async (su) => {
      const { rows } = await su.query(
        `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb
           FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
        [Object.values(roles)],
      );
      return rows;
    });

  const databaseState = () =>
    asSuperuser(async (su) => {
      const { rows } = await su.query<{ owner: string; connect: string[] }>(
        `SELECT pg_get_userbyid(d.datdba) AS owner,
                ARRAY(SELECT pg_get_userbyid(a.grantee)::text FROM aclexplode(d.datacl) a
                       WHERE a.privilege_type = 'CONNECT' AND a.grantee <> 0 AND a.grantee <> d.datdba
                       ORDER BY 1) AS connect
           FROM pg_database d WHERE d.datname = $1`,
        [database],
      );
      return rows[0];
    });

  /** The oids of the three roles and the database: a drop and re-create changes them. */
  const oids = () =>
    asSuperuser(async (su) => {
      const { rows } = await su.query(
        `SELECT rolname AS name, oid FROM pg_roles WHERE rolname = ANY($1)
         UNION ALL SELECT datname, oid FROM pg_database WHERE datname = $2 ORDER BY 1`,
        [Object.values(roles), database],
      );
      return rows;
    });

  it('creates the three logins with the right attributes and the database owned by the owner, with CONNECT for runtime and cards', async () => {
    const passwords = { owner: pw(), runtime: pw(), cards: pw() };
    const lines = await bootstrap(envFor(passwords));

    expect(lines).toEqual([
      `role ${roles.owner}: created`,
      `role ${roles.runtime}: created`,
      `role ${roles.cards}: created`,
      `database ${database}: created`,
      `connect ${roles.runtime}: granted`,
      `connect ${roles.cards}: granted`,
    ]);
    const plain = { rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false };
    expect(await roleAttributes()).toEqual(
      [
        { rolname: roles.cards, ...plain, rolbypassrls: false },
        { rolname: roles.owner, ...plain, rolbypassrls: false },
        { rolname: roles.runtime, ...plain, rolbypassrls: false },
      ].sort((a, b) => a.rolname.localeCompare(b.rolname)),
    );
    expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
    for (const role of ['owner', 'runtime', 'cards'] as const) expect(await login(roles[role], passwords[role], database)).toBe('ok');
    expect(output).not.toMatch(new RegExp(Object.values(passwords).join('|')));
  }, 30_000);

  it('keeps everything on a second run, re-setting only the passwords: nothing is dropped', async () => {
    const passwords = { owner: pw(), runtime: pw(), cards: pw() };
    await bootstrap(envFor(passwords));
    await asSuperuser((su) => su.query('CREATE TABLE public.survives (id int)'), database);
    const before = { oids: await oids(), attributes: await roleAttributes(), database: await databaseState() };

    const lines = await bootstrap(envFor(passwords));

    expect(lines).toEqual([
      `role ${roles.owner}: kept, password set`,
      `role ${roles.runtime}: kept, password set`,
      `role ${roles.cards}: kept, password set`,
      `database ${database}: kept`,
      `connect ${roles.runtime}: kept`,
      `connect ${roles.cards}: kept`,
    ]);
    expect({ oids: await oids(), attributes: await roleAttributes(), database: await databaseState() }).toEqual(before);
    const survives = await asSuperuser((su) => su.query(`SELECT to_regclass('public.survives') AS t`), database);
    expect(survives.rows[0].t).toBe('survives');
    expect(output).not.toMatch(new RegExp(Object.values(passwords).join('|')));
  }, 30_000);

  it('applies a changed password: the new one logs in and the old one is refused', async () => {
    const first = { owner: pw(), runtime: pw(), cards: pw() };
    const second = { owner: pw(), runtime: pw(), cards: pw() };
    await bootstrap(envFor(first));
    await bootstrap(envFor(second));

    for (const role of ['owner', 'runtime', 'cards'] as const) {
      expect(await login(roles[role], second[role], database)).toBe('ok');
      expect(await login(roles[role], first[role], database)).toBe('28P01'); // invalid_password
    }
    expect(output).not.toMatch(new RegExp([...Object.values(first), ...Object.values(second)].join('|')));
  }, 30_000);

  it('works from a CREATEROLE CREATEDB admin that is not a superuser (the RDS master user), granting itself the owner', async () => {
    const adminPassword = pw();
    await asSuperuser((su) => su.query(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD '${adminPassword}'`));
    const passwords = { owner: pw(), runtime: pw(), cards: pw() };
    const env = envFor(passwords, loginUrl(admin, adminPassword, 'postgres'));

    const lines = await bootstrap(env);
    expect(lines).toEqual([
      `role ${roles.owner}: created`,
      `role ${roles.runtime}: created`,
      `role ${roles.cards}: created`,
      `role ${roles.owner}: granted to ${admin}`,
      `database ${database}: created`,
      `connect ${roles.runtime}: granted`,
      `connect ${roles.cards}: granted`,
    ]);
    expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
    expect((await roleAttributes()).map((r) => r.rolbypassrls)).toEqual([false, false, false]);

    expect(await bootstrap(env)).toEqual([
      `role ${roles.owner}: kept, password set`,
      `role ${roles.runtime}: kept, password set`,
      `role ${roles.cards}: kept, password set`,
      `database ${database}: kept`,
      `connect ${roles.runtime}: kept`,
      `connect ${roles.cards}: kept`,
    ]);
    expect(output).not.toMatch(new RegExp([...Object.values(passwords), adminPassword].join('|')));
  }, 30_000);

  it('takes the admin login as parts when BWAT_DB_ADMIN_URL is unset, a password a URL would mangle included (QOR-4642)', async () => {
    // An RDS master password may hold URL-reserved characters; ECS hands the parts over as they are.
    const adminPassword = `p@ss:w/rd?#%&${pw()}`;
    await asSuperuser((su) => su.query(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD '${adminPassword}'`));
    const dir = mkdtempSync(join(tmpdir(), 'bwat-admin-'));
    try {
      writeFileSync(join(dir, 'password'), `${adminPassword}\n`);
      const server = new URL(superuserUrl('postgres'));
      const passwords = { owner: pw(), runtime: pw(), cards: pw() };
      const env = {
        ...envFor(passwords),
        BWAT_DB_ADMIN_URL: undefined,
        BWAT_DB_ADMIN_USER: admin,
        BWAT_DB_ADMIN_PASSWORD_FILE: join(dir, 'password'),
        BWAT_DB_ADMIN_HOST: server.hostname,
        BWAT_DB_ADMIN_PORT: server.port || '5432',
      };

      expect(await bootstrap(env)).toContain(`role ${roles.owner}: granted to ${admin}`);
      expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
      expect(output).not.toContain(adminPassword);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('names the missing part when neither the URL nor every part is set (QOR-4642)', async () => {
    const withoutUrl = { ...envFor({ owner: pw(), runtime: pw(), cards: pw() }), BWAT_DB_ADMIN_URL: undefined };
    await expect(bootstrap({ ...withoutUrl, BWAT_DB_ADMIN_USER: 'admin', BWAT_DB_ADMIN_PASSWORD: 'x', BWAT_DB_ADMIN_HOST: 'localhost' })).rejects.toThrow(
      'BWAT_DB_ADMIN_URL is not set, and neither is BWAT_DB_ADMIN_PORT',
    );
  });

  /** A CREATEROLE CREATEDB login that is not a superuser (the RDS master user), and its URL. */
  async function nonSuperuserAdmin(): Promise<string> {
    const adminPassword = pw();
    await asSuperuser((su) => su.query(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD '${adminPassword}'`));
    return loginUrl(admin, adminPassword, 'postgres');
  }

  /** Runs `sql` as `url`'s login. */
  async function as(url: string, sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  /** The three roles made by a superuser, which the admin holds ADMIN on as it would on roles it made, and cannot act as. */
  const rolesMadeElsewhere = (extra: Partial<Record<keyof BootstrapRoles, string>> = {}) =>
    asSuperuser(async (su) => {
      for (const login of ['owner', 'runtime', 'cards'] as const) await su.query(`CREATE ROLE ${roles[login]} LOGIN ${extra[login] ?? ''}`);
      await su.query(`GRANT ${Object.values(roles).join(', ')} TO ${admin} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    });

  it('as a non-superuser admin, gives itself only SET on the owner: no INHERIT, and the database is the owner\'s', async () => {
    const env = envFor({ owner: pw(), runtime: pw(), cards: pw() }, await nonSuperuserAdmin());
    await bootstrap(env);

    const membership = await asSuperuser(async (su) => {
      const { rows } = await su.query(
        `SELECT pg_has_role($1, $2, 'SET') AS can_set, pg_has_role($1, $2, 'USAGE') AS inherits FROM (SELECT 1) x`,
        [admin, roles.owner],
      );
      return rows[0];
    });
    expect(membership).toEqual({ can_set: true, inherits: false });
    expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
  }, 30_000);

  it('as a non-superuser admin that is a member of the owner with SET FALSE, sets SET on that membership and makes the database', async () => {
    const adminUrl = await nonSuperuserAdmin();
    // INHERIT TRUE, SET FALSE: it may use the owner's privileges but not act as it.
    await as(adminUrl, `CREATE ROLE ${roles.owner} LOGIN`);
    await as(adminUrl, `GRANT ${roles.owner} TO ${admin} WITH SET FALSE`);

    const lines = await bootstrap(envFor({ owner: pw(), runtime: pw(), cards: pw() }, adminUrl));

    expect(lines).toEqual([
      `role ${roles.owner}: kept, password set`,
      `role ${roles.runtime}: created`,
      `role ${roles.cards}: created`,
      `role ${roles.owner}: granted to ${admin}`,
      `database ${database}: created`,
      `connect ${roles.runtime}: granted`,
      `connect ${roles.cards}: granted`,
    ]);
    // The admin's own membership got SET and kept its INHERIT: nothing else about it changed.
    const own = await asSuperuser(async (su) => {
      const { rows } = await su.query(
        `SELECT inherit_option, set_option FROM pg_auth_members WHERE roleid = $1::regrole AND member = $2::regrole AND grantor = $2::regrole`,
        [roles.owner, admin],
      );
      return rows;
    });
    expect(own).toEqual([{ inherit_option: true, set_option: true }]);
    expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
  }, 30_000);

  it('as a non-superuser admin, grants CONNECT on an existing database it does not own by acting as the owner', async () => {
    const adminUrl = await nonSuperuserAdmin();
    await rolesMadeElsewhere();
    await asSuperuser((su) => su.query(`CREATE DATABASE ${database} OWNER ${roles.owner}`));

    const lines = await bootstrap(envFor({ owner: pw(), runtime: pw(), cards: pw() }, adminUrl));

    expect(lines).toEqual([
      `role ${roles.owner}: kept, password set`,
      `role ${roles.runtime}: kept, password set`,
      `role ${roles.cards}: kept, password set`,
      `role ${roles.owner}: granted to ${admin}`,
      `database ${database}: kept`,
      `connect ${roles.runtime}: granted`,
      `connect ${roles.cards}: granted`,
    ]);
    expect(await databaseState()).toEqual({ owner: roles.owner, connect: [roles.cards, roles.runtime].sort() });
  }, 30_000);

  it('never reports CONNECT granted when the GRANT did not take effect', async () => {
    const adminUrl = await nonSuperuserAdmin();
    // The GRANT a server answers with only a WARNING ("no privileges were granted").
    const query = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].includes('GRANT CONNECT')) return Promise.resolve({ rows: [], rowCount: null });
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof query);
    try {
      await expect(bootstrap(envFor({ owner: pw(), runtime: pw(), cards: pw() }, adminUrl))).rejects.toThrow(
        `granting CONNECT on ${database} to ${roles.runtime} did not take effect`,
      );
    } finally {
      spy.mockRestore();
    }
    expect(output).not.toMatch(/connect \S+: granted/);
  }, 30_000);

  it('fails without leaking a password when the admin may not create roles', async () => {
    const adminPassword = pw();
    await asSuperuser((su) => su.query(`CREATE ROLE ${admin} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB PASSWORD '${adminPassword}'`));
    const passwords = { owner: pw(), runtime: pw(), cards: pw() };

    await expect(bootstrap(envFor(passwords, loginUrl(admin, adminPassword, 'postgres')))).rejects.toThrow(
      new RegExp(`^creating role ${roles.owner} failed: permission denied`),
    );
    expect(output).not.toMatch(new RegExp([...Object.values(passwords), adminPassword].join('|')));
  }, 30_000);

  it('then migrates as the owner it made', async () => {
    const passwords = { owner: pw(), runtime: pw(), cards: pw() };
    await bootstrap(envFor(passwords));
    // The migrations name the fixed logins; this copy names this test's.
    const dir = mkdtempSync(join(tmpdir(), 'bwat-boot-migrations-'));
    // Core's files and each plugin's (migrations/plugins/<name>/, QOR-4806), in the order migrateAll applies them.
    const keys = readdirSync(MIGRATIONS_DIR, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split(sep).join('/'))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')) || (a < b ? -1 : 1));
    for (const key of keys) {
      const sql = readFileSync(join(MIGRATIONS_DIR, key), 'utf8');
      mkdirSync(dirname(join(dir, key)), { recursive: true });
      writeFileSync(join(dir, key), sql.replace(/\bbwat_(owner|runtime|cards)\b/g, (_, login: keyof BootstrapRoles) => roles[login]));
    }

    const applied = await migrateDatabase(loginUrl(roles.owner, passwords.owner, database), dir).finally(() => rmSync(dir, { recursive: true }));
    expect(applied).toEqual(keys);
    const check = await asSuperuser(
      (su) =>
        su.query(
          `SELECT pg_get_userbyid(nspowner) AS owner, has_schema_privilege($1, oid, 'USAGE') AS runtime, has_schema_privilege($2, oid, 'USAGE') AS cards
             FROM pg_namespace WHERE nspname = 'bwat'`,
          [roles.runtime, roles.cards],
        ),
      database,
    );
    expect(check.rows[0]).toEqual({ owner: roles.owner, runtime: true, cards: true });
  }, 60_000);

  it('rejects a database name that is not a plain identifier', async () => {
    await expect(bootstrap({ ...envFor({ owner: pw(), runtime: pw(), cards: pw() }), BWAT_DB_NAME: 'bwat"; drop' })).rejects.toThrow(
      /^BWAT_DB_NAME must be/,
    );
  });
});

describeDb('npm run db-bootstrap failing against a live server (QOR-4626)', () => {
  it('exits 1 with a clear message and prints none of the passwords', async () => {
    // The harness's plain login: it may not alter the roles, so the run fails at the
    // first one and changes nothing.
    const stranger = new URL(superuserUrl('postgres'));
    stranger.username = ROLE_NAMES.stranger;
    const passwords = [pw(), pw(), pw()];
    const env = {
      ...process.env,
      BWAT_DB_ADMIN_URL: stranger.toString(),
      BWAT_DB_NAME: `bwat_boot_${randomBytes(4).toString('hex')}_db`,
      BWAT_OWNER_PASSWORD: passwords[0],
      BWAT_RUNTIME_PASSWORD: passwords[1],
      BWAT_CARDS_PASSWORD: passwords[2],
    };
    const run = await runNpmScript('db-bootstrap', env);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^db-bootstrap failed: setting the password of role bwat_owner failed: permission denied/m);
    const adminPassword = decodeURIComponent(stranger.password);
    for (const secret of [...passwords, adminPassword]) expect(run.stdout + run.stderr).not.toContain(secret);
  }, 30_000);
});
