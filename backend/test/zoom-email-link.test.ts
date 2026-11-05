import { expect, it } from 'vitest';
import { resetAllocationsBeforeEach, signedIn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_S2S } from './fake-zoom.ts';
import { linkZoomByEmail } from '../src/zoom-board-signin.ts';
import { botInMeeting, pushTranscript, segment } from './meetings.ts';
import { deliver, lookupLogged, useAutoJoinApp, zoomEvent } from './zoom.ts';

/**
 * QOR-5111: a signed arrival naming both the Zoom account and its email links that account to
 * the member with that email, once Zoom's API, asked as the install's own S2S app, says the
 * account has that email.
 */
describeDb('linking a Zoom account by email', () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: { autoJoin: false, requireHost: false }, allowedDomains: ['test.invalid'] });
  resetAllocationsBeforeEach(t);

  /** What GET /users/{id} answers for each Zoom user id: the account's email and account, or a failure. Unknown: 404. */
  const accounts: Record<string, { email: string; account_id?: string; status?: string } | number | 'network_error'> = {};
  const ownAccount = ZOOM_S2S['zoom.s2s_account_id'];
  t.zoom.answer = (call) => {
    const asked = /^https:\/\/api\.zoom\.us\/v2\/users\/([^/?]+)$/.exec(call.url)?.[1];
    if (!asked) return undefined;
    const account = accounts[asked];
    if (account === undefined) return { status: 404, body: { code: 1001 } };
    if (account === 'network_error') return account;
    if (typeof account === 'number') return { status: account };
    return { status: 200, body: { id: asked, account_id: ownAccount, status: 'active', ...account } };
  };
  const userCalls = () => t.zoom.calls.filter((c) => c.url.startsWith('https://api.zoom.us/v2/users/')).length;

  const arrival = (participant: Record<string, unknown>, occurrence = 'email-link') =>
    zoomEvent('meeting.participant_joined', { id: '911222351', uuid: occurrence, participant: { user_id: '16778241', ...participant } });
  const member = async (email: string, { zoomUserId = null, role = 'member', activated = true }: { zoomUserId?: string | null; role?: string; activated?: boolean } = {}) =>
    (await t.pool.query<{ id: string }>(
      `INSERT INTO members (email, role, zoom_user_id, activated_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
      [email, role, zoomUserId, activated],
    )).rows[0]!.id;
  const zoomUserOf = async (id: string) =>
    (await t.pool.query<{ zoom_user_id: string | null }>(`SELECT zoom_user_id FROM members WHERE id = $1`, [id])).rows[0]!.zoom_user_id;
  const linkedAudits = async (id: string) =>
    (await t.pool.query(`SELECT 1 FROM audit WHERE action = 'member.zoom_linked' AND target_id = $1`, [id])).rowCount;
  const linkLines = (from: number) => t.lines.slice(from).filter((l) => l.includes('zoom.email_link'));

  /**
   * Delivers `event`, which Zoom answers at once, and the link's outcome once it has run after
   * the answer. Checks its level, and that no line names an email or an account.
   */
  const linkOutcome = async (event: object): Promise<string> => {
    const from = t.lines.length;
    const res = await deliver(t, event);
    expect(res.statusCode, res.body).toBe(200);
    const { outcome, level, status } = (await lookupLogged(t, from, 'zoom.email_link')) as { outcome: string; level: number; status?: number };
    const [line, ...more] = linkLines(from);
    expect(more).toEqual([]);
    expect(line).not.toMatch(/@|zoom-/);
    // A link is news. A conflict, an unconfirmed email or Zoom failing in a way that may pass
    // is a warning: something is not what it seems. Anything else, a refusal from Zoom that
    // will not pass (a missing scope) included, answers every such join alike: debug.
    const settled = outcome === 'zoom_unavailable' && typeof status === 'number' && status < 500 && status !== 429;
    expect(level, `${outcome} ${status}`).toBe(outcome === 'linked' ? 30 : ['conflict', 'not_confirmed', 'zoom_unavailable'].includes(outcome) && !settled ? 40 : 20);
    return outcome;
  };

  it('links the account to the member with that email, whatever its case, and the speaker resolves to them', async () => {
    const id = await member('grace@test.invalid');
    accounts['zoom-grace'] = { email: 'GRACE@test.invalid' };
    const occurrence = 'email-link-speaker';
    const bot = await botInMeeting(t, occurrence, '911222351');
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-grace', email: ' Grace@Test.Invalid ' }, occurrence))).toBe('linked');
    expect(await zoomUserOf(id)).toBe('zoom-grace');
    expect(await linkedAudits(id)).toBe(1);
    const pushed = await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1, return_segments: true, segments: [segment(0, { speaker_zoom_id: '16778241' })],
    });
    expect(pushed.json().segments[0].speaker_member_id).toBe(id);
    // A replay changes nothing, audits nothing again and asks Zoom nothing.
    const asked = userCalls();
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-grace', email: 'grace@test.invalid' }, occurrence))).toBe('already_linked');
    expect(await linkedAudits(id)).toBe(1);
    expect(userCalls()).toBe(asked);
  });

  it('links outside any meeting bwat attends: the account is the person, not the meeting', async () => {
    const id = await member('hopper@test.invalid');
    accounts['zoom-hopper'] = { email: 'hopper@test.invalid' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-hopper', email: 'hopper@test.invalid' }, 'unattended'))).toBe('linked');
    expect(await zoomUserOf(id)).toBe('zoom-hopper');
  });

  it('refuses an email Zoom does not confirm is the account\'s own: a registrant typing a member\'s address', async () => {
    const victim = await member('victim@test.invalid', { role: 'owner' });
    accounts['zoom-attacker'] = { email: 'attacker@test.invalid' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-attacker', email: 'victim@test.invalid' }))).toBe('not_confirmed');
    expect(await zoomUserOf(victim)).toBeNull();
    expect(await linkedAudits(victim)).toBe(0);
  });

  it("refuses an account on another Zoom account, or one Zoom's API does not know", async () => {
    const id = await member('outsider@test.invalid');
    accounts['zoom-outsider'] = { email: 'outsider@test.invalid', account_id: 'another-account' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-outsider', email: 'outsider@test.invalid' }))).toBe('zoom_unavailable');
    delete accounts['zoom-outsider'];
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-outsider', email: 'outsider@test.invalid' }))).toBe('zoom_unavailable');
    expect(await zoomUserOf(id)).toBeNull();
  });

  it("refuses a pending Zoom user, whose address Zoom has not verified, even with a member's email", async () => {
    const id = await member('pending.admin@test.invalid', { role: 'admin' });
    accounts['zoom-pending'] = { email: 'pending.admin@test.invalid', status: 'pending' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-pending', email: 'pending.admin@test.invalid' }))).toBe('zoom_unavailable');
    expect(await zoomUserOf(id)).toBeNull();
  });

  it('never fails the delivery when Zoom cannot answer, and links nobody', async () => {
    const id = await member('hamilton@test.invalid');
    for (const failure of [500, 401, 'network_error'] as const) {
      accounts['zoom-hamilton'] = failure;
      expect(await linkOutcome(arrival({ participant_user_id: 'zoom-hamilton', email: 'hamilton@test.invalid' }))).toBe('zoom_unavailable');
    }
    expect(await zoomUserOf(id)).toBeNull();
  });

  it('links nobody, and asks Zoom nothing, without the S2S app: pairing codes remain', async () => {
    const id = await member('johnson@test.invalid');
    accounts['zoom-johnson'] = { email: 'johnson@test.invalid' };
    const saved = { ...t.secrets.values };
    for (const name of Object.keys(ZOOM_S2S)) delete t.secrets.values[name];
    try {
      const asked = userCalls();
      expect(await linkOutcome(arrival({ participant_user_id: 'zoom-johnson', email: 'johnson@test.invalid' }))).toBe('not_configured');
      expect(userCalls()).toBe(asked);
      expect(await zoomUserOf(id)).toBeNull();
    } finally {
      Object.assign(t.secrets.values, saved);
    }
  });

  it('never pre-links an invited member who has not signed in, an owner included: they have not proven the address', async () => {
    const invited = await member('invited@test.invalid', { activated: false });
    const owner = await member('invited.owner@test.invalid', { role: 'owner', activated: false });
    accounts['zoom-invited'] = { email: 'invited@test.invalid' };
    accounts['zoom-owner'] = { email: 'invited.owner@test.invalid' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-invited', email: 'invited@test.invalid' }))).toBe('no_member');
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-owner', email: 'invited.owner@test.invalid' }))).toBe('no_member');
    expect(await zoomUserOf(invited)).toBeNull();
    expect(await zoomUserOf(owner)).toBeNull();
    await t.pool.query(`UPDATE members SET activated_at = now() WHERE id = $1`, [invited]);
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-invited', email: 'invited@test.invalid' }))).toBe('linked');
  });

  it('never tries an email alone, nor an account without one', async () => {
    const id = await member('lamarr@test.invalid');
    accounts['zoom-lamarr'] = { email: 'lamarr@test.invalid' };
    const from = t.lines.length;
    const asked = userCalls();
    for (const participant of [
      { email: 'lamarr@test.invalid' },
      { participant_user_id: '', email: 'lamarr@test.invalid' },
      { participant_user_id: 42, email: 'lamarr@test.invalid' },
      { participant_user_id: 'zoom-lamarr' },
      { participant_user_id: 'zoom-lamarr', email: '' },
    ]) expect((await deliver(t, arrival(participant))).statusCode).toBe(200);
    // One that is tried, after them: by the time its outcome is logged, none of those was.
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-nobody', email: 'nobody@test.invalid' }))).toBe('no_member');
    expect(linkLines(from)).toHaveLength(1);
    expect(userCalls()).toBe(asked);
    expect(await zoomUserOf(id)).toBeNull();
  });

  it('refuses an account id longer than a member can hold, and an email that is not one address', async () => {
    const id = await member('curie@test.invalid');
    expect(await linkOutcome(arrival({ participant_user_id: 'x'.repeat(65), email: 'curie@test.invalid' }))).toBe('invalid');
    // Not one address: two, or none.
    for (const email of ['curie@test.invalid,other@test.invalid', 'curie']) {
      expect(await linkOutcome(arrival({ participant_user_id: 'zoom-curie', email }))).toBe('invalid');
    }
    expect(await zoomUserOf(id)).toBeNull();
  });

  it('refuses an email outside the allowed domains', async () => {
    const id = await member('noether@elsewhere.invalid');
    accounts['zoom-noether'] = { email: 'noether@elsewhere.invalid' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-noether', email: 'noether@elsewhere.invalid' }))).toBe('domain_not_allowed');
    expect(await zoomUserOf(id)).toBeNull();
  });

  it('fails closed on a conflict: a member linked to another account, or an account another member holds', async () => {
    const linked = await member('meitner@test.invalid', { zoomUserId: 'zoom-meitner' });
    accounts['zoom-impostor'] = { email: 'meitner@test.invalid' };
    const asked = userCalls();
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-impostor', email: 'meitner@test.invalid' }))).toBe('conflict');
    // Settled from bwat's own record: Zoom is not asked.
    expect(userCalls()).toBe(asked);
    expect(await zoomUserOf(linked)).toBe('zoom-meitner');

    const other = await member('franklin@test.invalid');
    accounts['zoom-meitner'] = { email: 'franklin@test.invalid' };
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-meitner', email: 'franklin@test.invalid' }))).toBe('conflict');
    expect(await zoomUserOf(other)).toBeNull();
    expect(await zoomUserOf(linked)).toBe('zoom-meitner');
    expect(await linkedAudits(other)).toBe(0);
  });

  it('leaves a member linked to another account while Zoom was asked: a conflict, not a relink', async () => {
    const id = await member('lovelace@test.invalid');
    const outcome = await linkZoomByEmail(t.pool, {
      zoomUserId: 'zoom-late', email: 'lovelace@test.invalid', allowedDomains: ['test.invalid'],
      confirmedEmail: async () => {
        await t.pool.query(`UPDATE members SET zoom_user_id = 'zoom-first' WHERE id = $1`, [id]);
        return 'lovelace@test.invalid';
      },
    });
    expect(outcome).toBe('conflict');
    expect(await zoomUserOf(id)).toBe('zoom-first');
    expect(await linkedAudits(id)).toBe(0);
  });

  it('answers already linked, not a conflict, when the same account was linked while Zoom was asked', async () => {
    const id = await member('pascal@test.invalid');
    const outcome = await linkZoomByEmail(t.pool, {
      zoomUserId: 'zoom-pascal', email: 'pascal@test.invalid', allowedDomains: ['test.invalid'],
      confirmedEmail: async () => {
        await t.pool.query(`UPDATE members SET zoom_user_id = 'zoom-pascal' WHERE id = $1`, [id]);
        return 'pascal@test.invalid';
      },
    });
    expect(outcome).toBe('already_linked');
    expect(await zoomUserOf(id)).toBe('zoom-pascal');
  });

  it('answers an email no member has without asking Zoom or linking anyone', async () => {
    const asked = userCalls();
    expect(await linkOutcome(arrival({ participant_user_id: 'zoom-stranger', email: 'stranger@test.invalid' }))).toBe('no_member');
    expect(userCalls()).toBe(asked);
    expect((await t.pool.query(`SELECT 1 FROM members WHERE zoom_user_id = 'zoom-stranger'`)).rowCount).toBe(0);
  });
});
