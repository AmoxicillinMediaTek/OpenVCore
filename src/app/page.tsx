import { CreatePanel } from "@/components/create-panel";
import { SiteHeader } from "@/components/site-header";

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main>
        <section className="mx-auto max-w-[1180px] px-6 lg:px-8">
          <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center py-16 lg:py-20">
            <div
              id="create"
              className="rise w-full max-w-[520px] scroll-mt-24"
            >
              <CreatePanel />
            </div>
          </div>
        </section>
      </main>
    </>
  );
}