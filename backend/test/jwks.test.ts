import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GOOGLE_JWKS_URL, jwksKeys } from '../src/jwks.ts';
import { jwksFetch, newSigningKey, type TestSigningKey } from './google-fixture.ts';

const HOUR = 3_600_000;

function setup({ maxAge, keys = [newSigningKey('k1')] }: { maxAge?: number; keys?: TestSigningKey[] } = {}) {
  let t = 1_000_000;
  const served = { keys };
  const { fetch, calls } = jwksFetch(() => served.keys, maxAge);
  const source = jwksKeys({ fetch, now: () => t });
  return { source, calls, served, advance: (ms: number) => (t += ms) };
}

describe('jwksKeys: Google signing keys, fetched and cached (QOR-4575)', () => {
  it("fetches Google's JWKS once and serves the key for a kid from cache", async () => {
    const { source, calls } = setup({ maxAge: 600 });
    expect(await source.get('k1')).not.toBeNull();
    expect(await source.get('k1')).not.toBeNull();
    expect(calls).toEqual([GOOGLE_JWKS_URL]);
    expect(GOOGLE_JWKS_URL).toBe('https://www.googleapis.com/oauth2/v3/certs');
  });

  it('refetches once the max-age Google gave has passed', async () => {
    const { source, calls, advance } = setup({ maxAge: 600 });
    await source.get('k1');
    advance(599_000);
    await source.get('k1');
    expect(calls).toHaveLength(1);
    advance(2_000);
    await source.get('k1');
    expect(calls).toHaveLength(2);
  });

  it('caches for at most six hours whatever the max-age says, and for an hour when it says nothing', async () => {
    const long = setup({ maxAge: 10 ** 9 });
    await long.source.get('k1');
    long.advance(6 * HOUR + 1);
    await long.source.get('k1');
    expect(long.calls).toHaveLength(2);

    const none = setup();
    await none.source.get('k1');
    none.advance(HOUR - 1);
    await none.source.get('k1');
    expect(none.calls).toHaveLength(1);
    none.advance(2);
    await none.source.get('k1');
    expect(none.calls).toHaveLength(2);
  });

  it('refetches on an unknown kid, so a rotated key is found before the cache expires', async () => {
    const { source, calls, served } = setup({ maxAge: 3600 });
    await source.get('k1');
    served.keys = [...served.keys, newSigningKey('k2')];
    expect(await source.get('k2')).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('refetches for unknown kids at most once a minute, so made-up kids cannot hammer Google', async () => {
    const { source, calls, advance } = setup({ maxAge: 3600 });
    await source.get('k1');
    expect(await source.get('nope-1')).toBeNull();
    expect(await source.get('nope-2')).toBeNull();
    expect(calls).toHaveLength(2);
    advance(60_001);
    expect(await source.get('nope-3')).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('shares one fetch between concurrent lookups', async () => {
    const { source, calls } = setup({ maxAge: 600 });
    await Promise.all([source.get('k1'), source.get('k1'), source.get('k1')]);
    expect(calls).toHaveLength(1);
  });

  it('throws when Google does not answer with keys, and asks again on the next lookup', async () => {
    let fail = true;
    const key = newSigningKey('k1');
    const { fetch: good } = jwksFetch(() => [key], 600);
    const source = jwksKeys({ fetch: async (url) => (fail ? new Response('nope', { status: 503 }) : good(url)) });
    await expect(source.get('k1')).rejects.toThrow('jwks_unavailable');
    fail = false;
    expect(await source.get('k1')).not.toBeNull();
  });

  it('turns a fetch that throws (timeout, DNS) into jwks_unavailable', async () => {
    const source = jwksKeys({
      fetch: async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND www.googleapis.com');
      },
      now: () => 0,
    });
    await expect(source.get('k1')).rejects.toMatchObject({ code: 'jwks_unavailable', message: 'jwks_unavailable' });
  });

  it('ignores keys that are not RSA signing keys (RS256 only: no algorithm confusion)', async () => {
    const rsa = newSigningKey('k1');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const keys = [
      { ...rsa, jwk: { ...ec, kid: 'ec', alg: 'ES256', use: 'sig' } },
      { ...rsa, jwk: { ...rsa.jwk, kid: 'enc', use: 'enc' } },
    ] as TestSigningKey[];
    const source = jwksKeys({ fetch: jwksFetch(() => keys, 600).fetch, now: () => 0 });
    expect(await source.get('ec')).toBeNull();
    expect(await source.get('enc')).toBeNull();
  });
});
