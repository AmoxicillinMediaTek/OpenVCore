import {
  contentKeyForId,
  decryptBytes,
  derivePassphraseKey,
  fromBase64,
  importContentKey,
  passphraseMatches,
  unpackFiles,
  type FileEntry,
} from "@/lib/crypto";
import { LIMITS, type OpenPayload, type SecretInfo } from "@/lib/types";

export interface OpenedText {
  kind: "text";
  text: string;
}

export interface OpenedFile {
  kind: "file";
  files: FileEntry[];
}

export type Opened = OpenedText | OpenedFile;

export type OpenOutcome =
  | { status: "opened"; content: Opened }
  | { status: "password-mismatch" }
  | { status: "gone" };

/**
 * Fetches the sealed payload and decrypts it in this tab.
 * The password is verified against the encrypted check constant before the
 * server is asked for the payload, so a wrong password costs nothing.
 * Throws only for genuine failures (bad key material, broken ciphertext).
 */
export async function openSecret(options: {
  id: string;
  password: string;
  info: SecretInfo;
}): Promise<OpenOutcome> {
  const { id, password, info } = options;

  let passKey: CryptoKey | null = null;
  if (info.locked) {
    if (!info.kdf) throw new Error("This link is missing its key check.");
    if (password.length < LIMITS.minPassphrase) {
      throw new Error(`Password must be at least ${LIMITS.minPassphrase} characters.`);
    }
    passKey = await derivePassphraseKey(
      password,
      fromBase64(info.kdf.salt),
      info.kdf.iterations,
    );
    const matches = await passphraseMatches(passKey, info.kdf.checkIv, info.kdf.check);
    if (!matches) return { status: "password-mismatch" };
  }

  const response = await fetch(`/api/secrets/${id}/open`, { method: "POST" });
  if (!response.ok) return { status: "gone" };

  const payload = (await response.json()) as OpenPayload;

  let contentKey: CryptoKey;
  if (passKey) {
    if (!payload.kdf) throw new Error("The wrapped key is missing.");
    const raw = await decryptBytes(
      passKey,
      fromBase64(payload.kdf.wrapIv),
      fromBase64(payload.kdf.wrapped),
    );
    contentKey = await importContentKey(raw);
  } else {
    contentKey = await importContentKey(await contentKeyForId(id));
  }

  const plaintext = await decryptBytes(
    contentKey,
    fromBase64(payload.iv),
    fromBase64(payload.ciphertext),
  );

  if (payload.kind === "file") {
    return {
      status: "opened",
      content: { kind: "file", files: unpackFiles(plaintext) },
    };
  }

  return {
    status: "opened",
    content: {
      kind: "text",
      text: new TextDecoder().decode(plaintext),
    },
  };
}
