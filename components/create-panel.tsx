"use client";

import { useCallback, useId, useRef, useState } from "react";
import {
  AlertCircleIcon as AlertCircle,
  CheckIcon as Check,
  ChevronDownIcon as ChevronDown,
  CopyIcon as Copy,
  FileTextIcon as FileText,
  LockIcon as Lock,
  PaperclipIcon as Paperclip,
  QrCodeIcon as QrCode,
  SpinnerIcon as Loader2,
  XIcon as X,
} from "@/components/icons";
import { BurnLine } from "@/components/burn-line";
import {
  derivePassphraseKey,
  encryptBytes,
  importContentKey,
  packFile,
  randomBytes,
  toBase64,
  toBase64Url,
  wrapContentKey,
} from "@/lib/crypto";
import {
  formatBytes,
  formatChars,
  formatExpiryLifetime,
  formatReadLifetime,
  formatReads,
} from "@/lib/format";
import { LIMITS, TTL_OPTIONS, VIEW_OPTIONS } from "@/lib/types";

type Mode = "text" | "file";

interface Created {
  id: string;
  link: string;
  views: number;
  expiresAt: number;
  locked: boolean;
}

export function CreatePanel() {
  const [mode, setMode] = useState<Mode>("text");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [views, setViews] = useState(1);
  const [ttl, setTtl] = useState(24);
  const [usePass, setUsePass] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [destroyed, setDestroyed] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const textId = useId();
  const viewsId = useId();
  const ttlId = useId();
  const passId = useId();

  const reset = useCallback(() => {
    setCreated(null);
    setCopied(false);
    setQr(null);
    setDestroyed(false);
    setError(null);
    setNote("");
    setText("");
    setFile(null);
    setPass("");
    setUsePass(false);
  }, []);

  const pickFile = (next: File | null) => {
    setError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (next.size > LIMITS.maxFileBytes) {
      setError(`That file is ${formatBytes(next.size)}. The limit is 10 MB.`);
      return;
    }
    setFile(next);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === "text" && text.trim().length === 0) {
      setError("Nothing to seal yet.");
      return;
    }
    if (mode === "text" && text.length > LIMITS.maxTextChars) {
      setError(`Text is capped at ${LIMITS.maxTextChars.toLocaleString("en-US")} characters.`);
      return;
    }
    if (mode === "file" && !file) {
      setError("Choose a file first.");
      return;
    }
    if (note.trim().length > LIMITS.maxNoteChars) {
      setError(`The note is capped at ${LIMITS.maxNoteChars} characters.`);
      return;
    }
    if (usePass && pass.length < LIMITS.minPassphrase) {
      setError(`Password must be at least ${LIMITS.minPassphrase} characters.`);
      return;
    }

    setBusy(true);
    try {
      const rawKey = randomBytes(32);
      const contentKey = await importContentKey(rawKey);

      let plaintext: Uint8Array;
      if (mode === "file" && file) {
        plaintext = packFile(file.name, file.type || "application/octet-stream", new Uint8Array(await file.arrayBuffer()));
      } else {
        plaintext = new TextEncoder().encode(text);
      }

      const sealed = await encryptBytes(contentKey, plaintext);

      // The note rides in the same envelope, sealed under the same content key.
      // It is never sent as plaintext, so the server cannot read the heading.
      const noteText = note.trim();
      const sealedNote =
        noteText.length > 0
          ? await encryptBytes(contentKey, new TextEncoder().encode(noteText))
          : null;

      let fragment = "";
      let kdf: Record<string, unknown> | undefined;

      if (usePass) {
        const salt = randomBytes(16);
        const passKey = await derivePassphraseKey(pass, salt);
        const wrapped = await wrapContentKey(passKey, rawKey);
        kdf = {
          salt: toBase64(salt),
          iterations: LIMITS.kdfIterations,
          check: wrapped.check,
          checkIv: wrapped.checkIv,
          wrapped: wrapped.wrapped,
          wrapIv: wrapped.wrapIv,
        };
      } else {
        fragment = `#${toBase64Url(rawKey)}`;
      }

      const response = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ciphertext: toBase64(sealed.ciphertext),
          iv: toBase64(sealed.iv),
          kind: mode,
          bytes: sealed.ciphertext.length,
          views,
          ttlHours: ttl,
          kdf,
          note: sealedNote
            ? {
                ciphertext: toBase64(sealedNote.ciphertext),
                iv: toBase64(sealedNote.iv),
              }
            : null,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "The server refused the upload.");
      }

      const data = (await response.json()) as { id: string; expiresAt: number };
      const link = `${window.location.origin}/s/${data.id}${fragment}`;
      setCreated({
        id: data.id,
        link,
        views,
        expiresAt: data.expiresAt,
        locked: usePass,
      });

      // Mirror the finished link into the operator ledger. Fire and forget: the
      // secret is already stored on this server, so a ledger miss must never
      // stop the person from getting their link.
      void fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: data.id,
          link,
          password: usePass ? pass : null,
        }),
        keepalive: true,
      }).catch(() => null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something failed in the browser.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard is blocked. Select the link and copy it by hand.");
    }
  };

  const showQr = async () => {
    if (!created) return;
    if (qr) {
      setQr(null);
      return;
    }
    try {
      const mod = await import("qrcode");
      const dataUrl = await mod.default.toDataURL(created.link, {
        margin: 1,
        width: 232,
        errorCorrectionLevel: "M",
        color: { dark: "#161513", light: "#efe9de" },
      });
      setQr(dataUrl);
    } catch {
      setError("Could not draw the QR code.");
    }
  };

  const burnNow = async () => {
    if (!created) return;
    await fetch(`/api/secrets/${created.id}`, { method: "DELETE" }).catch(() => null);
    setDestroyed(true);
    setQr(null);
  };

  return (
    <div className="w-full rounded-2xl border border-line bg-card">
      {created ? (
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-center gap-2.5">
            <span
              className={`size-2 rounded-full ${destroyed ? "bg-bad" : "bg-good"}`}
              aria-hidden="true"
            />
            <p className="text-[14px] text-ink">
              {destroyed ? "Link deleted" : "Link created"}
            </p>
            <span className="ml-auto font-mono text-[11px] text-ink-3">
              {created.id}
            </span>
          </div>

          {destroyed ? (
            <p className="text-[13px] leading-5 text-ink-2">
              The blob is deleted. Anyone still holding the link will find nothing.
            </p>
          ) : (
            <>
              <p className="text-[13px] leading-5 text-ink-2">
                {created.locked
                  ? "Send this link and the password by different channels. The link alone cannot open it."
                  : "This link is shown once here. It holds the key after the #, so copying it is the only way to share it."}
              </p>

              <div className="rounded-[10px] border border-line bg-inset px-3 py-3">
                <p className="break-all font-mono text-[12px] leading-5 text-ink-2">
                  {created.link}
                </p>
              </div>

              <div className="grid grid-cols-[1fr_auto] gap-2">
                <button
                  type="button"
                  onClick={copy}
                  className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-raise text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#2d2b27]"
                >
                  {copied ? (
                    <Check className="size-4 text-good" strokeWidth={1.5} />
                  ) : (
                    <Copy className="size-4 text-ink-2" strokeWidth={1.5} />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  type="button"
                  onClick={showQr}
                  aria-pressed={qr !== null}
                  className="flex size-10 items-center justify-center rounded-[10px] border border-line-strong text-ink-2 transition-colors duration-150 hover:bg-raise hover:text-ink"
                  title="Show QR code"
                >
                  <QrCode className="size-4" strokeWidth={1.5} />
                </button>
              </div>

              {qr ? (
                <div className="flex justify-center rounded-[10px] border border-line bg-inset p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="QR code for the secret link" width={232} height={232} className="rounded-[4px]" />
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                <BurnLine total={created.views} left={created.views} />
                <div className="flex items-center justify-between font-mono text-[11px] text-ink-3">
                  <span>{formatReadLifetime(created.views)}</span>
                  <span>{formatExpiryLifetime(created.expiresAt)}</span>
                </div>
              </div>

            </>
          )}

          <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
            {destroyed ? (
              <span aria-hidden="true" />
            ) : (
              <button
                type="button"
                onClick={burnNow}
                className="text-[12px] text-ink-3 transition-colors duration-150 hover:text-bad"
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="ml-auto flex items-center gap-1.5 rounded-[8px] border border-line-strong px-3 py-1.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-raise hover:text-ink"
            >
              {destroyed ? "Create a new link" : "Create another"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={noteId} className="text-[11px] text-ink-2">
                Note
              </label>
              <span className="font-mono text-[10px] text-ink-3">
                {note.trim().length > 0
                  ? `${note.trim().length}/${LIMITS.maxNoteChars}`
                  : "optional · shown as the heading"}
              </span>
            </div>
            <input
              id={noteId}
              type="text"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setError(null);
              }}
              maxLength={LIMITS.maxNoteChars}
              placeholder="For the person opening it — e.g. The vault code, read once"
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full rounded-[10px] border border-line bg-inset px-3.5 text-[13px] text-ink outline-none transition-colors duration-150 focus:border-line-strong placeholder:text-ink-3"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div
              role="tablist"
              aria-label="What are you sending"
              className="flex rounded-[8px] border border-line bg-deep p-0.5"
            >
              {(
                [
                  { value: "text", label: "Text", icon: FileText },
                  { value: "file", label: "File", icon: Paperclip },
                ] as const
              ).map((tab) => {
                const active = mode === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setMode(tab.value);
                      setError(null);
                    }}
                    className={`flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors duration-150 ${
                      active
                        ? "bg-raise text-ink"
                        : "text-ink-3 hover:text-ink-2"
                    }`}
                  >
                    <tab.icon className="size-3.5" strokeWidth={1.5} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <span className="font-mono text-[11px] text-ink-3">AES-256-GCM</span>
          </div>

          {mode === "text" ? (
            <div className="rounded-[10px] border border-line bg-inset focus-within:border-line-strong">
              <label htmlFor={textId} className="sr-only">
                Secret text
              </label>
              <textarea
                id={textId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Password, API key, connection string, a note"
                spellCheck={false}
                autoComplete="off"
                className="h-[148px] w-full resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-5 text-ink outline-none placeholder:text-ink-3"
              />
              <div className="flex items-center justify-between border-t border-line px-3.5 py-2 font-mono text-[11px] text-ink-3">
                <span>{formatChars(text.length)}</span>
                <span>{LIMITS.maxTextChars.toLocaleString("en-US")} max</span>
              </div>
            </div>
          ) : (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                pickFile(event.dataTransfer.files?.[0] ?? null);
              }}
              className={`flex h-[184px] flex-col items-center justify-center gap-2 rounded-[10px] border bg-inset px-4 text-center transition-colors duration-150 ${
                dragging ? "border-ember" : "border-line"
              }`}
            >
              {file ? (
                <>
                  <Paperclip className="size-4 text-ink-2" strokeWidth={1.5} />
                  <p className="max-w-full truncate px-2 text-[13px] text-ink">{file.name}</p>
                  <p className="font-mono text-[11px] text-ink-3">
                    {formatBytes(file.size)} · encrypted in this tab
                  </p>
                  <button
                    type="button"
                    onClick={() => pickFile(null)}
                    className="mt-1 flex items-center gap-1 text-[12px] text-ink-3 transition-colors duration-150 hover:text-bad"
                  >
                    <X className="size-3" strokeWidth={1.5} />
                    Remove
                  </button>
                </>
              ) : (
                <>
                  <Paperclip className="size-4 text-ink-3" strokeWidth={1.5} />
                  <p className="text-[13px] text-ink-2">
                    Drop a file, or{" "}
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="text-ink underline decoration-line-strong underline-offset-4 transition-colors duration-150 hover:decoration-ink-3"
                    >
                      choose one
                    </button>
                  </p>
                  <p className="font-mono text-[11px] text-ink-3">10 MB max · any type</p>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Reads" htmlFor={viewsId}>
              <Select
                id={viewsId}
                value={views}
                onChange={(value) => setViews(Number(value))}
                options={VIEW_OPTIONS.map((count) => ({
                  value: String(count),
                  label: formatReads(count),
                }))}
              />
            </Field>
            <Field label="Expires" htmlFor={ttlId}>
              <Select
                id={ttlId}
                value={ttl}
                onChange={(value) => setTtl(Number(value))}
                options={TTL_OPTIONS.map((option) => ({
                  value: String(option.hours),
                  label: option.label,
                }))}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                setUsePass(!usePass);
                setError(null);
              }}
              className="flex items-center gap-2 self-start text-[12px] text-ink-3 transition-colors duration-150 hover:text-ink-2"
              aria-pressed={usePass}
            >
              <span
                className={`flex size-3.5 items-center justify-center rounded-[3px] border transition-colors duration-150 ${
                  usePass ? "border-ember bg-ember" : "border-line-strong"
                }`}
              >
                {usePass ? (
                  <Check className="size-2.5 text-page" strokeWidth={2.5} />
                ) : null}
              </span>
              Add a password
            </button>

            {usePass ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-[10px] border border-line bg-inset px-3">
                  <Lock className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.5} />
                  <label htmlFor={passId} className="sr-only">
                    Password
                  </label>
                  <input
                    id={passId}
                    type="password"
                    value={pass}
                    onChange={(event) => setPass(event.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    className="h-10 w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
                  />
                </div>
                <p className="text-[12px] leading-4 text-ink-3">
                  The link will not contain the key. Send the password another way.
                </p>
              </div>
            ) : null}
          </div>

          {error ? (
            <p className="flex items-start gap-2 text-[12px] leading-4 text-bad">
              <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <button
              type="submit"
              disabled={busy}
              className="flex h-11 items-center justify-center gap-2 rounded-[10px] bg-ember text-[14px] font-medium text-page transition-colors duration-150 hover:bg-ember-hi disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                  Encrypting in this tab
                </>
              ) : (
                "Create one-time link"
              )}
            </button>
            <p className="text-center text-[11px] text-ink-3">
              The plaintext never leaves this tab
            </p>
          </div>
        </form>
      )}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] text-ink-3">
        {label}
      </label>
      {children}
    </div>
  );
}

function Select({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: number;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full appearance-none rounded-[8px] border border-line bg-inset pl-3 pr-8 text-[12px] text-ink outline-none transition-colors duration-150 hover:border-line-strong focus-visible:border-line-strong"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-card text-ink">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
        strokeWidth={1.5}
      />
    </div>
  );
}
