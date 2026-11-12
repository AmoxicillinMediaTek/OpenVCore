// Service worker for /s/{id}/raw, scope /s/.
//
// The raw page is a real text/plain response so the browser renders it with its
// own plain-text viewer instead of a styled React page. The server cannot answer
// that request with the plaintext: the content key is derived in the browser and
// never reaches it. So the tab that already decrypted the secret stashes it in
// the Cache API, navigates, and
// this worker answers the navigation with those bytes. One stash entry, consumed
// and deleted on the way out, never touching the network.

const CACHE = "openvcore-raw-v1";
const STASH_PATH = "/__openvcore-raw/";
const RAW_PATH = /^\/s\/[a-z0-9]{8}\/raw$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A newer worker version starts from an empty stash.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("openvcore-raw-") && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!RAW_PATH.test(url.pathname)) return;

  event.respondWith(answer(url));
});

async function answer(url) {
  const id = url.pathname.split("/")[2];

  try {
    const cache = await caches.open(CACHE);
    const key = new URL(STASH_PATH + id, url.origin).toString();
    const hit = await cache.match(key);

    if (hit) {
      await cache.delete(key);
      const body = await hit.text();

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "inline",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch {
    // Fall through to the server rather than failing the navigation.
  }

  // No stash: nothing in this browser holds the plaintext. The route handler
  // explains that as plain text.
  return fetch(url.toString(), { cache: "no-store" });
}
