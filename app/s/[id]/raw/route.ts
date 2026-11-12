import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/s/{id}/raw` answers with a plain text document, so the browser renders it
 * with its built-in viewer rather than an app page.
 *
 * The server has nothing to put in it: the key lives in the URL fragment, which
 * browsers never transmit, so the stored blob cannot be opened here. This handler
 * covers the case where no tab holds the plaintext; the tab that opened the secret
 * answers the same URL through `public/raw-sw.js` with the decrypted bytes.
 */
export async function GET() {
  const rawContent = `This secret can only be shown as raw text in the tab that opened it.

The key lives in the URL fragment, which never reaches this server, so there is
nothing here to decrypt.

Open the link, press Open, then use Raw page from that tab. The plaintext goes to
the browser's own text viewer without touching the network again.`;

  return new NextResponse(rawContent, {
    status: 200,
    headers: {
      // This header triggers the browser's default plain-text dark/light viewer
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
