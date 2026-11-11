/**
 * Client side of the raw handoff.
 *
 * `/s/{id}/raw` is a plain text response served by the service worker from a
 * one-shot stash, so the browser paints it with its own text viewer. The stash
 * lives in the Cache API because that store is shared between the page and the
 * worker; `sessionStorage` is not visible to a service worker.
 *
 * If the worker is unavailable (private mode, unsupported browser, storage
 * blocked) the caller falls back to a blob document, which is the same native
 * viewer reached through a `blob:` URL.
 */

const CACHE = "schemaload-raw-v1";
const STASH_PATH = "/__schemaload-raw/";
const REGISTER_TIMEOUT_MS = 4000;

async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined") return null;
  if (!("serviceWorker" in navigator) || !("caches" in window)) return null;

  const registration = await navigator.serviceWorker.register("/raw-sw.js", {
    scope: "/s/",
  });

  // `ready` resolves once a worker controls this scope. The timeout keeps a
  // stuck registration from turning a button click into a dead end.
  const ready = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), REGISTER_TIMEOUT_MS),
    ),
  ]);

  if (!ready) return null;
  return registration;
}

/** Stash the plaintext for the next `/raw` navigation. False means "use a blob". */
export async function prepareRaw(id: string, text: string): Promise<boolean> {
  try {
    const registration = await activeRegistration();
    if (!registration) return false;

    const cache = await caches.open(CACHE);
    const key = new URL(STASH_PATH + id, window.location.origin).toString();
    await cache.put(
      key,
      new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    );
    return true;
  } catch {
    return false;
  }
}
