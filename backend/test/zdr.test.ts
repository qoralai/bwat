import { describe, expect, it } from 'vitest';
import { zdrLookup } from '../src/zdr.ts';
import { fakeOpenRouter as openRouter } from './fake-openrouter.ts';

// QOR-4769: the backend's ZDR verdicts for the models the card service uses.

const ZDR_LIST = 'https://openrouter.ai/api/v1/endpoints/zdr';

const JEV = 'typesafe/jev-1.13';
const WRITER = 'anthropic/claude-opus-5.5';

describe('zdrLookup (QOR-4769)', () => {
  it('passes "all" only when every endpoint is on the ZDR list, "any" when at least one is', async () => {
    const { fetch } = openRouter(
      { [JEV]: ['TypeSafe | typesafe/jev-1.13-20260917'], [WRITER]: ['Amazon Bedrock | anthropic/claude-opus-5.5', 'Anthropic | anthropic/claude-opus-5.5'] },
      ['TypeSafe | typesafe/jev-1.13-20260917', 'Amazon Bedrock | anthropic/claude-opus-5.5'],
    );
    const lookup = zdrLookup({ fetch });
    expect(await lookup(JEV)).toEqual({ any: true, all: true, decided: true });
    expect(await lookup(WRITER)).toEqual({ any: true, all: false, decided: true });
  });

  it('fails a model none of whose endpoints is listed, and a model with no endpoints', async () => {
    const { fetch } = openRouter({ [WRITER]: ['Anthropic | anthropic/claude-opus-5.5'], [JEV]: [] }, ['Other | x']);
    const lookup = zdrLookup({ fetch });
    expect(await lookup(WRITER)).toEqual({ any: false, all: false, decided: true });
    expect(await lookup(JEV)).toEqual({ any: false, all: false, decided: true });
  });

  it('fails closed, undecided, on a lookup that errors, answers badly or names no endpoint (not the same as no ZDR endpoint)', async () => {
    const failing = [
      (async () => new Response('down', { status: 503 })) as typeof fetch,
      (async () => {
        throw new TypeError('network');
      }) as typeof fetch,
      (async () => Response.json({ unexpected: true })) as typeof fetch,
      // Blank names identify no endpoint, so they must not match each other.
      (async (input: string | URL | Request) =>
        String(input) === ZDR_LIST ? Response.json({ data: [{ name: '' }] }) : Response.json({ data: { endpoints: [{ name: '' }] } })) as typeof fetch,
    ];
    for (const fetch of failing) expect(await zdrLookup({ fetch })(JEV)).toEqual({ any: false, all: false, decided: false });
  });

  it('refuses a model id that is not one owner/name pair, without a lookup (QOR-4769)', async () => {
    const { fetch, calls } = openRouter({ [JEV]: ['TypeSafe | j'] }, ['TypeSafe | j']);
    const lookup = zdrLookup({ fetch });
    for (const bad of ['a/b?x', '../x/y', 'a/b/c', '']) expect(await lookup(bad)).toEqual({ any: false, all: false, decided: false });
    expect(calls).toEqual([]);
    expect(await lookup(JEV)).toEqual({ any: true, all: true, decided: true });
    expect(calls).toContain(`https://openrouter.ai/api/v1/models/${JEV}/endpoints`);
  });

  it('keeps a verdict per model for an hour, and a failed lookup for 30 s', async () => {
    let now = 0;
    const clock = () => now;
    const { fetch, calls } = openRouter({ [JEV]: ['TypeSafe | j'] }, ['TypeSafe | j']);
    const lookup = zdrLookup({ fetch, clock });
    await lookup(JEV);
    now = 3_599_999;
    await lookup(JEV);
    expect(calls).toHaveLength(2);
    now = 3_600_000;
    await lookup(JEV);
    expect(calls).toHaveLength(4);

    let down = true;
    const flaky = (async (input: string | URL | Request) => (down ? new Response('down', { status: 503 }) : fetch(input))) as typeof globalThis.fetch;
    const again = zdrLookup({ fetch: flaky, clock });
    expect(await again(JEV)).toEqual({ any: false, all: false, decided: false });
    down = false;
    now += 29_999;
    expect(await again(JEV)).toEqual({ any: false, all: false, decided: false });
    now += 1;
    expect(await again(JEV)).toEqual({ any: true, all: true, decided: true });
  });
});
