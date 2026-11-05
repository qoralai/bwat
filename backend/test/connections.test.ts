import { describe, expect, it } from 'vitest';
import { describeDb } from './db/harness.ts';
import { MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { liveSession, notOnboardedDuring, putSession, client } from './sessions.ts';

describeDb("the person's links bwat needs: GET /me/connections", () => {
  const t = useRoles();
  const connections = (headers: Record<string, string> = MEMBER) => t.app.inject({ method: 'GET', url: '/me/connections', headers });

  it('says a link is connected once the person has a live Claude session and has linked their Zoom login', async () => {
    expect((await connections()).json()).toEqual({ claude_session: false, zoom: false });
    const id = await liveSession(t);
    expect((await connections()).json()).toEqual({ claude_session: true, zoom: false });
    await t.pool.query(`UPDATE members SET zoom_user_id = 'zoom-user-1' WHERE id = $1`, [MEMBER_ID]);
    expect((await connections()).json()).toEqual({ claude_session: true, zoom: true });
    await putSession(t, id, { client: client(), instance_id: 'i-1', ended: true });
    expect((await connections()).json()).toEqual({ claude_session: false, zoom: true });
    await t.pool.query(`UPDATE members SET zoom_user_id = NULL WHERE id = $1`, [MEMBER_ID]);
  });

  describe('refuses', () => {
    it('anyone not signed in, 401', async () => {
      expect((await connections({})).statusCode).toBe(401);
    });

    it('everyone before onboarding, 403 not_onboarded', async () => {
      await notOnboardedDuring(t, async () => {
        const res = await connections();
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'not_onboarded' });
      });
    });
  });
});
