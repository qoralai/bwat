import { expect, it } from 'vitest';
import { allowedDomainsFrom, ALLOWED_DOMAINS_KEY } from '../src/google-signin.ts';
import { writeSetting } from '../src/settings/store.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { createPool } from '../src/db/pool.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, useRoles } from './people.ts';

// QOR-5070: the Google sign-in card. The client ids are shown, a secret only as set and its last 4;
// the allowed email domains can be saved over BWAT_ALLOWED_DOMAINS on a self-hosted install.

const WEB_ID = 'web-client.apps.example.com';
const PLUGIN_ID = 'plugin-client.apps.example.com';
const PLUGIN_SECRET = 'fakegc-plugin-secret-0123456789-PS42';
// The personas sign in as test-<role>@test.invalid.
const OWN = 'test.invalid';

describeDb('/console/google-signin (QOR-5070)', () => {
  const t = useRoles({
    allowedDomains: ['example.com', OWN],
    googleClientIds: [WEB_ID, PLUGIN_ID],
    desktopClient: { id: PLUGIN_ID, secret: PLUGIN_SECRET },
  });
  const get = (headers = ADMIN) => t.app.inject({ method: 'GET', url: '/console/google-signin', headers });
  const put = (payload: object, headers = ADMIN) => t.app.inject({ method: 'PUT', url: '/console/google-signin/domains', headers, payload });
  const revision = async () => (await get()).json().domains.revision as number | null;

  it('shows an admin the client ids, the plugin secret as set and its last 4 only, and the domains from the env', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      signIn: 'google',
      configured: true,
      webClientIds: [WEB_ID],
      pluginClient: { id: PLUGIN_ID, secret: { set: true, last4: 'PS42' } },
      domains: { effective: ['example.com', OWN], env: ['example.com', OWN], saved: null, revision: null, updatedAt: null },
    });
    expect(res.body).not.toContain(PLUGIN_SECRET.slice(0, -4));
  });

  it('is owner or admin only, reading included', async () => {
    expect((await get(MEMBER)).statusCode).toBe(403);
    expect((await put({ domains: [OWN], expectedRevision: null }, MEMBER)).statusCode).toBe(403);
    expect((await get(OWNER)).statusCode).toBe(200);
  });

  it('saves a list over the env one, audited, and clearing it goes back to the env', async () => {
    const saved = await put({ domains: [' Newco.com ', OWN, 'newco.com'], expectedRevision: await revision() });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().domains).toMatchObject({ effective: ['newco.com', OWN], env: ['example.com', OWN], saved: ['newco.com', OWN], revision: 1 });

    const audited = await t.pool.query(`SELECT actor_id AS actor, action, before, after FROM audit WHERE target_type = 'google_signin'`);
    expect(audited.rows).toEqual([{ actor: ADMIN_ID, action: 'google_signin.domains_updated', before: { domains: null }, after: { domains: ['newco.com', OWN] } }]);

    const cleared = await put({ domains: null, expectedRevision: 1 });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().domains).toMatchObject({ effective: ['example.com', OWN], saved: null, revision: 2 });
  });

  it("refuses a list without the saving admin's own email domain, so nobody locks themselves out", async () => {
    const before = await revision();
    const res = await put({ domains: ['newco.com'], expectedRevision: before });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'own_domain_missing',
      message: `Keep ${OWN} in the list: it is your own email's domain, and without it you could not sign in again. Nothing was saved.`,
    });
    expect(await revision()).toBe(before);
  });

  it('refuses a list that is empty, too long or holds something that is not a domain', async () => {
    const at = await revision();
    for (const domains of [[], ['not a domain'], ['@test.invalid'], ['localhost'], [42], 'test.invalid', Array.from({ length: 51 }, (_, i) => `d${i}.test.invalid`)]) {
      const res = await put({ domains, expectedRevision: at });
      expect(res.statusCode, JSON.stringify(domains)).toBe(400);
      expect(res.json().error).toBe('invalid_domains');
    }
  });

  it('refuses a save read at an older revision: 409 stale, with the revision stored now', async () => {
    const at = await revision();
    await put({ domains: [OWN], expectedRevision: at });
    const res = await put({ domains: [OWN, 'newco.com'], expectedRevision: at });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevision: await revision() });
  });

  it('invites from a saved domain at once, without a restart', async () => {
    const invite = () => t.app.inject({ method: 'POST', url: '/members', headers: ADMIN, payload: { email: 'new@later.example' } });
    // Read once before the save, so the list in force is the cached one.
    expect((await invite()).json().error).toBe('domain_not_allowed');
    await put({ domains: [OWN, 'later.example'], expectedRevision: await revision() });
    expect((await invite()).statusCode).toBe(201);
  });
});

describeDb("/console/google-signin when the install's list leaves the admin out (QOR-5070)", () => {
  const t = useRoles({ allowedDomains: ['example.com'], googleClientIds: [WEB_ID] });

  it('refuses going back to the install list too: it would lock the saving admin out', async () => {
    const put = (payload: object) => t.app.inject({ method: 'PUT', url: '/console/google-signin/domains', headers: ADMIN, payload });
    expect((await put({ domains: [OWN], expectedRevision: null })).statusCode).toBe(200);
    const cleared = await put({ domains: null, expectedRevision: 1 });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error).toBe('own_domain_missing');
  });
});

describeDb('/console/google-signin protects the owners (QOR-5070)', () => {
  const t = useRoles({ allowedDomains: ['example.com', OWN], googleClientIds: [WEB_ID] });
  const put = (payload: object) => t.app.inject({ method: 'PUT', url: '/console/google-signin/domains', headers: ADMIN, payload });

  it('refuses a save, or going back to the install list, that leaves no activated owner able to sign in', async () => {
    // Every owner signs in from a domain of their own; the admin saving is from OWN.
    const moveOwners = (to: string) =>
      t.pool.query(`UPDATE members SET email = split_part(email, '@', 1) || '@' || $1 WHERE role = 'owner'`, [to]);
    await moveOwners('owners.example');
    try {
      const res = await put({ domains: [OWN], expectedRevision: null });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'owner_locked_out',
        message: 'Keep an owner’s email domain in the list, such as owners.example: without one, no owner could sign in. Nothing was saved.',
      });
      expect((await put({ domains: [OWN, 'owners.example'], expectedRevision: null })).statusCode).toBe(200);
      // The install's list has no owner's domain either.
      const cleared = await put({ domains: null, expectedRevision: 1 });
      expect(cleared.statusCode).toBe(400);
      expect(cleared.json().error).toBe('owner_locked_out');
    } finally {
      await moveOwners(OWN);
    }
  });
});

describeDb('/console/google-signin on a local install (QOR-5070)', () => {
  const t = useRoles({ codeSignIn: { codeDigest: Buffer.alloc(32) } });

  it('says it signs in with the install code, and has no domains to save', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/console/google-signin', headers: ADMIN });
    expect(res.json()).toMatchObject({ signIn: 'code', configured: false, webClientIds: [], pluginClient: { id: null } });
    const put = await t.app.inject({ method: 'PUT', url: '/console/google-signin/domains', headers: ADMIN, payload: { domains: [OWN], expectedRevision: null } });
    expect(put.statusCode).toBe(409);
    expect(put.json().error).toBe('code_signin');
  });
});

describeDb('allowedDomainsFrom (QOR-5070)', () => {
  const db = useTestDb();

  it('answers the saved list over the env one, the env one when none is saved or it was cleared, and a change after its cache runs out', async () => {
    const pool = createPool(db.url('runtime'));
    let now = 0;
    const domains = allowedDomainsFrom(pool, ['example.com'], { ttlMs: 1000, now: () => now });
    try {
      expect(await domains.get()).toEqual(['example.com']);
      const client = await pool.connect();
      try {
        await writeSetting(client, null, ALLOWED_DOMAINS_KEY, ['newco.com']);
        expect(await domains.get()).toEqual(['example.com']);
        now = 1000;
        expect(await domains.get()).toEqual(['newco.com']);
        await writeSetting(client, null, ALLOWED_DOMAINS_KEY, null);
        domains.invalidate();
        expect(await domains.get()).toEqual(['example.com']);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
