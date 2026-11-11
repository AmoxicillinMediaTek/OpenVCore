import { toBase64 } from "@/lib/crypto";

/**
 * Per-tab handoff for the opened view.
 *
 * When a one-time blob is unlinked the moment its last read is spent, the tab has
 * to carry the plaintext itself. This module keeps the only direction still
 * needed: the raw view (or any reload) handing the opened secret back to
 * `/s/{id}`, so coming back from it never lands on "gone".
 *
 * The reveal → raw direction now travels through the service worker and the
 * Cache API instead, because a fact transmitted in `sessionStorage` cannot reach
 * a worker that has to answer a document request. See `lib/raw-bridge.ts`.
 *
 * sessionStorage is scoped to one tab, never leaves the browser, and dies with
 * the tab. Every entry is consumed and deleted on arrival.
 */

const REVEAL_PREFIX = "schemaload.reveal.";

export interface TextHandoff {
  kind: "text";
  text: string;
  viewsLeft: number | null;
  /** Needed to redraw the burn line on the page that receives it. 0 = no limit. */
  viewsAllowed: number | null;
}

export interface FileHandoff {
  kind: "file";
  name: string;
  type: string;
  /** base64 of the decrypted bytes. */
  data: string;
  viewsLeft: number | null;
  viewsAllowed: number | null;
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/* ---- raw → reveal ---- */

export function stashRevealText(
  id: string,
  text: string,
  viewsLeft: number | null,
  viewsAllowed: number | null,
): boolean {
  return put(REVEAL_PREFIX + id, { kind: "text", text, viewsLeft, viewsAllowed });
}

export function stashRevealFile(
  id: string,
  file: {
    name: string;
    type: string;
    bytes: Uint8Array;
    viewsLeft: number | null;
    viewsAllowed: number | null;
  },
): boolean {
  return put(REVEAL_PREFIX + id, {
    kind: "file",
    name: file.name,
    type: file.type,
    data: toBase64(file.bytes),
    viewsLeft: file.viewsLeft,
    viewsAllowed: file.viewsAllowed,
  });
}

export function takeReveal(id: string): RevealHandoff | null {
  const parsed = take(REVEAL_PREFIX + id);
  if (!parsed) return null;
  const viewsLeft = numberOrNull(parsed.viewsLeft);
  const viewsAllowed = numberOrNull(parsed.viewsAllowed);

  if (parsed.kind === "text" && typeof parsed.text === "string") {
    return { kind: "text", text: parsed.text, viewsLeft, viewsAllowed };
  }
  if (
    parsed.kind === "file" &&
    typeof parsed.name === "string" &&
    typeof parsed.type === "string" &&
    typeof parsed.data === "string"
  ) {
    return {
      kind: "file",
      name: parsed.name,
      type: parsed.type,
      data: parsed.data,
      viewsLeft,
      viewsAllowed,
    };
  }
  return null;
}
