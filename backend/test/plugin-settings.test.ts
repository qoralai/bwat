import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pluginSecretNames, pluginSettings, type BwatPlugin } from '../src/plugins/plugin.ts';
import { localSecretStore } from '../src/secrets/store.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, useRoles } from './people.ts';

// QOR-4978: a plugin's own settings and secrets, which its setup card on the panel's Plugins
// page reads and saves. Kept in bwat.settings and the secret store under its own name.
const tuner: BwatPlugin = {
  name: 'tuner',
  displayName: 'Tuner',
  description: 'Tunes things.',
  settings: [
    {
      key: 'tuner_site',
      label: 'Tuner site',
      check: (v) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim()) ? null : 'Tuner site must be an https address.'),
      normalise: (v) => String(v).trim(),
      auditValue: true,
    },
    { key: 'tuner_email', label: 'Tuner email', check: (v) => (typeof v === 'string' && v.includes('@') ? null : 'Tuner email must be an email address.') },
    // Not under its own name: never one of its settings.
    { key: 'auto_join_enabled', label: 'Sneaky', check: () => null },
  ],
  secrets: ['tuner.token'],
};

describeDb("a plugin's own settings", () => {
  const t = useRoles({
    plugins: [tuner],
    secrets: (pool) => localSecretStore(pool, randomBytes(32), { pluginNames: pluginSecretNames([tuner]) }),
  });
  const read = async (headers = MEMBER) => t.app.inject({ method: 'GET', url: '/console/plugins/tuner/settings', headers });
  const save = (changes: Record<string, { value: unknown; expectedRevision: number | null }>, headers = ADMIN, name = 'tuner') =>
    t.app.inject({ method: 'PUT', url: `/console/plugins/${name}/settings`, headers, payload: { changes } });

  it('reads every setting under its own name, unset, to any signed-in person', async () => {
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      canManage: false,
      settings: { tuner_site: { value: null, revision: null }, tuner_email: { value: null, revision: null } },
    });
    expect((await read(ADMIN)).json().canManage).toBe(true);
  });

  it('saves as an owner or admin: normalised, revisioned, and audited, a value only where the setting shows it', async () => {
    const res = await save({ tuner_site: { value: '  https://tuner.example ', expectedRevision: null }, tuner_email: { value: 'ops@tuner.example', expectedRevision: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({ tuner_site: { value: 'https://tuner.example', revision: 1 }, tuner_email: { value: 'ops@tuner.example', revision: 1 } });
    const { rows } = await t.pool.query(`SELECT actor_id AS actor, action, before, after FROM audit WHERE target_type = 'settings:tuner'`);
    expect(rows).toEqual([{
      actor: ADMIN_ID,
      action: 'settings.updated',
      before: { tuner_site: { value: null, revision: null }, tuner_email: { value: null, revision: null } },
      after: { tuner_site: { value: 'https://tuner.example', revision: 1 }, tuner_email: { value: 'set', revision: 1 } },
    }]);
  });

  it('treats an unchanged value as no change: no write, no audit', async () => {
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM audit WHERE target_type = 'settings:tuner'`)).rows[0].n;
    const res = await save({ tuner_site: { value: 'https://tuner.example', expectedRevision: 1 } });
    expect(res.json().settings.tuner_site).toEqual({ value: 'https://tuner.example', revision: 1 });
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM audit WHERE target_type = 'settings:tuner'`)).rows[0].n).toBe(before);
  });

  it('resets a setting with null', async () => {
    const res = await save({ tuner_email: { value: null, expectedRevision: 1 } });
    expect(res.json().settings.tuner_email).toEqual({ value: null, revision: 2 });
  });

  it("refuses a bad value, a key that is not one of its own, and a body with nothing to save, naming each problem", async () => {
    const bad = await save({ tuner_site: { value: 'http://plain.example', expectedRevision: 1 }, auto_join_enabled: { value: false, expectedRevision: null } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_settings', problems: ['Tuner site must be an https address.', '"auto_join_enabled" is not a setting of Tuner.'] });
    expect((await t.app.inject({ method: 'PUT', url: '/console/plugins/tuner/settings', headers: ADMIN, payload: {} })).json()).toEqual({ error: 'invalid_settings', problems: ['Nothing to save.'] });
    expect((await t.pool.query(`SELECT 1 FROM settings WHERE key = 'auto_join_enabled'`)).rowCount).toBe(0);
  });

  it('refuses a save read at an older revision, saying what is stored now', async () => {
    const res = await save({ tuner_site: { value: 'https://other.example', expectedRevision: null } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevisions: { tuner_site: 1 } });
  });

  it('lets only an owner or admin save, and knows no other plugin', async () => {
    expect((await save({ tuner_site: { value: 'https://x.example', expectedRevision: 1 } }, MEMBER)).statusCode).toBe(403);
    expect((await save({ tuner_site: { value: 'https://x.example', expectedRevision: 1 } }, ADMIN, 'nope')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/console/plugins/nope/settings', headers: MEMBER })).statusCode).toBe(404);
  });

  it("lists its secret with the panel's others, and an admin sets and removes it there", async () => {
    const listed = async () => (await t.app.inject({ method: 'GET', url: '/console/secrets', headers: ADMIN })).json().secrets;
    expect(await listed()).toContainEqual({ name: 'tuner.token', set: false, source: null, last4: null });
    const put = await t.app.inject({ method: 'PUT', url: '/console/secrets/tuner.token', headers: ADMIN, payload: { value: 'tok-0123456789abcdefWXYZ' } });
    expect(put.json()).toEqual({ name: 'tuner.token', set: true, source: 'store', last4: 'WXYZ' });
    expect((await t.app.inject({ method: 'DELETE', url: '/console/secrets/tuner.token', headers: ADMIN })).json().set).toBe(false);
  });
});

describe("a plugin's settings keys", () => {
  it("are never one of core's, even under a plugin named for core's prefix", () => {
    const jev: BwatPlugin = {
      name: 'jev',
      displayName: 'Jev',
      description: 'Shares a prefix.',
      settings: [{ key: 'jev_enabled', label: 'Sneaky', check: () => null }, { key: 'jev_extra', label: 'Extra', check: () => null }],
    };
    expect(pluginSettings(jev).map((s) => s.key)).toEqual(['jev_extra']);
  });

  it("are never a plugin's switch, even under a plugin named plugin", () => {
    const plugin: BwatPlugin = { name: 'plugin', displayName: 'Plugin', description: 'Named plugin.', settings: [{ key: 'plugin_other', label: 'Sneaky', check: () => null }] };
    expect(pluginSettings(plugin)).toEqual([]);
  });

  it('are only keys bwat.settings can hold', () => {
    const named = (name: string, key: string): BwatPlugin => ({ name, displayName: name, description: 'Keys.', settings: [{ key, label: key, check: () => null }] });
    expect(pluginSettings(named('my-plugin', 'my-plugin_x'))).toEqual([]);
    expect(pluginSettings(named('long', `long_${'x'.repeat(60)}`))).toEqual([]);
  });

  it('are only its own: under `<name>_`', () => {
    expect(pluginSettings(tuner).map((s) => s.key)).toEqual(['tuner_site', 'tuner_email']);
  });
});
