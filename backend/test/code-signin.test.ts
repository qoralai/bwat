import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { endCodeSignIn, normaliseCode } from '../src/code-signin.ts';
import { normalEmail } from '../src/members.ts';
import { createPool } from '../src/db/pool.ts';
import { nobodySignedIn, peopleAuthConfig } from '../src/people-auth.ts';
import { buildServer } from '../src/server.ts';
import { apiBase } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';

const CODE = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789';
const sha = (code: string) => createHash('sha256').update(normaliseCode(code)).digest();
const OWNER = 'owner@home.example';

describe('peopleAuthConfig on a local install (QOR-5007, D202)', () => {
  const hex = sha(CODE).toString('hex');
  it('starts a production build with the code and no Google', () => {
    const config = peopleAuthConfig({ NODE_ENV: 'production', BWAT_TIER: 'local', BWAT_SIGNIN_CODE_SHA256: hex });
    expect(config.tier).toBe('local');
    expect(config.codeDigest?.toString('hex')).toBe(hex);
  });

  it('reads t0, the tier\'s name before QOR-5117, as local', () => {
    expect(peopleAuthConfig({ NODE_ENV: 'production', BWAT_TIER: 't0', BWAT_SIGNIN_CODE_SHA256: hex }).tier).toBe('local');
  });

  it('refuses local without the code: nobody could sign in', () => {
    expect(() => peopleAuthConfig({ NODE_ENV: 'production', BWAT_TIER: 'local' })).toThrow('BWAT_SIGNIN_CODE_SHA256 is required when BWAT_TIER=local');
  });

  it('refuses the code beside Google: never a second way into an install with Google', () => {
    for (const google of [{ BWAT_GOOGLE_CLIENT_IDS: 'web.example' }, { BWAT_ALLOWED_DOMAINS: 'example.com' }]) {
      expect(() => peopleAuthConfig({ BWAT_TIER: 'local', BWAT_SIGNIN_CODE_SHA256: hex, ...google })).toThrow(/signs in with the code only/);
    }
  });

  it('refuses the code on any other tier, or with no tier', () => {
    for (const tier of ['team', 'zoom-board', 'production', undefined]) {
      expect(() => peopleAuthConfig({ BWAT_TIER: tier, BWAT_SIGNIN_CODE_SHA256: hex }), String(tier)).toThrow(
        'BWAT_SIGNIN_CODE_SHA256 is refused unless BWAT_TIER=local',
      );
    }
  });

  it('still requires Google on a production build of any other tier', () => {
    expect(() => peopleAuthConfig({ NODE_ENV: 'production', BWAT_TIER: 'team' })).toThrow('BWAT_ALLOWED_DOMAINS is required when NODE_ENV=production');
  });

  it('refuses the digest of an empty code: any input would match it', () => {
    expect(() => peopleAuthConfig({ BWAT_TIER: 'local', BWAT_SIGNIN_CODE_SHA256: sha('').toString('hex') })).toThrow(/digest of an empty code/);
  });

  it('refuses an unknown tier and a malformed digest', () => {
    expect(() => peopleAuthConfig({ BWAT_TIER: 'Local' })).toThrow('BWAT_TIER must be one of local, team, zoom-board, production');
    expect(() => peopleAuthConfig({ BWAT_TIER: 'local', BWAT_SIGNIN_CODE_SHA256: 'abc' })).toThrow('BWAT_SIGNIN_CODE_SHA256 must be 64 hex characters');
  });
});

describe('the code and the email as typed', () => {
  it('reads the code in any case, with or without its dashes and spaces', () => {
    expect(normaliseCode(' abcd efgh-jklm ')).toBe('ABCDEFGHJKLM');
  });
  it('takes one email address, lower-cased', () => {
    expect(normalEmail(' Ada@Example.COM ')).toBe('ada@example.com');
    for (const bad of ['', 'ada', 'ada@example', 'a@b.c,d@e.f', 'a b@c.de', 42, null]) expect(normalEmail(bad), String(bad)).toBeNull();
  });
});

describeDb('signing in with the install code (QOR-5007, D202)', () => {
  const db = useTestDb();
  let pool: pg.Pool;
  // The runtime role may not truncate: each test starts clean as the owner.
  let owner: pg.Pool;
  let app: FastifyInstance;
  // firstOwnerEmail null: no owner email named, so the first sign-in claims the owner.
  const serve = (code: string | null, firstOwnerEmail: string | null = OWNER) =>
    apiBase(buildServer({ pool, authenticatePerson: nobodySignedIn, ...(code && { codeSignIn: { codeDigest: sha(code), firstOwnerEmail: firstOwnerEmail ?? undefined } }) }));
  const signIn = (email: string, code = CODE, on = app) => on.inject({ method: 'POST', url: '/code-signin', payload: { code, email } });
  const me = (token: string, on = app) => on.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });

  beforeAll(() => {
    pool = createPool(db.url('runtime'));
    owner = createPool(db.url('owner'));
  });
  beforeEach(async () => {
    await app?.close();
    await owner.query(`TRUNCATE members, removed_members, code_sessions, zoom_board_sessions CASCADE`);
    app = serve(CODE);
  });
  afterAll(async () => {
    await app?.close();
    await pool.end();
    await owner.end();
  });

  it('refuses a wrong code, and says nothing about the email', async () => {
    const res = await signIn(OWNER, 'WRONG-CODE');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'wrong_code' });
    expect((await pool.query(`SELECT 1 FROM members`)).rowCount).toBe(0);
  });

  it('makes the owner of the owner email, in any case and with the code typed loosely', async () => {
    const res = await signIn('Owner@Home.Example', CODE.toLowerCase().replaceAll('-', ' '));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^bwz_/);
    expect(body.refresh_token).toMatch(/^bwr_/);
    expect(body.member).toMatchObject({ email: OWNER, role: 'owner' });
    expect((await me(body.token)).json()).toMatchObject({ email: OWNER, role: 'owner' });
  });

  it('makes anyone else a member under the email they type: the code holder is trusted', async () => {
    await signIn(OWNER);
    const res = await signIn('teammate@anywhere.example');
    expect(res.json().member).toMatchObject({ email: 'teammate@anywhere.example', role: 'member' });
    // The same email again is the same member.
    expect((await signIn('teammate@anywhere.example')).json().member.id).toBe(res.json().member.id);
    const { rows } = await pool.query(`SELECT email, joined_by_code FROM members ORDER BY email`);
    expect(rows).toEqual([
      { email: OWNER, joined_by_code: true },
      { email: 'teammate@anywhere.example', joined_by_code: true },
    ]);
  });

  it('gives the owner role to nobody else, even first', async () => {
    const res = await signIn('first@anywhere.example');
    expect(res.json().member.role).toBe('member');
  });

  it('with two owners already, makes no one else an owner, and the owner email claims nothing again', async () => {
    await pool.query(`INSERT INTO members (email, role, activated_at) VALUES ($1, 'owner', now()), ('second@anywhere.example', 'owner', now())`, [OWNER]);
    // The audit log is not emptied between tests: count from here.
    const claims = async () => (await pool.query(`SELECT 1 FROM audit WHERE action = 'member.owner_claimed'`)).rowCount;
    const before = await claims();
    const unnamed = serve(CODE, null);
    try {
      expect((await signIn('new@anywhere.example', CODE, unnamed)).json().member.role).toBe('member');
    } finally {
      await unnamed.close();
    }
    await signIn(OWNER);
    expect(await claims()).toBe(before);
  });

  it('stops refreshing a session after 30 days, and sweeps it at the next sign-in', async () => {
    const { refresh_token } = (await signIn(OWNER)).json();
    await owner.query(`UPDATE code_sessions SET created_at = now() - interval '31 days'`);
    expect((await app.inject({ method: 'POST', url: '/code-signin/refresh', payload: { refresh_token } })).statusCode).toBe(401);
    await signIn('teammate@anywhere.example');
    expect((await pool.query(`SELECT 1 FROM code_sessions`)).rowCount).toBe(1);
  });

  it('sweeps lapsed board tokens at the next sign-in, the Zoom board never opened', async () => {
    await signIn(OWNER);
    await owner.query(`UPDATE zoom_board_sessions SET expires_at = now() - interval '1 minute'`);
    await signIn('teammate@anywhere.example');
    expect((await pool.query(`SELECT 1 FROM zoom_board_sessions WHERE expires_at <= now()`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM zoom_board_sessions`)).rowCount).toBe(1);
  });

  it('refuses a bad email, and an email an admin removed', async () => {
    expect((await signIn('not-an-email')).statusCode).toBe(400);
    await pool.query(`INSERT INTO removed_members (email) VALUES ('gone@anywhere.example')`);
    const res = await signIn('gone@anywhere.example');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'removed' });
  });

  it('keeps an invited member invited, not joined by code', async () => {
    await pool.query(`INSERT INTO members (email, role) VALUES ('invited@anywhere.example', 'admin')`);
    const res = await signIn('invited@anywhere.example');
    expect(res.json().member.role).toBe('admin');
    expect((await pool.query(`SELECT joined_by_code, activated_at IS NOT NULL AS active FROM members WHERE email = 'invited@anywhere.example'`)).rows[0]).toEqual({
      joined_by_code: false,
      active: true,
    });
  });

  it('refreshes a session into a new board token, until signed out', async () => {
    const { refresh_token } = (await signIn(OWNER)).json();
    const renewed = await app.inject({ method: 'POST', url: '/code-signin/refresh', payload: { refresh_token } });
    expect(renewed.statusCode).toBe(200);
    expect((await me(renewed.json().token)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/code-signin/sign-out', payload: { refresh_token } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/code-signin/refresh', payload: { refresh_token } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/code-signin/refresh', payload: { refresh_token: 'bwr_unknown' } })).statusCode).toBe(401);
  });

  it('never takes a code shorter than setup makes, even one whose digest was saved', async () => {
    const short = serve('ABCD');
    try {
      expect((await signIn(OWNER, 'ABCD', short)).statusCode).toBe(401);
    } finally {
      await short.close();
    }
  });

  it('signing out ends the live board token too', async () => {
    const { token, refresh_token } = (await signIn(OWNER)).json();
    expect((await me(token)).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/code-signin/sign-out', payload: { refresh_token } });
    expect((await me(token)).statusCode).toBe(401);
  });

  it('ends every sign-in of the old code once the code is replaced', async () => {
    const { token, refresh_token } = (await signIn(OWNER)).json();
    const renewed = serve('NEW0-CODE-2345-6789-ABCD-EFGH-JKLM-NPQR');
    try {
      expect((await me(token, renewed)).statusCode).toBe(401);
      expect((await renewed.inject({ method: 'POST', url: '/code-signin/refresh', payload: { refresh_token } })).statusCode).toBe(401);
      expect((await signIn(OWNER, CODE, renewed)).statusCode).toBe(401);
    } finally {
      await renewed.close();
    }
  });

  it('is not there past the local tier, and a code token signs nobody in', async () => {
    const { token } = (await signIn(OWNER)).json();
    const team = serve(null);
    try {
      expect((await signIn(OWNER, CODE, team)).statusCode).toBe(404);
      expect((await me(token, team)).statusCode).toBe(401);
      const client = (await team.inject({ method: 'GET', url: '/auth/desktop-client' })).json();
      expect(client.code_signin).toBe(false);
    } finally {
      await team.close();
    }
    expect((await app.inject({ method: 'GET', url: '/auth/desktop-client' })).json().code_signin).toBe(true);
  });

  it('counts wrong codes against the sign-in limit', async () => {
    const limited = apiBase(
      buildServer({ pool, authenticatePerson: nobodySignedIn, rateLimits: { signInFailuresPerMin: 2, zoomPerMin: 100 } as never, codeSignIn: { codeDigest: sha(CODE) } }),
    );
    try {
      for (let i = 0; i < 2; i++) expect((await signIn(OWNER, 'WRONG', limited)).statusCode).toBe(401);
      expect((await signIn(OWNER, CODE, limited)).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  describe('moving to Google (T1): endCodeSignIn', () => {
    it('removes whoever joined by code, keeps the owner, the invited and Google members, and runs once', async () => {
      await signIn(OWNER);
      await signIn('teammate@anywhere.example');
      await pool.query(`INSERT INTO members (email, role) VALUES ('invited@anywhere.example', 'member')`);
      await pool.query(`INSERT INTO members (email, role, google_sub, activated_at) VALUES ('google@anywhere.example', 'member', 'sub-1', now())`);
      expect(await endCodeSignIn(pool, { firstOwnerEmail: OWNER })).toBe(1);
      expect((await pool.query(`SELECT email FROM members ORDER BY email`)).rows.map((r) => r.email)).toEqual([
        'google@anywhere.example',
        'invited@anywhere.example',
        OWNER,
      ]);
      expect((await pool.query(`SELECT email FROM removed_members`)).rows).toEqual([{ email: 'teammate@anywhere.example' }]);
      expect((await pool.query(`SELECT 1 FROM code_sessions`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM zoom_board_sessions`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT action FROM audit WHERE action = 'member.removed'`)).rowCount).toBe(1);
      expect(await endCodeSignIn(pool, { firstOwnerEmail: OWNER })).toBe(0);
    });

    it('removes a code owner the owner email no longer names, so that email can claim the owner with Google', async () => {
      await signIn(OWNER);
      expect(await endCodeSignIn(pool, { firstOwnerEmail: 'boss@company.example' })).toBe(1);
      expect((await pool.query(`SELECT 1 FROM members`)).rowCount).toBe(0);
    });

    it('keeps an owner even when no owner email is named', async () => {
      await pool.query(`INSERT INTO members (email, role, activated_at, joined_by_code) VALUES ('boss@anywhere.example', 'owner', now(), true)`);
      expect(await endCodeSignIn(pool)).toBe(0);
      expect((await pool.query(`SELECT joined_by_code FROM members`)).rows).toEqual([{ joined_by_code: false }]);
    });
  });
});
