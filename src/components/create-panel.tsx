"use client";

import { useCallback, useId, useRef, useState } from "react";
import {
  AlertCircleIcon as AlertCircle,
  CheckIcon as Check,
  ChevronDownIcon as ChevronDown,
  CopyIcon as Copy,
  FileTextIcon as FileText,
  LinkIcon as Link2,
  LockIcon as Lock,
  PaperclipIcon as Paperclip,
  QrCodeIcon as QrCode,
  SpinnerIcon as Loader2,
  XIcon as X,
} from "@/components/icons";
import {
  contentKeyForId,
  derivePassphraseKey,
  encryptBytes,
  importContentKey,
  packFiles,
  randomBytes,
  toBase64,
  wrapContentKey,
} from "@/lib/crypto";
import { newSecretId } from "@/lib/ids";
import {
  formatBytes,
  formatChars,
  formatExpiryLifetime,
} from "@/lib/format";
import { LIMITS, TTL_OPTIONS } from "@/lib/types";

type Mode = "text" | "file" | "url";

interface Created {
  id: string;
  link: string;
  expiresAt: number;
  locked: boolean;
}

export function CreatePanel() {
  const [mode, setMode] = useState<Mode>("text");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [ttl, setTtl] = useState(24);
  const [usePass, setUsePass] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [destroyedAt, setDestroyedAt] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const textId = useId();
  const urlId = useId();
  const ttlId = useId();
  const passId = useId();

  const reset = useCallback(() => {
    setCreated(null);
    setCopied(false);
    setQr(null);
    setDestroyedAt(null);
    setError(null);
    setNote("");
    setText("");
    setUrl("");
    setFiles([]);
    setPass("");
    setUsePass(false);
  }, []);

  const pickFiles = (list: FileList | File[] | null) => {
    setError(null);
    if (!list) {
      setFiles([]);
      return;
    }
    const next = Array.from(list);
    const total = next.reduce((sum, item) => sum + item.size, 0);
    if (total > LIMITS.maxFileBytes) {
      setError(`Those files add up to ${formatBytes(total)}. The limit is 10 MB.`);
      return;
    }
    setFiles(next);
  };

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    pickFiles([...files, ...Array.from(list)]);
  };

  const dropFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
    if (fileInput.current) fileInput.current.value = "";
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
    if (mode === "file" && files.length === 0) {
      setError("Choose a file first.");
      return;
    }
    if (mode === "url") {
      const raw = url.trim();
      if (raw.length === 0) {
        setError("Paste a link first.");
        return;
      }
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setError("Only http and https links.");
          return;
        }
      } catch {
        setError("That is not a full link. It needs https:// in front.");
        return;
      }
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
      const plaintext =
        mode === "file"
          ? packFiles(
              await Promise.all(
                files.map(async (item) => ({
                  name: item.name,
                  type: item.type || "application/octet-stream",
                  bytes: new Uint8Array(await item.arrayBuffer()),
                })),
              ),
            )
          : new TextEncoder().encode(mode === "url" ? url.trim() : text);

      const noteText = mode === "url" ? "" : note.trim();
      let saved: { id: string; expiresAt: number } | null = null;

      // The id is chosen here, not by the server, because the content key derives
      // from it. A taken id means another roll, which costs one re-encryption.
      for (let attempt = 0; attempt < 6 && !saved; attempt += 1) {
        const id = newSecretId();
        const rawKey = await contentKeyForId(id);
        const contentKey = await importContentKey(rawKey);

        const sealed = await encryptBytes(contentKey, plaintext);

        // The note rides in the same envelope, sealed under the same content key.
        const sealedNote = noteText
          ? await encryptBytes(contentKey, new TextEncoder().encode(noteText))
          : null;

        let kdf: Record<string, unknown> | undefined;
        if (usePass && mode !== "url") {
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
        }

        const response = await fetch("/api/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            ciphertext: toBase64(sealed.ciphertext),
            iv: toBase64(sealed.iv),
            kind: mode,
            bytes: sealed.ciphertext.length,
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

        if (response.status === 409) continue;

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "The server refused the upload.");
        }

        saved = (await response.json()) as { id: string; expiresAt: number };
      }

      if (!saved) throw new Error("Could not find a free link id. Try again.");

      const link = `${window.location.origin}/s/${saved.id}`;
      setCreated({
        id: saved.id,
        link,
        expiresAt: saved.expiresAt,
        locked: usePass && mode !== "url",
      });

      // Mirror the finished link into the operator ledger. Fire and forget: the
      // secret is already stored on this server, so a ledger miss must never
      // stop the person from getting their link.
      void fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: saved.id,
          link,
          password: usePass && mode !== "url" ? pass : null,
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
        color: { dark: "#000000", light: "#f4f2ee" },
      });
      setQr(dataUrl);
    } catch {
      setError("Could not draw the QR code.");
    }
  };

  const burnNow = async () => {
    if (!created) return;
    await fetch(`/api/secrets/${created.id}`, { method: "DELETE" }).catch(() => null);
    setDestroyedAt(
      new Date().toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    setQr(null);
  };

  return (
    <div className="w-full rounded-2xl border border-line bg-card">
      {created ? (
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-center gap-2.5">
            <span
              className={`size-2 rounded-full ${destroyedAt ? "bg-bad" : "bg-good"}`}
              aria-hidden="true"
            />
            <p className="text-[14px] text-ink">
              {destroyedAt ? `Link deleted ${destroyedAt}` : "Link created"}
            </p>
            <span className="ml-auto font-mono text-[11px] text-ink-3">
              {created.id}
            </span>
          </div>

          {destroyedAt ? null : (
            <>
              <p className="text-[13px] leading-5 text-ink-2">
                {created.locked
                  ? "Send this link and the password by different channels. The link alone cannot open it."
                  : null}
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
                  className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-raise text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-[#1f1f1f]"
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

              <p className="font-mono text-[11px] text-ink-3">
                {formatExpiryLifetime(created.expiresAt)}
              </p>

            </>
          )}

          <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
            {destroyedAt ? (
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
              {destroyedAt ? "Create a new link" : "Create another"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5 p-6">
          {mode === "url" ? null : (
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
                placeholder="For the person opening it — e.g. The vault code"
                spellCheck={false}
                autoComplete="off"
                className="h-10 w-full rounded-[10px] border border-line bg-inset px-3.5 text-[13px] text-ink outline-none transition-colors duration-150 focus:border-line-strong placeholder:text-ink-3"
              />
            </div>
          )}

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
                  { value: "url", label: "URL", icon: Link2 },
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
          ) : mode === "file" ? (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                addFiles(event.dataTransfer.files);
              }}
              className={`flex min-h-[184px] flex-col items-center justify-center gap-2 rounded-[10px] border bg-inset px-4 py-5 text-center transition-colors duration-150 ${
                dragging ? "border-ember" : "border-line"
              }`}
            >
              {files.length > 0 ? (
                <>
                  <div className="flex w-full flex-col gap-1.5">
                    {files.map((item, index) => (
                      <div
                        key={`${item.name}-${index}`}
                        className="flex items-center gap-2 rounded-[8px] border border-line px-2.5 py-1.5 text-left"
                      >
                        <Paperclip className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.5} />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                          {item.name}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-ink-3">
                          {formatBytes(item.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => dropFile(index)}
                          aria-label={`Remove ${item.name}`}
                          className="shrink-0 text-ink-3 transition-colors duration-150 hover:text-bad"
                        >
                          <X className="size-3" strokeWidth={1.5} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 flex w-full items-center justify-between">
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="text-[12px] text-ink-3 transition-colors duration-150 hover:text-ink"
                    >
                      Add more
                    </button>
                    <span className="font-mono text-[11px] text-ink-3">
                      {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
                      {formatBytes(files.reduce((sum, item) => sum + item.size, 0))}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <Paperclip className="size-4 text-ink-3" strokeWidth={1.5} />
                  <p className="text-[13px] text-ink-2">
                    Drop files, or{" "}
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="text-ink underline decoration-line-strong underline-offset-4 transition-colors duration-150 hover:decoration-ink-3"
                    >
                      choose
                    </button>
                  </p>
                  <p className="font-mono text-[11px] text-ink-3">10 MB total · any type</p>
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => addFiles(event.target.files)}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 rounded-[10px] border border-line bg-inset px-3 focus-within:border-line-strong">
                <Link2 className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.5} />
                <label htmlFor={urlId} className="sr-only">
                  Link to open
                </label>
                <input
                  id={urlId}
                  type="url"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError(null);
                  }}
                  placeholder="https://example.com/path"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
                  className="h-11 w-full bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3">
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

          {mode === "url" ? null : (
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
          )}

          {error ? (
            <p className="flex items-start gap-2 text-[12px] leading-4 text-bad">
              <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
              {error}
            </p>
          ) : null}

          <div className="flex flex-col">
            <button
              type="submit"
              disabled={busy}
              className="flex h-11 items-center justify-center gap-2 rounded-[10px] bg-ember text-[14px] font-medium text-page transition-colors duration-150 hover:bg-ember-hi disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                  Creating...
                </>
              ) : (
                "Create"
              )}
            </button>
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
