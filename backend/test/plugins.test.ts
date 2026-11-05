import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pluginSecretNames, pluginSettings, type BwatPlugin } from '../src/plugins/plugin.ts';
import { localSecretStore, type SecretStore } from '../src/secrets/store.ts';
import { PLUGINS } from '../src/plugins/index.ts';
import { issueToken } from '../src/zoom-board-signin.ts';
import { describeDb } from './db/harness.ts';
import { switchOn } from './app.ts';
import { ADMIN, MEMBER, MEMBER_ID, OWNER, OWNER_ID, useRoles } from './people.ts';

// QOR-4806: a plugin switched on adds its bearer and its routes; switched off, it is not there at all.
let probeWrites = 0;
const probe: BwatPlugin = {
  name: 'probe',
  displayName: 'Probe',
  description: 'Probes things.',
  authenticate: (_pool, isOn) => (inner) => async (req, onBehalf) =>
    (onBehalf?.authorization ?? req.headers.authorization) === 'Bearer bwq_probe' && (await isOn()) ? { id: OWNER_ID } : inner(req, onBehalf),
  routes: (api, { authenticatePerson }) => {
    api.get('/open', async () => ({ ok: true }));
    api.post('/write', async () => ({ writes: ++probeWrites }));
    api.get('/who', async (req, reply) => {
      const person = await authenticatePerson(req);
      return person ? { id: person.id } : reply.code(401).send({ error: 'unauthorized' });
    });
  },
};

describe('the plugin registry', () => {
  it('every shipped plugin has a lowercase name, a display name and a description, and no two share a name', () => {
    for (const p of PLUGINS) {
      expect(p.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(p.displayName).not.toBe('');
      expect(p.description).not.toBe('');
    }
    expect(new Set(PLUGINS.map((p) => p.name)).size).toBe(PLUGINS.length);
  });

  // QOR-4977: a secret outside its own name, or one of core's, is never kept: declaring one is a mistake.
  it("every shipped plugin's secrets are its own", () => {
    for (const p of PLUGINS) expect(pluginSecretNames([p])).toEqual(p.secrets ?? []);
  });

  // QOR-4978: so are its settings: a key outside `<name>_` is never one of them.
  it("every shipped plugin's settings are its own", () => {
    for (const p of PLUGINS) expect(pluginSettings(p)).toEqual(p.settings ?? []);
  });
});

// An admin's switch turns a shipped plugin on or off while the backend runs; off, it is as if it were not there.
describeDb("a plugin, switched by an admin while the backend runs", () => {
  const t = useRoles({ plugins: [probe] });
  const turn = (on: boolean, headers = ADMIN) => t.app.inject({ method: 'PUT', url: '/console/plugins/probe', headers, payload: { on } });
  const listed = async () => (await t.app.inject({ method: 'GET', url: '/plugins' })).json();
  const probeBoardToken = async () => (await issueToken(t.pool, MEMBER_ID, 'probe')).token;
  const pair = () => t.app.inject({ method: 'POST', url: '/zoom/pair', headers: MEMBER, payload: { for: 'probe' } });

  it('starts off: not listed, its routes are 404, its bearer and board tokens sign in nobody, no pairing code for it', async () => {
    expect(await listed()).toEqual({ plugins: [] });
    expect((await t.app.inject({ method: 'GET', url: '/plugins/probe/open' })).statusCode).toBe(404);
    // a write never reaches its handler
    expect((await t.app.inject({ method: 'POST', url: '/plugins/probe/write' })).statusCode).toBe(404);
    expect(probeWrites).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer bwq_probe' } })).statusCode).toBe(401);
    expect(await me(t, await probeBoardToken())).toBe(401);
    expect((await pair()).statusCode).toBe(400);
  });

  it('turned on, is listed, answers under /v1/plugins/<name> and signs in through the whole chain, with no restart', async () => {
    expect((await turn(true)).statusCode).toBe(200);
    expect(await listed()).toEqual({ plugins: [{ name: 'probe', display_name: 'Probe', embeds: false }] });
    expect((await t.app.inject({ method: 'GET', url: '/plugins/probe/open' })).json()).toEqual({ ok: true });
    const who = await t.app.inject({ method: 'GET', url: '/plugins/probe/who', headers: { authorization: 'Bearer bwq_probe' } });
    expect(who.json()).toEqual({ id: OWNER_ID });
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer bwq_probe' } })).statusCode).toBe(200);
    // the chain still reaches core's own sign-in for anything that isn't the plugin's bearer
    expect((await t.app.inject({ method: 'GET', url: '/plugins/probe/who', headers: MEMBER })).json()).toEqual({ id: MEMBER_ID });
    expect(await me(t, await probeBoardToken())).toBe(200);
    expect((await pair()).statusCode).toBe(200);
  });

  it('turned off again, is gone at once', async () => {
    expect((await turn(false)).statusCode).toBe(200);
    expect(await listed()).toEqual({ plugins: [] });
    expect((await t.app.inject({ method: 'GET', url: '/plugins/probe/open' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer bwq_probe' } })).statusCode).toBe(401);
    expect(await me(t, await probeBoardToken())).toBe(401);
  });

  it('only an owner or an admin switches it', async () => {
    expect((await turn(true, MEMBER)).statusCode).toBe(403);
    expect((await turn(true, OWNER)).statusCode).toBe(200);
    expect((await turn(false, ADMIN)).statusCode).toBe(200);
  });
});

describeDb('a switched-on plugin that embeds the board', () => {
  const t = useRoles({ plugins: [{ ...probe, embeds: true }] });
  beforeAll(() => switchOn(t.pool, 'probe'));

  it('is listed as embedding, so the web server redeems its tickets at its own /embed/redeem', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/plugins' })).json()).toEqual({ plugins: [{ name: 'probe', display_name: 'Probe', embeds: true }] });
  });
});

// QOR-4890: a board token a plugin issued (its `source`) signs in only while that plugin is on.
const me = async (t: { app: { inject: (o: object) => Promise<{ statusCode: number }> } }, token: string) =>
  (await t.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } })).statusCode;

describeDb("a switched-on plugin's board tokens", () => {
  const t = useRoles({ plugins: [probe] });
  beforeAll(() => switchOn(t.pool, 'probe'));

  it('sign in, as a Zoom one does', async () => {
    expect(await me(t, (await issueToken(t.pool, MEMBER_ID, 'probe')).token)).toBe(200);
    expect(await me(t, (await issueToken(t.pool, MEMBER_ID)).token)).toBe(200);
  });

  it("never sign in as another plugin's, switched off", async () => {
    expect(await me(t, (await issueToken(t.pool, MEMBER_ID, 'other')).token)).toBe(401);
  });
});

describeDb("a switched-off plugin's board tokens", () => {
  const t = useRoles();

  it('sign in nobody, while a Zoom one still signs in', async () => {
    expect(await me(t, (await issueToken(t.pool, MEMBER_ID, 'probe')).token)).toBe(401);
    expect(await me(t, (await issueToken(t.pool, MEMBER_ID)).token)).toBe(200);
  });
});

// The panel's Plugins page: every shipped plugin, what it needs from the operator, and what it holds.
describeDb('the Plugins page', () => {
  const framed: BwatPlugin = { name: 'framed', displayName: 'Framed', description: 'Needs a frame.', needs: { env: 'BWAT_FRAME_ANCESTORS', to: 'allow Framed to frame the board' } };
  const keeper: BwatPlugin = { name: 'keeper', displayName: 'Keeper', description: 'Keeps things.', holds: async () => '3 things' };
  const t = useRoles({ plugins: [probe, framed, keeper] });
  const page = async (headers = ADMIN) => (await t.app.inject({ method: 'GET', url: '/console/plugins', headers })).json();

  it('lists every shipped plugin, off on a fresh install, with what it needs', async () => {
    expect(await page()).toEqual({
      canManage: true,
      plugins: [
        { name: 'probe', display_name: 'Probe', description: 'Probes things.', on: false, needs: null },
        { name: 'framed', display_name: 'Framed', description: 'Needs a frame.', on: false, needs: { env: 'BWAT_FRAME_ANCESTORS', to: 'allow Framed to frame the board' } },
        { name: 'keeper', display_name: 'Keeper', description: 'Keeps things.', on: false, needs: null },
      ],
    });
  });

  it('says what a plugin holds, asked as it is turned off', async () => {
    const holds = async (name: string) => (await t.app.inject({ method: 'GET', url: `/console/plugins/${name}/holds`, headers: ADMIN })).json();
    expect(await holds('keeper')).toEqual({ holds: '3 things' });
    expect(await holds('probe')).toEqual({ holds: null });
  });

  it('says what a plugin holds only to an owner or an admin', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/console/plugins/keeper/holds', headers: MEMBER });
    expect(res.statusCode).toBe(403);
  });

  it('a member reads it and cannot switch', async () => {
    expect((await page(MEMBER)).canManage).toBe(false);
  });

  it('will not switch on a plugin that still needs setup', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/console/plugins/framed', headers: ADMIN, payload: { on: true } });
    expect(res.json()).toEqual({ error: 'needs_setup' });
  });
});

describeDb('the Plugins page, once the operator has set what a plugin needs', () => {
  const framed: BwatPlugin = { name: 'framed', displayName: 'Framed', description: 'Needs a frame.', needs: { env: 'BWAT_FRAME_ANCESTORS', to: 'allow Framed to frame the board' } };
  const t = useRoles({ plugins: [framed], env: { BWAT_FRAME_ANCESTORS: 'https://framer.example' } });

  it('switches it on, and says so', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/console/plugins/framed', headers: ADMIN, payload: { on: true } });
    expect(res.json().plugins).toEqual([expect.objectContaining({ name: 'framed', on: true, needs: null })]);
  });
});

// QOR-4977: a plugin's routes read the secrets it declares, and only those, and call out through
// the server's fetch.
describe("a plugin's secret names", () => {
  it("are its own, and never one of core's, even under a plugin named for core's prefix", () => {
    const provider: BwatPlugin = { name: 'provider', displayName: 'Provider', description: 'Shares a prefix.', secrets: ['provider.openrouter', 'provider.extra'] };
    expect(pluginSecretNames([provider])).toEqual(['provider.extra']);
  });
});

describeDb("a plugin's secrets and outbound calls", () => {
  const outbound: string[] = [];
  const secretive: BwatPlugin = {
    name: 'secretive',
    displayName: 'Secretive',
    description: 'Keeps a key.',
    // One outside its own name: never read, so a plugin cannot reach core's secrets by naming them.
    secrets: ['secretive.key', 'zoom.client_secret'],
    routes: (api, { getSecret, fetch }) => {
      api.get('/secret/:name', async (req) => ({ value: await getSecret((req.params as { name: string }).name) }));
      api.post('/call', async () => ({ status: (await fetch('https://outbound.example/x')).status }));
    },
  };
  // The store the server reads, keeping the plugin's own name as start() makes it keep them.
  let store: SecretStore;
  const t = useRoles({
    plugins: [secretive],
    // It also keeps one more name under the plugin's own, which the plugin never declared.
    secrets: (pool) => (store = localSecretStore(pool, randomBytes(32), { pluginNames: [...pluginSecretNames([secretive]), 'secretive.other'] })),
    pluginFetch: async (url) => { outbound.push(String(url)); return new Response(null, { status: 204 }); },
  });
  beforeAll(async () => {
    await switchOn(t.pool, 'secretive');
    await store.put('secretive.key', 'k-123');
    await store.put('zoom.client_secret', 'zoom-secret');
  });
  const secret = async (name: string) => (await t.app.inject({ method: 'GET', url: `/plugins/secretive/secret/${name}` })).json();

  it('reads a secret it declares', async () => {
    expect(await secret('secretive.key')).toEqual({ value: 'k-123' });
  });

  it("reads no other secret, core's included, even one it names", async () => {
    expect(await secret('zoom.client_secret')).toEqual({ value: null });
  });

  it('reads no secret under its own name that it did not declare', async () => {
    await store.put('secretive.other', 'k-undeclared');
    expect(await secret('secretive.other')).toEqual({ value: null });
  });

  it("calls out through the server's fetch", async () => {
    expect((await t.app.inject({ method: 'POST', url: '/plugins/secretive/call' })).json()).toEqual({ status: 204 });
    expect(outbound).toEqual(['https://outbound.example/x']);
  });
});
