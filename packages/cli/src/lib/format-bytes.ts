/**
 * Bytes as a short DECIMAL string (`3.9 GB`, `512 MB`), matching spec § 16.9's printed shape and
 * `nimbus media understand --budget`'s decimal units — `parseBudget` treats `GB` as 10^9, so
 * echoing a binary-rounded number back at an operator who typed `4GB` would not agree with what
 * they asked for. Exact for a byte count under 1 kB, since rounding `873` to `0.9 kB` loses more
 * than it saves.
 *
 * Lives here (rather than in `commands/media-cmd.ts`, which re-exports it for back-compat) so
 * `commands/media-grants-cmd.ts` can reuse it without creating an import cycle between the two
 * command files (`no-circular`, `.dependency-cruiser.cjs`).
 */
export function formatBytes(bytes: number): string {
  const units: readonly (readonly [number, string])[] = [
    [1_000 ** 3, "GB"],
    [1_000 ** 2, "MB"],
    [1_000, "kB"],
  ];
  for (const [scale, label] of units) {
    if (bytes >= scale) {
      const value = bytes / scale;
      // One decimal below 10 (3.9 GB), none above it (412 MB) — the extra digit stops mattering.
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${label}`;
    }
  }
  return `${bytes} B`;
}
