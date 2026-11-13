export type SecretKind = "text" | "file" | "url";

/**
 * Everything the browser needs to derive the passphrase key before spending a
 * read: the salt, the check constant, and the wrapped content key. None of it
 * is secret — the check constant already lets a holder test guesses offline, so
 * shipping the wrapped key alongside it adds no new attack.
 */
export interface KdfPublic {
  salt: string;
  iterations: number;
  checkIv: string;
  check: string;
  wrapIv: string;
  wrapped: string;
}

export interface KdfSecret {
  wrapped: string;
  wrapIv: string;
}

/** A short line from the sender, sealed under the same content key. */
export interface SealedNote {
  ciphertext: string;
  iv: string;
}

/** What the API will say about a secret without consuming a read. */
export interface SecretInfo {
  id: string;
  kind: SecretKind;
  /** null when the link has no read limit. */
  viewsLeft: number | null;
  /** 0 means no read limit. */
  viewsAllowed: number;
  /** 0 means the link never expires. */
  expiresAt: number;
  locked: boolean;
  bytes: number;
  kdf: KdfPublic | null;
  /** Sealed sender note, decrypted in the tab before the read is spent. */
  note: SealedNote | null;
}

export interface CreatePayload {
  /** Eight characters, chosen by the client because the content key derives from it. */
  id: string;
  ciphertext: string;
  iv: string;
  kind: SecretKind;
  /** 0 means the link never expires. */
  ttlHours: number;
  bytes: number;
  kdf?: KdfPublic & KdfSecret;
  note?: SealedNote | null;
}

export interface OpenPayload {
  ciphertext: string;
  iv: string;
  kind: SecretKind;
  /** null when the link has no read limit. */
  viewsLeft: number | null;
  /** 0 means the link never expires. */
  expiresAt: number;
  kdf: KdfSecret | null;
}

export const CHECK_TOKEN = "openvcore.check.v1";

export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTextChars: 100_000,
  maxNoteChars: 160,
  minPassphrase: 8,
  maxTtlHours: 720,
  kdfIterations: 310_000,
} as const;

export const TTL_OPTIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
  { hours: 0, label: "No expiry" },
] as const;

