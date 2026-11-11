export function BurnLine({
  total,
  left,
  className = "",
}: {
  /** 0 renders the unbounded track: a link with no read limit. */
  total: number;
  left: number;
  className?: string;
}) {
  if (total === 0) {
    return (
      <div
        className={`burn-track ${className}`}
        role="img"
        aria-label="no read limit"
      >
        <span className="burn-seg" data-unbounded="true" data-live="true" />
      </div>
    );
  }

  const safeTotal = Math.max(1, Math.min(total, 10));
  return (
    <div
      className={`burn-track ${className}`}
      role="img"
      aria-label={`${left} of ${safeTotal} reads left`}
    >
      {Array.from({ length: safeTotal }).map((_, index) => (
        <span
          key={index}
          className="burn-seg"
          data-live={index < left ? "true" : "false"}
        />
      ))}
    </div>
  );
}
