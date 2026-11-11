import { CHECK_TOKEN, LIMITS } from "@/lib/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const IV_BYTES = 12;
export const SALT_BYTES = 16;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** URL-safe, unpadded. The fragment of the share link. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return fromBase64(padded + "=".repeat(padLength));
}

export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptBytes(
  key: CryptoKey,
  data: BufferSource,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

export async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

export async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = LIMITS.kdfIterations,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt the raw content key under the passphrase key, plus a public check value. */
export async function wrapContentKey(passphraseKey: CryptoKey, rawKey: Uint8Array) {
  const wrapped = await encryptBytes(passphraseKey, rawKey);
  const check = await encryptBytes(passphraseKey, encoder.encode(CHECK_TOKEN));
  return {
    wrapped: toBase64(wrapped.ciphertext),
    wrapIv: toBase64(wrapped.iv),
    check: toBase64(check.ciphertext),
    checkIv: toBase64(check.iv),
  };
}

/** Returns true when the passphrase produced the right key. No server round trip. */
export async function passphraseMatches(
  key: CryptoKey,
  checkIv: string,
  check: string,
): Promise<boolean> {
  try {
    const plain = await decryptBytes(key, fromBase64(checkIv), fromBase64(check));
    return decoder.decode(plain) === CHECK_TOKEN;
  } catch {
    return false;
  }
}

/* ---- file envelope: 4-byte header length + JSON header + raw bytes ---- */

export interface FileEnvelope {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export function packFile(name: string, type: string, data: Uint8Array): Uint8Array {
  const header = encoder.encode(JSON.stringify({ name, type }));
  const out = new Uint8Array(4 + header.length + data.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(data, 4 + header.length);
  return out;
}

export function unpackFile(buffer: Uint8Array): FileEnvelope {
  if (buffer.length < 4) throw new Error("File envelope is truncated.");
  const headerLength = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
  if (4 + headerLength > buffer.length) throw new Error("File envelope is truncated.");
  const header = JSON.parse(decoder.decode(buffer.subarray(4, 4 + headerLength))) as {
    name?: string;
    type?: string;
  };
  return {
    name: header.name || "secret.bin",
    type: header.type || "application/octet-stream",
    bytes: buffer.subarray(4 + headerLength),
  };
}
