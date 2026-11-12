import { toBase64 } from "@/lib/crypto";

/**
 * Per-tab handoff for the opened view.
 *
 * The tab that opened a secret carries the plaintext itself, so the raw view and
 * any reload can render it again without asking the server to decrypt anything it
 * cannot decrypt anyway.
 *
 * The reveal → raw direction travels through the service worker and the Cache
 * API instead, because a fact transmitted in `sessionStorage` cannot reach a
 * worker that has to answer a document request. See `lib/raw-bridge.ts`.
 *
 * sessionStorage is scoped to one tab, never leaves the browser, and dies with
 * the tab. Every entry is consumed and deleted on arrival.
 */

const REVEAL_PREFIX = "openvcore.reveal.";

export interface TextHandoff {
  kind: "text";
  text: string;
}

export interface HandoffFile {
  name: string;
  type: string;
  /** base64 of the decrypted bytes. */
  data: string;
}

export interface FileHandoff {
  kind: "file";
  files: HandoffFile[];
}

export type RevealHandoff = TextHandoff | FileHandoff;

function put(key: string, value: unknown): boolean {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function take(key: string): Record<string, unknown> | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return null;
    window.sessionStorage.removeItem(key);
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/* ---- opened view → reveal page ---- */

export function stashRevealText(id: string, text: string): boolean {
  return put(REVEAL_PREFIX + id, { kind: "text", text });
}

export function stashRevealFile(
  id: string,
  files: { name: string; type: string; bytes: Uint8Array }[],
): boolean {
  return put(REVEAL_PREFIX + id, {
    kind: "file",
    files: files.map((file) => ({
      name: file.name,
      type: file.type,
      data: toBase64(file.bytes),
    })),
  });
}

export function takeReveal(id: string): RevealHandoff | null {
  const parsed = take(REVEAL_PREFIX + id);
  if (!parsed) return null;

  if (parsed.kind === "text" && typeof parsed.text === "string") {
    return { kind: "text", text: parsed.text };
  }
  if (parsed.kind === "file" && Array.isArray(parsed.files)) {
    const files = (parsed.files as Record<string, unknown>[])
      .filter(
        (entry) =>
          typeof entry?.name === "string" &&
          typeof entry?.type === "string" &&
          typeof entry?.data === "string",
      )
      .map((entry) => ({
        name: entry.name as string,
        type: entry.type as string,
        data: entry.data as string,
      }));
    if (files.length > 0) return { kind: "file", files };
  }
  return null;
}
