import type { Metadata } from "next";
import { RevealPanel } from "@/components/reveal-panel";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "A sealed secret — OpenVCore",
  robots: { index: false, follow: false, nocache: true },
};

export default async function RevealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <SiteHeader />
      <RevealPanel id={id} />
    </>
  );
}
