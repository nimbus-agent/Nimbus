/**
 * Exemptions for the index lane-coverage gate (`--check`). Matched on `(file, key)` — `file` the
 * repo-relative path, no line number (lines churn). An exemption that suppresses no current
 * violation is itself a violation (stale), so a fixed read cannot leave its exemption behind.
 */
export type LaneExemptionCategory = "disclosed" | "legacy" | "not-item" | "by-design";

export type LaneExemption = {
  /** Repo-relative, e.g. "packages/gateway/src/metrics/dora.ts". */
  readonly file: string;
  /** Metadata key (or item type, for a `kind: "type"` read). */
  readonly key: string;
  readonly category: LaneExemptionCategory;
  readonly reason: string;
};

export const LANE_EXEMPTIONS: readonly LaneExemption[] = [];
