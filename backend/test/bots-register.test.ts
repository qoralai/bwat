import { beforeAll, expect, it } from 'vitest';
import { digest, issueFleetCredential } from '../src/credentials.ts';
import { useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('POST /bots/register (QOR-4571)', () => {
  const t = useApp();
  let fleetToken: string;

  beforeAll(async () => {
    fleetToken = await issueFleetCredential(t.pool, 'test fleet');
  });

  const register = (authorization: string | undefined, payload: object = {}) =>
    t.app.inject({
      method: 'POST',
      url: '/bots/register',
      headers: authorization ? { authorization } : {},
      payload,
    });

  it('refuses a caller with no credential, a malformed one, or an unknown one', async () => {
    for (const auth of [undefined, 'Bearer', 'Basic abc', `Bearer ${fleetToken}x`, `Bearer bwf_${'A'.repeat(43)}`]) {
      const res = await register(auth);
      expect(res.statusCode, String(auth)).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('registers a bot with a fleet credential and hands it its own bot token, once', async () => {
    // An older bot may still send capabilities: accepted, and stored nowhere.
    const res = await register(`Bearer ${fleetToken}`, {
      version: '0.1.0',
      capabilities: { speech: false, sdk: '6.3' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.bot_token).toMatch(/^bwb_[A-Za-z0-9_-]{43}$/);

    const { rows } = await t.pool.query(`SELECT * FROM bots WHERE id = $1`, [body.bot_id]);
    expect(rows[0].version).toBe('0.1.0');
    expect(rows[0].ready_at).toBeNull();
    // Only the digest is kept.
    expect(rows[0].token_sha256).toEqual(digest(body.bot_token));
    expect(JSON.stringify(rows[0])).not.toContain(body.bot_token.slice(4));
  });

  it('takes the bot id from the credential, never from the body', async () => {
    const claimed = '00000000-0000-4000-8000-000000000001';
    const res = await register(`Bearer ${fleetToken}`, { bot_id: claimed, id: claimed });
    expect(res.statusCode).toBe(200);
    expect(res.json().bot_id).not.toBe(claimed);
  });

  it('gives each registration its own id and token', async () => {
    const a = (await register(`Bearer ${fleetToken}`)).json();
    const b = (await register(`Bearer ${fleetToken}`)).json();
    expect(a.bot_id).not.toBe(b.bot_id);
    expect(a.bot_token).not.toBe(b.bot_token);
  });

  it('does not take a bot token in place of the fleet credential', async () => {
    const { bot_token } = (await register(`Bearer ${fleetToken}`)).json();
    expect((await register(`Bearer ${bot_token}`)).statusCode).toBe(401);
  });

  it('keeps the ECS task ARN a hosted bot reads from its own task, so the fleet can protect that task (QOR-4888)', async () => {
    const arn = 'arn:aws:ecs:us-west-2:123456789012:task/bwat/0123456789abcdef0123456789abcdef';
    const res = await register(`Bearer ${fleetToken}`, { task_arn: arn });
    expect(res.statusCode).toBe(200);
    const { rows } = await t.pool.query(`SELECT task_arn, draining_at FROM bots WHERE id = $1`, [res.json().bot_id]);
    expect(rows[0]).toEqual({ task_arn: arn, draining_at: null });

    const none = (await register(`Bearer ${fleetToken}`)).json();
    expect((await t.pool.query(`SELECT task_arn FROM bots WHERE id = $1`, [none.bot_id])).rows[0].task_arn).toBeNull();
  });

  it('refuses a task ARN that is not an ECS task ARN (QOR-4888)', async () => {
    for (const task_arn of ['arn:aws:ecs:us-west-2:123456789012:service/bwat/0123456789abcdef', 'abc', 7]) {
      expect((await register(`Bearer ${fleetToken}`, { task_arn })).statusCode, String(task_arn)).toBe(400);
    }
  });
});
