export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatChars(chars: number): string {
  return chars === 1 ? "1 character" : `${chars.toLocaleString("en-US")} characters`;
}

export function formatExpiry(expiresAt: number, now = Date.now()): string {
  if (expiresAt === 0) return "never";
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** Sentence for the pre-read summary, where "0" means the link never expires. */
export function formatExpiryLifetime(expiresAt: number): string {
  return expiresAt === 0 ? "No expiry" : formatExpiry(expiresAt);
}
