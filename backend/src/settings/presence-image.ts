import type pg from 'pg';

/** The largest picture an admin may upload. */
export const PRESENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export type PresenceType = 'image/png' | 'image/jpeg';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A PNG's or JPEG's type, from its magic bytes, and its size, from its header (the PNG IHDR,
 * the JPEG frame header); null for anything else. The image itself is never decoded.
 */
export function imageShape(bytes: Buffer): { contentType: PresenceType; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Segment by segment: each is 0xFF, its marker, then a length that counts itself.
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill
      continue;
    }
    // SOF0-SOF15, but C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return { contentType: 'image/jpeg', width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** 16:9 give or take a height error of 1% of the width, the bot's own rule (bot/bwat_bot/presence.py). */
export const isSixteenByNine = (width: number, height: number): boolean =>
  width > 0 && height > 0 && Math.abs(width * 9 - height * 16) <= Math.floor((width * 16) / 100);

/** What an audit row records of a picture: never its bytes. */
export type PresenceSummary = { sha256: string; content_type: PresenceType; bytes: number };

export interface PresenceImage {
  contentType: PresenceType;
  bytes: Buffer;
  sha256: string;
}

/** The uploaded picture, or null while the bot shows the default. */
export async function readPresenceImage(db: pg.Pool | pg.ClientBase): Promise<PresenceImage | null> {
  const { rows } = await db.query<{ content_type: PresenceType; bytes: Buffer; sha256: string }>(
    'SELECT content_type, bytes, sha256 FROM presence_image',
  );
  return rows[0] ? { contentType: rows[0].content_type, bytes: rows[0].bytes, sha256: rows[0].sha256 } : null;
}

/** The stored picture's tag (its sha256), without its bytes; null when none. */
export async function presenceImageTag(db: pg.Pool | pg.ClientBase): Promise<string | null> {
  const { rows } = await db.query<{ sha256: string }>('SELECT sha256 FROM presence_image');
  return rows[0]?.sha256 ?? null;
}

/** The stored picture's summary, the row locked for the caller's transaction; null when none. */
export async function lockedSummary(client: pg.ClientBase): Promise<PresenceSummary | null> {
  const { rows } = await client.query<PresenceSummary>(
    'SELECT sha256, content_type, octet_length(bytes) AS bytes FROM presence_image FOR UPDATE',
  );
  return rows[0] ?? null;
}
