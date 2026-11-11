export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/schema-s.svg"
        alt=""
        width={20}
        height={20}
        className="size-5 rounded-[5px]"
      />
      <span className="text-[16px] font-medium tracking-[-0.01em] text-ink">
        SchemaLoad
      </span>
    </span>
  );
}
