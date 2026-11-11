import { CreatePanel } from "@/components/create-panel";
import { Faq } from "@/components/faq";
import { Limits } from "@/components/limits";
import { Protocol } from "@/components/protocol";
import { ServerDiagram } from "@/components/server-diagram";
import { SiteHeader } from "@/components/site-header";

const FACTS = ["AES-256-GCM", "key in the fragment", "no account"];

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main>
        <section className="mx-auto max-w-[1180px] px-6 lg:px-8">
          <div className="grid items-center gap-14 py-16 lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:gap-16 lg:py-20">
            <div className="rise flex max-w-[520px] flex-col">
              <p className="font-mono text-[11px] text-ink-3">
                Zero-knowledge, one-time links
              </p>

              <h1 className="mt-5 text-[44px] font-medium leading-[1.02] tracking-[-0.035em] text-ink sm:text-[58px] lg:text-[64px]">
                Send it once.
                <span className="mt-1 block text-ink-2">Then it&rsquo;s gone.</span>
              </h1>

              <p className="mt-6 max-w-[44ch] text-[16px] leading-7 text-ink-2">
                Passwords, API keys, and files, sealed in your browser before they
                leave it. The server holds a blob it cannot read, then deletes it
                after the reads you allow.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] text-ink-3">
                {FACTS.map((fact, index) => (
                  <span key={fact} className="flex items-center gap-3">
                    {index > 0 ? (
                      <span className="h-3 w-px bg-[var(--color-line-strong)]" aria-hidden="true" />
                    ) : null}
                    {fact}
                  </span>
                ))}
              </div>
            </div>

            <div
              id="create"
              className="rise scroll-mt-24"
              style={{ animationDelay: "60ms" }}
            >
              <CreatePanel />
            </div>
          </div>
        </section>

        <ServerDiagram />
        <Protocol />
        <Limits />
        <Faq />
      </main>
    </>
  );
}
