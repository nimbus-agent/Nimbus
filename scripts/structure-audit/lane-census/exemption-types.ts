// The exemption shape for the index lane-coverage gate; the list is `exemptions.ts`.
/**
 * - `disclosed` — a partial/dead read whose gap the brief or metric discloses to the user.
 * - `legacy` — a pre-contract key read only for rows written before the canonical key existed.
 * - `not-item` — the receiver is not item metadata (e.g. a parsed vendor file).
 * - `by-design` — absence of the key is an intended, handled state, not a gap.
 * - `census-blind` — a read whose real production writer the census writer scan cannot see; the
 *   reason must name that writer function and file (e.g. `ingestClip` in clips/clip-ingest.ts
 *   writes `sourceWordCount` inside a conditional spread). Teaching `writer-emissions.ts` the
 *   shape makes the exemption go stale, which is the intended way to retire it.
 */
export type LaneExemptionCategory =
  | "disclosed"
  | "legacy"
  | "not-item"
  | "by-design"
  | "census-blind";

export type LaneExemption = {
  /** Repo-relative, e.g. "packages/gateway/src/metrics/dora.ts". */
  readonly file: string;
  /** Metadata key (or item type, for a `kind: "type"` read). */
  readonly key: string;
  readonly category: LaneExemptionCategory;
  /** The exact number of violations this exemption suppresses — see the module comment. */
  readonly reads: number;
  readonly reason: string;
};
