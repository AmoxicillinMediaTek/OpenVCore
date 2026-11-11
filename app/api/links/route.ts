import { NextResponse } from "next/server";
import { storeFailure } from "@/lib/api-errors";
import { logLink, ledgerConfigured, type LedgerRow } from "@/lib/ledger";
import { peekSecret } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID_RE = /^[a-f0-9]{16}$/;
const MAX_LINK_CHARS = 4096;
const MAX_PASSWORD_CHARS = 512;
const MAX_UA_CHARS = 512;

function fail(message: string, status = 400) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The requester's address. Behind a proxy the leftmost entry of
 * `x-forwarded-for` is the client; the rest are hops. Falls back to
 * `x-real-ip`, then to a marker so the column is never silently empty.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

export async function POST(request: Request) {
  if (!ledgerConfigured) {
    return fail("The ledger is not configured on this server.", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("Body must be JSON.");
  }

  const { id, link, password } = body;

  if (typeof id !== "string" || !ID_RE.test(id)) {
    return fail("id must be a 16 character hex string.");
  }
  if (typeof link !== "string" || link.length === 0 || link.length > MAX_LINK_CHARS) {
    return fail("link must be a URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return fail("link must be an absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("link must be http or https.");
  }
  if (parsed.pathname !== `/s/${id}`) {
    return fail("link does not point at the id it names.");
  }

  let secretPassword: string | null = null;
  if (password !== undefined && password !== null && password !== "") {
    if (typeof password !== "string" || password.length > MAX_PASSWORD_CHARS) {
      return fail("password must be a string of at most 512 characters.");
    }
    secretPassword = password;
  }

  // The row is derived from the stored secret, not from the request, so a caller
  // cannot invent a kind, a read count or an expiry that the link does not have.
  let peeked: Awaited<ReturnType<typeof peekSecret>>;
  try {
    peeked = await peekSecret(id);
  } catch (cause) {
    const failure = storeFailure(cause);
    if (failure) return failure;
    throw cause;
  }
  if (peeked.status !== "ok") {
    return fail("That link does not exist.", 404);
  }

  const row: LedgerRow = {
    id,
    ip: clientIp(request),
    user_agent: request.headers.get("user-agent")?.slice(0, MAX_UA_CHARS) ?? null,
    link,
    password: secretPassword,
    kind: peeked.record.kind,
    locked: peeked.record.kdf !== null,
    views_allowed: peeked.record.viewsAllowed,
    expires_at: peeked.record.expiresAt,
  };

  const result = await logLink(row);
  if (!result.ok) {
    // The link itself is already live on this server. A ledger miss is reported
    // so it can be retried, but it never invalidates what the person holds.
    return NextResponse.json(
      { logged: false, error: result.error },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { logged: true },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
