// Service worker for /s/{id}/raw, scope /s/.
//
// The raw page is a real text/plain response so the browser renders it with its
// own plain-text viewer instead of a styled React page. When the tab that opened
// the secret asks for it, that tab stashes the bytes in the Cache API, navigates,
// and this worker answers the navigation from the stash: one entry, consumed and
// deleted on the way out, never touching the network. A cold request falls
// through to the route handler, which can open the link by itself.
//
// The stash is keyed by id plus the `?file=` selector, because the opened link
// offers a raw view per text file as well as for the whole secret.

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

function stashKey(id, url) {
  const file = url.searchParams.get("file");
  return new URL(STASH_PATH + id + (file === null ? "" : `-${file}`), url.origin).toString();
}

async function answer(url) {
  const id = url.pathname.split("/")[2];

  try {
    const cache = await caches.open(CACHE);
    const key = stashKey(id, url);
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
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch {
    // Fall through to the server rather than failing the navigation.
  }

  // No stash in this browser: the route handler opens the link itself, and its
  // answer (plaintext, password prompt, or refusal) is already plain text.
  return fetch(url.toString(), { cache: "no-store" });
}
