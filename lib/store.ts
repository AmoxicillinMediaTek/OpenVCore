import crypto from "node:crypto";
import type { KdfPublic, KdfSecret, SealedNote, SecretKind } from "@/lib/types";

/**
 * Secrets live in Postgres (`public.secrets`), not on disk, so links survive a
 * rebuild, a redeploy, or a file sync wiping the project directory.
 *
 * The table is sealed: RLS is on with no policies, and every grant is revoked
 * from `anon` / `authenticated`. All access goes through five `security definer`
 * functions exposed over PostgREST, and the publishable key in `.env.local` can
 * only call those. Possession of the 16 character id is the authorisation, which
 * is the same rule `/s/{id}` already follows.
 */

export interface SecretRecord {
  id: string;
  createdAt: number;
  /** 0 means the link never expires. */
  expiresAt: number;
  /** 0 means the link has no read limit. */
  viewsAllowed: number;
  viewsUsed: number;
  kind: SecretKind;
  bytes: number;
  ciphertext: string;
  iv: string;
  kdf: (KdfPublic & KdfSecret) | null;
  /** Sender note, sealed under the content key. Null when none was written. */
  note: SealedNote | null;
}

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "") ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

export const storeConfigured = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;

export class StoreUnavailableError extends Error {
  constructor(message = "The secret store is not reachable.") {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!storeConfigured) {
    throw new StoreUnavailableError(
      "SUPABASE_URL and SUPABASE_KEY must be set for the secret store.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch (cause) {
    throw new StoreUnavailableError(
      cause instanceof Error ? cause.message : "The secret store timed out.",
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new StoreUnavailableError(`${response.status} ${detail}`.trim());
  }

  return (await response.json()) as T;
}

interface RpcRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  viewsAllowed: number;
  viewsUsed: number;
  kind: SecretKind;
  bytes: number;
  ciphertext: string;
  iv: string;
  kdf: (KdfPublic & KdfSecret) | null;
  note: SealedNote | null;
}

type RpcResult =
  | { status: "missing" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "ok"; record: RpcRecord; views_left: number | null };

type CreatedRow = { id: string; expiresAt: number; viewsAllowed: number };

const ID_RE = /^[a-f0-9]{16}$/;

function newId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function toRecord(raw: RpcRecord): SecretRecord {
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    viewsAllowed: raw.viewsAllowed,
    viewsUsed: raw.viewsUsed,
    kind: raw.kind,
    bytes: raw.bytes,
    ciphertext: raw.ciphertext,
    iv: raw.iv,
    kdf: raw.kdf ?? null,
    note: raw.note ?? null,
  };
}

export async function createSecret(input: {
  ciphertext: string;
  iv: string;
  kind: SecretKind;
  bytes: number;
  views: number;
  ttlHours: number;
  kdf?: (KdfPublic & KdfSecret) | null;
  note?: SealedNote | null;
}): Promise<SecretRecord> {
  let inserted: CreatedRow | null = null;
  let id = newId();

  // `sl_create` inserts with ON CONFLICT DO NOTHING and answers null when the id
  // already exists, so a collision just means another roll of the dice.
  for (let attempt = 0; attempt < 4 && !inserted; attempt += 1) {
    inserted = await rpc<CreatedRow | null>("sl_create", {
      p_id: id,
      p_ciphertext: input.ciphertext,
      p_iv: input.iv,
      p_kind: input.kind,
      p_bytes: input.bytes,
      p_views: input.views,
      p_ttl_hours: input.ttlHours,
      p_kdf: input.kdf ?? null,
      p_note: input.note ?? null,
    });
    if (!inserted) id = newId();
  }

  if (!inserted) {
    throw new StoreUnavailableError("Could not allocate a unique id.");
  }

  return {
    id: inserted.id,
    createdAt: Date.now(),
    expiresAt: inserted.expiresAt,
    viewsAllowed: inserted.viewsAllowed,
    viewsUsed: 0,
    kind: input.kind,
    bytes: input.bytes,
    ciphertext: input.ciphertext,
    iv: input.iv,
    kdf: input.kdf ?? null,
    note: input.note ?? null,
  };
}

export type ReadResult =
  | { status: "ok"; record: SecretRecord }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "consumed" };

function toReadResult(result: RpcResult): ReadResult {
  if (result.status === "ok") {
    return { status: "ok", record: toRecord(result.record) };
  }
  return { status: result.status };
}

/** Read without spending a view. Used by the pre-reveal screen. */
export async function peekSecret(id: string): Promise<ReadResult> {
  if (!ID_RE.test(id)) return { status: "missing" };
  return toReadResult(await rpc<RpcResult>("sl_peek", { p_id: id }));
}

/**
 * Spend exactly one view. The increment and the allowance check are one SQL
 * statement, so two instances behind a load balancer cannot both claim the last
 * read; the blob is deleted in the same call when the allowance hits zero.
 * `viewsAllowed === 0` means unlimited — the counter still ticks, nothing dies.
 */
export async function consumeSecret(
  id: string,
): Promise<ReadResult & { viewsLeft?: number | null }> {
  if (!ID_RE.test(id)) return { status: "missing" };
  const result = await rpc<RpcResult>("sl_open", { p_id: id });
  if (result.status !== "ok") return toReadResult(result);
  return {
    status: "ok",
    record: toRecord(result.record),
    viewsLeft: result.views_left,
  };
}

export async function destroySecret(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  return rpc<boolean>("sl_delete", { p_id: id });
}

let lastSweep = 0;

/** Lazy cleanup of expired and spent rows. Runs at most once a minute. */
export async function sweepExpired(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  try {
    await rpc<number>("sl_sweep", {});
  } catch {
    // A failed sweep changes nothing: the next open still checks expiry itself.
  }
}
