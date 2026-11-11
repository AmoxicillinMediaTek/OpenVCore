import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "SchemaLoad — one-time secrets that delete themselves",
  description:
    "Send a password, API key, or file once. Encrypted in your browser with AES-256-GCM. The key stays in the link, the server only stores a sealed blob, and it deletes itself after the reads you allow.",
  metadataBase: new URL("https://schemaload.local"),
  openGraph: {
    title: "SchemaLoad — one-time secrets",
    description:
      "Zero-knowledge, one-time links for passwords, keys, and files.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#161513",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-page text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
