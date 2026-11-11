const STEPS = [
  {
    number: "01",
    title: "Seal it",
    body: "Your browser generates a 256-bit key and encrypts the text or file with AES-256-GCM before a single byte leaves the tab.",
  },
  {
    number: "02",
    title: "Send the link",
    body: "The server stores the sealed blob with a read counter and an expiry. The key travels in the fragment, which never reaches it.",
  },
  {
    number: "03",
    title: "It burns",
    body: "Every open spends one read. On the last one the blob is deleted from disk. A later request for that id returns nothing.",
  },
];

export function Protocol() {
  return (
    <section id="protocol" className="border-y border-line bg-deep">
      <div className="mx-auto max-w-[1180px] px-6 py-20 lg:px-8 lg:py-28">
        <div className="flex max-w-[620px] flex-col gap-3">
          <h2 className="text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-ink md:text-[32px]">
            How it works
          </h2>
          <p className="text-[15px] leading-6 text-ink-2">
            No account, no email, no recovery path. Three steps, in order.
          </p>
        </div>

        <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((step) => (
            <li key={step.number} className="flex flex-col gap-3 border-t border-line-strong pt-5">
              <span className="font-mono text-[11px] text-ink-3">{step.number}</span>
              <h3 className="text-[15px] font-medium text-ink">{step.title}</h3>
              <p className="max-w-[34ch] text-[14px] leading-6 text-ink-2">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
