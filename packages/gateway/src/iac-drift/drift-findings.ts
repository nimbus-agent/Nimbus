/**
 * IaC drift D2 (Phase 10, owner rulings OR-DRIFT-1 and OR-DRIFT-2): the finding one drift check leaves
 * for one approved Terraform workdir, and the one file the latest findings live in.
 *
 * A finding carries the renderer's own drift lines (`iac-plan-preview.ts`: escaped object addresses
 * and attribute NAMES, never a value) and fixed refusal text, never error text or plan JSON. The latest
 * finding per workdir is stored with NO migration as `<dataDir>/iac-drift/latest.json`, written to a
 * temp file and renamed (mode 0600), and read tolerantly: a missing or malformed file, or a malformed
 * entry, reads as no finding.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IAC_PREFLIGHT_REFUSALS } from "../connectors/connector-writes/iac-limits.ts";
import type { TerraformDriftOutcome } from "../engine/executor.ts";

export type DriftStarter = "owner_cli" | "schedule";
export type DriftStatus = "drift" | "clean" | "failed" | "busy";

export interface DriftFinding {
  readonly workdir: string;
  readonly checkedAt: number;
  readonly startedBy: DriftStarter;
  readonly status: DriftStatus;
  /** Objects changed outside Terraform; `null` when the check did not read a drift report. */
  readonly driftCount: number | null;
  /** Changes an apply would make now (counted, never shown or applied); `null` when unknown. */
  readonly plannedChanges: number | null;
  /** The renderer's escaped drift lines (names, never values); empty unless `status` is drift. */
  readonly lines: readonly string[];
  /** The fixed reason of a failed or busy check. */
  readonly reason?: string;
  /**
   * The drift count of the last check of this workdir that OBSERVED (`drift` or `clean`), carried across
   * `busy` and `failed` checks, which observe nothing. The notification compares against it. Absent
   * when no check has observed yet.
   */
  readonly observedDriftCount?: number;
}

/** What a finding says the workdir looked like: its own count when it observed, else the carried one. */
export function observedDriftCount(f: DriftFinding | undefined): number | undefined {
  if (f === undefined) return undefined;
  if (f.status === "drift" || f.status === "clean") return f.driftCount ?? undefined;
  return f.observedDriftCount;
}

/** The fixed reason a check whose drift report could not be read ends with. */
export const DRIFT_UNREADABLE_REASON = "drift: terraform's drift report could not be read";

/** The finding `outcome` leaves for `workdir`. Pure. */
export function findingFromOutcome(
  workdir: string,
  outcome: TerraformDriftOutcome,
  checkedAt: number,
  startedBy: DriftStarter,
): DriftFinding {
  const base = { workdir, checkedAt, startedBy };
  if (!outcome.ok) {
    const busy = outcome.reason === IAC_PREFLIGHT_REFUSALS.busy;
    return {
      ...base,
      status: busy ? "busy" : "failed",
      driftCount: null,
      plannedChanges: null,
      lines: [],
      reason: outcome.reason,
    };
  }
  const plannedChanges = outcome.plan.changeCount ?? null;
  const count = outcome.plan.driftCount;
  if (typeof count !== "number") {
    return {
      ...base,
      status: "failed",
      driftCount: null,
      plannedChanges,
      lines: [],
      reason: DRIFT_UNREADABLE_REASON,
    };
  }
  if (count === 0) return { ...base, status: "clean", driftCount: 0, plannedChanges, lines: [] };
  return {
    ...base,
    status: "drift",
    driftCount: count,
    plannedChanges,
    lines: [...(outcome.plan.driftLines ?? [])],
  };
}

const FILE_NAME = "latest.json";
const STATUSES: ReadonlySet<string> = new Set(["drift", "clean", "failed", "busy"]);
const STARTERS: ReadonlySet<string> = new Set(["owner_cli", "schedule"]);

function isCount(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

/** A stored entry, or `undefined` when it is not exactly the shape this module writes. */
function parseFinding(v: unknown): DriftFinding | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const { workdir, checkedAt, startedBy, status, driftCount, plannedChanges, lines, reason } = o;
  const observed = o["observedDriftCount"];
  if (typeof workdir !== "string" || workdir === "") return undefined;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return undefined;
  if (typeof startedBy !== "string" || !STARTERS.has(startedBy)) return undefined;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  if (!isCount(driftCount) || !isCount(plannedChanges)) return undefined;
  if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) return undefined;
  if (reason !== undefined && typeof reason !== "string") return undefined;
  if (observed !== undefined && (!isCount(observed) || observed === null)) return undefined;
  return {
    workdir,
    checkedAt,
    startedBy: startedBy as DriftStarter,
    status: status as DriftStatus,
    driftCount,
    plannedChanges,
    lines: lines as string[],
    ...(reason === undefined ? {} : { reason }),
    ...(observed === undefined ? {} : { observedDriftCount: observed }),
  };
}

/** By workdir, in code-unit order (locale-independent). */
function compareWorkdir(a: DriftFinding, b: DriftFinding): number {
  if (a.workdir < b.workdir) return -1;
  if (a.workdir > b.workdir) return 1;
  return 0;
}

/** The directory the findings file lives in. */
export function driftDir(dataDir: string): string {
  return join(dataDir, "iac-drift");
}

function findingsOf(raw: unknown): DriftFinding[] {
  if (!Array.isArray(raw)) return [];
  const byWorkdir = new Map<string, DriftFinding>();
  for (const entry of raw as unknown[]) {
    const f = parseFinding(entry);
    if (f !== undefined) byWorkdir.set(f.workdir, f);
  }
  return [...byWorkdir.values()].sort(compareWorkdir);
}

/** The latest finding per workdir, sorted by workdir. Never throws (for display). */
export function readLatestFindings(dataDir: string): DriftFinding[] {
  try {
    return findingsOf(JSON.parse(readFileSync(join(driftDir(dataDir), FILE_NAME), "utf8")));
  } catch {
    return [];
  }
}

/**
 * The stored findings for a merge: a missing file is none, an unparsable one is none (nothing in it can
 * be kept), but a file that exists and cannot be READ throws, so the write leaves it in place.
 */
function readForMerge(dataDir: string): DriftFinding[] {
  let text: string;
  try {
    text = readFileSync(join(driftDir(dataDir), FILE_NAME), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return findingsOf(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * Replaces each given workdir's finding (others are kept), atomically, and returns the findings each
 * replaced. A `busy` or `failed` finding carries its predecessor's observed count forward. The read and
 * the write are synchronous, so no other check of this process can commit between them.
 */
export function writeLatestFindings(
  dataDir: string,
  findings: readonly DriftFinding[],
): Map<string, DriftFinding> {
  const previous = new Map(readForMerge(dataDir).map((f) => [f.workdir, f] as const));
  const merged = new Map(previous);
  for (const f of findings) {
    const carried =
      f.status === "busy" || f.status === "failed"
        ? observedDriftCount(previous.get(f.workdir))
        : undefined;
    merged.set(f.workdir, carried === undefined ? f : { ...f, observedDriftCount: carried });
  }
  const sorted = [...merged.values()].sort(compareWorkdir);
  const dir = driftDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, FILE_NAME);
  const tmp = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return previous;
}
