import { expect, it } from 'vitest';
import { nextVersionStamp, problemsWith } from '../src/settings/dictionary.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { WORDS } from './words.ts';

it('refuses scopes and blank spellings that the bot cannot compile', () => {
  const target = { id: 'term', canonical: 'Bwat', hardness: 'hard', proper_noun: true };
  for (const scopes of [[], ['foo'], 'body', null]) {
    expect(problemsWith({ targets: [target], aliases: [{ alias: 'boat', target_id: 'term', scopes }] })).not.toEqual([]);
  }
  expect(problemsWith({ targets: [{ ...target, canonical: '  ' }], aliases: [] })).not.toEqual([]);
  expect(problemsWith({ targets: [target], aliases: [{ alias: 'boat', target_id: 'term', scopes: ['body'] }] })).toEqual([]);
});

describeDb('/console/corrections (QOR-4578)', () => {
  const t = useRoles();
  const get = (headers: Record<string, string> = MEMBER) => t.app.inject({ method: 'GET', url: '/console/corrections', headers });
  const put = (payload: unknown, headers: Record<string, string> = MEMBER) =>
    t.app.inject({ method: 'PUT', url: '/console/corrections', headers, payload: payload as object });

  it('answers 401 to nobody signed in, both ways', async () => {
    expect((await get({})).statusCode).toBe(401);
    expect((await put({ expectedRevision: null, payload: WORDS }, {})).statusCode).toBe(401);
  });

  it('starts absent: bwat uses the dictionary it ships with', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      dictionary: { state: 'absent', revision: null, version: null, payload: null, updatedAt: null, updatedBy: null },
    });
  });

  it('refuses a payload that is not a dictionary, naming each problem, and saves nothing', async () => {
    const res = await put({
      expectedRevision: null,
      payload: { targets: [{ id: 'a', canonical: 'A', hardness: 'hard', proper_noun: true }], aliases: [{ alias: 'ay', target_id: 'nope' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_dictionary', problems: ['"ay" points at a word that is not in the list.'] });
    expect((await put({ expectedRevision: null, payload: [] })).json().error).toBe('invalid_dictionary');
    for (const expectedRevision of ['one', 0, 1.5, 2_147_483_648]) {
      expect((await put({ expectedRevision, payload: WORDS })).json(), String(expectedRevision)).toEqual({ error: 'invalid_revision' });
    }
    expect((await get()).json().dictionary.state).toBe('absent');
  });

  it('refuses a payload over 256 KiB with 413', async () => {
    const big = { ...WORDS, padding: 'x'.repeat(256 * 1024) };
    const res = await put({ expectedRevision: null, payload: big });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
  });

  it('refuses a request over 300 KiB with the same 413, before reading it', async () => {
    const res = await put({ expectedRevision: null, payload: { ...WORDS, padding: 'x'.repeat(300 * 1024) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
  });

  it('saves the first dictionary at revision 1, as sent, with a dated version the server stamps', async () => {
    const res = await put({ expectedRevision: null, payload: { ...WORDS, version: 'from-the-browser' } });
    expect(res.statusCode).toBe(200);
    const { dictionary } = res.json();
    const today = new Date().toISOString().slice(0, 10);
    expect(dictionary).toMatchObject({ state: 'set', revision: 1, version: `${today}.1`, updatedBy: MEMBER_ID });
    expect(dictionary.payload).toEqual({ ...WORDS, version: `${today}.1` });
  });

  it('refuses a save based on an old revision with 409 and the current one', async () => {
    const res = await put({ expectedRevision: null, payload: WORDS }, ADMIN);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevision: 1 });
    expect((await get()).json().dictionary.revision).toBe(1);
  });

  it('clears it with a null payload at the next revision, and the next save starts a new stamp', async () => {
    const cleared = await put({ expectedRevision: 1, payload: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().dictionary).toMatchObject({ state: 'cleared', revision: 2, version: null, payload: null });
    const again = await put({ expectedRevision: 2, payload: WORDS });
    expect(again.json().dictionary).toMatchObject({ state: 'set', revision: 3 });
  });

  it('bumps the settings version the bots report on every save, and not on a stale one', async () => {
    const version = async () => (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settingsVersion;
    const before = await version();
    expect((await put({ expectedRevision: 3, payload: { ...WORDS, extra: 1 } })).statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
    expect((await put({ expectedRevision: 3, payload: WORDS })).statusCode).toBe(409);
    expect(await version()).toBe(before + 1);
    expect((await put({ expectedRevision: 4, payload: WORDS })).statusCode).toBe(200);
  });

  it('audits each save by revision and version only, never the words', async () => {
    const { rows } = await t.pool.query(`SELECT actor_id AS actor, action, before, after FROM audit WHERE target_type = 'dictionary' ORDER BY at`);
    expect(rows.map((r) => [r.action, r.before?.revision ?? null, r.after.revision, r.after.state])).toEqual([
      ['dictionary.updated', null, 1, 'set'],
      ['dictionary.updated', 1, 2, 'cleared'],
      ['dictionary.updated', 2, 3, 'set'],
      ['dictionary.updated', 3, 4, 'set'],
      ['dictionary.updated', 4, 5, 'set'],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Zedekiah|be what|Bwat/);
  });
});

it('stamps versions by UTC date, counting up within a day and restarting the next (QOR-4578)', () => {
  const now = new Date('2026-10-01T23:00:00Z');
  expect(nextVersionStamp(null, now)).toBe('2026-10-01.1');
  expect(nextVersionStamp('2026-10-01.1', now)).toBe('2026-10-01.2');
  expect(nextVersionStamp('2026-09-30.7', now)).toBe('2026-10-01.1');
  expect(nextVersionStamp('2026-10-01.9007199254740993', now)).toBe('2026-10-01.9007199254740994');
  expect(nextVersionStamp('2026-10-01.x', now)).toBe('2026-10-01.1');
});

describeDb('/console/corrections, two first saves at once (QOR-4578)', () => {
  const t = useRoles();

  it('makes the one that loses the race to insert stale, not revision 2', async () => {
    const other = await t.db.connect('runtime');
    try {
      await other.query('BEGIN');
      await other.query(`INSERT INTO bwat.dictionary (payload, revision, updated_by) VALUES ('null', 1, gen_random_uuid())`);
      const racing = t.app.inject({ method: 'PUT', url: '/console/corrections', headers: MEMBER, payload: { expectedRevision: null, payload: WORDS } });
      const blocked = `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      while ((await t.pool.query(blocked)).rowCount === 0) await new Promise((r) => setTimeout(r, 10));
      await other.query('COMMIT');
      const res = await racing;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'stale', currentRevision: 1 });
    } finally {
      await other.end();
    }
  });
});
