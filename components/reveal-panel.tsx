"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircleIcon as AlertCircle,
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  CopyIcon as Copy,
  DownloadIcon as Download,
  FileDownIcon as FileDown,
  LockIcon as Lock,
  SpinnerIcon as Loader2,
} from "@/components/icons";
import { BurnLine } from "@/components/burn-line";
import { openSecret } from "@/lib/open-secret";
import { stashRevealText, takeReveal } from "@/lib/handoff";
import { prepareRaw } from "@/lib/raw-bridge";
import {
  decryptBytes,
  derivePassphraseKey,
  fromBase64,
  fromBase64Url,
  importContentKey,
  passphraseMatches,
} from "@/lib/crypto";
import { formatBytes, formatExpiry, formatReads } from "@/lib/format";
import { LIMITS, type SecretInfo } from "@/lib/types";

type Phase = "loading" | "ready" | "incomplete" | "gone" | "error";

interface RevealedText {
  kind: "text";
  text: string;
  viewsLeft: number | null;
}

interface RevealedFile {
  kind: "file";
  name: string;
  type: string;
  url: string;
  size: number;
  viewsLeft: number | null;
}

type Revealed = RevealedText | RevealedFile;

export function RevealPanel({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<SecretInfo | null>(null);
  const [keyFragment, setKeyFragment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [burnLeft, setBurnLeft] = useState<number | null>(null);
  const [restoredTotal, setRestoredTotal] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const burnTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (burnTimer.current !== null) window.clearTimeout(burnTimer.current);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const fragment = window.location.hash.replace(/^#/, "");
    setKeyFragment(fragment);

    // Coming back from the raw page: a one-time blob is usually unlinked by
    // then, so the tab hands its plaintext over instead of refetching a corpse.
    const reopened = takeReveal(id);
    if (reopened) {
      setRestoredTotal(reopened.viewsAllowed);
      if (reopened.kind === "file") {
        const bytes = fromBase64(reopened.data);
        setRevealed({
          kind: "file",
          name: reopened.name,
          type: reopened.type,
          url: URL.createObjectURL(
            new Blob([bytes.slice().buffer], { type: reopened.type }),
          ),
          size: bytes.length,
          viewsLeft: reopened.viewsLeft,
        });
      } else {
        setRevealed({
          kind: "text",
          text: reopened.text,
          viewsLeft: reopened.viewsLeft,
        });
      }
      setPhase("ready");
      return () => {
        alive = false;
      };
    }

    fetch(`/api/secrets/${id}`, { cache: "no-store" })
      .then(async (response) => {
        if (!alive) return;
        if (!response.ok) {
          setPhase("gone");
          return;
        }
        const data = (await response.json()) as SecretInfo;
        setInfo(data);
        if (!data.locked && fragment.length === 0) {
          setPhase("incomplete");
          return;
        }
        setPhase("ready");
      })
      .catch(() => {
        if (!alive) return;
        setError("Could not reach the server.");
        setPhase("error");
      });

    return () => {
      alive = false;
    };
  }, [id]);

  // The note is the heading, so it has to be readable before a read is spent.
  // On an unlocked link the key is already in the fragment: no round trip, no
  // password, nothing for the server to learn.
  useEffect(() => {
    if (!info || info.locked) return;
    const sealed = info.note;
    if (!sealed) {
      setNote(null);
      return;
    }
    if (keyFragment.length === 0) return;

    let alive = true;
    (async () => {
      const contentKey = await importContentKey(fromBase64Url(keyFragment));
      const plain = await decryptBytes(
        contentKey,
        fromBase64(sealed.iv),
        fromBase64(sealed.ciphertext),
      );
      if (alive) setNote(new TextDecoder().decode(plain));
    })().catch(() => {
      if (alive) setNote(null);
    });

    return () => {
      alive = false;
    };
  }, [info, keyFragment]);

  // On a locked link the key only exists once the password has been typed, so
  // the note follows the password field on a short debounce. A wrong guess fails
  // the public check constant before anything is decrypted or spent.
  useEffect(() => {
    if (!info || !info.locked) return;
    const sealed = info.note;
    const kdf = info.kdf;
    if (!sealed || !kdf || passphrase.length < LIMITS.minPassphrase) {
      setNote(null);
      return;
    }

    let alive = true;
    const timer = window.setTimeout(() => {
      (async () => {
        const passKey = await derivePassphraseKey(
          passphrase,
          fromBase64(kdf.salt),
          kdf.iterations,
        );
        const matches = await passphraseMatches(passKey, kdf.checkIv, kdf.check);
        if (!matches || !alive) return;
        const raw = await decryptBytes(
          passKey,
          fromBase64(kdf.wrapIv),
          fromBase64(kdf.wrapped),
        );
        const contentKey = await importContentKey(raw);
        const plain = await decryptBytes(
          contentKey,
          fromBase64(sealed.iv),
          fromBase64(sealed.ciphertext),
        );
        if (alive) setNote(new TextDecoder().decode(plain));
      })().catch(() => {
        /* a wrong password simply leaves the generic heading in place */
      });
    }, 320);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [info, passphrase]);

  useEffect(() => {
    return () => {
      if (revealed?.kind === "file") URL.revokeObjectURL(revealed.url);
    };
  }, [revealed]);

  const open = useCallback(async () => {
    if (!info || busy) return;
    setBusy(true);
    setError(null);

    try {
      const outcome = await openSecret({ id, keyFragment, password: passphrase, info });

      if (outcome.status === "password-mismatch") {
        setError("That password does not match. Nothing was burned.");
        return;
      }
      if (outcome.status === "gone") {
        setPhase("gone");
        return;
      }

      const content = outcome.content;

      // Hold the pre-read burn line for a beat so the read visibly burns out.
      // An unlimited link has no count to flip, so it stays on the open track.
      if (content.viewsLeft !== null) {
        setBurnLeft(content.viewsBefore);
        if (burnTimer.current !== null) window.clearTimeout(burnTimer.current);
        burnTimer.current = window.setTimeout(() => setBurnLeft(content.viewsLeft), 220);
      } else {
        setBurnLeft(null);
      }

      if (content.kind === "file") {
        const blob = new Blob([content.bytes.slice().buffer], {
          type: content.type,
        });
        setRevealed({
          kind: "file",
          name: content.name,
          type: content.type,
          url: URL.createObjectURL(blob),
          size: content.bytes.length,
          viewsLeft: content.viewsLeft,
        });
      } else {
        setRevealed({
          kind: "text",
          text: content.text,
          viewsLeft: content.viewsLeft,
        });
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The browser could not decrypt this payload.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, id, info, keyFragment, passphrase]);

  const copy = async () => {
    if (revealed?.kind !== "text") return;
    try {
      await navigator.clipboard.writeText(revealed.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard is blocked. Select the text and copy it by hand.");
    }
  };

  /** Text only, and only after a read: the bytes come from this tab, not the server. */
  const downloadText = () => {
    if (revealed?.kind !== "text") return;
    const blob = new Blob([revealed.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `schemaload-${id}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking too early cancels the write in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const contentsLabel = useMemo(() => {
    if (!info) return "";
    return info.kind === "file" ? "File" : "Text";
  }, [info]);

  /**
   * `/s/{id}/raw` is a plain text response, so this is a document navigation,
   * not a client-side route change. The tab hands its decrypted text to the
   * service worker first; the worker answers the navigation with those bytes in
   * `text/plain`, which is what makes the browser paint its own text viewer.
   *
   * A one-time link cannot be fetched again by then — its blob is already
   * deleted — so the plaintext is also stashed in session storage, which lets
   * the opened view come back if the browser reloads instead of restoring it
   * from the back/forward cache.
   */
  const openRaw = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (revealed?.kind !== "text") return;
    event.preventDefault();
    const href = event.currentTarget.href;

    stashRevealText(
      id,
      revealed.text,
      revealed.viewsLeft,
      info?.viewsAllowed ?? restoredTotal,
    );

    if (await prepareRaw(id, revealed.text)) {
      window.location.assign(href);
      return;
    }

    // No worker control over this origin: the same native viewer via a blob.
    const url = URL.createObjectURL(
      new Blob([revealed.text], { type: "text/plain;charset=utf-8" }),
    );
    window.location.assign(url);
  };

  const rawAvailable =
    revealed !== null &&
    (revealed.kind === "text" ||
      revealed.viewsLeft === null ||
      revealed.viewsLeft > 0);

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[600px] flex-col justify-center px-6 py-14">
      <div className="rounded-[20px] border border-line bg-card">
        {phase === "loading" ? (
          <div className="flex items-center gap-2.5 p-8 text-[13px] text-ink-3">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
            Checking the link
          </div>
        ) : null}

        {phase === "gone" ? (
          <div className="flex flex-col gap-5 p-8">
            <div className="flex items-center gap-2.5">
              <span className="size-2 rounded-full bg-bad" aria-hidden="true" />
              <p className="font-mono text-[11px] text-ink-3">not found</p>
            </div>
            <h1 className="text-[24px] font-medium leading-[1.2] tracking-[-0.02em] text-ink">
              This secret is gone
            </h1>
            <p className="max-w-[46ch] text-[14px] leading-6 text-ink-2">
              Links are deleted the moment their reads run out or their expiry
              passes. A burned link, an expired one, and an id that never existed
              all look exactly like this. That is deliberate.
            </p>
            <Link
              href="/"
              className="mt-1 flex h-10 w-fit items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#2d2b27]"
            >
              Create your own link
              <ArrowRight className="size-3.5" strokeWidth={1.5} />
            </Link>
          </div>
        ) : null}

        {phase === "incomplete" ? (
          <div className="flex flex-col gap-5 p-8">
            <div className="flex items-center gap-2.5">
              <span className="size-2 rounded-full bg-ember" aria-hidden="true" />
              <p className="font-mono text-[11px] text-ink-3">key missing</p>
            </div>
            <h1 className="text-[24px] font-medium leading-[1.2] tracking-[-0.02em] text-ink">
              This link lost its key
            </h1>
            <p className="max-w-[48ch] text-[14px] leading-6 text-ink-2">
              The part after the <code className="font-mono text-[12px] text-ink">#</code> was
              cut off somewhere between the sender and this tab. Without it the
              ciphertext cannot be opened, and the server cannot help.
            </p>
            <p className="text-[13px] leading-5 text-ink-3">
              Ask for the full link, copied in one piece.
            </p>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="flex flex-col gap-5 p-8">
            <div className="flex items-center gap-2.5">
              <span className="size-2 rounded-full bg-bad" aria-hidden="true" />
              <p className="font-mono text-[11px] text-ink-3">offline</p>
            </div>
            <h1 className="text-[24px] font-medium leading-[1.2] tracking-[-0.02em] text-ink">
              Could not reach the server
            </h1>
            <p className="text-[14px] leading-6 text-ink-2">{error}</p>
          </div>
        ) : null}

        {phase === "ready" && info && !revealed ? (
          <div className="flex flex-col gap-6 p-8">
            <div className="flex items-center justify-between gap-4">
              <p className="font-mono text-[11px] text-ink-3">One-time secret</p>
              <span className="font-mono text-[11px] text-ink-3">
                {formatExpiry(info.expiresAt)}
              </span>
            </div>

            {note ? (
              <h1
                className={
                  note.length > 48
                    ? "max-w-[42ch] text-[19px] font-medium leading-[1.35] tracking-[-0.01em] text-ink"
                    : "max-w-[30ch] text-[26px] font-medium leading-[1.15] tracking-[-0.025em] text-ink"
                }
              >
                {note}
              </h1>
            ) : info.locked ? (
              <h1 className="text-[26px] font-medium leading-[1.15] tracking-[-0.025em] text-ink">
                Enter the password
              </h1>
            ) : null}

            <dl className="divide-y divide-line border-y border-line">
              <Row term="Contents">
                {contentsLabel} · {formatBytes(info.bytes)} sealed
              </Row>
              <Row term="Reads">
                {info.viewsLeft === null ? "No limit" : `${formatReads(info.viewsLeft)} left`}
              </Row>
              <Row term="Expires">{formatExpiry(info.expiresAt)}</Row>
            </dl>

            <BurnLine total={info.viewsAllowed} left={info.viewsLeft ?? 0} />

            {info.locked ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-[10px] border border-line bg-inset px-3 transition-colors duration-150 focus-within:border-line-strong">
                  <Lock className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.5} />
                  <input
                    type="password"
                    aria-label="Password"
                    value={passphrase}
                    onChange={(event) => {
                      setPassphrase(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void open();
                    }}
                    placeholder="Password"
                    autoComplete="current-password"
                    className="h-11 w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
                  />
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="flex items-start gap-2 text-[12px] leading-4 text-bad">
                <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
                {error}
              </p>
            ) : null}

            <button
              type="button"
              onClick={open}
              disabled={busy || (info.locked && passphrase.length < LIMITS.minPassphrase)}
              className="flex h-11 items-center justify-center gap-2 rounded-[10px] bg-ember text-[14px] font-medium text-page transition-colors duration-150 hover:bg-ember-hi disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                  Decrypting
                </>
              ) : (
                "Open"
              )}
            </button>

            {info.viewsLeft === null ? (
              info.expiresAt === 0 ? null : (
                <p className="text-center text-[12px] leading-5 text-ink-3">
                  Reads are unlimited. The link still dies when its expiry passes.
                </p>
              )
            ) : (
              <p className="text-center text-[12px] leading-5 text-ink-3">
                {info.viewsLeft === 1
                  ? "Opening it deletes the blob. There is no second read."
                  : `${info.viewsLeft} reads remain. This one cannot be undone.`}
              </p>
            )}
          </div>
        ) : null}

        {revealed ? (
          <div className="flex flex-col gap-5 p-8">
            <div className="flex items-center gap-2.5">
              <span
                className={`size-2 rounded-full ${
                  revealed.viewsLeft === null
                    ? "bg-good"
                    : revealed.viewsLeft <= 0
                      ? "bg-ember"
                      : "bg-good"
                }`}
                aria-hidden="true"
              />
              <p className="font-mono text-[11px] text-ink-3">
                {revealed.viewsLeft === null
                  ? "no read limit"
                  : revealed.viewsLeft <= 0
                    ? "burned after this read"
                    : `${revealed.viewsLeft} reads left`}
              </p>
            </div>

            {revealed.kind === "text" ? (
              <>
                <div className="max-h-[360px] overflow-auto rounded-[10px] border border-line bg-inset p-4">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-ink">
                    {revealed.text}
                  </pre>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={copy}
                      className="flex h-10 items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#2d2b27]"
                    >
                      {copied ? (
                        <Check className="size-4 text-good" strokeWidth={1.5} />
                      ) : (
                        <Copy className="size-4 text-ink-2" strokeWidth={1.5} />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={downloadText}
                      className="flex h-10 items-center gap-2 rounded-[10px] border border-line-strong px-4 text-[13px] text-ink-2 transition-colors duration-150 hover:bg-raise hover:text-ink"
                    >
                      <Download className="size-4" strokeWidth={1.5} />
                      Download
                    </button>
                  </div>
                  <span className="font-mono text-[11px] text-ink-3">
                    {revealed.text.length.toLocaleString("en-US")} characters
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 rounded-[10px] border border-line bg-inset p-4">
                  <FileDown className="size-4 shrink-0 text-ink-2" strokeWidth={1.5} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">{revealed.name}</p>
                    <p className="font-mono text-[11px] text-ink-3">
                      {formatBytes(revealed.size)}
                    </p>
                  </div>
                </div>
                <a
                  href={revealed.url}
                  download={revealed.name}
                  className="flex h-10 w-fit items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#2d2b27]"
                >
                  <Download className="size-4 text-ink-2" strokeWidth={1.5} />
                  Download
                </a>
              </>
            )}

            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <BurnLine
                total={
                  revealed.viewsLeft === null
                    ? 0
                    : (info?.viewsAllowed ??
                      restoredTotal ??
                      Math.max(1, burnLeft ?? revealed.viewsLeft))
                }
                left={burnLeft ?? revealed.viewsLeft ?? 0}
              />
              <p className="text-[12px] leading-4 text-ink-3">
                {revealed.viewsLeft === null
                  ? "Unlimited reads. Anyone with the link can open it again until it expires or is destroyed."
                  : revealed.viewsLeft <= 0
                    ? "The blob is deleted. This tab is the only place this exists now."
                    : "Close this tab when you are done. The link is still live."}
              </p>

              {rawAvailable ? (
                <a
                  href={`/s/${id}/raw${keyFragment ? `#${keyFragment}` : ""}`}
                  onClick={openRaw}
                  className="mt-1 flex h-9 w-fit items-center rounded-[8px] border border-line-strong px-3 font-mono text-[11px] text-ink-2 transition-colors duration-150 hover:bg-raise hover:text-ink"
                >
                  Raw page
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <p className="mt-6 text-center font-mono text-[11px] text-ink-3">
        decrypted in your browser · {id}
      </p>
    </main>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-[13px] text-ink-3">{term}</dt>
      <dd className="font-mono text-[12px] text-ink-2">{children}</dd>
    </div>
  );
}
