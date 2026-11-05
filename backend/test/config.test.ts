import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  envSecret,
  ownerDbUrl,
  runtimeDbUrl,
  serverConfig,
  startupSecret,
  ZOOM_SECRET_ENV,
  zoomConfig,
} from '../src/config.ts';
import { withEnvFallback, type SecretStore } from '../src/secrets/store.ts';

/** A secret store holding nothing. */
const nothingStored = { get: async () => null } as unknown as SecretStore;

const RUNTIME = 'postgres://bwat_runtime:secret-one@127.0.0.1:5432/bwat';
const OWNER = 'postgres://bwat_owner:secret-two@127.0.0.1:5432/bwat';

describe('database configuration (QOR-4568)', () => {
  it('reads the runtime URL from BWAT_DB_URL and the owner URL from BWAT_OWNER_DB_URL', () => {
    expect(runtimeDbUrl({ BWAT_DB_URL: RUNTIME, BWAT_OWNER_DB_URL: OWNER })).toBe(RUNTIME);
    expect(ownerDbUrl({ BWAT_DB_URL: RUNTIME, BWAT_OWNER_DB_URL: OWNER })).toBe(OWNER);
  });

  it('names the missing variable and nothing else', () => {
    expect(() => runtimeDbUrl({ BWAT_OWNER_DB_URL: OWNER })).toThrow(/^BWAT_DB_URL is not set$/);
    expect(() => runtimeDbUrl({ BWAT_DB_URL: '' })).toThrow(/^BWAT_DB_URL is not set$/);
    expect(() => ownerDbUrl({ BWAT_DB_URL: RUNTIME })).toThrow(/^BWAT_OWNER_DB_URL is not set$/);
  });

  it('refuses a value that is not a postgres URL without echoing it', () => {
    let message = '';
    try {
      runtimeDbUrl({ BWAT_DB_URL: 'mysql://u:secret-three@host/db' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('BWAT_DB_URL is not a postgres:// or postgresql:// URL');
  });

  it('listens on 127.0.0.1:3000 unless HOST and PORT say otherwise', () => {
    expect(serverConfig({})).toEqual({ host: '127.0.0.1', port: 3000 });
    expect(serverConfig({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({ host: '0.0.0.0', port: 8080 });
  });
});

describe('Zoom configuration (QOR-4576)', () => {
  it('falls back to BWAT_ZOOM_WEBHOOK_SECRET for zoom.webhook_secret when nothing is stored; unset or empty is none', async () => {
    const zoomSecrets = (env: NodeJS.ProcessEnv) => withEnvFallback(nothingStored, ZOOM_SECRET_ENV, env);
    expect(await zoomSecrets({ BWAT_ZOOM_WEBHOOK_SECRET: 'tok' }).get('zoom.webhook_secret')).toBe('tok');
    expect(await zoomSecrets({}).get('zoom.webhook_secret')).toBeNull();
    expect(await zoomSecrets({ BWAT_ZOOM_WEBHOOK_SECRET: '' }).get('zoom.webhook_secret')).toBeNull();
  });

  it('answers no other name from the env, and reads the env once, when built', async () => {
    const env: Record<string, string | undefined> = { BWAT_ZOOM_WEBHOOK_SECRET: 'tok', 'zoom.client_secret': 'x' };
    const secrets = withEnvFallback(nothingStored, ZOOM_SECRET_ENV, env);
    expect(await secrets.get('zoom.client_secret')).toBeNull();
    expect(await secrets.get('BWAT_ZOOM_WEBHOOK_SECRET')).toBeNull();
    env.BWAT_ZOOM_WEBHOOK_SECRET = 'changed';
    expect(await secrets.get('zoom.webhook_secret')).toBe('tok');
  });

  it('allows auto-join and waits for the host unless the deployment says off in so many words', () => {
    expect(zoomConfig({})).toMatchObject({ autoJoin: true, requireHost: true });
    for (const on of ['true', '1', 'yes', 'on', 'typo', ' ']) {
      expect(zoomConfig({ BWAT_AUTO_JOIN: on, BWAT_AUTO_JOIN_REQUIRE_HOST: on }), on).toMatchObject({
        autoJoin: true,
        requireHost: true,
      });
    }
    for (const off of ['false', '0', 'no', 'off', 'n', 'disabled', ' FALSE ', 'Off']) {
      expect(zoomConfig({ BWAT_AUTO_JOIN: off }).autoJoin, off).toBe(false);
      expect(zoomConfig({ BWAT_AUTO_JOIN_REQUIRE_HOST: off }).requireHost, off).toBe(false);
    }
  });
});

describe('tier-1 startup secrets: NAME_FILE > NAME > store (QOR-4578)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bwat-config-'));
  const FROM_FILE = 'postgres://bwat_runtime:from-file-secret@127.0.0.1:5432/bwat';
  writeFileSync(join(dir, 'db'), `${FROM_FILE}\n`);
  writeFileSync(join(dir, 'crlf'), 'value-from-file\r\n');
  const warnings = () => {
    const seen: unknown[] = [];
    return { seen, warn: (w: unknown) => void seen.push(w) };
  };

  it('reads the variable, or the file its _FILE form names without the trailing newline, or nothing', () => {
    expect(envSecret({ X: 'value' }, 'X')).toBe('value');
    expect(envSecret({ X_FILE: join(dir, 'crlf') }, 'X')).toBe('value-from-file');
    expect(envSecret({}, 'X')).toBeUndefined();
    expect(envSecret({ X: '' }, 'X')).toBeUndefined();
    expect(() => envSecret({ X_FILE: join(dir, 'missing') }, 'X')).toThrow(/^X_FILE cannot be read$/);
  });

  it('takes the _FILE form over the variable, with one warning naming the winner and never a value', () => {
    const { seen, warn } = warnings();
    expect(envSecret({ X: 'direct-value', X_FILE: join(dir, 'crlf') }, 'X', warn)).toBe('value-from-file');
    expect(seen).toEqual([{ event: 'config.secret_precedence', name: 'X', winner: 'X_FILE' }]);
  });

  it('accepts BWAT_DB_URL_FILE and BWAT_OWNER_DB_URL_FILE, the file over the variable', () => {
    expect(runtimeDbUrl({ BWAT_DB_URL_FILE: join(dir, 'db') })).toBe(FROM_FILE);
    expect(ownerDbUrl({ BWAT_OWNER_DB_URL_FILE: join(dir, 'db'), BWAT_OWNER_DB_URL: OWNER })).toBe(FROM_FILE);
  });

  it('falls back to the store last, and names the winner once when a name is set in two or three places', async () => {
    const store = async (name: string) => (name === 'BWAT_DB_URL' ? 'postgres://bwat_runtime:from-store@db/bwat' : null);
    let w = warnings();
    expect(await startupSecret({}, 'BWAT_DB_URL', { fromStore: store, warn: w.warn })).toBe('postgres://bwat_runtime:from-store@db/bwat');
    expect(w.seen).toEqual([]);
    w = warnings();
    expect(await startupSecret({ BWAT_DB_URL: RUNTIME }, 'BWAT_DB_URL', { fromStore: store, warn: w.warn })).toBe(RUNTIME);
    expect(w.seen).toEqual([{ event: 'config.secret_precedence', name: 'BWAT_DB_URL', winner: 'BWAT_DB_URL' }]);
    w = warnings();
    const all = { BWAT_DB_URL: RUNTIME, BWAT_DB_URL_FILE: join(dir, 'db') };
    expect(await startupSecret(all, 'BWAT_DB_URL', { fromStore: store, warn: w.warn })).toBe(FROM_FILE);
    expect(w.seen).toEqual([{ event: 'config.secret_precedence', name: 'BWAT_DB_URL', winner: 'BWAT_DB_URL_FILE' }]);
    expect(await startupSecret({}, 'BWAT_SESSION_SECRET', { fromStore: store })).toBeUndefined();
  });

  it('uses the env when the store cannot be read, and names the variable only when nothing else has it', async () => {
    const broken = async () => {
      throw new Error('AccessDeniedException');
    };
    expect(await startupSecret({ BWAT_DB_URL: RUNTIME }, 'BWAT_DB_URL', { fromStore: broken })).toBe(RUNTIME);
    await expect(startupSecret({}, 'BWAT_DB_URL', { fromStore: broken })).rejects.toThrow(/^BWAT_DB_URL cannot be read from the secret store$/);
  });

  // Statically: in aws mode startupEnv imports the SDK on demand (B3).
  it('keeps the AWS SDK out of everything npm run migrate loads', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      // `import x from '…'`, `export … from '…'` and a bare `import '…'`.
      const imports = /^\s*(?:import\s+'([^']+)'|(?:import|export)\b[^'";]*?\bfrom\s+'([^']+)')/gm;
      for (const [, bare, from] of readFileSync(file, 'utf8').matchAll(imports)) {
        const spec = bare ?? from ?? '';
        expect(spec, file).not.toMatch(/^@aws-sdk\//);
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      }
    };
    walk(resolve(import.meta.dirname, '..', 'scripts', 'migrate.ts'));
    expect([...seen].map((f) => f.split(sep).join('/').replace(/^.*\/backend\//, ''))).toContain('src/config.ts');
    expect([...seen].some((f) => /secrets/.test(f))).toBe(false);
  });
});
