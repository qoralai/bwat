import { describe, expect, it } from 'vitest';
import { cardsClient, CardsUnavailable } from '../src/cards-client.ts';

// QOR-4985: what a plugin reads of a card to file it in its product, and the line it adds once it has.
const CARD = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const CONTENT = { title: 'Ship it', note: 'Ship it on Friday.', quotes: [{ speaker: 'Marco', quote: 'ship it on friday' }] };

function fakeCards(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; method: string; member: string | undefined; authorization: string | undefined; body: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method!, member: headers['x-bwat-member-id'], authorization: headers.authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { calls, client: cardsClient('http://cards.test/', 'tok', fetchFn) };
}

describe("a card's content and notes, through the card service", () => {
  it('reads the content as the acting member', async () => {
    const { calls, client } = fakeCards(() => Response.json(CONTENT));
    expect(await client.content(CARD, MEMBER)).toEqual(CONTENT);
    expect(calls).toEqual([{ url: `http://cards.test/v1/cards/${CARD}/content`, method: 'GET', member: MEMBER, authorization: 'Bearer tok', body: undefined }]);
  });

  it('adds a note as the member it names, and answers the revision', async () => {
    const { calls, client } = fakeCards(() => Response.json({ revision: 4 }));
    expect(await client.note(CARD, { lead: 'Sent to Probe', text: 'as PRB-1', by_member_id: MEMBER })).toEqual({ revision: 4 });
    expect(calls).toEqual([{
      url: `http://cards.test/v1/cards/${CARD}/note`,
      method: 'POST',
      member: MEMBER,
      authorization: 'Bearer tok',
      body: { lead: 'Sent to Probe', text: 'as PRB-1', by_member_id: MEMBER },
    }]);
  });

  it('is unavailable when the card service refuses either, or answers no content', async () => {
    const refused = fakeCards(() => new Response(null, { status: 404 })).client;
    await expect(refused.content(CARD, MEMBER)).rejects.toBeInstanceOf(CardsUnavailable);
    await expect(refused.note(CARD, { lead: 'Sent', text: 'x', by_member_id: MEMBER })).rejects.toBeInstanceOf(CardsUnavailable);
    const empty = fakeCards(() => Response.json({ title: 'Ship it' })).client;
    await expect(empty.content(CARD, MEMBER)).rejects.toBeInstanceOf(CardsUnavailable);
  });
});
