import { NextResponse } from "next/server";
import { StoreUnavailableError } from "@/lib/store";

/**
 * Turns a store outage into a 503 instead of an unhandled throw. The distinction
 * matters: a 503 says "nothing happened", while a 410 says the link is gone. A
 * store hiccup must never read as a burned link.
 */
export function storeFailure(cause: unknown): NextResponse | null {
  if (!(cause instanceof StoreUnavailableError)) return null;
  return NextResponse.json(
    { error: "The secret store is unreachable. Nothing was spent. Try again in a moment." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
