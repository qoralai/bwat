import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { switchOn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { takePairing } from '../src/zoom-board-signin.ts';

const SECRET = 'board-app-production-client-secret';

/** A context minted the way Zoom does (see zoom-app-context.test.ts). */
function context(uid: string, expMs = Date.now() + 60_000): string {
  const key = createHash('sha256').update(SECRET).digest();
  const iv = randomBytes(12);
  const aad = Buffer.from('zoom');
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(JSON.stringify({ typ: 'panel', uid, mid: 'm==', exp: expMs })), c.final()]);
  const aadLen = Buffer.alloc(2);
  aadLen.writeUInt16LE(aad.length);
  const bodyLen = Buffer.alloc(4);
  bodyLen.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from([iv.length]), iv, aadLen, aad, bodyLen, body, c.getAuthTag()]).toString('base64url');
}

describeDb('the board inside Zoom signs a person in from the signed app context (QOR-4708)', () => {
  const t = useRoles({ getSecret: async (name) => (name === 'zoom.board_client_secret' ? SECRET : null) });
  const boardSession = (ctx: string) => t.app.inject({ method: 'POST', url: '/zoom/board-session', payload: { context: ctx } });
  // The person signs in with Google in a browser and gets a pairing code to type into Zoom.
  const pair = (headers: Record<string, string> = MEMBER) => t.app.inject({ method: 'POST', url: '/zoom/pair', headers });
  // The board, holding the link code its Zoom context got, sends the typed pairing code.
  const link = (linkCode: string, pairCode: string) =>
    t.app.inject({ method: 'POST', url: '/zoom/link', payload: { link_code: linkCode, pair_code: pairCode } });

  it('offers a one-time link code for a Zoom user no member holds yet', async () => {
    const res = await boardSession(context('zoomUserA'));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['link_code', 'occurrence_id']);
    expect(res.json().link_code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // The meeting the board was opened from, so the board opens on it.
    expect(res.json().occurrence_id).toBe('m==');
  });

  it('pairs the Zoom user with the member whose code is typed in, signs them in at once, and from then on by context', async () => {
    const { link_code } = (await boardSession(context('zoomUserB'))).json();
    const paired = await pair();
    expect(paired.statusCode).toBe(200);
    const { pair_code } = paired.json();
    expect(pair_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Typed as a person would: lower case, without the dash.
    const linked = await link(link_code, pair_code.replace('-', '').toLowerCase());
    expect(linked.statusCode).toBe(200);
    const me = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${linked.json().token}` } });
    expect(me.json().id).toBe(MEMBER_ID);

    const again = await boardSession(context('zoomUserB'));
    expect(again.json().token).toMatch(/^bwz_/);
    expect(again.json().occurrence_id).toBe('m==');

    // The member's Zoom identity changed: audited as the member's own act, without the id.
    const { rows } = await t.pool.query(`SELECT actor_id, action, target_id, after FROM audit WHERE action = 'member.zoom_linked'`);
    expect(rows).toEqual([{ actor_id: MEMBER_ID, action: 'member.zoom_linked', target_id: MEMBER_ID, after: { zoom_user_id: true } }]);
  });

  it('clears expired sessions and codes as people open the board', async () => {
    const old = (n: number) => createHash('sha256').update(`expired-${n}`).digest();
    await t.pool.query(`INSERT INTO zoom_board_sessions (token_sha256, member_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`, [old(1), MEMBER_ID]);
    await t.pool.query(`INSERT INTO zoom_links (code_sha256, zoom_user_id, expires_at) VALUES ($1, 'gone', now() - interval '1 second')`, [old(2)]);
    await t.pool.query(`INSERT INTO zoom_pairings (code_sha256, member_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`, [old(3), MEMBER_ID]);
    await boardSession(context('zoomUserH'));
    for (const table of ['zoom_board_sessions', 'zoom_links', 'zoom_pairings']) {
      const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE expires_at <= now()`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('uses a pairing code once', async () => {
    const { pair_code } = (await pair()).json();
    const first = (await boardSession(context('zoomUserC'))).json().link_code;
    const second = (await boardSession(context('zoomUserC2'))).json().link_code;
    expect((await link(first, pair_code)).statusCode).toBe(200);
    expect((await link(second, pair_code)).statusCode).toBe(404);
  });

  it('refuses a wrong pairing code and keeps the link code for another try', async () => {
    const { link_code } = (await boardSession(context('zoomUserD'))).json();
    expect((await link(link_code, 'AAAA-AAAA')).statusCode).toBe(404);
    const { pair_code } = (await pair()).json();
    expect((await link(link_code, pair_code)).statusCode).toBe(200);
  });

  it('refuses an unknown link code and keeps the pairing code for another try', async () => {
    const { pair_code } = (await pair()).json();
    expect((await link('not-a-link-code', pair_code)).statusCode).toBe(404);
    const { link_code } = (await boardSession(context('zoomUserG'))).json();
    expect((await link(link_code, pair_code)).statusCode).toBe(200);
  });

  it('gives a pairing code only to a signed-in person', async () => {
    expect((await pair({})).statusCode).toBe(401);
  });

  it('refuses a context it cannot open, or an expired one', async () => {
    expect((await boardSession('garbage')).statusCode).toBe(400);
    expect((await boardSession(context('zoomUserE', Date.now() - 1000))).statusCode).toBe(400);
  });

  it('refuses an expired board token, and one it never issued', async () => {
    const { link_code } = (await boardSession(context('zoomUserF'))).json();
    const { token } = (await link(link_code, (await pair()).json().pair_code)).json();
    // The runtime role may not update sessions, so the expired one is put in its place.
    const sha = createHash('sha256').update(token).digest();
    await t.pool.query(`DELETE FROM zoom_board_sessions WHERE token_sha256 = $1`, [sha]);
    await t.pool.query(`INSERT INTO zoom_board_sessions (token_sha256, member_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`, [sha, MEMBER_ID]);
    const expired = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(expired.statusCode).toBe(401);
    const forged = await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer bwz_${'a'.repeat(43)}` } });
    expect(forged.statusCode).toBe(401);
  });
});

describeDb('guessing pairing codes is limited per link code (QOR-4708)', () => {
  const t = useRoles({ getSecret: async (name) => (name === 'zoom.board_client_secret' ? SECRET : null) });

  it('retires a link code after five wrong pairing codes, even for the right one next', async () => {
    const { link_code } = (await t.app.inject({ method: 'POST', url: '/zoom/board-session', payload: { context: context('zoomUserR') } })).json();
    const link = (pairCode: string) => t.app.inject({ method: 'POST', url: '/zoom/link', payload: { link_code, pair_code: pairCode } });
    for (let i = 0; i < 5; i++) expect((await link('AAAA-AAAA')).statusCode).toBe(404);
    const { pair_code } = (await t.app.inject({ method: 'POST', url: '/zoom/pair', headers: MEMBER })).json();
    expect((await link(pair_code)).statusCode).toBe(404);
  });
});

// QOR-4806: a pairing code is minted for one product and redeemed only there; only a sign-in mints one.
describeDb('pairing codes have an audience, and only a sign-in mints one (QOR-4806)', () => {
  const t = useRoles({
    getSecret: async (name) => (name === 'zoom.board_client_secret' ? SECRET : null),
    plugins: [{ name: 'probe', displayName: 'Probe', description: 'Probes things.' }],
  });
  beforeAll(() => switchOn(t.pool, 'probe'));
  const mint = (payload?: object, headers: Record<string, string> = MEMBER) =>
    t.app.inject({ method: 'POST', url: '/zoom/pair', headers, ...(payload && { payload }) });

  it("mints for 'zoom' by default and for a switched-on plugin by name; another name is refused", async () => {
    expect((await mint()).statusCode).toBe(200);
    expect((await mint({ for: 'probe' })).statusCode).toBe(200);
    expect((await mint({ for: 'nope' })).json()).toEqual({ error: 'bad_request' });
    expect((await mint({ for: 7 })).statusCode).toBe(400);
  });

  it("a code minted for a plugin can't link the board inside Zoom, and a Zoom code can't be taken for a plugin", async () => {
    const { link_code } = (await t.app.inject({ method: 'POST', url: '/zoom/board-session', payload: { context: context('zoomUserX') } })).json();
    const probeCode = (await mint({ for: 'probe' })).json().pair_code;
    expect((await t.app.inject({ method: 'POST', url: '/zoom/link', payload: { link_code, pair_code: probeCode } })).statusCode).toBe(404);
    expect(await takePairing(t.pool, probeCode, 'probe')).toBe(MEMBER_ID);
    const zoomCode = (await mint()).json().pair_code;
    expect(await takePairing(t.pool, zoomCode, 'probe')).toBeNull();
    expect(await takePairing(t.pool, zoomCode)).toBe(MEMBER_ID);
  });

  it('refuses a board token: a bearer never mints itself a pairing code (so never a successor)', async () => {
    const { link_code } = (await t.app.inject({ method: 'POST', url: '/zoom/board-session', payload: { context: context('zoomUserY') } })).json();
    const linked = await t.app.inject({ method: 'POST', url: '/zoom/link', payload: { link_code, pair_code: (await mint()).json().pair_code } });
    const board = { authorization: `Bearer ${linked.json().token}` };
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: board })).statusCode).toBe(200);
    expect((await mint(undefined, board)).statusCode).toBe(401);
  });
});
