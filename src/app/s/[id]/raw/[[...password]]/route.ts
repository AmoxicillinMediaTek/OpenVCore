import { NextResponse } from "next/server";
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
import { formatBytes } from "@/lib/format";
import { ID_RE } from "@/lib/ids";
import { peekSecret } from "@/lib/store";
import type { SecretRecord } from "@/lib/store";
import { isTextualFile } from "@/lib/textual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/s/{id}/raw` answers with a plain text document, so the browser renders it
 * with its built-in viewer rather than an app page.
 *
 * The content key is a hash of the id, and the id is the URL, so this handler can
 * derive it and open the sealed payload by itself. It reads with `peekSecret`, not
 * `consumeSecret`, so viewing the raw text never spends a read. A tab that already
 * opened the secret answers the same URL from `public/raw-sw.js` before the request
 * leaves the browser; this handler is the fallback for everything else — a curl, a
 * second browser, a link pasted into a viewer with no JavaScript.
 *
 * A password-protected link carries its content key wrapped under a PBKDF2 key, so
 * the password has to come along: `/s/{id}/raw/{password}` (or `?p=`). Without it
 * the handler explains how to add one.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; password?: string[] }> },
) {
  const { id, password: segments } = await context.params;
  if (!ID_RE.test(id)) return plain("No secret at this address.", 404);

  const url = new URL(request.url);
  const supplied = resolvePassword(segments, url.searchParams);

  let peeked;
  try {
    peeked = await peekSecret(id);
  } catch {
    return plain("The secret store is not reachable right now. Try again in a moment.", 503);
  }

  if (peeked.status === "expired") return plain("This link has expired.", 410);
  if (peeked.status !== "ok") return plain("This secret is gone.", 404);

  const record = peeked.record;

  let plaintext: Uint8Array;
  if (record.kdf) {
    if (!supplied) {
      // A shell gets the recipe; a browser gets nothing to read.
      if (wantsDocument(request)) return plain("No Access", 403);
      if (isScriptClient(request)) return plain(scriptNotice(url.origin, id), 200, SHELL_TYPE);
      return plain(passwordPrompt(url.origin, id));
    }

    const throttle = checkThrottle(`${id}:${clientKey(request)}`);
    if (!throttle.allowed) {
      return plain("Too many wrong passwords. Try again in a few minutes.", 429);
    }

    try {
      const passKey = await derivePassphraseKey(
        supplied,
        fromBase64(record.kdf.salt),
        record.kdf.iterations,
      );
      const matches = await passphraseMatches(passKey, record.kdf.checkIv, record.kdf.check);
      if (!matches) {
        throttle.fail();
        return wrongPassword(request, url.origin, id);
      }
      throttle.reset();
      const rawKey = await decryptBytes(
        passKey,
        fromBase64(record.kdf.wrapIv),
        fromBase64(record.kdf.wrapped),
      );
      plaintext = await open(record, await importContentKey(rawKey));
    } catch {
      throttle.fail();
      return wrongPassword(request, url.origin, id);
    }
  } else {
    try {
      plaintext = await open(record, await importContentKey(await contentKeyForId(id)));
    } catch {
      return plain("The stored payload could not be opened.", 500);
    }
  }

  // A url link is a redirect, not a document: nothing to print here.
  if (record.kind === "url") return plain("This link has no text view.", 404);

  // The payload is for a shell, not a person: `curl -sSL …/raw | bash` runs it.
  // A browser asking for the same URL gets the door.
  if (wantsDocument(request)) return plain("No Access", 403);

  if (record.kind === "text") {
    return plain(new TextDecoder().decode(plaintext), 200, SHELL_TYPE);
  }

  let files: FileEntry[];
  try {
    files = unpackFiles(plaintext);
  } catch {
    return plain("The stored payload could not be opened.", 500);
  }

  // `?file=` picks one entry: an index from the opened link's rows, or the name.
  const wanted = url.searchParams.get("file");
  if (wanted !== null) {
    const index = /^\d+$/.test(wanted) ? Number(wanted) : files.findIndex((f) => f.name === wanted);
    const file = files[index];
    if (!file) return plain("No file by that name in this link.", 404);
    if (!isTextualFile(file.name, file.type)) {
      return plain(`${file.name} is not text (${file.type || "unknown type"}).`, 415);
    }
    return plain(new TextDecoder().decode(file.bytes));
  }

  const only = files[0];
  if (files.length === 1 && isTextualFile(only.name, only.type)) {
    return plain(new TextDecoder().decode(only.bytes));
  }

  const listing = files.map((file) => `${file.name}\t${formatBytes(file.bytes.length)}`).join("\n");
  return plain(`${files.length} files\n\n${listing}\n\nOpen the link to download them.`);
}

/** Openned payload, decrypted with a key the caller already recovered. */
async function open(record: SecretRecord, key: CryptoKey): Promise<Uint8Array> {
  return decryptBytes(key, fromBase64(record.iv), fromBase64(record.ciphertext));
}

/** Path segment first (`/raw/hunter22`), then `?p=` / `?password=`. */
function resolvePassword(segments: string[] | undefined, params: URLSearchParams): string {
  const fromPath = (segments ?? []).join("/");
  if (fromPath.length > 0) {
    try {
      return decodeURIComponent(fromPath);
    } catch {
      return fromPath;
    }
  }
  return params.get("p") ?? params.get("password") ?? "";
}

function passwordHint(origin: string, id: string): string {
  return `Add the password to the address:\n\n  ${origin}/s/${id}/raw/YOUR-PASSWORD`;
}

function passwordPrompt(origin: string, id: string): string {
  return `No Access\n\n\n${passwordHint(origin, id)}\n\n` +
    `Anything after /raw/ is read as the password, so curl, wget, or any client\n` +
    `without JavaScript can fetch and run it.`;
}

function wrongPassword(request: Request, origin: string, id: string) {
  // Roblox raises on a 4xx and never runs the body, so a script client gets the
  // notice as a 200 it can print. The throttle is server side either way.
  if (isScriptClient(request)) {
    return plain(
      `warn("OpenVCore: wrong password — nothing was spent, nothing was revealed.")`,
      200,
      SHELL_TYPE,
    );
  }
  return plain(`Wrong password.\n\n${passwordHint(origin, id)}`, 401);
}

/* ---- who is asking: a browser document, or a shell ---- */

const SHELL_TYPE = "application/x-sh; charset=utf-8";

const BROWSER_UA = /mozilla|chrome|chromium|safari|firefox|edg\/|opr\/|msie|trident/i;

/** Roblox itself, or an executor that identifies as Roblox. */
const SCRIPT_UA = /roblox|lua|synapse|wave|xeno|delta|fluxus|krnl|solara|argon/i;

/**
 * True when the request looks like a browser navigation. `curl`, `wget` and
 * `fetch()` send a wildcard Accept and no `Mozilla` agent, so they fall through
 * to the payload; a browser sending `text/html` (or any Mozilla-flavoured agent)
 * gets `No Access` instead of a script it would render as a wall of text.
 *
 * Roblox is checked first on purpose: executors commonly send
 * `Mozilla/5.0 … Roblox/WinInet`, and `loadstring(game:HttpGet(…))` must get the
 * script, not the door.
 */
function wantsDocument(request: Request): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  const accept = request.headers.get("accept") ?? "";
  if (SCRIPT_UA.test(agent)) return false;
  return BROWSER_UA.test(agent) || accept.includes("text/html");
}

/**
 * A Lua client cannot read prose: a prompt full of `https://` makes Luau die with
 * `expected identifier when parsing method name, got '//'`. Hand it a line that
 * parses and prints the same instruction to the console instead.
 */
function isScriptClient(request: Request): boolean {
  return SCRIPT_UA.test(request.headers.get("user-agent") ?? "");
}

function scriptNotice(origin: string, id: string): string {
  return `warn("OpenVCore: no access — add the password to the address: ${origin}/s/${id}/raw/YOUR-PASSWORD")`;
}

/* ---- password attempts: per id and client, in memory, best effort ---- */

const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPT_LIMIT = 10;

interface Attempt {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Attempt>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

function checkThrottle(key: string) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    return {
      allowed: true,
      fail() {
        attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      },
      reset() {
        attempts.delete(key);
      },
    };
  }
  if (entry.count >= ATTEMPT_LIMIT) return { allowed: false, fail() {}, reset() {} };
  return {
    allowed: true,
    fail() {
      entry.count += 1;
      if (attempts.size > 5_000) attempts.clear();
    },
    reset() {
      attempts.delete(key);
    },
  };
}

function plain(body: string, status = 200, type = "text/plain; charset=utf-8") {
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      // A password can sit in the path here, so keep it out of any Referer.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
