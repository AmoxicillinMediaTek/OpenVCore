import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RevealPanel } from "@/components/reveal-panel";
import { SiteHeader } from "@/components/site-header";
import {
  contentKeyForId,
  decryptBytes,
  fromBase64,
  importContentKey,
} from "@/lib/crypto";
import { ID_RE } from "@/lib/ids";
import { peekSecret } from "@/lib/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "A sealed secret — OpenVCore",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * A URL link carries no page: the stored target is opened here and the visitor
 * is sent straight to it. Peeking rather than consuming keeps the link intact
 * for the next visitor, the same way `/raw` does.
 */
async function redirectTarget(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;

  try {
    const peeked = await peekSecret(id);
    if (peeked.status !== "ok") return null;
    if (peeked.record.kind !== "url") return null;

    const key = await importContentKey(await contentKeyForId(id));
    const bytes = await decryptBytes(
      key,
      fromBase64(peeked.record.iv),
      fromBase64(peeked.record.ciphertext),
    );

    const target = new URL(new TextDecoder().decode(bytes));
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    return target.toString();
  } catch {
    return null;
  }
}

export default async function RevealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const target = await redirectTarget(id);
  if (target) redirect(target);

  return (
    <>
      <SiteHeader />
      <RevealPanel id={id} />
    </>
  );
}
