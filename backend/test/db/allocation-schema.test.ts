import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CHECK_VIOLATION, describeDb, INSUFFICIENT_PRIVILEGE, sqlstate, UNDEFINED_COLUMN, UNIQUE_VIOLATION, useTestDb } from './harness.ts';

describeDb('allocation tables and what the runtime role may do with them (QOR-4571)', () => {
  const db = useTestDb();
  let runtime: pg.Client;
  let fleetId: string;
  let botA: string;
  let botB: string;

  beforeAll(async () => {
    runtime = await db.connect('runtime');
    await runtime.query('SET search_path = bwat');
  });

  afterAll(async () => {
    await runtime?.end();
  });

  it('can issue and read fleet credentials, but never change or delete one', async () => {
    const { rows } = await runtime.query<{ id: string }>(
      `INSERT INTO fleet_credentials (token_sha256, label) VALUES (sha256('f1'), 'test') RETURNING id`,
    );
    fleetId = rows[0]!.id;
    expect(await sqlstate(runtime, `SELECT id FROM fleet_credentials`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE fleet_credentials SET label = 'x'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DELETE FROM fleet_credentials`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('can register bots and update them, but never delete one', async () => {
    const insert = `INSERT INTO bots (fleet_credential_id, token_sha256) VALUES ($1, sha256($2)) RETURNING id`;
    botA = (await runtime.query<{ id: string }>(insert, [fleetId, Buffer.from('a')])).rows[0]!.id;
    botB = (await runtime.query<{ id: string }>(insert, [fleetId, Buffer.from('b')])).rows[0]!.id;
    expect(await sqlstate(runtime, `UPDATE bots SET ready_at = now() WHERE id = $1`, [botA])).toBe('ok');
    expect(await sqlstate(runtime, `DELETE FROM bots`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps no bot capabilities: nothing read them (QOR-4961)', async () => {
    expect(await sqlstate(runtime, `SELECT capabilities FROM bots`)).toBe(UNDEFINED_COLUMN);
  });

  it('can open and move claims, but never delete one (ended claims are tombstones)', async () => {
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number) VALUES ('123456789')`)).toBe('ok');
    expect(await sqlstate(runtime, `UPDATE claims SET state = 'claimed', bot_id = $1`, [botA])).toBe('ok');
    expect(await sqlstate(runtime, `DELETE FROM claims`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot change the tables themselves', async () => {
    expect(await sqlstate(runtime, `ALTER TABLE claims ADD COLUMN sneaky text`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `TRUNCATE claims`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(runtime, `DROP TABLE bots`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('holds one open claim per meeting, and opens a new one once the old one has ended', async () => {
    // 123456789 is open (claimed by botA) from the test above.
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number) VALUES ('123456789')`)).toBe(UNIQUE_VIOLATION);
    await runtime.query(`UPDATE claims SET state = 'done', ended_at = now() WHERE meeting_number = '123456789'`);
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number) VALUES ('123456789')`)).toBe('ok');
  });

  it('gives a bot one live meeting at a time', async () => {
    await runtime.query(`INSERT INTO claims (meeting_number, state, bot_id) VALUES ('2223334445', 'claimed', $1)`, [botB]);
    expect(
      await sqlstate(runtime, `INSERT INTO claims (meeting_number, state, bot_id) VALUES ('3334445556', 'attending', $1)`, [
        botB,
      ]),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('accepts only the known claim states and a 9-12 digit meeting number', async () => {
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number, state) VALUES ('4445556667', 'lost')`)).toBe(
      CHECK_VIOLATION,
    );
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number) VALUES ('12345678')`)).toBe(CHECK_VIOLATION);
    expect(await sqlstate(runtime, `INSERT INTO claims (meeting_number) VALUES ('1234567890123')`)).toBe(CHECK_VIOLATION);
  });

  it('stores credentials as sha256 digests, one per token', async () => {
    expect(await sqlstate(runtime, `INSERT INTO fleet_credentials (token_sha256) VALUES ('short')`)).toBe(CHECK_VIOLATION);
    expect(await sqlstate(runtime, `INSERT INTO fleet_credentials (token_sha256) VALUES (sha256('f1'))`)).toBe(
      UNIQUE_VIOLATION,
    );
  });
});
