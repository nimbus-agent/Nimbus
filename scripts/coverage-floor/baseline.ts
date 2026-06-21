export interface FileFloor {
  readonly line: number;
  readonly branch: number;
}

export interface Baseline {
  readonly version: 2;
  readonly generated_at: string;
  /**
   * Below-floor debt: files that have NOT yet cleared the 80% line+branch floor. The ratchet
   * (`computeUpdatedBaseline`) grinds these up and drops each one once it clears both floors.
   */
  readonly files: Map<string, FileFloor>;
  /**
   * Flagship 100% targets (hand-curated, NEVER auto-generated). A file listed here must meet its
   * required pct on BOTH axes regardless of the global floor — `check.ts` flags `below_target`
   * otherwise. The ratchet leaves this section untouched (`computeUpdatedBaseline` round-trips it
   * verbatim), so a reseed can never silently lower a pinned 100% ceiling. Disjoint from `files`:
   * a target is by definition above the debt floor and must never also be a ratchet entry.
   */
  readonly targets: Map<string, FileFloor>;
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

export const FLOOR_PCT = 85; // line floor
export const BRANCH_FLOOR_PCT = 80; // branch floor (separate constant; line floor raised to 85 ahead of branch)

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
  const targets = parseFloorMap(obj["targets"], "target", files);
  return { version: 2, generated_at: obj["generated_at"], files, targets };
}

/**
 * Parse the optional `targets` map (flagship 100% ceilings). Same `{min_line_pct, min_branch_pct}`
 * shape as v2 `files`, but never has a v1 form. A target path must not also be a `files` entry —
 * the two carry contradictory intent (debt-below-floor vs pinned-above-floor).
 */
function parseFloorMap(
  raw: unknown,
  label: string,
  files: ReadonlyMap<string, FileFloor>,
): Map<string, FileFloor> {
  const out = new Map<string, FileFloor>();
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`baseline ${label}s must be an object`);
  }
  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (path.includes("\\")) {
      throw new Error(
        `baseline ${label} contains backslash separator: ${JSON.stringify(path)} — use forward slashes`,
      );
    }
    if (files.has(path)) {
      throw new Error(
        `baseline path ${JSON.stringify(path)} is in both files and ${label}s — a ${label} is above the debt floor and must not also be a ratchet entry`,
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`baseline ${label} ${path}: must be an object`);
    }
    const e = entry as Record<string, unknown>;
    out.set(path, {
      line: assertPct(`${label}s.${path}.min_line_pct`, e["min_line_pct"]),
      branch: assertPct(`${label}s.${path}.min_branch_pct`, e["min_branch_pct"]),
    });
  }
  return out;
}

function serializeFloorMap(
  m: ReadonlyMap<string, FileFloor>,
): Record<string, { min_line_pct: number; min_branch_pct: number }> {
  const sortedKeys = Array.from(m.keys()).sort((x, y) => (x > y ? 1 : -1));
  const out: Record<string, { min_line_pct: number; min_branch_pct: number }> = {};
  for (const k of sortedKeys) {
    const v = m.get(k);
    if (v !== undefined) out[k] = { min_line_pct: v.line, min_branch_pct: v.branch };
  }
  return out;
}

export function serializeBaseline(b: Baseline): string {
  return `${JSON.stringify(
    {
      version: 2,
      generated_at: b.generated_at,
      files: serializeFloorMap(b.files),
      targets: serializeFloorMap(b.targets),
    },
    null,
    2,
  )}\n`;
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
    } else if (
      // Only a genuinely SUB-FLOOR stored watermark is ratchetable. A satisfied
      // axis is pinned at the floor by computeUpdatedBaseline (e.g. a 95%-line /
      // 55%-branch file stores {line: 80, branch: 55}); its actual sits above 80
      // by design, so it must NOT trigger must_raise — otherwise the gate could
      // never be green right after a reseed (every mixed file would loop).
      (floor.line < FLOOR_PCT && lineActual > floor.line) ||
      (floor.branch < BRANCH_FLOOR_PCT && branchActual > floor.branch)
    ) {
      mustRaise.push({ path });
    }
  }
  return { regressions, mustRaise, mustRemove, missingFromActual };
}
