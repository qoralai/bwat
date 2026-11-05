import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGoogleIdToken } from '../src/google-id-token.ts';
import { CLIENT_ID, idToken, newSigningKey } from './google-fixture.ts';

const key = newSigningKey('kid-1');
const other = newSigningKey('kid-2');
const keys = { get: async (kid: string) => (kid === key.kid ? createPublicKey({ key: key.jwk, format: 'jwk' }) : null) };
const verify = (token: string, clientIds = [CLIENT_ID]) => verifyGoogleIdToken(token, { clientIds, keys });
const now = () => Math.floor(Date.now() / 1000);

describe('verifyGoogleIdToken (QOR-4575)', () => {
  it('accepts a Google ID token signed by a known key, for one of our clients, with a verified email', async () => {
    expect(await verify(idToken(key))).toEqual({ email: 'ada@example.com', hd: 'example.com', sub: '1234567890' });
  });

  it('lower-cases the email it returns', async () => {
    expect(await verify(idToken(key, { email: 'Ada@Example.COM' }))).toEqual({
      email: 'ada@example.com',
      hd: 'example.com',
      sub: '1234567890',
    });
  });

  it("returns the account's name, trimmed, so a member who signs in is shown by name, not email", async () => {
    expect(await verify(idToken(key, { name: '  Ada Lovelace ' }))).toEqual({
      email: 'ada@example.com',
      hd: 'example.com',
      sub: '1234567890',
      name: 'Ada Lovelace',
    });
    expect((await verify(idToken(key)))?.name).toBeUndefined();
    expect((await verify(idToken(key, { name: '  ' })))?.name).toBeUndefined();
  });

  it('accepts both issuer spellings Google documents', async () => {
    expect(await verify(idToken(key, { iss: 'accounts.google.com' }))).not.toBeNull();
    expect(await verify(idToken(key, { iss: 'https://accounts.google.com' }))).not.toBeNull();
  });

  it('accepts any of the configured client ids', async () => {
    expect(await verify(idToken(key), ['other-client', CLIENT_ID])).not.toBeNull();
  });

  it.each([
    ['another issuer', { iss: 'https://accounts.example.com' }],
    ['another audience', { aud: 'someone-else' }],
    ['an audience list', { aud: [CLIENT_ID] }],
    ['an expired token', { exp: now() - 1 }],
    ['no expiry', { exp: undefined }],
    ['an unverified email', { email_verified: false }],
    ['email_verified as a string', { email_verified: 'true' }],
    ['no email_verified', { email_verified: undefined }],
    ['no email', { email: undefined }],
    // sub is Google's stable id for the account: membership is bound to it, not the email.
    ['no sub', { sub: undefined }],
    ['an empty sub', { sub: '' }],
    ['a sub that is not a string', { sub: 1234567890 }],
  ])('refuses %s', async (_name, claims) => {
    expect(await verify(idToken(key, claims))).toBeNull();
  });

  it('refuses a token signed by a key it does not know', async () => {
    expect(await verify(idToken(other))).toBeNull();
  });

  it('refuses a token whose kid names a known key but was signed by another', async () => {
    expect(await verify(idToken({ ...other, kid: key.kid }))).toBeNull();
  });

  it('refuses a token whose payload was changed after signing', async () => {
    const [h, , s] = idToken(key).split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'eve@example.com' })).toString('base64url');
    expect(await verify(`${h}.${forged}.${s}`)).toBeNull();
  });

  it('refuses any algorithm but RS256, and a token with no kid', async () => {
    expect(await verify(idToken(key, {}, { alg: 'none' }))).toBeNull();
    expect(await verify(idToken(key, {}, { alg: 'HS256' }))).toBeNull();
    expect(await verify(idToken(key, {}, { kid: undefined }))).toBeNull();
  });

  it('refuses garbage without throwing', async () => {
    for (const junk of ['', 'a.b', 'a.b.c', '...', `${'x'.repeat(5000)}.y.z`, 'e30.e30.']) {
      expect(await verify(junk), junk.slice(0, 20)).toBeNull();
    }
  });

  it('refuses a validly signed token too large to be a Google ID token, without parsing it', async () => {
    expect(await verify(idToken(key, { pad: 'x'.repeat(2000) }))).not.toBeNull();
    expect(await verify(idToken(key, { pad: 'x'.repeat(4000) }))).toBeNull();
  });

  it('refuses when no client id is configured', async () => {
    expect(await verify(idToken(key), [])).toBeNull();
  });
});
