/**
 * The share link is `/s/{id}` and nothing else — no fragment, no long key in the
 * URL. The id is both the address and the material the content key is derived
 * from, so an eight character id carries the whole secret identity:
 *
 *   link  = https://host/s/7fq2m1xa
 *   key   = SHA-256("openvcore.key.v1:" + id)
 *
 * The client picks the id before it encrypts, so the key it uses and the address
 * it shares can never disagree.
 */

export const ID_LENGTH = 8;
export const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const ID_RE = /^[a-z0-9]{8}$/;

/** 36^8 ≈ 2.8e12 addresses. Rejection sampling keeps the distribution flat. */
export function newSecretId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH * 4));
  let out = "";
  for (let i = 0; i < bytes.length && out.length < ID_LENGTH; i += 1) {
    if (bytes[i] >= 252) continue; // 252 = 7 * 36, so the modulo stays uniform
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}
