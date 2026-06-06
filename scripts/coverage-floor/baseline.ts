export interface Baseline {
  readonly version: 1;
  readonly generated_at: string;
  readonly files: Map<string, number>;
}

export interface BaselineDiff {
  readonly regressions: ReadonlyArray<{ path: string; baseline: number; actual: number }>;
  readonly mustRaise: ReadonlyArray<{ path: string; baseline: number; actual: number }>;
  readonly mustRemove: ReadonlyArray<{ path: string; actual: number }>;
  readonly missingFromActual: ReadonlyArray<string>;
}

export const FLOOR_PCT = 80;

export function parseBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("baseline JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== 1) {
    throw new Error(`baseline version must be 1 (got ${JSON.stringify(obj["version"])})`);
  }
  if (typeof obj["generated_at"] !== "string") {
    throw new TypeError("baseline generated_at must be an ISO-8601 string");
  }
  const filesRaw = obj["files"];
  if (filesRaw === null || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    throw new Error("baseline files must be an object");
  }
  const files = new Map<string, number>();
  for (const [path, entry] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (path.includes("\\")) {
      throw new Error(
        `baseline entry contains backslash separator: ${JSON.stringify(path)} — use forward slashes (e.g. "packages/gateway/src/foo.ts")`,
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`baseline entry ${path}: must be an object`);
    }
    const pct = (entry as Record<string, unknown>)["min_coverage_pct"];
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(`baseline entry ${path}: min_coverage_pct must be a number in [0, 100]`);
    }
    files.set(path, pct);
  }
  return { version: 1, generated_at: obj["generated_at"], files };
}

export function serializeBaseline(b: Baseline): string {
  const sortedKeys = Array.from(b.files.keys()).sort((a, b) => (a > b ? 1 : -1));
  const files: Record<string, { min_coverage_pct: number }> = {};
  for (const k of sortedKeys) {
    const v = b.files.get(k);
    if (v !== undefined) files[k] = { min_coverage_pct: v };
  }
  return `${JSON.stringify(
    { version: b.version, generated_at: b.generated_at, files },
    null,
    2,
  )}\n`;
}

export function computeBaselineDiff(
  baseline: Baseline,
  actual: ReadonlyMap<string, number>,
): BaselineDiff {
  const regressions: Array<{ path: string; baseline: number; actual: number }> = [];
  const mustRaise: Array<{ path: string; baseline: number; actual: number }> = [];
  const mustRemove: Array<{ path: string; actual: number }> = [];
  const missingFromActual: string[] = [];
  for (const [path, minPct] of baseline.files) {
    const present = actual.has(path);
    const actualPct = actual.get(path) ?? 0;
    if (!present) missingFromActual.push(path);
    if (actualPct < minPct) {
      regressions.push({ path, baseline: minPct, actual: actualPct });
    } else if (actualPct >= FLOOR_PCT) {
      mustRemove.push({ path, actual: actualPct });
    } else if (actualPct > minPct) {
      mustRaise.push({ path, baseline: minPct, actual: actualPct });
    }
  }
  return { regressions, mustRaise, mustRemove, missingFromActual };
}
