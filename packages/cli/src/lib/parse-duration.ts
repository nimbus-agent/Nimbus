export function parseDurationToMs(raw: string): number {
  const s = raw.trim();
  const m = /^(\d+)\s*(ms|s|m|h)$/i.exec(s);
  if (m === null) {
    throw new Error(`Invalid duration "${raw}" (use e.g. 5m, 1h, 30s)`);
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
    default:
      throw new Error(`Invalid duration "${raw}"`);
  }
}
