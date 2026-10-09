import type { LaneCensus } from "../check-index-lane-coverage.ts";
import type { LaneExemption } from "./exemptions.ts";

export type GateViolationKind =
  | "unmatched"
  | "partial"
  | "unscoped"
  | "annotation"
  | "stale-exemption"
  | "exemption-count"
  | "invalid-exemption";

export type GateViolation = {
  readonly kind: GateViolationKind;
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly message: string;
};

/**
 * Evaluates the census against the exemptions. An exemption matches on `(file, key)` and must
 * declare in `reads` the EXACT number of violations it suppresses (ruling amending R6): a (file,
 * key) match alone would also silence a FUTURE dead read of the same key in the same file, so a
 * count that drifts (more or fewer, but above zero) is an `exemption-count` violation, and zero
 * stays `stale-exemption`.
 */
export function evaluateLaneGate(
  census: LaneCensus,
  exemptions: readonly LaneExemption[],
): readonly GateViolation[] {
  const out: GateViolation[] = [];
  const idOf = (file: string, key: string): string => `${file}\u0000${key}`;
  // Suppressed-violation count by (file, key), so a duplicate is reported once, as invalid.
  const used = new Map<string, number>();
  const exemptFor = (file: string, key: string): LaneExemption | undefined => {
    const e = exemptions.find((x) => x.file === file && x.key === key);
    if (e !== undefined) {
      const id = idOf(file, key);
      used.set(id, (used.get(id) ?? 0) + 1);
    }
    return e;
  };
  const seen = new Set<string>();
  for (const e of exemptions) {
    if (e.reason.trim() === "") {
      out.push({
        kind: "invalid-exemption",
        file: e.file,
        line: 0,
        key: e.key,
        message: "exemption has no reason",
      });
    }
    const id = idOf(e.file, e.key);
    if (seen.has(id)) {
      out.push({
        kind: "invalid-exemption",
        file: e.file,
        line: 0,
        key: e.key,
        message: `duplicate exemption for '${e.key}' — merge the reasons`,
      });
    }
    seen.add(id);
  }
  const unscopedIds = new Set(
    census.unscopedReads.map((r) => `${r.file}\u0000${r.line}\u0000${r.value}`),
  );
  for (const r of census.unmatchedItemReads) {
    // An unscoped read also lands here via the __ANY__ union check; report it once, as unscoped.
    if (unscopedIds.has(`${r.file}\u0000${r.line}\u0000${r.value}`)) continue;
    if (exemptFor(r.file, r.value) !== undefined) continue;
    out.push({
      kind: r.matchState === "partial" ? "partial" : "unmatched",
      file: r.file,
      line: r.line,
      key: r.value,
      message:
        r.matchState === "partial"
          ? `'${r.value}' is emitted only by ${(r.partialCoverage ?? []).join(", ")} for this scope`
          : `no writer emits '${r.value}' for this scope`,
    });
  }
  for (const r of census.unscopedReads) {
    if (exemptFor(r.file, r.value) !== undefined) continue;
    out.push({
      kind: "unscoped",
      file: r.file,
      line: r.line,
      key: r.value,
      message: `'${r.value}' has no type scope: add // lane-census: scope=<type> above the statement`,
    });
  }
  for (const a of census.annotationErrors) {
    out.push({ kind: "annotation", file: a.file, line: a.line, key: "", message: a.message });
  }
  const reportedStale = new Set<string>();
  for (const e of exemptions) {
    const id = idOf(e.file, e.key);
    if (reportedStale.has(id)) continue;
    reportedStale.add(id);
    const suppressed = used.get(id) ?? 0;
    if (suppressed === 0) {
      out.push({
        kind: "stale-exemption",
        file: e.file,
        line: 0,
        key: e.key,
        message: `exemption (${e.category}) suppresses nothing — delete it`,
      });
    } else if (suppressed !== e.reads) {
      out.push({
        kind: "exemption-count",
        file: e.file,
        line: 0,
        key: e.key,
        message: `exemption for '${e.key}' suppresses ${suppressed} read(s), declares ${e.reads} — a read was added or removed; review it`,
      });
    }
  }
  return out;
}
