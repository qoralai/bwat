import type { FastifyRequest } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { AuthenticatePerson } from '../src/people-auth.ts';
import { inviteMember, signIn, type Role } from '../src/members.ts';
import { race, useApp, type TestApp } from './app.ts';
import { describeDb } from './db/harness.ts';

/** Signs in as whichever member id follows `Member `: the routes' own checks are under test. */
const asMember: AuthenticatePerson = async (req: FastifyRequest) => {
  const id = req.headers.authorization?.match(/^Member (\S+)$/)?.[1];
  return id ? { id } : null;
};
const as = (id: string) => ({ authorization: `Member ${id}` });
const NOBODY = '00000000-0000-4000-8000-000000000000';

/** The routes' own checks under test, with example.com in BWAT_ALLOWED_DOMAINS (D146). */
const ALLOWED = { authenticatePerson: asMember, allowedDomains: ['example.com'] };

/** Every test starts from one owner, one admin and one member, each of whom has signed in (activated). */
function useMembers(t: TestApp) {
  const ids = {} as Record<Role, string>;
  beforeEach(async () => {
    await t.pool.query('DELETE FROM members');
    await t.pool.query('DELETE FROM removed_members');
    for (const role of ['owner', 'admin', 'member'] as Role[]) {
      const { rows } = await t.pool.query<{ id: string }>(
        `INSERT INTO members (email, display_name, role, activated_at) VALUES ($1, $2, $3, now()) RETURNING id`,
        [`${role}@example.com`, `The ${role}`, role],
      );
      ids[role] = rows[0]!.id;
    }
  });
  return ids;
}

describeDb('GET /me and GET /members (QOR-4575)', () => {
  const t = useApp(ALLOWED);
  const ids = useMembers(t);

  it('answers the signed-in member', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/me', headers: as(ids.admin) });
    expect(res.statusCode).toBe(200);
    // Exactly these four (D144 gap 8): no Zoom identity, no timestamps.
    expect(res.json()).toEqual({ id: ids.admin, email: 'admin@example.com', display_name: 'The admin', role: 'admin' });
  });

  it('answers 401 to nobody, to a removed member and to an id that is not a member id', async () => {
    for (const headers of [{}, as(NOBODY), as('test-person')]) {
      for (const url of ['/me', '/members']) {
        const res = await t.app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.json()).toEqual({ error: 'unauthorized' });
      }
    }
  });

  it('lists every member to any member, by email', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/members', headers: as(ids.member) });
    expect(res.statusCode).toBe(200);
    expect(res.json().members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['admin@example.com', 'admin'],
      ['member@example.com', 'member'],
      ['owner@example.com', 'owner'],
    ]);
  });
});

describeDb('the panel stays closed until onboarding: no owner, no people route but GET /me (D149)', () => {
  const t = useApp(ALLOWED);
  let memberId: string;
  beforeEach(async () => {
    await t.pool.query('DELETE FROM members');
    await t.pool.query('DELETE FROM removed_members');
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO members (email, display_name, role) VALUES ('member@example.com', 'The member', 'admin') RETURNING id`,
    );
    memberId = rows[0]!.id;
  });
  const routes = () =>
    [
      { method: 'GET', url: '/members' },
      { method: 'POST', url: '/members', payload: { email: 'x@example.com' } },
      { method: 'PATCH', url: `/members/${memberId}`, payload: { role: 'member' } },
      { method: 'DELETE', url: `/members/${memberId}` },
      { method: 'POST', url: '/allocations', payload: { zoom_url: 'https://zoom.us/j/123456789' } },
      { method: 'GET', url: '/allocations' },
      { method: 'PATCH', url: '/allocations/00000000-0000-4000-8000-000000000000', payload: { recall: true } },
      { method: 'GET', url: '/fleet' },
    ] as const;

  it('answers 403 not_onboarded to every people route but GET /me, and changes nothing', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: as(memberId) })).statusCode).toBe(200);
    for (const route of routes()) {
      const res = await t.app.inject({ ...route, headers: as(memberId) });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(res.json()).toEqual({ error: 'not_onboarded' });
    }
    expect((await t.pool.query(`SELECT email, role FROM members`)).rows).toEqual([
      { email: 'member@example.com', role: 'admin' },
    ]);
    expect((await t.pool.query(`SELECT 1 FROM claims`)).rowCount).toBe(0);
  });

  it('still answers 401 first to nobody', async () => {
    for (const route of [{ method: 'GET', url: '/me' } as const, ...routes()]) {
      expect((await t.app.inject(route)).statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('opens once an activated owner exists: an owner who has never signed in does not count', async () => {
    await t.pool.query(`INSERT INTO members (email, role) VALUES ('owner@example.com', 'owner')`);
    const res = await t.app.inject({ method: 'GET', url: '/members', headers: as(memberId) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_onboarded' });
    await t.pool.query(`UPDATE members SET activated_at = now() WHERE email = 'owner@example.com'`);
    expect((await t.app.inject({ method: 'GET', url: '/members', headers: as(memberId) })).statusCode).toBe(200);
  });
});

/** The audit entries about one member, oldest first. */
const auditOf = (t: TestApp, targetId: string) =>
  t.pool
    .query(`SELECT actor_id, action, target_type, before, after FROM audit WHERE target_id = $1 ORDER BY at, id`, [
      targetId,
    ])
    .then((r) => r.rows);

describeDb('POST /members: invite by email (QOR-4575)', () => {
  const t = useApp(ALLOWED);
  const ids = useMembers(t);
  const invite = (by: string, payload: object) =>
    t.app.inject({ method: 'POST', url: '/members', headers: as(by), payload });

  it('lets an admin invite a member by email, stored lower-cased, and audits it', async () => {
    const res = await invite(ids.admin, { email: 'New.Person@Example.com', display_name: 'New Person' });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ email: 'new.person@example.com', display_name: 'New Person', role: 'member' });
    expect(await auditOf(t, created.id)).toEqual([
      { actor_id: ids.admin, action: 'member.invited', target_type: 'member', before: null, after: { role: 'member' } },
    ]);
  });

  it('invites as admin when asked; only an owner may invite an owner', async () => {
    expect((await invite(ids.admin, { email: 'a2@example.com', role: 'admin' })).json().role).toBe('admin');
    const refused = await invite(ids.admin, { email: 'o2@example.com', role: 'owner' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'owner_required' });
    expect((await invite(ids.owner, { email: 'o2@example.com', role: 'owner' })).statusCode).toBe(201);
  });

  it('refuses a plain member', async () => {
    const res = await invite(ids.member, { email: 'x@example.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await t.pool.query(`SELECT 1 FROM members WHERE email = 'x@example.com'`)).rowCount).toBe(0);
  });

  it('answers 409 domain_not_allowed for an email outside BWAT_ALLOWED_DOMAINS, which could never sign in (D146)', async () => {
    for (const [email, role] of [
      ['someone@gmail.com', 'owner'],
      ['someone@gmail.com', 'admin'],
      ['someone@gmail.com', 'member'],
      ['someone@example.com.evil.example', 'owner'],
      ['someone@sub.example.com', 'member'],
    ] as const) {
      const res = await invite(ids.owner, { email, role });
      expect(res.statusCode, `${email} ${role}`).toBe(409);
      expect(res.json()).toEqual({ error: 'domain_not_allowed' });
    }
    const allowed = await invite(ids.owner, { email: 'Someone@EXAMPLE.com', role: 'owner' });
    expect(allowed.statusCode).toBe(201);
    // Nothing was added for the refused ones.
    expect((await t.pool.query(`SELECT email FROM members WHERE email LIKE 'someone@%'`)).rows).toEqual([
      { email: 'someone@example.com' },
    ]);
    expect(await auditOf(t, allowed.json().id)).toHaveLength(1);
  });

  it('refuses every invite when no domain is allowed: nobody invited could sign in', async () => {
    expect(await inviteMember(t.pool, ids.owner, { email: 'x@example.com', role: 'member' }, [])).toEqual({
      refused: 'domain_not_allowed',
    });
  });

  it('answers 409 for an email that is already a member, whatever its case', async () => {
    const res = await invite(ids.admin, { email: 'Member@Example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'member_exists' });
  });

  it('answers 400 for a body that is not an invite', async () => {
    for (const payload of [
      {},
      { email: 'not-an-email' },
      { email: 'y@example.com', role: 'root' },
      { email: 'y@example.com', workspace_id: NOBODY },
      { email: `${'y'.repeat(320)}@example.com` },
    ]) {
      const res = await invite(ids.admin, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_body' });
    }
  });
});

describeDb('PATCH /members/{id}: change a role (QOR-4575)', () => {
  const t = useApp(ALLOWED);
  const ids = useMembers(t);
  const patch = (by: string, id: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url: `/members/${id}`, headers: as(by), payload });

  it('lets an admin make a member an admin, and audits the before and after', async () => {
    const res = await patch(ids.admin, ids.member, { role: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ids.member, role: 'admin' });
    expect(await auditOf(t, ids.member)).toEqual([
      {
        actor_id: ids.admin,
        action: 'member.role_changed',
        target_type: 'member',
        before: { role: 'member' },
        after: { role: 'admin' },
      },
    ]);
  });

  it('lets only an owner grant or take away ownership', async () => {
    for (const [target, role] of [
      [ids.member, 'owner'],
      [ids.owner, 'admin'],
    ] as const) {
      const res = await patch(ids.admin, target, { role });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'owner_required' });
    }
    expect((await patch(ids.owner, ids.admin, { role: 'owner' })).json().role).toBe('owner');
    expect((await patch(ids.admin, ids.owner, { role: 'member' })).json().role).toBe('member');
  });

  it('grants ownership only to an email in BWAT_ALLOWED_DOMAINS: 409 domain_not_allowed (D146)', async () => {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO members (email, role) VALUES ('someone@gmail.com', 'member') RETURNING id`,
    );
    const res = await patch(ids.owner, rows[0]!.id, { role: 'owner' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'domain_not_allowed' });
    // Any other role is still the admins' to give.
    expect((await patch(ids.owner, rows[0]!.id, { role: 'admin' })).json().role).toBe('admin');
    expect(await auditOf(t, rows[0]!.id)).toHaveLength(1);
  });

  it('keeps the last activated owner: an owner who never signed in is no successor; once it has, the old owner may step down', async () => {
    const invited = await t.app.inject({
      method: 'POST',
      url: '/members',
      headers: as(ids.owner),
      payload: { email: 'successor@example.com', role: 'owner' },
    });
    expect(invited.statusCode).toBe(201);
    for (const step of [
      () => patch(ids.owner, ids.owner, { role: 'member' }),
      () => t.app.inject({ method: 'DELETE', url: `/members/${ids.owner}`, headers: as(ids.owner) }),
    ]) {
      const res = await step();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'last_owner' });
    }
    // The successor signs in: activated, so the install stays owned without the old owner.
    expect(await signIn(t.pool, { email: 'successor@example.com', sub: 'sub-successor' })).toMatchObject({
      member: { id: invited.json().id, role: 'owner' },
    });
    expect((await patch(ids.owner, ids.owner, { role: 'member' })).json().role).toBe('member');
  });

  it('never demotes the last owner, so there is always an owner and an admin', async () => {
    for (const role of ['admin', 'member']) {
      const res = await patch(ids.owner, ids.owner, { role });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'last_owner' });
    }
    expect(await auditOf(t, ids.owner)).toEqual([]);
    await patch(ids.owner, ids.admin, { role: 'owner' });
    expect((await patch(ids.owner, ids.owner, { role: 'member' })).json().role).toBe('member');
  });

  it('keeps one owner when two owners demote each other at once', async () => {
    await patch(ids.owner, ids.admin, { role: 'owner' });
    const [a, b] = await race(t.db, [
      () => patch(ids.owner, ids.admin, { role: 'member' }),
      () => patch(ids.admin, ids.owner, { role: 'member' }),
    ]);
    // Whoever goes second is no longer an owner, so cannot take ownership away.
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 403]);
    const owners = await t.pool.query(`SELECT 1 FROM members WHERE role = 'owner'`);
    expect(owners.rowCount).toBe(1);
  });

  it('changes nothing and audits nothing when the role is already that', async () => {
    expect((await patch(ids.admin, ids.member, { role: 'member' })).statusCode).toBe(200);
    expect(await auditOf(t, ids.member)).toEqual([]);
  });

  it('refuses a plain member, an unknown member and a body that is not a role', async () => {
    expect((await patch(ids.member, ids.member, { role: 'admin' })).statusCode).toBe(403);
    for (const id of [NOBODY, 'not-a-uuid']) {
      const res = await patch(ids.admin, id, { role: 'admin' });
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    for (const payload of [{}, { role: 'root' }, { role: 'admin', email: 'x@example.com' }]) {
      expect((await patch(ids.admin, ids.member, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await t.pool.query(`SELECT role FROM members WHERE id = $1`, [ids.member])).rows[0].role).toBe('member');
  });
});

describeDb('DELETE /members/{id} (QOR-4575)', () => {
  const t = useApp(ALLOWED);
  const ids = useMembers(t);
  const remove = (by: string, id: string) => t.app.inject({ method: 'DELETE', url: `/members/${id}`, headers: as(by) });

  it('lets an admin remove a member, who can no longer sign in, and audits it', async () => {
    const res = await remove(ids.admin, ids.member);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: as(ids.member) })).statusCode).toBe(401);
    expect(await auditOf(t, ids.member)).toEqual([
      { actor_id: ids.admin, action: 'member.removed', target_type: 'member', before: { role: 'member' }, after: null },
    ]);
  });

  it('lets only an owner remove an owner, and never the last one', async () => {
    const byAdmin = await remove(ids.admin, ids.owner);
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toEqual({ error: 'owner_required' });
    const last = await remove(ids.owner, ids.owner);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: 'last_owner' });
    await t.app.inject({ method: 'PATCH', url: `/members/${ids.admin}`, headers: as(ids.owner), payload: { role: 'owner' } });
    expect((await remove(ids.owner, ids.owner)).statusCode).toBe(204);
  });

  it('keeps one owner when two owners remove each other at once', async () => {
    await t.app.inject({ method: 'PATCH', url: `/members/${ids.admin}`, headers: as(ids.owner), payload: { role: 'owner' } });
    const results = await race(t.db, [() => remove(ids.owner, ids.admin), () => remove(ids.admin, ids.owner)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 403]);
    expect((await t.pool.query(`SELECT 1 FROM members WHERE role = 'owner'`)).rowCount).toBe(1);
  });

  it('refuses a plain member and an unknown member', async () => {
    expect((await remove(ids.member, ids.admin)).statusCode).toBe(403);
    expect((await remove(ids.admin, NOBODY)).statusCode).toBe(404);
    expect((await t.pool.query(`SELECT 1 FROM members`)).rowCount).toBe(3);
  });
});
