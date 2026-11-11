const SPEC: { term: string; value: string; emphasis?: boolean }[] = [
  { term: "File size", value: "10 MB" },
  { term: "Text length", value: "100,000 characters" },
  { term: "Reads per link", value: "1 to 10, or no limit" },
  { term: "Link lifetime", value: "1 hour to 30 days, or never" },
  { term: "Cipher", value: "AES-256-GCM" },
  { term: "Password KDF", value: "PBKDF2-SHA256 · 310,000" },
  { term: "Accounts", value: "none" },
  { term: "Recovery", value: "none", emphasis: true },
];

export function Limits() {
  return (
    <section id="limits" className="mx-auto max-w-[1180px] px-6 py-20 lg:px-8 lg:py-28">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="flex max-w-[420px] flex-col gap-4">
          <h2 className="text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-ink md:text-[32px]">
            Limits, stated plainly
          </h2>
          <p className="text-[14px] leading-6 text-ink-2">
            A one-time link is a small, sharp tool. These are the edges of it. If a
            file is larger than 10 MB, or someone needs the secret back after it
            burns, this is the wrong tool and the honest answer is to say so.
          </p>
          <p className="text-[14px] leading-6 text-ink-2">
            Nothing is recoverable. There is no copy of the key to reset, no backup
            of the blob, and no support inbox that can undo a read.
          </p>
        </div>

        <dl className="border-t border-line">
          {SPEC.map((row) => (
            <div
              key={row.term}
              className="flex items-baseline justify-between gap-6 border-b border-line py-3.5"
            >
              <dt className="text-[13px] text-ink-2">{row.term}</dt>
              <dd
                className={`font-mono text-[12px] tabular-nums ${
                  row.emphasis ? "text-ember" : "text-ink"
                }`}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
