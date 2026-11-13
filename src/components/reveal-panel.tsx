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
import { openSecret } from "@/lib/open-secret";
import { stashRevealFile, stashRevealText, takeReveal } from "@/lib/handoff";
import { prepareRaw } from "@/lib/raw-bridge";
import {
  contentKeyForId,
  decryptBytes,
  derivePassphraseKey,
  fromBase64,
  importContentKey,
  passphraseMatches,
} from "@/lib/crypto";
import { buildZip } from "@/lib/zip";
import { formatBytes, formatExpiry } from "@/lib/format";
import { isTextualFile } from "@/lib/textual";
import { LIMITS, type SecretInfo } from "@/lib/types";

type Phase = "loading" | "ready" | "gone" | "error";

interface RevealedText {
  kind: "text";
  text: string;
}

interface RevealedFileItem {
  name: string;
  type: string;
  url: string;
  size: number;
  bytes: Uint8Array;
}

interface RevealedFile {
  kind: "file";
  files: RevealedFileItem[];
}

type Revealed = RevealedText | RevealedFile;

export function RevealPanel({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<SecretInfo | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;

    // Coming back from the raw view: the tab hands its plaintext over instead of
    // refetching and decrypting it a second time.
    const reopened = takeReveal(id);
    if (reopened) {
      if (reopened.kind === "file") {
        setRevealed({
          kind: "file",
          files: reopened.files.map((file) => {
            const bytes = fromBase64(file.data);
            return {
              name: file.name,
              type: file.type,
              url: URL.createObjectURL(
                new Blob([bytes.slice().buffer], { type: file.type }),
              ),
              size: bytes.length,
              bytes,
            };
          }),
        });
      } else {
        setRevealed({
          kind: "text",
          text: reopened.text,
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

  // The note is the heading, so it has to be visible before anything is opened.
  // On an unlocked link the key derives from the id alone: no round trip, no
  // password, nothing for the server to learn.
  useEffect(() => {
    if (!info || info.locked) return;
    const sealed = info.note;
    if (!sealed) {
      setNote(null);
      return;
    }

    let alive = true;
    (async () => {
      const contentKey = await importContentKey(await contentKeyForId(id));
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
  }, [id, info]);

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
      if (revealed?.kind === "file") {
        for (const file of revealed.files) URL.revokeObjectURL(file.url);
      }
    };
  }, [revealed]);

  const open = useCallback(async () => {
    if (!info || busy) return;
    setBusy(true);
    setError(null);

    try {
      const outcome = await openSecret({ id, password: passphrase, info });

      if (outcome.status === "password-mismatch") {
        setError("That password does not match.");
        return;
      }
      if (outcome.status === "gone") {
        setPhase("gone");
        return;
      }

      const content = outcome.content;

      if (content.kind === "file") {
        setRevealed({
          kind: "file",
          files: content.files.map((file) => ({
            name: file.name,
            type: file.type,
            url: URL.createObjectURL(
              new Blob([file.bytes.slice().buffer], { type: file.type }),
            ),
            size: file.bytes.length,
            bytes: file.bytes,
          })),
        });
      } else {
        setRevealed({
          kind: "text",
          text: content.text,
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
  }, [busy, id, info, passphrase]);

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

  /** Text only, and only once opened: the bytes come from this tab, not the server. */
  const downloadText = () => {
    if (revealed?.kind !== "text") return;
    const blob = new Blob([revealed.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openvcore-${id}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking too early cancels the write in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /** File mode with more than one file: one archive, built from decrypted bytes. */
  const downloadAll = () => {
    if (revealed?.kind !== "file") return;
    const blob = buildZip(
      revealed.files.map((file) => ({ name: file.name, bytes: file.bytes })),
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `openvcore-${id}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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
   * The plaintext is also stashed in session storage, so the opened view comes
   * back if the browser reloads instead of restoring it from the back/forward
   * cache.
   */
  const openRaw = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (revealed?.kind !== "text") return;
    event.preventDefault();
    const href = event.currentTarget.href;

    stashRevealText(id, revealed.text);

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

  const rawAvailable = revealed !== null && revealed.kind === "text";

  /**
   * One text file inside a file-mode link, opened in the native viewer. Same
   * handoff as `openRaw`, keyed by the file so the worker answers with just that
   * file's text; the fallback paints a blob of the same bytes.
   */
  const openRawFile = async (
    event: React.MouseEvent<HTMLAnchorElement>,
    file: RevealedFileItem,
    index: number,
  ) => {
    event.preventDefault();
    const href = event.currentTarget.href;
    const text = new TextDecoder().decode(file.bytes);

    if (revealed?.kind === "file") {
      stashRevealFile(
        id,
        revealed.files.map((entry) => ({
          name: entry.name,
          type: entry.type,
          bytes: entry.bytes,
        })),
      );
    }

    if (await prepareRaw(id, text, index)) {
      window.location.assign(href);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    window.location.assign(url);
  };

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
              Links are deleted by their sender, or when their expiry passes. An
              expired link and an id that never existed look exactly like this.
              That is deliberate.
            </p>
            <Link
              href="/"
              className="mt-1 flex h-10 w-fit items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#1f1f1f]"
            >
              Create your own link
              <ArrowRight className="size-3.5" strokeWidth={1.5} />
            </Link>
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
            <div className="flex items-center justify-end gap-4">
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
              <Row term="Expires">{formatExpiry(info.expiresAt)}</Row>
            </dl>

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
                  Opening…
                </>
              ) : (
                "Open"
              )}
            </button>

          </div>
        ) : null}

        {revealed ? (
          <div className="flex flex-col gap-5 p-8">
            {revealed.kind === "text" ? (
              <>
                <div className="max-h-[360px] overflow-auto rounded-[10px] border border-line bg-inset p-4">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-ink">
                    {revealed.text}
                  </pre>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copy}
                    className="flex h-10 items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#1f1f1f]"
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
              </>
            ) : (
              <>
                <div className="flex max-h-[280px] flex-col gap-1.5 overflow-auto">
                  {revealed.files.map((file, index) => (
                    <div
                      key={file.url}
                      className="flex items-center gap-3 rounded-[10px] border border-line bg-inset px-4 py-3"
                    >
                      <FileDown
                        className="size-4 shrink-0 text-ink-2"
                        strokeWidth={1.5}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[13px] text-ink">{file.name}</p>
                          {isTextualFile(file.name, file.type) ? (
                            <a
                              href={`/s/${id}/raw?file=${index}`}
                              onClick={(event) => openRawFile(event, file, index)}
                              aria-label={`Open ${file.name} as raw text`}
                              className="shrink-0 rounded-[6px] border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-3 transition-colors duration-150 hover:bg-raise hover:text-ink"
                            >
                              Raw
                            </a>
                          ) : null}
                        </div>
                        <p className="font-mono text-[11px] text-ink-3">
                          {formatBytes(file.size)}
                        </p>
                      </div>
                      <a
                        href={file.url}
                        download={file.name}
                        aria-label={`Download ${file.name}`}
                        className="shrink-0 text-ink-3 transition-colors duration-150 hover:text-ink"
                      >
                        <Download className="size-4" strokeWidth={1.5} />
                      </a>
                    </div>
                  ))}
                </div>
                {revealed.files.length > 1 ? (
                  <button
                    type="button"
                    onClick={downloadAll}
                    className="flex h-10 w-fit items-center gap-2 rounded-[10px] bg-raise px-4 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#1f1f1f]"
                  >
                    <Download className="size-4 text-ink-2" strokeWidth={1.5} />
                    Download all (.zip)
                  </button>
                ) : null}
              </>
            )}

            {rawAvailable ? (
              <div className="border-t border-line pt-4">
                <a
                  href={`/s/${id}/raw`}
                  onClick={openRaw}
                  className="flex h-9 w-fit items-center rounded-[8px] border border-line-strong px-3 font-mono text-[11px] text-ink-2 transition-colors duration-150 hover:bg-raise hover:text-ink"
                >
                  Raw page
                </a>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

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
