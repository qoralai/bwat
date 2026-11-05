import { expect, it } from 'vitest';
import { issueInstallCredential } from '../src/credentials.ts';
import { bearer } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, useRoles } from './people.ts';

// QOR-4334: the admin panel's "Finish setting up" list. The onboarding page sends its
// unfinished steps under its own credential; an owner or admin ticks them off.

const ITEMS = [
  { id: 'zoom-board', title: 'Create the board app', detail: 'From the setup page.', link: 'https://github.com/qoralai/bwat/blob/main/docs/onboarding.md' },
  { id: 'first-meeting', title: 'Hold your first meeting', detail: '', link: null },
];

describeDb('the "Finish setting up" list (QOR-4334)', () => {
  const t = useRoles();
  const put = (token: string, body: unknown) => t.app.inject({ method: 'PUT', url: '/install/checklist', headers: bearer(token), payload: body as object });
  const list = (headers: Record<string, string> = ADMIN) => t.app.inject({ method: 'GET', url: '/setup-checklist', headers });

  it('takes the page\'s unfinished steps, in its order, and shows them to an admin', async () => {
    const token = await issueInstallCredential(t.pool);
    expect((await put(token, { items: ITEMS })).statusCode).toBe(204);
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { ...ITEMS[0], done_at: null, done_by: null },
      { ...ITEMS[1], done_at: null, done_by: null },
    ]);
    expect((await list(OWNER)).statusCode).toBe(200);
  });

  it('lets an admin tick an item off, once, audited with who did it', async () => {
    const token = await issueInstallCredential(t.pool);
    await put(token, { items: ITEMS });
    const done = await t.app.inject({ method: 'POST', url: '/setup-checklist/zoom-board/done', headers: ADMIN });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: 'zoom-board', done_by: ADMIN_ID });
    const first = done.json().done_at;
    const again = await t.app.inject({ method: 'POST', url: '/setup-checklist/zoom-board/done', headers: OWNER });
    expect(again.json()).toMatchObject({ done_at: first, done_by: ADMIN_ID });
    const { rows } = await t.pool.query(`SELECT actor_id, action, after FROM audit WHERE action = 'setup_checklist.done' ORDER BY at`);
    expect(rows[0]).toEqual({ actor_id: ADMIN_ID, action: 'setup_checklist.done', after: { id: 'zoom-board' } });
    expect((await t.app.inject({ method: 'POST', url: '/setup-checklist/nope/done', headers: ADMIN })).statusCode).toBe(404);
  });

  it('replaces the list when the page sends it again, keeping a tick on a step still listed', async () => {
    const token = await issueInstallCredential(t.pool);
    await put(token, { items: ITEMS });
    await t.app.inject({ method: 'POST', url: '/setup-checklist/first-meeting/done', headers: ADMIN });
    await put(token, { items: [ITEMS[1], { id: 'share', title: 'Share bwat with the team', detail: '', link: null }] });
    const items = (await list()).json().items;
    expect(items.map((i: { id: string }) => i.id)).toEqual(['first-meeting', 'share']);
    expect(items[0].done_by).toBe(ADMIN_ID);
  });

  it('is closed to a member, and to anyone without a person\'s sign-in', async () => {
    expect((await list(MEMBER)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/setup-checklist/zoom-board/done', headers: MEMBER })).statusCode).toBe(403);
    const token = await issueInstallCredential(t.pool);
    expect((await list(bearer(token))).statusCode).toBe(401);
  });

  it('takes the list only from the page\'s credential, and only in the table\'s shape', async () => {
    const token = await issueInstallCredential(t.pool);
    expect((await t.app.inject({ method: 'PUT', url: '/install/checklist', headers: ADMIN, payload: { items: ITEMS } })).statusCode).toBe(401);
    for (const bad of [{}, { items: 'x' }, { items: [{ id: 'Bad Id', title: 't' }] }, { items: [{ id: 'a', title: '' }] },
      { items: [{ id: 'a', title: 't', link: 'http://plain.example' }] }, { items: [{ id: 'a', title: 't' }, { id: 'a', title: 't' }] }]) {
      expect((await put(token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});
