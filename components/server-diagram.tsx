import { KeyIcon as Key, LockIcon as Lock } from "@/components/icons";

const HEX_ROWS = [
  "4b 1f a7 03 c8 9e 5d 62  91 0b e4 7a 1d 3f 88 c2",
  "07 5e d1 9b 63 a0 2c f8  44 71 be 19 0a d6 3c 5f",
  "92 8f 21 c4 6a 0d b7 35  e0 58 4c 1a 77 93 fd 06",
  "3d 9a 70 15 ce 48 b2 6f  d4 28 91 03 fa 5c 8e 37",
  "61 c0 4e 88 2b 95 17 d3  7c 40 ae 62 09 bf 53 e1",
  "a8 34 6d 02 9c 71 e5 4b  80 16 c9 2f 5a d7 88 3e",
  "12 ef 5b 94 76 3a c1 08  b5 6e 43 d9 27 7f 90 ac",
  "9d 05 68 b3 e2 4f 71 c6  38 ab 14 5d 82 0c f9 6a",
];

export function ServerDiagram() {
  return (
    <section id="server" className="mx-auto max-w-[1180px] px-6 py-20 lg:px-8 lg:py-28">
      <div className="flex max-w-[620px] flex-col gap-3">
        <h2 className="text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-ink md:text-[32px]">
          What the server sees
        </h2>
        <p className="text-[15px] leading-6 text-ink-2">
          Three places a secret passes through. Only one of them can read it.
        </p>
      </div>

      <div className="mt-10 overflow-hidden rounded-[20px] border border-line bg-card">
        <div className="grid divide-y divide-line lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <Cell
            label="In your browser"
            icon={<Lock className="size-3.5 text-ink-3" strokeWidth={1.5} />}
            caption="Plaintext exists here, and only here."
          >
            <dl className="divide-y divide-line rounded-[10px] border border-line bg-inset px-3.5 py-1">
              {[
                ["service", "db-primary"],
                ["user", "app_readonly"],
                ["password", "hoppers-9K!vault-rail"],
              ].map(([term, value], index) => (
                <div key={term} className="flex items-baseline justify-between gap-4 py-1.5">
                  <dt className="font-mono text-[11px] text-ink-3">{term}</dt>
                  <dd
                    className={`truncate font-mono text-[12px] ${
                      index === 2 ? "text-ink" : "text-ink-2"
                    }`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </Cell>

          <Cell
            label="On the wire"
            icon={<span className="font-mono text-[11px] text-ink-3">1.2 kB</span>}
            caption="AES-256-GCM ciphertext. Nothing to read."
          >
            <div className="overflow-hidden rounded-[10px] border border-line bg-inset p-3.5">
              <pre className="overflow-hidden font-mono text-[11px] leading-[18px] text-ink-2">
                {HEX_ROWS.join("\n")}
              </pre>
            </div>
          </Cell>

          <Cell
            label="On the server"
            icon={<span className="font-mono text-[11px] text-ink-3">disk</span>}
            caption="No key, no plaintext, no file name."
          >
            <dl className="divide-y divide-line rounded-[10px] border border-line bg-inset px-3.5 py-1.5 font-mono text-[11px]">
              {[
                ["blob", "1.2 kB"],
                ["kind", "text"],
                ["reads", "0 / 1"],
                ["expires", "2026-11-12T09:14Z"],
              ].map(([term, value]) => (
                <div key={term} className="flex items-baseline justify-between gap-4 py-1.5">
                  <dt className="text-ink-3">{term}</dt>
                  <dd className="tabular-nums text-ink-2">{value}</dd>
                </div>
              ))}
            </dl>
          </Cell>
        </div>

        <div className="flex items-start gap-3 border-t border-line bg-deep px-6 py-4">
          <Key className="mt-0.5 size-4 shrink-0 text-ember" strokeWidth={1.5} />
          <p className="text-[13px] leading-5 text-ink-2">
            The key is generated in your browser and appended to the link after{" "}
            <code className="font-mono text-[12px] text-ink">#</code>. Browsers never
            send fragments, so the request that stores the blob cannot carry the
            key that opens it.
          </p>
        </div>
      </div>
    </section>
  );
}

function Cell({
  label,
  icon,
  caption,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <span className="font-mono text-[11px] text-ink-3">{label}</span>
        {icon}
      </div>
      {children}
      <p className="mt-auto text-[12px] leading-4 text-ink-3">{caption}</p>
    </div>
  );
}
