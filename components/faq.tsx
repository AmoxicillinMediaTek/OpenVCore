import { PlusIcon as Plus } from "@/components/icons";

const QUESTIONS = [
  {
    question: "What stops the server from reading what it stores?",
    answer:
      "The encryption key is generated in your browser and never sent anywhere. It lives in the part of the link after the #. Browsers strip that fragment before the request leaves the tab, so the machine holding the ciphertext has never had the bytes needed to open it.",
  },
  {
    question: "What happens if the recipient loses the link?",
    answer:
      "It is gone. There is no second copy of the key and no way to regenerate one. Create a new link and send it again.",
  },
  {
    question: "Does the server see the file name?",
    answer:
      "No. The name and MIME type are packed into the encrypted payload ahead of the file bytes. The server knows only that something is a file and how many bytes it is.",
  },
  {
    question: "How does the password change things?",
    answer:
      "The content key is wrapped with a second key derived from your password using PBKDF2-SHA256 at 310,000 rounds. The link carries no key of its own, so an intercepted link is not enough. Send the password through a different channel.",
  },
  {
    question: "What happens on the last read?",
    answer:
      "The server deletes the blob in the same operation that returns it. Requests after that get a 410 and nothing else. The counter is not a soft limit and there is no grace period.",
  },
  {
    question: "Can a link have no limit?",
    answer:
      "Yes, in both directions and independently. Reads can be set to no limit, so the link opens as often as it is used, or expiry can be set to no expiry, so it only dies when its reads run out. Set both and the link lives until someone deletes it. The trade is obvious: a link with no read limit cannot be recalled once it is out, because every copy of it still opens.",
  },
  {
    question: "Can I delete a link before it is read?",
    answer:
      "Yes. The panel after creation has a Delete action, and the row is deleted immediately. Anyone who already has the link finds nothing.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="border-t border-line bg-deep">
      <div className="mx-auto max-w-[1180px] px-6 py-20 lg:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-20">
          <h2 className="text-[28px] font-medium leading-[1.15] tracking-[-0.02em] text-ink md:text-[32px]">
            Questions
          </h2>

          <div className="border-t border-line">
            {QUESTIONS.map((item) => (
              <details key={item.question} className="group border-b border-line">
                <summary className="flex items-start gap-4 py-4">
                  <span className="text-[14px] leading-6 text-ink">{item.question}</span>
                  <Plus
                    className="faq-plus ml-auto mt-1 size-4 shrink-0 text-ink-3"
                    strokeWidth={1.5}
                  />
                </summary>
                <p className="max-w-[62ch] pb-5 pr-8 text-[14px] leading-6 text-ink-2">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
