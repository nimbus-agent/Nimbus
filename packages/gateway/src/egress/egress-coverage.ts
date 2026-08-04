// packages/gateway/src/egress/egress-coverage.ts

/**
 * How completely a binary observed one egress class.
 * Ordered weakest-first; `weakestCoverage` relies on this order.
 */
export const GRANULARITIES = ["none", "per-run", "per-call"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The egress-BEARING source types. Marker classes carry no coverage claim. */
export const COVERAGE_CLASSES = ["model", "peer", "session", "sync", "task"] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type CoverageVector = Readonly<Record<CoverageClass, Granularity>>;

/**
 * What THIS binary is built to observe. Phase 1 adds no coverage — it only makes the existing
 * claim honest — so only `task` is non-`none`. Later phases raise `sync`, `model`, `peer`,
 * `session`; raising an entry without landing its appender is the exact defect this vector exists
 * to prevent.
 */
export const THIS_BINARY_COVERAGE: CoverageVector = {
  task: "per-call",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/**
 * Claims nothing about any class. Used as the contribution of an UNPARSEABLE boot marker, so the
 * weakest-merge drives the whole window to `none` (→ `indeterminate`) rather than letting a
 * sibling marker's richer claim stand unchallenged.
 */
export const ALL_NONE_COVERAGE: CoverageVector = {
  task: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/** Stable, key-sorted serialization. Stored in the HASHED `source_id`, so it must be canonical. */
export function serializeCoverage(v: CoverageVector): string {
  return COVERAGE_CLASSES.map((c) => `${c}=${v[c]}`).join(";");
}

function isGranularity(s: string): s is Granularity {
  return (GRANULARITIES as readonly string[]).includes(s);
}

/**
 * Parse; returns null (never a guess, never a partial vector) unless the string is EXACTLY the
 * canonical `serializeCoverage` shape: every `;`-segment is a single `key=value` pair (no extra
 * `=`), every key is a known `CoverageClass`, every key appears at most once, and every class is
 * present with a recognized `Granularity`.
 *
 * This is deliberately strict — a marker written by a NEWER binary that adds an unknown coverage
 * class, or that is merely malformed, must be REJECTED (→ `null`, which the caller turns into
 * `ALL_NONE_COVERAGE`) rather than silently accepted with the unknown/duplicate/extra data
 * dropped. Accepting-and-ignoring would let that marker contribute real (understated but
 * plausible-looking) coverage instead of forcing the window to `indeterminate` — exactly the
 * forward-compatibility failure this function exists to prevent.
 */
export function parseCoverage(s: string): CoverageVector | null {
  const found = new Map<string, string>();
  for (const part of s.split(";")) {
    const eq = part.split("=");
    if (eq.length !== 2) return null; // not exactly one `key=value` pair (0 or ≥2 `=` signs)
    const [k, val] = eq as [string, string];
    if (!(COVERAGE_CLASSES as readonly string[]).includes(k)) return null; // unknown key
    if (found.has(k)) return null; // duplicate key
    found.set(k, val);
  }
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    const val = found.get(c);
    if (val === undefined || !isGranularity(val)) return null;
    out[c] = val;
  }
  return out as CoverageVector;
}

/**
 * The weakest granularity per class across every binary that wrote into a window.
 *
 * An EMPTY list yields all-`none`: with no boot marker there is no evidence of any coverage, and
 * the correct response is to claim nothing.
 */
export function weakestCoverage(vs: readonly CoverageVector[]): CoverageVector {
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    let weakest: Granularity = "none";
    if (vs.length > 0) {
      weakest = vs.reduce<Granularity>((acc, v) => {
        return GRANULARITIES.indexOf(v[c]) < GRANULARITIES.indexOf(acc) ? v[c] : acc;
      }, "per-call");
    }
    out[c] = weakest;
  }
  return out as CoverageVector;
}
