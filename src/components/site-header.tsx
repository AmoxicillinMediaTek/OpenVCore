import Link from "next/link";
import { GitHubIcon } from "@/components/icons";
import { Wordmark } from "@/components/mark";

const REPO_URL = "https://github.com/AmoxicillinMediaTek/OpenVCore";

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
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="OpenVCore on GitHub"
            title="OpenVCore on GitHub"
            className="flex size-9 items-center justify-center rounded-full text-ink no-underline transition-colors duration-150 hover:bg-raise"
          >
            <GitHubIcon className="size-5" />
          </a>
        </div>
      </div>
    </header>
  );
}
