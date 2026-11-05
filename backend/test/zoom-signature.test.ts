import { describe, expect, it } from 'vitest';
import { SIGNATURE_WINDOW_MS, urlValidation, verifyZoomRequest, zoomSignature } from '../src/zoom-signature.ts';

// Vectors computed outside this code, with Python's hmac module.
const SECRET = 'test-secret-token';
const BODY = '{"event":"meeting.started"}';
const SIGNED = 'v0=1d221fda5232ba29d6968b2ddf7edb04a5b3d36cf500b017fbc9e9e08b97c725';
const AT = 1_700_000_000; // seconds, as Zoom sends x-zm-request-timestamp

const request = (over: Partial<Parameters<typeof verifyZoomRequest>[0]> = {}) => ({
  secret: SECRET,
  signature: SIGNED,
  timestamp: String(AT),
  rawBody: Buffer.from(BODY),
  nowMs: AT * 1000,
  ...over,
});

describe('Zoom webhook signature (QOR-4576)', () => {
  it('signs v0:{timestamp}:{raw body} with HMAC-SHA256 under the secret token', () => {
    expect(zoomSignature(SECRET, String(AT), Buffer.from(BODY))).toBe(SIGNED);
  });

  it('accepts a request signed with the secret within five minutes either side', () => {
    expect(verifyZoomRequest(request())).toBe('ok');
    expect(verifyZoomRequest(request({ nowMs: AT * 1000 + SIGNATURE_WINDOW_MS }))).toBe('ok');
    expect(verifyZoomRequest(request({ nowMs: AT * 1000 - SIGNATURE_WINDOW_MS }))).toBe('ok');
    expect(SIGNATURE_WINDOW_MS).toBe(5 * 60_000);
  });

  it('refuses a request outside the five-minute window', () => {
    expect(verifyZoomRequest(request({ nowMs: AT * 1000 + SIGNATURE_WINDOW_MS + 1000 }))).toBe('stale');
    expect(verifyZoomRequest(request({ nowMs: AT * 1000 - SIGNATURE_WINDOW_MS - 1000 }))).toBe('stale');
  });

  it('refuses a missing or malformed timestamp', () => {
    for (const timestamp of [undefined, '', 'soon', '1700000000.5', '-1']) {
      expect(verifyZoomRequest(request({ timestamp })), String(timestamp)).toBe('stale');
    }
  });

  it('refuses a wrong, missing or differently sized signature, and an edited body', () => {
    expect(verifyZoomRequest(request({ signature: SIGNED.replace(/.$/, '0') }))).toBe('bad_signature');
    expect(verifyZoomRequest(request({ signature: undefined }))).toBe('bad_signature');
    expect(verifyZoomRequest(request({ signature: 'v0=abc' }))).toBe('bad_signature');
    expect(verifyZoomRequest(request({ rawBody: Buffer.from(BODY + ' ') }))).toBe('bad_signature');
    expect(verifyZoomRequest(request({ secret: 'another-secret' }))).toBe('bad_signature');
  });

  it('signs the timestamp too: a replay under a fresh timestamp fails', () => {
    expect(verifyZoomRequest(request({ timestamp: String(AT + 1), nowMs: (AT + 1) * 1000 }))).toBe('bad_signature');
  });

  it('answers endpoint validation with the plain token and its HMAC', () => {
    expect(urlValidation(SECRET, 'qgg8vlvZRS6UYooatFL8Aw')).toEqual({
      plainToken: 'qgg8vlvZRS6UYooatFL8Aw',
      encryptedToken: '9c8ad56737c19db2904b301c0781e86857e999f39f07727668cf62a5e7e298c8',
    });
  });
});
