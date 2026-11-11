# SchemaLoad

One-time, zero-knowledge links for passwords, keys, and files. The plaintext never
leaves the browser: encryption happens client-side with AES-256-GCM, and the
decryption key lives in the URL fragment (`/s/{id}#<key>`), which the browser never
transmits. The server stores an opaque ciphertext blob and a read counter. When the
counter hits zero the blob is deleted.

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
| `sl_peek`   | id                                                                    | Returns the record without spending a read; deletes it if expired or spent. |
| `sl_open`   | id                                                                    | Spends one read. See below. |
| `sl_delete` | id                                                                    | Deletes the row. |
| `sl_sweep`  | —                                                                     | Deletes expired and spent rows. |

The only thing these functions require is the 16 character id, which is what `/s/{id}`
already treats as the access token. There is no list function, so the namespace cannot
be enumerated, and the ciphertext is useless without the fragment key anyway.

`sl_open` spends the read with a single statement:

```sql
update public.secrets s
   set views_used = s.views_used + 1
 where s.id = p_id
   and (s.expires_at = 0 or s.expires_at > now_ms)
   and (s.views_allowed = 0 or s.views_used < s.views_allowed)
returning *;
```

Zero rows means missing, expired or already spent, and the function says which before
deleting. Because the predicate is part of the update, two instances behind a load
balancer cannot both claim the last read — the row lock decides, not an application
mutex.

A store outage surfaces as 503, never as 404 or 410 (`lib/api-errors.ts`), so a
database hiccup can never look like a burned link.

## The link ledger

Every link that is created is also written to a Supabase table, `public.links`:

| Column          | Type          | Contents                                        |
| --------------- | ------------- | ----------------------------------------------- |
| `id`            | `text` pk     | The 16 hex character secret id                   |
| `created_at`    | `timestamptz` | Insert time, default `now()`                     |
| `ip`            | `text`        | Requester's address, from `x-forwarded-for` / `x-real-ip` |
| `user_agent`    | `text`        | Truncated `User-Agent`                           |
| `link`          | `text`        | The full share URL, fragment key included        |
| `password`      | `text`        | The typed password for locked links, else null   |
| `kind`          | `text`        | `text` or `file`, taken from the stored secret   |
| `locked`        | `boolean`     | Whether a password protects the link             |
| `views_allowed` | `integer`     | 0 means no read limit                            |
| `expires_at`    | `bigint`      | Epoch ms, 0 means never                          |

This table intentionally holds the key material — including the fragment key inside
`link` and, for locked links, the password — so the operator can recover a link that a
sender never managed to deliver. That is a deliberate exception to the zero-knowledge
property everywhere else in the app.

The browser posts `{id, link, password}` to `POST /api/links` after a successful
create. The route never trusts the rest: it derives `kind`, `locked`, `views_allowed`
and `expires_at` from the stored secret, rejects ids that do not exist, and validates
that `link` is an absolute `http(s)` URL whose path is `/s/{id}`.

Writes go through PostgREST with the publishable key (`lib/ledger.ts`, plain `fetch`,
no client library). `public.links` has RLS enabled with a single insert-only policy for
`anon` and `authenticated`, so the browser-visible key can add rows and read nothing.
Duplicates are ignored via `Prefer: resolution=ignore-duplicates`. If the insert fails
the route answers 502 with `{logged: false, error}`, the response is fire-and-forget on
the client, and the link keeps working either way.

## How the crypto works

**Link-key mode (default).** A random 256-bit content key is generated in the browser.
The payload — an envelope of 4-byte JSON-header length, JSON header (filename, MIME
type, kind), then raw bytes — is encrypted with AES-GCM. The key is base64url'd into
the fragment. The server sees only `{id, ciphertext, iv, note, viewsAllowed, ttl}`.

**Password mode.** The content key is wrapped under a key derived from the password
with PBKDF2-SHA256 (310,000 iterations, 16-byte salt). The link carries no fragment
key. A separate `check` value — a known constant encrypted under the derived key —
lets the client reject a wrong password without a server round trip, so a typo never
burns the link.

The reveal page fetches metadata (kind, views left, expiry, whether a password is
required) without consuming anything. Only `POST /api/secrets/{id}/open` decrements
the counter, and it does so with an `update … where views_used < views_allowed` inside
Postgres, so two simultaneous opens cannot both claim the last read.

## The note

An optional one-line note sits above the composer and becomes the heading of the
reveal page — the sender's words in place of a generic prompt. Leave it empty and the
heading is not rendered at all: no placeholder, no `Open this secret?`, nothing.

The note is sealed with the same content key as the payload and stored beside it as
`note: {ciphertext, iv}`. The server never sees the text. Because the note is the
heading, it has to be readable *before* a read is spent:

- **Link-key links** decrypt it on load from the fragment key — no request at all.
- **Password links** derive the key from the typed password on a short debounce, check
  it against the public `check` constant, then unwrap and decrypt the note. Until the
  password matches, the heading stays `Enter the password`. A wrong guess spends
  nothing and reveals nothing.

To make that possible, `GET /api/secrets/{id}` also returns the wrapped content key for
password links. That is not a new exposure: the `check` constant already lets anyone
holding the link test guesses offline, and the wrapped key is protected by the same
PBKDF2-derived key.

## The raw view

`/s/{id}/raw` is not a page. It is a route handler returning `text/plain; charset=utf-8`
(`app/s/[id]/raw/route.ts`), so the browser paints it with its own plain-text viewer —
no app chrome, no stylesheet, no react tree. The button appears on the styled page only
after the secret has been opened, so it never competes with `Open` and never offers a
link to something still sealed.

The server cannot fill that response. A one-time link's key is in the URL fragment,
which browsers never transmit, and the sealed blob is deleted the moment its last read
is spent. So the tab that already decrypted the secret answers the request itself:

1. The tab hands its plaintext to the Cache API under `__schemaload-raw/{id}` and
   registers `public/raw-sw.js` for scope `/s/` (`lib/raw-bridge.ts`).
2. The browser navigates to `/s/{id}/raw#<key>` as a document request.
3. The worker matches that URL, reads the stash, **deletes it**, and responds with the
   bytes as `text/plain`. One shot: the entry is gone before the document renders.

If the worker cannot take control (private mode, storage blocked, four second
registration timeout) `prepareRaw` returns false and the tab opens the same native
viewer through a `blob:` URL instead. That is the only path where the address bar shows
a `blob:` origin — the URL cannot keep its `/raw` shape without a worker.

Coming back is plain browser back. The worker does not intercept the return trip; the
styled page restores what it opened from `sessionStorage` (`schemaload.reveal.{id}` in
`lib/handoff.ts`), which also covers a reload that misses the back/forward cache. Files
travel as base64 in the same entry.

A bare `/s/{id}/raw` requested cold — no stash, no worker, curl — answers with a short
`text/plain` note explaining that the plaintext only exists in the tab that opened the
secret. It never leaks a hint about whether the id exists.

The document hides `<link rel="icon">` from the browser, so `next.config.ts` rewrites
`/favicon.ico` onto `/icon.svg`; without it every raw view logs a 404.

## Limits

- Views: 1, 3, 5, 10, or no limit (default 1)
- Expiry: 1 hour, 24 hours, 7 days, 30 days, or no expiry (default 24 hours)
- Text: 100,000 characters
- Note: 160 characters (optional)
- Files: 10 MB
- Password: 8 characters minimum

A limit of `0` means "none": `viewsAllowed === 0` never deletes on reads (the access
counter still ticks for the record's own history) and `expiresAt === 0` never expires.
The API reports `viewsLeft: null` for an unlimited link so the client never confuses
"zero left" with "no cap". Both directions are independent.

## Verification

`scripts/verify.cjs` is an assertion-based end-to-end run against a live server:
link-key text round trip, burn line depletion, second-visit gone state, text download
out of the tab, file filename + byte-for-byte download, password wrong-then-right
without burning a read, multi-view burn segments, unlimited reads across repeated opens
with no expiry, the delete return path, the raw `text/plain` document (worker handoff,
no app chrome, browser back restoring the opened view), the encrypted
note as a heading (present, absent, and unlocked only after the right password), the
missing site footer, the ledger contract, an open race that must spend exactly one read,
the favicon fallback path, and a console-error sweep that also fails on any 4xx/5xx
response the pages make.

```bash
npm start &
node scripts/verify.cjs
```

`scripts/persist.cjs` covers the thing the database was added for: it creates a
one-read link, kills the running server, starts a new one, then reads and opens the
same id. It restarts whatever is listening on `BASE` (default
`http://127.0.0.1:3211`), so point it at a server you own:

```bash
node scripts/persist.cjs
```

Screenshots land in `/tmp/opencode/shots`.
