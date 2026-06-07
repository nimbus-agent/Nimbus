export interface FileCoverage {
  readonly lines: number;
  readonly covered: number;
  readonly pct: number;
  readonly branches: number;
  readonly branchesHit: number;
  readonly branchPct: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseLcov(text: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let currentFile: string | null = null;
  let lines = 0;
  let covered = 0;
  let branches = 0;
  let branchesHit = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).replaceAll("\\", "/");
      lines = 0;
      covered = 0;
      branches = 0;
      branchesHit = 0;
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
    if (line.startsWith("BRDA:") && currentFile !== null) {
      const taken = line.slice(line.lastIndexOf(",") + 1);
      branches += 1;
      if (taken !== "-") {
        const n = Number.parseInt(taken, 10);
        if (Number.isFinite(n) && n > 0) branchesHit += 1;
      }
      continue;
    }
    if (line === "end_of_record" && currentFile !== null) {
      const pct = lines === 0 ? 100 : round2((100 * covered) / lines);
      const branchPct = branches === 0 ? 100 : round2((100 * branchesHit) / branches);
      out.set(currentFile, { lines, covered, pct, branches, branchesHit, branchPct });
      currentFile = null;
      lines = 0;
      covered = 0;
      branches = 0;
      branchesHit = 0;
    }
  }
  return out;
}
