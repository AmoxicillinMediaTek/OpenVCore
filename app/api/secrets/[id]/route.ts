import { NextResponse } from "next/server";
import { storeFailure } from "@/lib/api-errors";
import { destroySecret, peekSecret, sweepExpired, type ReadResult } from "@/lib/store";
import type { SecretInfo } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const GONE = {
  missing: { error: "This secret does not exist.", status: 404 },
  expired: { error: "This secret expired.", status: 410 },
  consumed: { error: "This secret was already read and deleted.", status: 410 },
} as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let result: ReadResult;
  try {
    // Sweeping inline keeps no background async work tied to this response,
    // which otherwise leaves the 404 body stream open in the browser.
    await sweepExpired();
    result = await peekSecret(id);
  } catch (cause) {
    const failure = storeFailure(cause);
    if (failure) return failure;
    throw cause;
  }

  if (result.status !== "ok") {
    const gone = GONE[result.status];
    return NextResponse.json({ error: gone.error }, { status: gone.status, headers: NO_STORE });
  }

  const { record } = result;
  const info: SecretInfo = {
    id: record.id,
    kind: record.kind,
    viewsLeft:
      record.viewsAllowed === 0 ? null : record.viewsAllowed - record.viewsUsed,
    viewsAllowed: record.viewsAllowed,
    expiresAt: record.expiresAt,
    locked: record.kdf !== null,
    bytes: record.bytes,
    kdf: record.kdf
      ? {
          salt: record.kdf.salt,
          iterations: record.kdf.iterations,
          checkIv: record.kdf.checkIv,
          check: record.kdf.check,
          wrapIv: record.kdf.wrapIv,
          wrapped: record.kdf.wrapped,
        }
      : null,
    note: record.note ?? null,
  };

  return NextResponse.json(info, { headers: NO_STORE });
}

/** Burn a link early. The owner gets this too; so does anyone holding the id. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let destroyed: boolean;
  try {
    destroyed = await destroySecret(id);
  } catch (cause) {
    const failure = storeFailure(cause);
    if (failure) return failure;
    throw cause;
  }
  return NextResponse.json(
    { destroyed },
    { status: destroyed ? 200 : 404, headers: NO_STORE },
  );
}
