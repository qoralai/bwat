import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cardsClient } from '../../../src/cards-client.ts';
import { jira } from '../../../src/plugins/jira/index.ts';
import { jiraSummary, moveJiraEmailToSetting } from '../../../src/plugins/jira/jira.ts';
import { pluginSecretNames } from '../../../src/plugins/plugin.ts';
import { localSecretStore, type SecretStore } from '../../../src/secrets/store.ts';
import { switchOn, type TestApp } from '../../app.ts';
import { describeDb } from '../../db/harness.ts';
import { ADMIN, MEMBER, MEMBER_ID, OWNER, useRoles } from '../../people.ts';

// QOR-4722, a plugin since QOR-4976: Route to Jira. With the plugin on, the API token stored and
// the site, project key and account email set, a member files a card as a Jira Task, once per
// card; otherwise the board offers no button and the route answers 409 jira_not_configured.

const CARDS_TOKEN = 'cards-backend-token-0123456789-abcdef-0123456789';
const SITE = 'https://example.atlassian.net';
const EMAIL = 'bot@example.com';
const TOKEN = 'jira-api-token-do-not-leak-0123456789';
const CONTENT = {
  title: 'Ship the release',
  note: 'Ship it on Friday.',
  quotes: [
    { speaker: 'Marco', quote: 'ship it on friday' },
    { speaker: 'Ada', quote: 'and the docs' },
  ],
};

/** The card service: a card's content, its notes (each recorded), and which cards a person may read. */
const cardCalls: { method: string; url: string; member: string | undefined; body: unknown }[] = [];
let noteFails = false;
let unreadable = new Set<string>();
/** The cards merged into each card, as the card service's facts say. */
let merges = new Map<string, string[]>();
const fake = createServer(async (req: IncomingMessage, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  cardCalls.push({ method: req.method!, url: req.url!, member: req.headers['x-bwat-member-id'] as string | undefined, body });
  if (req.headers.authorization !== `Bearer ${CARDS_TOKEN}`) return void res.writeHead(401).end();
  const json = (answer: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  if (req.url === '/v1/cards/facts') {
    return json({ cards: (body.card_ids as string[]).filter((id) => !unreadable.has(id)).map((id) => ({ id, merged_from: merges.get(id) ?? [] })) });
  }
  if (/^\/v1\/cards\/[0-9a-f-]+\/content$/.test(req.url!)) return json(CONTENT);
  if (/^\/v1\/cards\/[0-9a-f-]+\/note$/.test(req.url!)) return noteFails ? void res.writeHead(503).end() : json({ revision: 2 });
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const cardsUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

/** Jira Cloud: every call recorded; the next issue is ABC-<n>, or the status in `failWith`. */
const jiraCalls: { url: string; init: RequestInit }[] = [];
let failWith: number | undefined;
const pluginFetch = (async (url: string | URL, init: RequestInit = {}) => {
  jiraCalls.push({ url: String(url), init });
  if (failWith === -1) throw new TypeError('fetch failed');
  if (failWith) return new Response(JSON.stringify({ errorMessages: ['nope'] }), { status: failWith });
  const n = jiraCalls.length;
  return new Response(JSON.stringify({ id: String(10000 + n), key: `ABC-${n}`, self: `${SITE}/rest/api/3/issue/${n}` }), { status: 201 });
}) as typeof fetch;

/** A server with the jira plugin on, its token in a real store, and its log. */
function useJira() {
  const lines: string[] = [];
  let store!: SecretStore;
  const t = useRoles({
    plugins: [jira],
    cards: cardsClient(cardsUrl, CARDS_TOKEN),
    secrets: (pool) => (store = localSecretStore(pool, randomBytes(32), { pluginNames: pluginSecretNames([jira], { retired: true }) })),
    pluginFetch,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });
  beforeAll(async () => {
    await switchOn(t.pool, 'jira');
  });
  const setJira = async (key: 'jira_site_url' | 'jira_project_key' | 'jira_account_email', value: string | null) => {
    const read = (await t.app.inject({ method: 'GET', url: '/console/plugins/jira/settings', headers: OWNER })).json();
    const changes = { [key]: { value, expectedRevision: read.settings[key].revision } };
    const res = await t.app.inject({ method: 'PUT', url: '/console/plugins/jira/settings', headers: OWNER, payload: { changes } });
    expect(res.statusCode).toBe(200);
  };
  const setUp = async () => {
    jiraCalls.length = 0;
    cardCalls.length = 0;
    failWith = undefined;
    noteFails = false;
    unreadable = new Set();
    merges = new Map();
    await store.put('jira.api_token', TOKEN);
    // Pasted with a trailing slash; stored without one.
    await setJira('jira_site_url', `${SITE}/`);
    await setJira('jira_project_key', 'ABC');
    await setJira('jira_account_email', EMAIL);
  };
  return { t, lines, setJira, setUp, store: () => store };
}

// A card, written as the card service writes them (the runtime role writes no card).
const freshCard = async (t: TestApp) => {
  const owner = await t.db.connect('owner');
  const { rows } = await owner.query(
    `WITH m AS (INSERT INTO bwat.meetings (occurrence_uuid, meeting_number) VALUES (gen_random_uuid()::text, '444444444') RETURNING id)
     INSERT INTO cards.cards (meeting_id, kind, display_number, title) SELECT id, 'todo', nextval('cards.todo_numbers'), 'A card' FROM m RETURNING id`,
  );
  await owner.end();
  return rows[0].id as string;
};

describeDb('Route to Jira, the jira plugin (QOR-4976)', () => {
  const { t, lines, setJira, setUp, store } = useJira();
  const route = (card: string, headers = MEMBER) => t.app.inject({ method: 'POST', url: `/plugins/jira/cards/${card}`, headers });
  const status = async () => (await t.app.inject({ method: 'GET', url: '/plugins/jira/status', headers: MEMBER })).json();
  const issues = (cards: string[]) => t.app.inject({ method: 'GET', url: `/plugins/jira/issues?cards=${cards.join(',')}`, headers: MEMBER });
  beforeEach(setUp);

  it('sends no credential to a stored site that is not an Atlassian Cloud site, and follows no redirect', async () => {
    await route(await freshCard(t));
    expect(jiraCalls.map((c) => c.init.redirect)).toEqual(['error']);
    jiraCalls.length = 0;
    // A value stored before the site rule: not sent to.
    await t.pool.query(`UPDATE settings SET value = '"https://jira.example.com"'::jsonb WHERE key = 'jira_site_url'`);
    expect(await status()).toEqual({ enabled: false });
    expect((await route(await freshCard(t))).statusCode).toBe(409);
    expect(jiraCalls).toEqual([]);
    // Said once in the log, by its host only, so an admin can see why Jira went quiet.
    const refused = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'jira.site_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ level: 40, host: 'jira.example.com' });
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('is off, and refused 409 jira_not_configured, until the site, email, token and project are all set', async () => {
    await setJira('jira_project_key', null);
    expect(await status()).toEqual({ enabled: false });
    const res = await route(await freshCard(t));
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'jira_not_configured' }]);
    await setJira('jira_project_key', 'ABC');
    await setJira('jira_site_url', null);
    expect(await status()).toEqual({ enabled: false });
    await setJira('jira_site_url', SITE);
    await setJira('jira_account_email', null);
    expect(await status()).toEqual({ enabled: false });
    await setJira('jira_account_email', EMAIL);
    await store().delete('jira.api_token');
    expect(await status()).toEqual({ enabled: false });
    expect((await route(await freshCard(t))).statusCode).toBe(409);
    expect(jiraCalls).toEqual([]);
    expect(cardCalls).toEqual([]);
  });

  it('is on for any signed-in member once configured, and says nothing else about the configuration', async () => {
    expect(await status()).toEqual({ enabled: true });
    expect((await t.app.inject({ method: 'GET', url: '/plugins/jira/status' })).statusCode).toBe(401);
  });

  it('keeps the site and the account email as the plugin\'s settings, which any member reads, the site stored without the trailing slash', async () => {
    const read = (await t.app.inject({ method: 'GET', url: '/console/plugins/jira/settings', headers: MEMBER })).json();
    expect(read.settings.jira_site_url.value).toBe(SITE);
    expect(read.settings.jira_account_email.value).toBe(EMAIL);
  });

  it('files the card as one Task in the project, as the Jira account, keeps the issue and notes it on the card', async () => {
    const card = await freshCard(t);
    const res = await route(card);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: 'ABC-1', url: `${SITE}/browse/ABC-1`, revision: 2 });

    expect(jiraCalls).toHaveLength(1);
    const { url, init } = jiraCalls[0]!;
    expect(url).toBe(`${SITE}/rest/api/3/issue`);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`);
    const { fields } = JSON.parse(String(init.body));
    expect(fields.project).toEqual({ key: 'ABC' });
    expect(fields.issuetype).toEqual({ name: 'Task' });
    expect(fields.summary).toBe('Ship the release');
    // Atlassian Document Format: the note, each quote with its speaker, and who sent it.
    const text = JSON.stringify(fields.description);
    for (const part of ['Ship it on Friday.', 'Marco: \\"ship it on friday\\"', 'Ada: \\"and the docs\\"', 'Sent from bwat by test-member@test.invalid']) {
      expect(text).toContain(part);
    }

    // Whether a card merged into it was sent first, then the content to file, then the note.
    expect(cardCalls.map((c) => [c.method, c.url, c.member])).toEqual([
      ['POST', '/v1/cards/facts', MEMBER_ID],
      ['GET', `/v1/cards/${card}/content`, MEMBER_ID],
      ['POST', `/v1/cards/${card}/note`, MEMBER_ID],
    ]);
    // One line per issue, however often the card service is asked (a retry after a lost answer).
    expect(cardCalls[2]!.body).toEqual({ lead: 'Sent to Jira', text: 'as ABC-1', by_member_id: MEMBER_ID, request_id: 'jira:ABC-1' });
    const { rows } = await t.pool.query(`SELECT key, url, sent_by, noted_at IS NOT NULL AS noted FROM jira.card_issues WHERE card_id = $1`, [card]);
    expect(rows).toEqual([{ key: 'ABC-1', url: `${SITE}/browse/ABC-1`, sent_by: MEMBER_ID, noted: true }]);
  });

  it('answers a card already sent with its issue, and creates no second one nor a second note', async () => {
    const card = await freshCard(t);
    const first = (await route(card)).json();
    cardCalls.length = 0;
    const again = await route(card);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ key: first.key, url: first.url });
    expect(jiraCalls).toHaveLength(1);
    expect(cardCalls).toEqual([]);
  });

  it("writes the card's line on the next press when the card service could not take it, as the member who sent it", async () => {
    const card = await freshCard(t);
    noteFails = true;
    expect((await route(card)).statusCode).toBe(502);
    noteFails = false;
    cardCalls.length = 0;
    // Someone else presses: the line still names who sent the card.
    const again = await route(card, OWNER);
    expect(again.json()).toEqual({ key: 'ABC-1', url: `${SITE}/browse/ABC-1`, revision: 2 });
    expect(jiraCalls).toHaveLength(1);
    expect(cardCalls.map((c) => [c.url, c.member])).toEqual([[`/v1/cards/${card}/note`, MEMBER_ID]]);
    expect(cardCalls[0]!.body).toMatchObject({ by_member_id: MEMBER_ID });
  });

  it("answers Jira's refusal as 502 jira_failed with Jira's status, and keeps nothing", async () => {
    failWith = 400;
    const card = await freshCard(t);
    const res = await route(card);
    expect([res.statusCode, res.json()]).toEqual([502, { error: 'jira_failed', status: 400 }]);
    expect(cardCalls.filter((c) => c.url.endsWith('/note'))).toEqual([]);
    expect((await t.pool.query(`SELECT 1 FROM jira.card_issues WHERE card_id = $1`, [card])).rowCount).toBe(0);
  });

  it('never answers or logs the API token or the basic credential', async () => {
    await route(await freshCard(t));
    failWith = 401;
    const failed = await route(await freshCard(t));
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
    for (const secret of [TOKEN, basic]) {
      expect(failed.body).not.toContain(secret);
      expect(lines.join('\n')).not.toContain(secret);
    }
    expect(lines.join('\n')).toContain('"jira.failed"');
  });

  it("gives the board the issue of each card sent, of the cards the card service has, for the card's link", async () => {
    const [a, b, c] = [await freshCard(t), await freshCard(t), await freshCard(t)];
    await route(a);
    await route(b);
    unreadable = new Set([b]);
    const res = await issues([a, b, c]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issues: [{ card_id: a, key: 'ABC-1', url: `${SITE}/browse/ABC-1` }] });
    expect((await issues(['not-a-card'])).statusCode).toBe(400);
  });

  // The card service may merge a sent card into one never sent: the issue is the survivor's.
  it('gives a card the issue of a card merged into it, and never files the survivor again', async () => {
    const [sentOne, survivor] = [await freshCard(t), await freshCard(t)];
    await route(sentOne);
    merges = new Map([[survivor, [sentOne]]]);
    expect((await issues([survivor])).json()).toEqual({ issues: [{ card_id: survivor, key: 'ABC-1', url: `${SITE}/browse/ABC-1` }] });
    const again = await route(survivor);
    expect(again.json()).toEqual({ key: 'ABC-1', url: `${SITE}/browse/ABC-1` });
    expect(jiraCalls).toHaveLength(1);
    expect((await t.pool.query(`SELECT 1 FROM jira.card_issues WHERE card_id = $1`, [survivor])).rowCount).toBe(0);
  });

  it('says what it holds as an admin turns it off', async () => {
    await route(await freshCard(t));
    const res = await t.app.inject({ method: 'GET', url: '/console/plugins/jira/holds', headers: ADMIN });
    expect(res.json().holds).toMatch(/^links to \d+ Jira issues?$/);
  });
});

describeDb('checking the Jira connection from its setup card (QOR-4904)', () => {
  const { t, lines, setUp, store } = useJira();
  const check = (headers = ADMIN) => t.app.inject({ method: 'POST', url: '/plugins/jira/check', headers, payload: {} });
  beforeEach(setUp);

  it('asks Jira for the project as the stored account, and answers connected', async () => {
    const res = await check();
    expect([res.statusCode, res.json()]).toEqual([200, { result: 'connected' }]);
    const { url, init } = jiraCalls[0]!;
    expect([url, init.method ?? 'GET']).toEqual([`${SITE}/rest/api/3/project/ABC`, 'GET']);
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`);
    expect(init.redirect).toBe('error');
  });

  it("says why it is not connected: Jira refused the token, has no such project, or could not be reached", async () => {
    for (const [code, result] of [[401, 'refused'], [403, 'refused'], [404, 'no_project'], [500, 'unreachable'], [-1, 'unreachable']] as const) {
      failWith = code;
      const res = await check();
      expect([res.statusCode, res.json()], String(code)).toEqual([200, { result }]);
    }
  });

  it('is for owners and admins only, and refused 409 jira_not_configured until all four values are set', async () => {
    expect((await check(MEMBER)).statusCode).toBe(403);
    await store().delete('jira.api_token');
    const res = await check();
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'jira_not_configured' }]);
    expect(jiraCalls).toEqual([]);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describeDb('the jira plugin switched off', () => {
  const t = useRoles({ plugins: [jira], pluginFetch });

  it('serves none of its routes', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/plugins/jira/status', headers: MEMBER })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/plugins/jira/cards/00000000-0000-4000-8000-000000000001', headers: MEMBER })).statusCode).toBe(404);
  });
});

describe('jiraSummary', () => {
  it('fits a card title into what Jira takes: one line, at most 255 characters', () => {
    expect(jiraSummary('Ship\n  the   release')).toBe('Ship the release');
    expect(jiraSummary('x'.repeat(300))).toHaveLength(255);
  });
});

describeDb('the Jira account email, moved out of the secret store at start', () => {
  const t = useRoles({ plugins: [jira] });
  const stored = async () => (await t.app.inject({ method: 'GET', url: '/console/plugins/jira/settings', headers: MEMBER })).json().settings.jira_account_email;
  const keeping = (pool: TestApp['pool']) => localSecretStore(pool, randomBytes(32), { pluginNames: pluginSecretNames([jira], { retired: true }) });

  it('copies a stored jira.email secret into the jira_account_email setting, then deletes the secret; a second start changes nothing', async () => {
    const store = keeping(t.pool);
    await store.put('jira.email', 'ops@acme.com');
    await jira.start!({ pool: t.pool, secrets: store, log: t.app.log });
    expect(await stored()).toEqual({ value: 'ops@acme.com', revision: 1 });
    expect(await store.get('jira.email')).toBeNull();
    // Audited as a settings change by no one, without the address (audit.ts: never an email).
    const audited = await t.pool.query(`SELECT actor_id, action, after FROM audit WHERE target_type = 'settings:jira'`);
    expect(audited.rows).toEqual([{ actor_id: null, action: 'settings.updated', after: { jira_account_email: { value: 'set', revision: 1 } } }]);
    await jira.start!({ pool: t.pool, secrets: store, log: t.app.log });
    expect(await stored()).toEqual({ value: 'ops@acme.com', revision: 1 });
  });

  it('audits an email saved on its setup card without the address', async () => {
    const changes = { jira_account_email: { value: 'new@acme.com', expectedRevision: (await stored()).revision } };
    expect((await t.app.inject({ method: 'PUT', url: '/console/plugins/jira/settings', headers: OWNER, payload: { changes } })).statusCode).toBe(200);
    const { rows } = await t.pool.query(`SELECT before, after FROM audit WHERE target_type = 'settings:jira' ORDER BY at DESC LIMIT 1`);
    expect(JSON.stringify(rows)).not.toContain('@acme.com');
    expect(rows[0].after).toEqual({ jira_account_email: { value: 'set', revision: 2 } });
  });

  it('never shows the retired secret on the panel', async () => {
    const names = (await t.app.inject({ method: 'GET', url: '/console/secrets', headers: ADMIN })).json().secrets.map((s: { name: string }) => s.name);
    expect(names).toContain('jira.api_token');
    expect(names).not.toContain('jira.email');
  });
});

describeDb('the Jira account email move, retried after the secret could not be deleted', () => {
  const t = useRoles({ plugins: [jira] });
  const stored = async () => (await t.app.inject({ method: 'GET', url: '/console/plugins/jira/settings', headers: MEMBER })).json().settings.jira_account_email;

  it('never overwrites an email saved since: a retry after a failed delete only deletes the secret', async () => {
    const store = localSecretStore(t.pool, randomBytes(32), { pluginNames: pluginSecretNames([jira], { retired: true }) });
    await store.put('jira.email', 'legacy@acme.com');
    const deleteFails = { ...store, delete: async () => Promise.reject(new Error('store down')) };
    await expect(moveJiraEmailToSetting(t.pool, deleteFails)).rejects.toThrow('store down');
    expect(await stored()).toMatchObject({ value: 'legacy@acme.com' });
    const changes = { jira_account_email: { value: 'admin@acme.com', expectedRevision: (await stored()).revision } };
    expect((await t.app.inject({ method: 'PUT', url: '/console/plugins/jira/settings', headers: OWNER, payload: { changes } })).statusCode).toBe(200);
    await moveJiraEmailToSetting(t.pool, store);
    expect(await stored()).toMatchObject({ value: 'admin@acme.com' });
    expect(await store.get('jira.email')).toBeNull();
  });

  it('logs a move that failed by its error name only, and does not fail the start', async () => {
    const lines: string[] = [];
    const log = { warn: (o: object, msg: string) => void lines.push(JSON.stringify({ ...o, msg })) } as unknown as TestApp['app']['log'];
    const broken = { get: async () => Promise.reject(Object.assign(new Error('nope legacy@acme.com'), { name: 'SecretUnavailable' })) } as unknown as SecretStore;
    await jira.start!({ pool: t.pool, secrets: broken, log });
    expect(lines).toEqual([JSON.stringify({ event: 'jira.email_not_moved', code: 'SecretUnavailable', msg: 'the stored Jira email could not be moved to its setting' })]);
  });
});
