export function parseSinceDurationToMs(raw: string): number {
  const s = raw.trim();
  const m = /^(\d+)\s*(w|d|h|m|s|ms)$/i.exec(s);
  if (m === null) {
    throw new Error(`Invalid --since value "${raw}" (examples: 7d, 24h, 30m)`);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --since value "${raw}"`);
  }
  const unit = m[2]?.toLowerCase() ?? "";
  switch (unit) {
    case "w":
      return Math.floor(n * 7 * 24 * 60 * 60 * 1000);
    case "d":
      return Math.floor(n * 24 * 60 * 60 * 1000);
    case "h":
      return Math.floor(n * 60 * 60 * 1000);
    case "m":
      return Math.floor(n * 60 * 1000);
    case "s":
      return Math.floor(n * 1000);
    case "ms":
      return Math.floor(n);
    default:
      throw new Error(`Invalid --since unit in "${raw}"`);
  }
}
