import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { imageShape } from '../src/settings/presence-image.ts';
import { bearer, registerBot } from './app.ts';
import { asSuperuser, describeDb, ROLE_NAMES } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, useRoles } from './people.ts';

/** A PNG's signature and IHDR chunk: all the backend reads of one. */
export function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth; colour type, compression, filter, interlace 0; CRC unchecked
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** A JPEG's start, an APP0 segment, then a baseline SOF0 frame header naming its size. */
export function jpeg(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(sof, 1);
  frame.writeUInt16BE(17, 2);
  frame.writeUInt8(8, 4);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame]);
}

/** A DHT segment before the frame header: a marker in the SOF range that is not one. */
const jpegWithTableFirst = (width: number, height: number) => {
  const plain = jpeg(width, height);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x05, 0x00, 0x09]);
  return Buffer.concat([plain.subarray(0, 20), dht, plain.subarray(20)]);
};

describe('the presence image header check', () => {
  it('reads a PNG and a JPEG by their magic bytes and their own size fields', () => {
    expect(imageShape(png(1920, 1080))).toEqual({ contentType: 'image/png', width: 1920, height: 1080 });
    expect(imageShape(jpeg(1280, 720))).toEqual({ contentType: 'image/jpeg', width: 1280, height: 720 });
    expect(imageShape(jpeg(1600, 900, 0xc2))).toEqual({ contentType: 'image/jpeg', width: 1600, height: 900 });
    expect(imageShape(jpegWithTableFirst(1280, 720))).toEqual({ contentType: 'image/jpeg', width: 1280, height: 720 });
  });

  it('is not an image: anything else, or a header cut short', () => {
    expect(imageShape(Buffer.from('GIF89a........................'))).toBeNull();
    expect(imageShape(png(1280, 720).subarray(0, 20))).toBeNull();
    expect(imageShape(jpeg(1280, 720).subarray(0, 24))).toBeNull();
    expect(imageShape(Buffer.alloc(0))).toBeNull();
  });
});

describeDb('the presence image (QOR-4846)', () => {
  const t = useRoles();
  const put = (body: Buffer, headers: Record<string, string> = ADMIN, contentType = 'image/png') =>
    t.app.inject({ method: 'PUT', url: '/console/settings/presence-image', headers: { ...headers, 'content-type': contentType }, payload: body });
  const consoleGet = (headers: Record<string, string> = ADMIN) => t.app.inject({ method: 'GET', url: '/console/settings/presence-image', headers });
  const remove = (headers: Record<string, string> = ADMIN) => t.app.inject({ method: 'DELETE', url: '/console/settings/presence-image', headers });
  const botGet = (token: string, etag?: string) =>
    t.app.inject({ method: 'GET', url: '/bot/presence-image', headers: { ...bearer(token), ...(etag && { 'if-none-match': etag }) } });
  const auditRows = async () =>
    (await t.pool.query(`SELECT actor_id AS actor, action, before, after FROM audit WHERE target_type = 'presence_image' ORDER BY at, id`)).rows;

  it('is the default until an admin uploads one: 204 to the console and to a bot', async () => {
    await remove();
    expect((await consoleGet()).statusCode).toBe(204);
    const { bot_token } = await registerBot(t);
    expect((await botGet(bot_token)).statusCode).toBe(204);
  });

  it('refuses nobody (401) and a member (403) on every console route, and stores nothing', async () => {
    for (const headers of [{}, MEMBER]) {
      const status = headers === MEMBER ? 403 : 401;
      expect((await put(png(1280, 720), headers)).statusCode).toBe(status);
      expect((await consoleGet(headers)).statusCode).toBe(status);
      expect((await remove(headers)).statusCode).toBe(status);
    }
    expect((await consoleGet()).statusCode).toBe(204);
  });

  it('answers a bot only with its bot token, as /bot/settings does', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/bot/presence-image' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/bot/presence-image', headers: ADMIN })).statusCode).toBe(401);
  });

  it('stores an admin upload, serves it to the console and to bots with an ETag, and a bot that has it gets 304', async () => {
    const picture = png(1920, 1080);
    const saved = await put(picture);
    expect(saved.statusCode).toBe(204);

    const read = await consoleGet(OWNER);
    expect(read.statusCode).toBe(200);
    expect(read.headers['content-type']).toBe('image/png');
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.rawPayload.equals(picture)).toBe(true);

    const { bot_token } = await registerBot(t);
    const served = await botGet(bot_token);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.rawPayload.equals(picture)).toBe(true);
    const etag = `"${createHash('sha256').update(picture).digest('hex')}"`;
    expect(served.headers.etag).toBe(etag);
    const again = await botGet(bot_token, etag);
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect((await botGet(bot_token, '"something-else"')).statusCode).toBe(200);
  });

  it('takes a JPEG, typed by its bytes, and a new upload replaces the old one', async () => {
    const picture = jpeg(1280, 720);
    expect((await put(picture, OWNER, 'image/jpeg')).statusCode).toBe(204);
    const read = await consoleGet();
    expect(read.headers['content-type']).toBe('image/jpeg');
    expect(read.rawPayload.equals(picture)).toBe(true);
  });

  // The panel sends image/png for any picture whose browser type is not JPEG (QOR-5023): the bytes decide.
  it('stores a JPEG sent as image/png as the JPEG it is', async () => {
    const picture = jpeg(1280, 720);
    expect((await put(picture, OWNER, 'image/png')).statusCode).toBe(204);
    const read = await consoleGet();
    expect(read.headers['content-type']).toBe('image/jpeg');
    expect(read.rawPayload.equals(picture)).toBe(true);
  });

  it('goes back to the default on DELETE', async () => {
    await put(png(1280, 720));
    expect((await remove()).statusCode).toBe(204);
    expect((await consoleGet()).statusCode).toBe(204);
    const { bot_token } = await registerBot(t);
    expect((await botGet(bot_token)).statusCode).toBe(204);
  });

  it('refuses a picture that is not 16:9 within 1% of its width, as the bot does', async () => {
    for (const [width, height] of [[1000, 1000], [1280, 1024], [720, 1280], [1280, 707], [1280, 733]] as const) {
      const res = await put(png(width, height));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'not_16_9' });
    }
    // A height error of up to 1% of the width is still 16:9 (presence.py).
    expect((await put(png(1280, 721))).statusCode).toBe(204);
    expect((await put(png(1280, 708))).statusCode).toBe(204);
    expect((await put(png(1280, 732))).statusCode).toBe(204);
  });

  it('refuses a picture larger than 3840x2160, so a bot never renders a huge one', async () => {
    const res = await put(png(4000, 2250));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'too_many_pixels' });
    expect((await put(png(3840, 2160))).statusCode).toBe(204);
  });

  it('refuses what is not a PNG or JPEG whatever its content type says (400), and any other content type (415)', async () => {
    const gif = await put(Buffer.from('GIF89a' + 'x'.repeat(40)));
    expect(gif.statusCode).toBe(400);
    expect(gif.json()).toEqual({ error: 'not_an_image' });
    const json = await put(Buffer.from('{"a":1}'), ADMIN, 'application/json');
    expect(json.statusCode).toBe(415);
    expect((await put(png(1280, 720), ADMIN, 'image/gif')).statusCode).toBe(415);
  });

  it('refuses a picture over 2 MB with 413 too_large', async () => {
    const big = Buffer.concat([png(1280, 720), Buffer.alloc(2 * 1024 * 1024)]);
    const res = await put(big);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'too_large' });
    expect((await put(Buffer.concat([png(1280, 720), Buffer.alloc(2 * 1024 * 1024 - 33)]))).statusCode).toBe(204);
  });

  it('audits each upload and each return to the default by its digest, never its bytes', async () => {
    await remove();
    const before = (await auditRows()).length;
    const picture = png(1600, 900);
    const sha256 = createHash('sha256').update(picture).digest('hex');
    await put(picture);
    await remove();
    await remove(); // already the default: nothing changed, nothing audited
    const rows = (await auditRows()).slice(before);
    expect(rows).toEqual([
      { actor: ADMIN_ID, action: 'presence_image.set', before: null, after: { sha256, content_type: 'image/png', bytes: picture.length } },
      { actor: ADMIN_ID, action: 'presence_image.removed', before: { sha256, content_type: 'image/png', bytes: picture.length }, after: null },
    ]);
  });

  it('gives the runtime role only what it needs on the table', async () => {
    const rows = await asSuperuser(
      async (su) =>
        (
          await su.query(
            `SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
              WHERE has_table_privilege($1, 'bwat.presence_image', p) ORDER BY p`,
            [ROLE_NAMES.runtime],
          )
        ).rows.map((r) => r.p),
      t.db.name,
    );
    expect(rows).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
