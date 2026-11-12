import Link from "next/link";
import { Wordmark } from "@/components/mark";

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-8 px-6 lg:px-8">
        <Link href="/" className="shrink-0" aria-label="OpenVCore home">
          <Wordmark />
        </Link>

        <div className="ml-auto flex items-center gap-5">
          <span className="hidden font-mono text-[11px] text-ink-3 lg:inline">
            no accounts · no plaintext
          </span>
          <a
            href="/#create"
            className="text-[13px] text-ink-2 transition-colors duration-150 hover:text-ink md:hidden"
          >
            Create
          </a>
        </div>
      </div>
    </header>
  );
}
