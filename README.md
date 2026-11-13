# OpenVCore

Zero-knowledge links for passwords, keys, and files. The plaintext never leaves the
browser: encryption happens client-side with AES-256-GCM, and the content key is derived
from the link id itself (`SHA-256("openvcore.key.v1:" + id)`), computed only in the
browser. A shared link is just `https://host/s/{id}` — eight characters, no fragment.
The server stores an opaque ciphertext blob and nothing it can decrypt.

A link stays live until the sender deletes it or its expiry passes. Opening it never
removes it.

## Run

```bash
npm install
npx next build
npm start
```

`npm start` and `npm run dev` boot Node with `scripts/net-shim.mjs` preloaded. Next
calls `os.networkInterfaces()` after binding the socket to print its "Network:" URL;
in containers that deny the underlying netlink ioctl, that throws `ERR_SYSTEM_ERROR`
(UV_EACCES) from an unhandled `'listening'` handler and kills the process. The shim
answers with an empty interface map in that case, so the server falls back to
loopback and keeps running. Binding `-H 127.0.0.1` also avoids the call, but the shim
covers `dev`, custom ports, and any script that starts Next directly.

Development:

```bash
npm run dev
```

## Layout

```
src/app/          routes and route handlers
src/components/   client components
src/lib/          crypto, store, zip, raw handoff
src/public/       static assets: brand mark, service worker
public -> src/public
```

Every application folder lives under `src/`; `tsconfig.json` maps `@/*` to `./src/*`.
Next resolves `public/` from the project root only, so a root symlink points at
`src/public`. The symlink is read when the server boots, so restart after adding an
asset there.

## Configuration

| Variable       | Default | Purpose                                             |
| -------------- | ------- | --------------------------------------------------- |
| `SUPABASE_URL` | unset   | Project URL. Required: secret blobs live here.      |
| `SUPABASE_KEY` | unset   | Publishable key. Required: drives the RPC functions. |

Secrets are stored in Postgres, in `public.secrets`. Nothing is written to disk, so a
rebuild, a redeploy or a sync that replaces the project folder no longer takes live
links with it. If the two variables are missing, `/api/secrets` answers 503 instead of
silently falling back to a store that can vanish.

## Why the table is sealed

`public.secrets` has RLS enabled with **no policies**, and every grant is revoked from
`anon` and `authenticated`. The publishable key cannot read, write or delete a row.

Access goes through five `security definer` functions exposed over PostgREST:

| Function    | Arguments                                                             | Effect |
| ----------- | --------------------------------------------------------------------- | ------ |
| `sl_create` | id, ciphertext, iv, kind, bytes, views, ttlHours, kdf, note            | Inserts. Returns null on an id collision so the caller can retry. |
| `sl_peek`   | id                                                                    | Returns the record; deletes it if expired. |
| `sl_open`   | id                                                                    | Returns the payload and records the open. |
| `sl_delete` | id                                                                    | Deletes the row. |
| `sl_sweep`  | —                                                                     | Deletes expired and spent rows. |

The only thing these functions require is the eight character id, which is what
`/s/{id}` already treats as the access token. There is no list function, so the
namespace cannot be enumerated, and the ciphertext is useless without that id anyway.

`sl_open` returns the row with a single statement:

```sql
update public.secrets s
   set views_used = s.views_used + 1
 where s.id = p_id
   and (s.expires_at = 0 or s.expires_at > now_ms)
returning *;
```

Zero rows means missing or expired, and the function says which. `views_used` is kept
only as a record of how often the link was opened; `views_allowed` stays `0`, which is
the "no limit" value, so an open never deletes the row.

A store outage surfaces as 503, never as 404 or 410 (`src/lib/api-errors.ts`), so a
database hiccup can never look like a burned link.

## The link ledger

Every link that is created is also written to a Supabase table, `public.links`:

| Column          | Type          | Contents                                        |
| --------------- | ------------- | ----------------------------------------------- |
| `id`            | `text` pk     | The eight character secret id                    |
| `created_at`    | `timestamptz` | Insert time, default `now()`                     |
| `ip`            | `text`        | Requester's address, from `x-forwarded-for` / `x-real-ip` |
| `user_agent`    | `text`        | Truncated `User-Agent`                           |
| `link`          | `text`        | The full share URL, `/s/{id}`                    |
| `password`      | `text`        | The typed password for locked links, else null   |
| `kind`          | `text`        | `text` or `file`, taken from the stored secret   |
| `locked`        | `boolean`     | Whether a password protects the link             |
| `views_allowed` | `integer`     | Always 0: no cap on opens                        |
| `expires_at`    | `bigint`      | Epoch ms, 0 means never                          |

This table intentionally holds the secret material — the link itself and, for locked
links, the password — so the operator can recover a link that a sender never managed to
deliver. That is a deliberate exception to the zero-knowledge property everywhere else in
the app.

The browser posts `{id, link, password}` to `POST /api/links` after a successful
create. The route never trusts the rest: it derives `kind`, `locked`, `views_allowed`
and `expires_at` from the stored secret, rejects ids that do not exist, and validates
that `link` is an absolute `http(s)` URL whose path is `/s/{id}`.

Writes go through PostgREST with the publishable key (`src/lib/ledger.ts`, plain `fetch`,
no client library). `public.links` has RLS enabled with a single insert-only policy for
`anon` and `authenticated`, so the browser-visible key can add rows and read nothing.
Duplicates are ignored via `Prefer: resolution=ignore-duplicates`. If the insert fails
the route answers 502 with `{logged: false, error}`, the response is fire-and-forget on
the client, and the link keeps working either way.

## How the crypto works

**Id-key mode (default).** The browser picks the eight character id first, derives the
256-bit content key from it with SHA-256, then encrypts. The payload is an envelope: a
4-byte JSON-header length, a JSON header listing every file (`name`, `type`, `size`),
then the file bodies back to back. One blob, one key, no fragment. The server sees only
`{id, ciphertext, iv, note, ttl}`. If the id is already taken the route answers 409 and
the client rolls a new id and re-encrypts, so the address and the key can never
disagree.

**Password mode.** The content key is wrapped under a key derived from the password
with PBKDF2-SHA256 (310,000 iterations, 16-byte salt). The link still carries no key
material. A separate `check` value — a known constant encrypted under the derived key —
lets the client reject a wrong password without a server round trip, so a typo never
burns the link.

The reveal page fetches metadata (kind, views left, expiry, whether a password is
required) without consuming anything. Only `POST /api/secrets/{id}/open` decrements
the payload, and it does so with an `update … returning *` inside Postgres, so two
simultaneous opens see one consistent row.

## The note

An optional one-line note sits above the composer and becomes the heading of the
reveal page — the sender's words in place of a generic prompt. Leave it empty and the
heading is not rendered at all: no placeholder, no `Open this secret?`, nothing.

The note is sealed with the same content key as the payload and stored beside it as
`note: {ciphertext, iv}`. The server never sees the text. Because the note is the
heading, it has to be visible *before* the payload is opened:

- **Id-key links** derive the key from the id on load — no request at all.
- **Password links** derive the key from the typed password on a short debounce, check
  it against the public `check` constant, then unwrap and decrypt the note. Until the
  password matches, the heading stays `Enter the password`. A wrong guess spends
  nothing and reveals nothing.

To make that possible, `GET /api/secrets/{id}` also returns the wrapped content key for
password links. That is not a new exposure: the `check` constant already lets anyone
holding the link test guesses offline, and the wrapped key is protected by the same
PBKDF2-derived key.

## URL links

The third tab stores a target address instead of a document. The visitor never sees a
reveal page: `/s/{id}` looks the link up, decrypts the target with the key derived from
the id, and answers `307` with it in `Location`. It peeks rather than consumes, so the
link survives every visit until it expires or the sender deletes it. There is no `/raw`
view for these — the route answers `404` — and the password toggle is hidden, because a
redirect has to be readable by the server at visit time.

## The raw view

`/s/{id}/raw` is not a page. It is a route handler returning `text/plain; charset=utf-8`
(`src/app/s/[id]/raw/[[...password]]/route.ts`), so the browser paints it with its own
plain-text viewer —
no app chrome, no stylesheet, no react tree. The button appears on the styled page only
after the secret has been opened, so it never competes with `Open` and never offers a
link to something still sealed.

The key is a hash of the id, so the handler can open the payload by itself. It uses
`peekSecret`, never `consumeSecret`, so a raw view costs no read. When a tab has already
decrypted the secret, that tab answers the request first and no network call happens:

1. The tab hands its plaintext to the Cache API under `__openvcore-raw/{id}` and
   registers `src/public/raw-sw.js` for scope `/s/` (`src/lib/raw-bridge.ts`).
2. The browser navigates to `/s/{id}/raw` as a document request.
3. The worker matches that URL, reads the stash, **deletes it**, and responds with the
   bytes as `text/plain`. One shot: the entry is gone before the document renders.

If the worker cannot take control (private mode, storage blocked, four second
registration timeout) `prepareRaw` returns false and the tab opens the same native
viewer through a `blob:` URL instead. That is the only path where the address bar shows
a `blob:` origin — the URL cannot keep its `/raw` shape without a worker.

Coming back is plain browser back. The worker does not intercept the return trip; the
styled page restores what it opened from `sessionStorage` (`openvcore.reveal.{id}` in
`src/lib/handoff.ts`), which also covers a reload that misses the back/forward cache. Files
travel as base64 in the same entry.

A cold request — no stash, no worker, curl — is answered by the route handler: it looks
the secret up, derives the key from the id in the URL, decrypts, and returns the text.
Text secrets come back verbatim; a single text file comes back as its contents, a
multi-file secret as a name and size listing. Unknown ids answer `404`, expired links
`410`.

A file-mode link shows a small `Raw` button beside every file whose bytes are text —
`src/lib/textual.ts` decides from the MIME type and then the extension, so a `.json`, `.md`,
`.csv`, or `.env` qualifies and a `.png` does not. The button points at
`/s/{id}/raw?file={index}` (the handler also takes `?file={name}`), which returns just
that entry, `415` when it is not text, `404` when no entry matches. The service worker
stashes per-file text under the same selector, so the in-tab click still makes no network
request.

A password-protected link has its content key wrapped under a PBKDF2 key, so the password
travels in the URL: `/s/{id}/raw/{password}` or `/s/{id}/raw?p={password}`. With neither,
the handler answers with the exact address shape to paste, using the id it was asked for.
A wrong password is `401` and counts against a per-id, per-client budget of ten attempts
per ten minutes, then `429` for the rest of the window. Right or wrong, the response sets
`Referrer-Policy: no-referrer` so the password in the path never rides out on a link.


The document hides `<link rel="icon">` from the browser, so `next.config.ts` rewrites
`/favicon.ico` onto `/icon.png`; without it every raw view logs a 404.

## Limits

- Expiry: 1 hour, 24 hours, 7 days, 30 days, or no expiry (default 24 hours)
- Text: 100,000 characters
- Note: 160 characters (optional)
- Files: 10 MB total, any number of files in one link
- Password: 8 characters minimum

`expiresAt === 0` means the link never expires. `viewsAllowed` is always `0`, the API
reports `viewsLeft: null`, and any `views` field in a create request is ignored rather
than trusted.

## Verification

`scripts/verify.cjs` is an assertion-based end-to-end run against a live server: the
eight character link with no fragment, a second visitor opening the same link, text
download out of the tab, a two-file upload with per-file download and `Download all`
producing a zip that extracts byte for byte, password wrong-then-right without side
effects, several opens of one link, no expiry, the delete return path, the raw
`text/plain` document (worker handoff, no app chrome, browser back restoring the opened
view), the encrypted note as a heading (present, absent, and unlocked only after the
right password), the missing site footer, the stripped copy, the ledger contract, a
requested limit being ignored, the favicon fallback path, and a console-error sweep that
also fails on any 4xx/5xx response the pages make.

```bash
npm start &
node scripts/verify.cjs
```

`scripts/persist.cjs` covers the thing the database was added for: it creates a link,
kills the running server, starts a new one, then opens the same id twice — proving the
link survived and does not delete itself. It restarts whatever is listening on `BASE` (default
`http://127.0.0.1:3211`), so point it at a server you own:

```bash
node scripts/persist.cjs
```

Screenshots land in `/tmp/opencode/shots`.
