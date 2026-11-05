import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM: a random 12-byte nonce per seal, caller-given associated data, and a
 * full 16-byte tag appended to the ciphertext. From our own prototype admin panel
 * (docs/provenance.md).
 */
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * True when nonce and sealed have the shape seal() produces: a 12-byte nonce, and a full
 * 16-byte tag plus at least one byte of ciphertext. GCM would otherwise accept a short tag.
 */
export function wellFormed(nonce: Buffer, sealed: Buffer): boolean {
  return nonce.length === NONCE_BYTES && sealed.length > TAG_BYTES;
}

export function seal(plain: Buffer, key: Buffer, aad: Buffer): { nonce: Buffer; sealed: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { nonce, sealed };
}

/**
 * The plaintext of a seal() result. Throws on a malformed value and when the tag does
 * not verify: tampered, wrong key or different associated data. The error never
 * includes the key, the sealed value or the plaintext.
 */
export function open(nonce: Buffer, sealed: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (!wellFormed(nonce, sealed)) throw new Error('aead: malformed sealed value');
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  // final() throws when the tag does not verify.
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
}
