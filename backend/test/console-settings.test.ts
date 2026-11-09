import { expect, it } from 'vitest';
import { SETTINGS } from '../src/settings/catalogue.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, OWNER_ID, useRoles } from './people.ts';

describeDb('GET /console/settings (QOR-4578)', () => {
  const t = useRoles();
  const get = (headers: Record<string, string> = MEMBER) => t.app.inject({ method: 'GET', url: '/console/settings', headers });

  it('answers 401 to nobody signed in', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('shows a member every catalogue key, unset, with the settings version and no right to save', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settingsVersion).toBe(0);
    expect(body.canManage).toBe(false);
    expect(Object.keys(body.settings)).toEqual(SETTINGS.map((s) => s.key));
    expect(body.settings.display_name).toEqual({ value: null, default: 'bwat', revision: null, updatedAt: null, updatedBy: null });
    // The default is what applies while the key is unset, so the panel can show it.
    expect(body.settings.wait_for_start_min.default).toBe(10);
    // Off until an admin turns it on.
    expect(body.settings.auto_join_enabled.default).toBe(false);
    expect(body.settings.auto_join_require_host.default).toBe(true);
    // QOR-4760: transcripts are kept forever unless an admin turns it off.
    expect(body.settings.transcript_keep_forever.default).toBe(true);
  });

  it('tells an owner and an admin they can save (D141, D149)', async () => {
    expect((await get(ADMIN)).json().canManage).toBe(true);
    expect((await get(OWNER)).json().canManage).toBe(true);
  });

  it('carries the joining and retention keys, and none of the removed ones (QOR-4894)', () => {
    const keys = SETTINGS.map((s) => s.key);
    for (const key of ['auto_join_enabled', 'auto_join_require_host', 'transcript_retention_days', 'transcript_keep_forever']) {
      expect(keys).toContain(key);
    }
    for (const key of ['tts_voice', 'aura_color', 'timekeeper_enabled', 'follow_mode_enabled']) {
      expect(keys).not.toContain(key);
    }
  });
});

describeDb('PUT /console/settings/{section} (QOR-4578)', () => {
  const t = useRoles();
  const save = (section: string, changes: unknown, headers: Record<string, string> = ADMIN) =>
    t.app.inject({ method: 'PUT', url: `/console/settings/${section}`, headers, payload: { changes } });
  const revisionOf = async (key: string) =>
    (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settings[key].revision;
  const auditRows = async (target: string) =>
    (await t.pool.query(`SELECT actor_id AS actor, action, before, after FROM audit WHERE target_type = $1 ORDER BY at`, [target])).rows;

  it('refuses nobody (401) and a member (403), and writes nothing', async () => {
    const changes = { jev_enabled: { value: true, expectedRevision: null } };
    expect((await save('jev', changes, {})).statusCode).toBe(401);
    const res = await save('jev', changes, MEMBER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(await revisionOf('jev_enabled')).toBeNull();
  });

  it('answers 404 for a section that does not exist', async () => {
    const res = await save('voice', { display_name: { value: 'bwat', expectedRevision: null } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown_section' });
  });

  it('refuses unknown keys, keys of another section, bad values and a missing revision, all at once', async () => {
    const res = await save('joining', {
      nope: { value: 1, expectedRevision: null },
      tts_voice: { value: 'marin', expectedRevision: null },
      cards_granularity: { value: 'more', expectedRevision: null },
      idle_leave_min: { value: 0, expectedRevision: null },
      display_name: { value: 'bwat' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_settings',
      problems: [
        '"nope" is not a setting.',
        '"tts_voice" is not a setting.',
        '"cards_granularity" is not in the joining section.',
        'Leave after a silence of must be a whole number from 1 to 120.',
        '"display_name" needs a value and the revision it was read at.',
      ],
    });
    expect((await save('joining', {})).json()).toEqual({ error: 'invalid_settings', problems: ['Nothing to save.'] });
  });

  it('saves a first value at revision 1, normalised, bumps the settings version once and audits it', async () => {
    const res = await save('jev', {
      jev_model: { value: '  typesafe/jev-2  ', expectedRevision: null },
      jev_link_threshold_pct: { value: 40, expectedRevision: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.jev_model).toMatchObject({ value: 'typesafe/jev-2', revision: 1, updatedBy: ADMIN_ID });
    expect(body.settings.jev_link_threshold_pct).toMatchObject({ value: 40, revision: 1 });
    expect(body.settingsVersion).toBe(1);
    expect(await auditRows('settings:jev')).toEqual([
      {
        actor: ADMIN_ID,
        action: 'settings.updated',
        before: { jev_model: { value: null, revision: null }, jev_link_threshold_pct: { value: null, revision: null } },
        after: { jev_model: { value: 'typesafe/jev-2', revision: 1 }, jev_link_threshold_pct: { value: 40, revision: 1 } },
      },
    ]);
  });

  it('refuses the whole save with 409 when any key was changed since it was read, and writes none of it', async () => {
    await save('jev', { jev_enabled: { value: false, expectedRevision: null } });
    const version = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settingsVersion;
    const res = await save('jev', {
      jev_threshold_pct: { value: 50, expectedRevision: null },
      jev_enabled: { value: true, expectedRevision: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevisions: { jev_threshold_pct: null, jev_enabled: 1 } });
    const after = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json();
    expect(after.settings.jev_threshold_pct.revision).toBeNull();
    expect(after.settings.jev_enabled).toMatchObject({ value: false, revision: 1 });
    expect(after.settingsVersion).toBe(version);
  });

  it('stores a reset as JSON null in a kept row, at the next revision', async () => {
    await save('joining', { display_name: { value: '  Scribe ', expectedRevision: null } });
    const res = await save('joining', { display_name: { value: null, expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.display_name).toMatchObject({ value: null, revision: 2 });
    const { rows } = await t.pool.query(`SELECT value, revision FROM settings WHERE key = 'display_name'`);
    expect(rows).toEqual([{ value: null, revision: 2 }]);
    expect((await auditRows('settings:joining')).map((r) => r.after)).toEqual([
      { display_name: { value: 'Scribe', revision: 1 } },
      { display_name: { value: null, revision: 2 } },
    ]);
  });

  it('treats an unchanged value as no change: no write, no version bump, no audit', async () => {
    await save('retention', { transcript_retention_days: { value: 30, expectedRevision: null } });
    const before = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settingsVersion;
    const res = await save('retention', { transcript_retention_days: { value: 30, expectedRevision: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.transcript_retention_days.revision).toBe(1);
    expect(res.json().settingsVersion).toBe(before);
    expect(await auditRows('settings:retention')).toHaveLength(1);
  });

  it('makes a first save that raced another first save of the same key stale, not revision 2', async () => {
    // Another save of the key is in flight: it holds the settings lock and has written
    // its row, uncommitted.
    const other = await t.db.connect('runtime');
    try {
      await other.query('BEGIN');
      await other.query('SELECT version FROM bwat.settings_version FOR UPDATE');
      await other.query(`INSERT INTO bwat.settings (key, value, revision, updated_by) VALUES ('waiting_room_min', '7', 1, gen_random_uuid())`);
      const racing = save('joining', { waiting_room_min: { value: 9, expectedRevision: null } });
      // Wait until the PUT is blocked behind the other transaction, then let that commit.
      // (This database only: other suites share the server.)
      const blocked = `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      while ((await t.pool.query(blocked)).rowCount === 0) await new Promise((r) => setTimeout(r, 10));
      await other.query('COMMIT');
      const res = await racing;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'stale', currentRevisions: { waiting_room_min: 1 } });
    } finally {
      await other.end();
    }
    expect(await revisionOf('waiting_room_min')).toBe(1);
  });
});

describeDb('PUT /console/settings: one save across sections (QOR-4908)', () => {
  const t = useRoles();
  const save = (changes: unknown, headers: Record<string, string> = ADMIN) =>
    t.app.inject({ method: 'PUT', url: '/console/settings', headers, payload: { changes } });
  const read = async () => (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json();
  const auditRows = async () =>
    (await t.pool.query(`SELECT target_type AS target, after FROM audit WHERE action = 'settings.updated' ORDER BY target_type`)).rows;

  it('refuses a member (403) and writes nothing', async () => {
    const res = await save({ jev_enabled: { value: true, expectedRevision: null } }, MEMBER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await read()).settings.jev_enabled.revision).toBeNull();
  });

  it('saves keys of several sections at once: one version bump, one audit row per section', async () => {
    const res = await save({
      chat_posts_enabled: { value: false, expectedRevision: null },
      jev_enabled: { value: false, expectedRevision: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.chat_posts_enabled).toMatchObject({ value: false, revision: 1, updatedBy: ADMIN_ID });
    expect(body.settings.jev_enabled).toMatchObject({ value: false, revision: 1 });
    expect(body.settingsVersion).toBe(1);
    expect(await auditRows()).toEqual([
      { target: 'settings:behaviour', after: { chat_posts_enabled: { value: false, revision: 1 } } },
      { target: 'settings:jev', after: { jev_enabled: { value: false, revision: 1 } } },
    ]);
  });

  it('refuses the whole save with 409 when one key changed since it was read, and writes none of the other sections', async () => {
    await save({ bypass_waiting_room: { value: false, expectedRevision: null } });
    const before = await read();
    const res = await save({
      transcript_keep_forever: { value: false, expectedRevision: null },
      bypass_waiting_room: { value: true, expectedRevision: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevisions: { transcript_keep_forever: null, bypass_waiting_room: 1 } });
    const after = await read();
    expect(after.settings.transcript_keep_forever.revision).toBeNull();
    expect(after.settingsVersion).toBe(before.settingsVersion);
  });

  it('refuses bad values of any section, named, and writes nothing', async () => {
    const res = await save({
      transcript_keep_forever: { value: false, expectedRevision: null },
      idle_leave_min: { value: 0, expectedRevision: null },
      nope: { value: 1, expectedRevision: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_settings',
      problems: ['Leave after a silence of must be a whole number from 1 to 120.', '"nope" is not a setting.'],
    });
    expect((await read()).settings.transcript_keep_forever.revision).toBeNull();
  });
});

describeDb('PUT /console/settings/{section} by the owner (QOR-4578)', () => {
  const t = useRoles();

  it('lets an owner save, as an admin can (D141, D149)', async () => {
    const changes = { jev_enabled: { value: true, expectedRevision: null } };
    const res = await t.app.inject({ method: 'PUT', url: '/console/settings/jev', headers: OWNER, payload: { changes } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.jev_enabled.revision).toBe(1);
    const { rows } = await t.pool.query(`SELECT actor_id AS actor FROM audit WHERE target_type = 'settings:jev'`);
    expect(rows).toEqual([{ actor: OWNER_ID }]);
  });
});

describeDb('settings, corrections and model keys behind identity (QOR-4575, QOR-4578)', () => {
  const t = useRoles();
  const save = (headers: Record<string, string>) =>
    t.app.inject({ method: 'PUT', url: '/console/settings/jev', headers, payload: { changes: { jev_enabled: { value: true, expectedRevision: null } } } });

  it("reads an admin's role fresh: one demoted to member is refused at once, and canManage says so", async () => {
    await t.pool.query(`UPDATE members SET role = 'member' WHERE id = $1`, [ADMIN_ID]);
    try {
      expect((await save(ADMIN)).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN })).json().canManage).toBe(false);
    } finally {
      await t.pool.query(`UPDATE members SET role = 'admin' WHERE id = $1`, [ADMIN_ID]);
    }
    expect((await save(ADMIN)).statusCode).toBe(200);
  });

  it('answers 403 not_onboarded on every route while the install has no activated owner (D149)', async () => {
    await t.pool.query(`UPDATE members SET activated_at = NULL WHERE role = 'owner'`);
    try {
      for (const [method, url] of [
        ['GET', '/console/settings'],
        ['PUT', '/console/settings/jev'],
        ['GET', '/console/corrections'],
        ['GET', '/console/model-keys'],
      ] as const) {
        const res = await t.app.inject({ method, url, headers: OWNER, payload: {} });
        expect(res.statusCode, url).toBe(403);
        expect(res.json(), url).toEqual({ error: 'not_onboarded' });
      }
    } finally {
      await t.pool.query(`UPDATE members SET activated_at = now() WHERE role = 'owner'`);
    }
  });
});
