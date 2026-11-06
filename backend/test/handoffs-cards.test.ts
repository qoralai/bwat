import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cardsClient } from '../src/cards-client.ts';
import { createPool } from '../src/db/pool.ts';
import { start } from '../src/server.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { apiBase, bearer } from './app.ts';
import { client, liveSession, postHandoff, sessionId } from './sessions.ts';

// QOR-4620 (D162, D169): a hand-off of a card takes its brief from the card service and
// then tells the card it was routed, both with BWAT_CARDS_BACKEND_TOKEN at BWAT_CARDS_URL.

const TOKEN = 'cards-backend-token-0123456789-abcdef-0123456789';
const BRIEF = { subject: 'Ship the release on Friday', body: 'Ada said: "ship it on Friday". Owner: Ada.' };

type Call = { method: string; url: string; authorization: string | undefined; member: string | undefined; body: unknown };

/** The card service's two backend-only operations (cards/api/app.py), recording every call. */
const calls: Call[] = [];
/** While true the card service answers 503 to everything. */
let down = false;
/** While true the card service gives briefs but answers 503 to a routed notice. */
let routedDown = false;
/** A card whose brief comes back as JSON null. */
const NULL_BRIEF = randomUUID();
/** A card whose brief is a 200 that is not JSON. */
const NOT_JSON = randomUUID();
/** A card whose brief has an empty subject. */
const EMPTY = randomUUID();
const fake = createServer(async (req: IncomingMessage, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls.push({
    method: req.method!,
    url: req.url!,
    authorization: req.headers.authorization,
    member: req.headers['x-bwat-member-id'] as string | undefined,
    body: raw ? JSON.parse(raw) : undefined,
  });
  if (down) {
    res.writeHead(503).end();
  } else if (req.method === 'GET' && req.url === `/v1/cards/${EMPTY}/brief`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ subject: '', body: 'text' }));
  } else if (req.method === 'GET' && req.url === `/v1/cards/${NOT_JSON}/brief`) {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>proxy error</html>');
  } else if (req.method === 'GET' && req.url === `/v1/cards/${NULL_BRIEF}/brief`) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('null');
  } else if (req.method === 'GET' && /^\/v1\/cards\/[0-9a-f-]+\/brief$/.test(req.url!)) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(BRIEF));
  } else if (req.method === 'POST' && /^\/v1\/cards\/[0-9a-f-]+\/(routed|handoff-read)$/.test(req.url!)) {
    res.writeHead(routedDown && req.url!.endsWith('/routed') ? 503 : 204).end();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const cardsUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

describeDb('POST /handoffs of a card (QOR-4620)', () => {
  const lines: string[] = [];
  const t = useRoles({
    cards: cardsClient(cardsUrl, TOKEN),
    boardUrl: 'https://bwat.test',
    logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
  });
  beforeEach(() => void (calls.length = lines.length = 0));

  it('queues one message whose subject and body are the card brief, then records exactly one routed call by the acting member', async () => {
    const target = await liveSession(t);
    const card = randomUUID();
    const res = await postHandoff(t, { source_kind: 'card', source_id: card, target_session_id: target, request_key: randomUUID() });
    expect(res.statusCode).toBe(202);
    const { handoff_id } = res.json();

    const { rows } = await t.pool.query(`SELECT subject, body, source_id FROM inbox_messages WHERE handoff_id = $1`, [handoff_id]);
    // The brief has no link back: the board's address is appended (BWAT_PUBLIC_URL).
    expect(rows).toEqual([{ subject: BRIEF.subject, body: `${BRIEF.body}

Board: https://bwat.test/`, source_id: card }]);
    expect(calls).toEqual([
      { method: 'GET', url: `/v1/cards/${card}/brief`, authorization: `Bearer ${TOKEN}`, member: MEMBER_ID, body: undefined },
      {
        method: 'POST',
        url: `/v1/cards/${card}/routed`,
        authorization: `Bearer ${TOKEN}`,
        member: MEMBER_ID,
        body: { handoff_id, by_member_id: MEMBER_ID, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
      },
    ]);
  });

  it('carries the sender\'s note after the brief, before the board link; a note over 1000 characters is refused', async () => {
    const target = await liveSession(t);
    const sent = { source_kind: 'card', source_id: randomUUID(), target_session_id: target };
    const res = await postHandoff(t, { ...sent, request_key: randomUUID(), note: 'Start with the release notes.' });
    expect(res.statusCode).toBe(202);
    const { rows } = await t.pool.query(`SELECT body FROM inbox_messages WHERE handoff_id = $1`, [res.json().handoff_id]);
    expect(rows[0].body).toBe(`${BRIEF.body}\n\nNote from the sender: Start with the release notes.\n\nBoard: https://bwat.test/`);
    const long = await postHandoff(t, { ...sent, request_key: randomUUID(), note: 'x'.repeat(1001) });
    expect(long.statusCode).toBe(400);
  });

  it('makes no second routed call for the same request_key', async () => {
    const target = await liveSession(t);
    const sent = { source_kind: 'card', source_id: randomUUID(), target_session_id: target, request_key: randomUUID() };
    const first = await postHandoff(t, sent);
    const again = await postHandoff(t, sent);
    expect(again.json()).toEqual(first.json());
    expect(calls.filter((c) => c.url.endsWith('/routed'))).toHaveLength(1);
  });

  it('answers a repeat with the first hand-off even while the card service is down; a new one is 502 cards_unavailable', async () => {
    const target = await liveSession(t);
    const sent = { source_kind: 'card', source_id: randomUUID(), target_session_id: target, request_key: randomUUID() };
    const first = await postHandoff(t, sent);
    down = true;
    try {
      const again = await postHandoff(t, sent);
      expect(again.statusCode).toBe(202);
      expect(again.json()).toEqual(first.json());
      const fresh = await postHandoff(t, { ...sent, request_key: randomUUID() });
      expect(fresh.statusCode).toBe(502);
      expect(fresh.json()).toEqual({ error: 'cards_unavailable' });
    } finally {
      down = false;
    }
  });

  it('keeps a queued hand-off when the card service cannot be told it was routed: 202, one message, and a warning naming ids only', async () => {
    const target = await liveSession(t);
    const card = randomUUID();
    routedDown = true;
    try {
      const res = await postHandoff(t, { source_kind: 'card', source_id: card, target_session_id: target, request_key: randomUUID() });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ handoff_id: expect.any(String), status: 'queued' });
      const { handoff_id } = res.json();
      const queued = await t.pool.query(`SELECT handoff_id, subject, target_client_session FROM inbox_messages WHERE source_id = $1`, [card]);
      expect(queued.rows).toEqual([{ handoff_id, subject: BRIEF.subject, target_client_session: target }]);
      expect(calls.filter((c) => c.url === `/v1/cards/${card}/routed`)).toHaveLength(1);
      const warned = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'cards.routed_failed');
      expect(warned).toEqual([expect.objectContaining({ card_id: card, handoff_id })]);
      expect(JSON.stringify(warned)).not.toContain(BRIEF.subject);
    } finally {
      routedDown = false;
    }
  });

  it('answers 502 cards_unavailable for a brief that is not {subject, body}, or not JSON', async () => {
    const target = await liveSession(t);
    for (const card of [NULL_BRIEF, NOT_JSON, EMPTY]) {
      const res = await postHandoff(t, { source_kind: 'card', source_id: card, target_session_id: target, request_key: randomUUID() });
      expect(res.statusCode).toBe(502);
    }
  });
});

// Once the session marks a card's hand-off read, the card is told, as it was told it was queued.
describeDb('PATCH /me/inbox/{id} of a card hand-off', () => {
  const t = useRoles({ cards: cardsClient(cardsUrl, TOKEN), boardUrl: 'https://bwat.test' });
  beforeEach(() => void (calls.length = 0));
  const markRead = (id: string) => t.app.inject({ method: 'PATCH', url: `/me/inbox/${id}`, headers: MEMBER });
  const queued = async (sent: object) => {
    const { handoff_id } = (await postHandoff(t, sent)).json();
    const { rows } = await t.pool.query<{ id: string }>(`SELECT id FROM inbox_messages WHERE handoff_id = $1`, [handoff_id]);
    calls.length = 0;
    return { handoff_id, id: rows[0]!.id };
  };

  it('tells the card its hand-off was read, as the reading member, with the first read_at, and answers only {id, read_at}', async () => {
    const card = randomUUID();
    const { handoff_id, id } = await queued({ source_kind: 'card', source_id: card, target_session_id: await liveSession(t), request_key: randomUUID() });
    const first = await markRead(id);
    expect(first.statusCode).toBe(200);
    expect(Object.keys(first.json()).sort()).toEqual(['id', 'read_at']);
    expect(calls).toEqual([
      {
        method: 'POST',
        url: `/v1/cards/${card}/handoff-read`,
        authorization: `Bearer ${TOKEN}`,
        member: MEMBER_ID,
        body: { handoff_id, by_member_id: MEMBER_ID, at: first.json().read_at },
      },
    ]);
    expect((await markRead(id)).json()).toEqual(first.json());
    expect(calls.map((c) => c.body)).toEqual([calls[0]!.body, calls[0]!.body]);
  });

  it('tells no card about a to-do hand-off', async () => {
    const { id } = await queued({ source_kind: 'todo', source_id: randomUUID(), target_session_id: await liveSession(t), request_key: randomUUID(), subject: 'S', body: 'B' });
    expect((await markRead(id)).statusCode).toBe(200);
    expect(calls).toEqual([]);
  });

  it('marks the message read while the card service is down, and tells the card when it is marked again', async () => {
    const card = randomUUID();
    const { id } = await queued({ source_kind: 'card', source_id: card, target_session_id: await liveSession(t), request_key: randomUUID() });
    down = true;
    try {
      const res = await markRead(id);
      expect(res.statusCode).toBe(200);
      expect(res.json().read_at).toEqual(expect.any(String));
    } finally {
      down = false;
    }
    calls.length = 0;
    expect((await markRead(id)).statusCode).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`/v1/cards/${card}/handoff-read`]);
  });
});

describeDb('BWAT_CARDS_URL at startup (QOR-4620)', () => {
  const db = useTestDb();
  const env = () => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_CARDS_URL: cardsUrl });

  it('needs BWAT_CARDS_BACKEND_TOKEN, of at least 32 characters', async () => {
    await expect(start(env())).rejects.toThrow('BWAT_CARDS_BACKEND_TOKEN is required when BWAT_CARDS_URL is set');
    await expect(start({ ...env(), BWAT_CARDS_BACKEND_TOKEN: 'short' })).rejects.toThrow('BWAT_CARDS_BACKEND_TOKEN must be at least 32 characters');
  });

  it('gives the server started with them the card brief on a hand-off', async () => {
    calls.length = 0;
    const DEV = 'dev-person-token-for-the-cards-client-test';
    const app = apiBase(await start({ ...env(), NODE_ENV: 'development', BWAT_DEV_PERSON_TOKEN: DEV, BWAT_CARDS_BACKEND_TOKEN: TOKEN, BWAT_PUBLIC_URL: 'https://bwat.example' }));
    const pool = createPool(db.url('runtime'));
    try {
      const target = sessionId();
      await app.inject({ method: 'PUT', url: `/sessions/${target}`, headers: bearer(DEV), payload: { client: client(), instance_id: 'i-1' } });
      const res = await app.inject({
        method: 'POST',
        url: '/handoffs',
        headers: bearer(DEV),
        payload: { source_kind: 'card', source_id: randomUUID(), target_session_id: target, request_key: randomUUID() },
      });
      expect(res.statusCode).toBe(202);
      expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
      const { rows } = await pool.query(`SELECT body FROM inbox_messages WHERE handoff_id = $1`, [res.json().handoff_id]);
      expect(rows[0].body).toBe(`${BRIEF.body}\n\nBoard: https://bwat.example/`);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describe('BWAT_CARDS_BACKEND_TOKEN is a startup secret (QOR-4620)', () => {
  it('is resolved with the server startup secrets', async () => {
    const { STARTUP_NAMES } = await import('../src/config.ts');
    expect(STARTUP_NAMES.server).toContain('BWAT_CARDS_BACKEND_TOKEN');
  });
});
