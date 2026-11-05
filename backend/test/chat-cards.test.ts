import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { cardsClient } from '../src/cards-client.ts';
import { botPost, occurrenceUuid, resetAllocationsBeforeEach, signedIn, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';
import { botInMeeting } from './meetings.ts';

// What the bot posts in the meeting chat comes from the card service, asked by the
// backend for the bot's own claim, with BWAT_CARDS_BACKEND_TOKEN and no acting member.

const TOKEN = 'cards-backend-token-0123456789-abcdef-0123456789';
const CARDS = [{ display_id: 'A12', title: 'Ship the release' }];
const SUMMARY = 'Open from last time: the release still has to ship.';

const calls: { url: string; authorization: string | undefined; member: string | undefined }[] = [];
let down = false;
let slowMs = 0;
const fake = createServer((req: IncomingMessage, res) => {
  calls.push({ url: req.url!, authorization: req.headers.authorization, member: req.headers['x-bwat-member-id'] as string | undefined });
  const agenda = req.url!.includes('list=agenda');
  setTimeout(() => {
    if (down) res.writeHead(503).end();
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(agenda ? { cards: CARDS, summary: SUMMARY } : { cards: CARDS }));
  }, slowMs);
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const cardsUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

describeDb('POST /assignment/chat-cards', () => {
  const t = useApp({ authenticatePerson: signedIn, cards: cardsClient(cardsUrl, TOKEN) });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    calls.length = 0;
    down = false;
    slowMs = 0;
  });

  /** A bot holding a claim for `meeting`, promoted to an occurrence. */
  async function inMeeting(meeting: string) {
    const occurrence = occurrenceUuid();
    const bot = await botInMeeting(t, occurrence, meeting);
    return { token: bot.bot_token, held: { claim_id: bot.claim_id, generation: 1 }, occurrence };
  }

  it("answers the agenda for the claim's meeting and the open questions of its occurrence, asked for no person", async () => {
    const { token, held, occurrence } = await inMeeting('280000001');
    for (const list of ['agenda', 'questions']) {
      const res = await botPost(t, '/assignment/chat-cards', token, { ...held, list });
      expect(res.statusCode, list).toBe(200);
      expect(res.json(), list).toEqual(list === 'agenda' ? { cards: CARDS, summary: SUMMARY } : { cards: CARDS });
    }
    const query = new URLSearchParams({ meeting_number: '280000001', occurrence_uuid: occurrence });
    expect(calls).toEqual([
      { url: `/v1/meeting-chat?list=agenda&${query}`, authorization: `Bearer ${TOKEN}`, member: undefined },
      { url: `/v1/meeting-chat?list=questions&${query}`, authorization: `Bearer ${TOKEN}`, member: undefined },
    ]);
  });

  // QOR-4966: the card service asks the card writer's model for the agenda's summary, with
  // a budget of its own; the backend waits past it, so the count it falls back to arrives.
  it('waits longer than any other card service call for the agenda, which the model sums up', async () => {
    const { token, held } = await inMeeting('280000004');
    slowMs = 6_000;
    const res = await botPost(t, '/assignment/chat-cards', token, { ...held, list: 'agenda' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cards: CARDS, summary: SUMMARY });
  }, 15_000);

  it('refuses a claim the bot does not hold, asking the card service nothing', async () => {
    const { token } = await inMeeting('280000002');
    const res = await botPost(t, '/assignment/chat-cards', token, { claim_id: crypto.randomUUID(), generation: 1, list: 'agenda' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
    expect(calls).toEqual([]);
  });

  it('answers 503 while the card service is down', async () => {
    const { token, held } = await inMeeting('280000003');
    down = true;
    const res = await botPost(t, '/assignment/chat-cards', token, { ...held, list: 'questions' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'unavailable' });
  });
});
