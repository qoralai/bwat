import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zoomAppContext } from '../src/zoom-app-context.ts';

const SECRET = 'board-app-client-secret';
const NOW_MS = 1_791_000_000_000;

/**
 * A context minted the way Zoom does: AES-256-GCM under SHA-256(client secret), laid out as
 * [ivLen:1][iv][aadLen:2 LE][aad][cipherLen:4 LE][cipher][tag:16], base64url.
 */
function mint(payload: unknown, opts: { secret?: string; bigEndian?: boolean; tamper?: boolean } = {}): string {
  const key = createHash('sha256').update(opts.secret ?? SECRET).digest();
  const iv = randomBytes(12);
  const aad = Buffer.from('zoom');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (opts.tamper) body[0] = (body[0] ?? 0) ^ 1;
  const aadLen = Buffer.alloc(2);
  const bodyLen = Buffer.alloc(4);
  if (opts.bigEndian) {
    aadLen.writeUInt16BE(aad.length);
    bodyLen.writeUInt32BE(body.length);
  } else {
    aadLen.writeUInt16LE(aad.length);
    bodyLen.writeUInt32LE(body.length);
  }
  return Buffer.concat([Buffer.from([iv.length]), iv, aadLen, aad, bodyLen, body, tag]).toString('base64url');
}

const context = { typ: 'panel', uid: 'zoomUser_123-ab', mid: 'meetingUuid==', ts: NOW_MS - 1000, exp: NOW_MS + 60_000 };

describe("Zoom's signed app context (x-zoom-app-context)", () => {
  it('opens a context minted like Zoom, with little-endian lengths', () => {
    expect(zoomAppContext(mint(context), SECRET, NOW_MS)).toEqual({ uid: 'zoomUser_123-ab', mid: 'meetingUuid==', issuedAtMs: NOW_MS - 1000 });
  });

  it('refuses one with big-endian lengths (the mistake that shipped once)', () => {
    expect(zoomAppContext(mint(context, { bigEndian: true }), SECRET, NOW_MS)).toBeNull();
  });

  it('refuses one sealed with another secret', () => {
    expect(zoomAppContext(mint(context, { secret: 'someone else' }), SECRET, NOW_MS)).toBeNull();
  });

  it('refuses a tampered one', () => {
    expect(zoomAppContext(mint(context, { tamper: true }), SECRET, NOW_MS)).toBeNull();
  });

  it('refuses an expired one, whether exp is in milliseconds or seconds', () => {
    expect(zoomAppContext(mint({ ...context, exp: NOW_MS - 1 }), SECRET, NOW_MS)).toBeNull();
    expect(zoomAppContext(mint({ ...context, exp: Math.floor(NOW_MS / 1000) - 1 }), SECRET, NOW_MS)).toBeNull();
    expect(zoomAppContext(mint({ ...context, exp: Math.floor(NOW_MS / 1000) + 60 }), SECRET, NOW_MS)).not.toBeNull();
    // Zoom documents exp on every context; one without it is not Zoom's.
    const noExp: Record<string, unknown> = { ...context };
    delete noExp.exp;
    expect(zoomAppContext(mint(noExp), SECRET, NOW_MS)).toBeNull();
  });

  it('refuses one without a uid, and anything that is not a context', () => {
    expect(zoomAppContext(mint({ ...context, uid: '' }), SECRET, NOW_MS)).toBeNull();
    expect(zoomAppContext('not-a-context', SECRET, NOW_MS)).toBeNull();
    expect(zoomAppContext('', SECRET, NOW_MS)).toBeNull();
    expect(zoomAppContext(mint(context), '', NOW_MS)).toBeNull();
  });
});
