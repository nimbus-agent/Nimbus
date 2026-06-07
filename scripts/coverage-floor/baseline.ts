export interface FileFloor {
  readonly line: number;
  readonly branch: number;
}

export interface Baseline {
  readonly version: 2;
  readonly generated_at: string;
  readonly files: Map<string, FileFloor>;
}

export interface BaselineDiff {
  readonly regressions: ReadonlyArray<{
    path: string;
    dimension: "line" | "branch";
    baseline: number;
    actual: number;
  }>;
  readonly mustRaise: ReadonlyArray<{ path: string }>;
  readonly mustRemove: ReadonlyArray<{ path: string }>;
  readonly missingFromActual: ReadonlyArray<string>;
}

export const FLOOR_PCT = 80; // line floor
export const BRANCH_FLOOR_PCT = 80; // branch floor (separate constant so it can diverge)

function assertPct(label: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`baseline entry ${label}: must be a number in [0, 100]`);
  }
  return v;
}

export function parseBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("baseline JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj["version"];
  if (version !== 1 && version !== 2) {
    throw new Error(`baseline version must be 1 or 2 (got ${JSON.stringify(version)})`);
  }
  if (typeof obj["generated_at"] !== "string") {
    throw new TypeError("baseline generated_at must be an ISO-8601 string");
  }
  const filesRaw = obj["files"];
  if (filesRaw === null || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    throw new Error("baseline files must be an object");
  }
  const files = new Map<string, FileFloor>();
  for (const [path, entry] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (path.includes("\\")) {
      throw new Error(
        `baseline entry contains backslash separator: ${JSON.stringify(path)} — use forward slashes (e.g. "packages/gateway/src/foo.ts")`,
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`baseline entry ${path}: must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (version === 1) {
      // v1 -> v2 read shim: branch floor starts at 0 (ratchet-from-zero).
      files.set(path, {
        line: assertPct(`${path}.min_coverage_pct`, e["min_coverage_pct"]),
        branch: 0,
      });
    } else {
      files.set(path, {
        line: assertPct(`${path}.min_line_pct`, e["min_line_pct"]),
        branch: assertPct(`${path}.min_branch_pct`, e["min_branch_pct"]),
      });
    }
  }
  return { version: 2, generated_at: obj["generated_at"], files };
}

export function serializeBaseline(b: Baseline): string {
  const sortedKeys = Array.from(b.files.keys()).sort((a, b) => (a > b ? 1 : -1));
  const files: Record<string, { min_line_pct: number; min_branch_pct: number }> = {};
  for (const k of sortedKeys) {
    const v = b.files.get(k);
    if (v !== undefined) files[k] = { min_line_pct: v.line, min_branch_pct: v.branch };
  }
  return `${JSON.stringify({ version: 2, generated_at: b.generated_at, files }, null, 2)}\n`;
}

export function computeBaselineDiff(
  baseline: Baseline,
  actualLine: ReadonlyMap<string, number>,
  actualBranch: ReadonlyMap<string, number>,
): BaselineDiff {
  const regressions: Array<{
    path: string;
    dimension: "line" | "branch";
    baseline: number;
    actual: number;
  }> = [];
  const mustRaise: Array<{ path: string }> = [];
  const mustRemove: Array<{ path: string }> = [];
  const missingFromActual: string[] = [];
  for (const [path, floor] of baseline.files) {
    const present = actualLine.has(path) || actualBranch.has(path);
    const lineActual = actualLine.get(path) ?? 0;
    const branchActual = actualBranch.get(path) ?? 0;
    if (!present) missingFromActual.push(path);
    let regressed = false;
    if (lineActual < floor.line) {
      regressions.push({ path, dimension: "line", baseline: floor.line, actual: lineActual });
      regressed = true;
    }
    if (branchActual < floor.branch) {
      regressions.push({ path, dimension: "branch", baseline: floor.branch, actual: branchActual });
      regressed = true;
    }
    if (regressed) continue;
    const fullySatisfied = lineActual >= FLOOR_PCT && branchActual >= BRANCH_FLOOR_PCT;
    if (fullySatisfied) {
      mustRemove.push({ path });
    } else if (lineActual > floor.line || branchActual > floor.branch) {
      mustRaise.push({ path });
    }
  }
  return { regressions, mustRaise, mustRemove, missingFromActual };
}
