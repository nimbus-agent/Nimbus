export function parseDurationToMs(raw: string): number {
  const s = raw.trim();
  const m = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(s);
  if (m === null) {
    throw new Error(`Invalid duration "${raw}" (use e.g. 5m, 1h, 90d)`);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid duration "${raw}"`);
  }
  const unit = m[2]?.toLowerCase() ?? "";
  switch (unit) {
    case "ms":
      return Math.floor(n);
    case "s":
      return Math.floor(n * 1000);
    case "m":
      return Math.floor(n * 60 * 1000);
    case "h":
      return Math.floor(n * 60 * 60 * 1000);
    case "d":
      return Math.floor(n * 24 * 60 * 60 * 1000);
    case "w":
      return Math.floor(n * 7 * 24 * 60 * 60 * 1000);
    default:
      throw new Error(`Invalid duration "${raw}"`);
  }
}
