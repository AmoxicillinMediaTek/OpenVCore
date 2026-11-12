import { NextResponse } from "next/server";
import { storeFailure } from "@/lib/api-errors";
import { consumeSecret, type ReadResult } from "@/lib/store";
import type { OpenPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Spends one view and returns the sealed payload.
 * The key needed to open it is not here: it is derived in the browser from the
 * id, or unwrapped from the passphrase, neither of which this process has seen.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let result: ReadResult & { viewsLeft?: number | null };
  try {
    result = await consumeSecret(id);
  } catch (cause) {
    const failure = storeFailure(cause);
    if (failure) return failure;
    throw cause;
  }

  if (result.status !== "ok") {
    const gone =
      result.status === "missing"
        ? { error: "This secret does not exist.", status: 404 }
        : result.status === "expired"
          ? { error: "This secret expired.", status: 410 }
          : { error: "This secret was deleted.", status: 410 };
    return NextResponse.json({ error: gone.error }, { status: gone.status, headers: NO_STORE });
  }

  const { record, viewsLeft } = result;
  const payload: OpenPayload = {
    ciphertext: record.ciphertext,
    iv: record.iv,
    kind: record.kind,
    viewsLeft: viewsLeft ?? null,
    expiresAt: record.expiresAt,
    kdf: record.kdf ? { wrapped: record.kdf.wrapped, wrapIv: record.kdf.wrapIv } : null,
  };

  return NextResponse.json(payload, { headers: NO_STORE });
}
