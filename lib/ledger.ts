/**
 * The operator's link ledger.
 *
 * Every created link is mirrored into a Supabase table (`public.links`) together
 * with the requester's IP, the full share link and, for password-protected links,
 * the password itself. This is deliberate: the ledger exists so the operator can
 * recover a link that was never delivered, and so a lost password can be handed
 * back. The content key is not in the link, so the ledger holds no ability to
 * decrypt what it records.
 *
 * Writes go through PostgREST with the publishable key. The table has RLS on and
 * an insert-only policy, so this key can add rows and read nothing. Reads are
 * service-role only.
 */

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "") ?? "";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

export const ledgerConfigured = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;

export interface LedgerRow {
  id: string;
  ip: string | null;
  user_agent: string | null;
  link: string;
  password: string | null;
  kind: string;
  locked: boolean;
  views_allowed: number;
  expires_at: number;
}

export interface LedgerResult {
  ok: boolean;
  error?: string;
}

/** Insert one row. Resolves rather than throws so the caller can log and move on. */
export async function logLink(row: LedgerRow): Promise<LedgerResult> {
  if (!ledgerConfigured) {
    return { ok: false, error: "SUPABASE_URL / SUPABASE_KEY are not set." };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // PostgREST wants the key twice: apikey for the gateway, bearer for auth.
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        // No `resolution=ignore-duplicates` here: that turns the insert into an
        // upsert, and an upsert also needs a SELECT policy, which this table
        // deliberately does not have. A repeat insert comes back as 409 and is
        // treated as "already logged" below.
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // 409 means the id is already in the ledger, which is the desired end
      // state: a retried create must not look like a failure.
      if (response.status === 409) return { ok: true };
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      return { ok: false, error: `${response.status} ${detail}`.trim() };
    }
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "ledger request failed",
    };
  }
}
