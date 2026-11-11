import { NextResponse } from "next/server";
import { storeFailure } from "@/lib/api-errors";
import { createSecret, sweepExpired } from "@/lib/store";
import { LIMITS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// 10 MB of raw bytes becomes ~13.98 MB of base64. Leave a little room.
const MAX_CIPHERTEXT_CHARS = Math.ceil((LIMITS.maxFileBytes * 4) / 3) + 4096;

function isBase64(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_CIPHERTEXT_CHARS) return false;
  if (value.length % 4 !== 0 || !B64_RE.test(value)) return false;
  if (expectedBytes !== undefined) {
    return Buffer.from(value, "base64").length === expectedBytes;
  }
  return true;
}

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("Body must be JSON.");
  }

  if (!isBase64(body.ciphertext)) return fail("ciphertext must be base64.");
  if (!isBase64(body.iv, 12)) return fail("iv must be 12 bytes of base64.");

  const kind = body.kind === "file" ? "file" : body.kind === "text" ? "text" : null;
  if (!kind) return fail("kind must be text or file.");

  const views = Number(body.views ?? 1);
  if (!Number.isInteger(views) || views < 0 || views > LIMITS.maxViews) {
    return fail(`views must be 0 (no limit) or an integer from 1 to ${LIMITS.maxViews}.`);
  }

  const ttlHours = Number(body.ttlHours ?? 24);
  if (!Number.isFinite(ttlHours) || ttlHours < 0 || ttlHours > LIMITS.maxTtlHours) {
    return fail(
      `ttlHours must be 0 (never expires) or between 1 and ${LIMITS.maxTtlHours}.`,
    );
  }
  if (ttlHours > 0 && ttlHours < 1) {
    return fail(`ttlHours must be at least 1, or 0 for no expiry.`);
  }

  let kdf = null;
  if (body.kdf !== undefined && body.kdf !== null) {
    const raw = body.kdf as Record<string, unknown>;
    if (!isBase64(raw.salt, 16)) return fail("kdf.salt must be 16 bytes of base64.");
    if (!isBase64(raw.checkIv, 12) || !isBase64(raw.check)) return fail("kdf check is invalid.");
    if (!isBase64(raw.wrapIv, 12) || !isBase64(raw.wrapped)) return fail("kdf wrap is invalid.");
    const iterations = Number(raw.iterations);
    if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
      return fail("kdf.iterations is out of range.");
    }
    kdf = {
      salt: raw.salt as string,
      iterations,
      checkIv: raw.checkIv as string,
      check: raw.check as string,
      wrapIv: raw.wrapIv as string,
      wrapped: raw.wrapped as string,
    };
  }

  const ciphertext = body.ciphertext as string;
  const bytes = Buffer.from(ciphertext, "base64").length;

  let note = null;
  if (body.note !== undefined && body.note !== null) {
    const raw = body.note as Record<string, unknown>;
    if (!isBase64(raw.ciphertext)) return fail("note.ciphertext must be base64.");
    if (!isBase64(raw.iv, 12)) return fail("note.iv must be 12 bytes of base64.");
    note = {
      ciphertext: raw.ciphertext as string,
      iv: raw.iv as string,
    };
  }

  let record: Awaited<ReturnType<typeof createSecret>>;
  try {
    record = await createSecret({
      ciphertext,
      iv: body.iv,
      kind,
      bytes,
      views,
      ttlHours,
      kdf,
      note,
    });

    // Await the sweep so the response stream closes cleanly; a floating promise
    // keeps the connection open in the browser.
    await sweepExpired();
  } catch (cause) {
    const failure = storeFailure(cause);
    if (failure) return failure;
    throw cause;
  }

  return NextResponse.json(
    {
      id: record.id,
      expiresAt: record.expiresAt,
      viewsAllowed: record.viewsAllowed,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
