export interface FileCoverage {
  readonly lines: number;
  readonly covered: number;
  readonly pct: number;
}

export function parseLcov(text: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let currentFile: string | null = null;
  let lines = 0;
  let covered = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).replaceAll("\\", "/");
      lines = 0;
      covered = 0;
      continue;
    }
    if (line.startsWith("DA:") && currentFile !== null) {
      const comma = line.indexOf(",");
      if (comma === -1) continue;
      lines += 1;
      const hit = Number.parseInt(line.slice(comma + 1), 10);
      if (Number.isFinite(hit) && hit > 0) covered += 1;
      continue;
    }
    if (line === "end_of_record" && currentFile !== null) {
      const pct = lines === 0 ? 100 : Math.round(((100 * covered) / lines) * 100) / 100;
      out.set(currentFile, { lines, covered, pct });
      currentFile = null;
      lines = 0;
      covered = 0;
    }
  }
  return out;
}
