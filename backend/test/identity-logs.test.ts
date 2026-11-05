import { expect, it } from 'vitest';
import { jwksKeys } from '../src/jwks.ts';
import { peopleAuth } from '../src/people-auth.ts';
import { buildServer } from '../src/server.ts';
import { createPool } from '../src/db/pool.ts';
import { apiBase } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { CLIENT_ID, idToken, jwksFetch, newSigningKey } from './google-fixture.ts';

describeDb('identity through the server, and what it logs (QOR-4575)', () => {
  const db = useTestDb();

  it('signs in with Google, claims the owner (D149), runs every member route, and logs no email, name, id token or Zoom id', async () => {
    const lines: string[] = [];
    const key = newSigningKey('kid-1');
    const pool = createPool(db.url('runtime'));
    const auth = peopleAuth(
      pool,
      { googleClientIds: [CLIENT_ID], allowedDomains: ['example.com'] },
      { keys: jwksKeys({ fetch: jwksFetch(() => [key]).fetch }) },
    );
    const app = apiBase(
      buildServer({
        pool,
        authenticatePerson: auth,
        allowedDomains: ['example.com'],
        logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
      }),
    );
    try {
      // Each account's Google sub: digits, as Google's are, so the leak check below cannot lean on 'leaky'.
      const subs = { owner: '109876543210987654321', invitee: '108765432109876543210', other: '107654321098765432109' };
      const ownerToken = idToken(key, { email: 'Leaky.Owner@Example.com', name: 'Leaky Owner', sub: subs.owner });
      const owner = { authorization: `Bearer ${ownerToken}` };
      const me = await app.inject({ method: 'GET', url: '/me', headers: owner });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email: 'leaky.owner@example.com', role: 'owner' });

      const invited = await app.inject({
        method: 'POST',
        url: '/members',
        headers: owner,
        payload: { email: 'leaky.invitee@example.com', display_name: 'Leaky Invitee' },
      });
      expect(invited.statusCode).toBe(201);
      const id = invited.json().id;
      const invitee = { authorization: `Bearer ${idToken(key, { email: 'leaky.invitee@example.com', sub: subs.invitee })}` };
      expect((await app.inject({ method: 'GET', url: '/members', headers: invitee })).statusCode).toBe(200);
      // The same address from another Google account: refused.
      const reassigned = { authorization: `Bearer ${idToken(key, { email: 'leaky.invitee@example.com', sub: subs.other })}` };
      expect((await app.inject({ method: 'GET', url: '/me', headers: reassigned })).statusCode).toBe(401);
      const steps = [
        { method: 'PATCH', url: `/members/${id}`, payload: { role: 'admin' } },
        { method: 'PATCH', url: `/members/${id}?email=leaky.query@example.com`, payload: { role: 'member' } },
        { method: 'POST', url: '/members', payload: { email: 'leaky.invitee@example.com' } },
        { method: 'DELETE', url: `/members/${id}` },
      ] as const;
      const codes = [];
      for (const step of steps) codes.push((await app.inject({ ...step, headers: owner })).statusCode);
      expect(codes).toEqual([200, 200, 409, 204]);
      const stranger = { authorization: `Bearer ${idToken(key, { email: 'leaky.stranger@example.com', sub: subs.other })}` };
      expect((await app.inject({ method: 'GET', url: '/me', headers: stranger })).statusCode).toBe(200);
      const consumer = { authorization: `Bearer ${idToken(key, { email: 'leaky.gmail@gmail.com', hd: undefined })}` };
      expect((await app.inject({ method: 'GET', url: '/me', headers: consumer })).statusCode).toBe(401);

      const log = lines.join('');
      for (const event of ['member.owner_claimed', 'member.invited', 'member.role_changed', 'member.removed', 'member.change_refused', 'member.joined', 'auth.domain_refused', 'member.activated', 'auth.subject_mismatch']) {
        expect(log).toContain(`"event":"${event}"`);
      }
      for (const secret of ['leaky', 'Leaky', 'example.com', 'gmail', ownerToken.slice(0, 40), 'Bearer', ...Object.values(subs)]) {
        expect(log, secret).not.toContain(secret);
      }
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
