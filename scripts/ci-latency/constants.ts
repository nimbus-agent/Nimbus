/**
 * Tuning constants for `audit:ci-latency`, kept in one module so the tests and
 * the gate can never drift apart. Every value here was chosen against measured
 * data — see docs/superpowers/specs/2026-07-27-p4b-ci-latency-design.md.
 */

/** Below this many samples a key is `insufficient-data`: skipped, never failed. */
export const MIN_SAMPLES = 3;

/**
 * Lowering a baseline needs MORE evidence than enforcing one: a few consecutive
 * hot-cache runs is a plausible window, and the cost of a wrongly-low bound is a
 * permanently red gate.
 *
 * 7 is affordable only because sampling is capped per WORKFLOW rather than per
 * repo — under the old per-repo window a stable CI job could reach at most 4
 * samples, which made every threshold above 5 unreachable and the ratchet dead.
 */
export const MIN_SAMPLES_FOR_RATCHET = 7;

/** Ratios and small noise bands are both meaningless on a sub-minute job. */
export const MIN_ABSOLUTE_DELTA_MIN = 1;

/** spread > this × median ⇒ reported `unstable` (observed, never failed). */
export const UNSTABLE_SPREAD_RATIO = 0.5;

/** One cheap list request at the API maximum. */
export const RUN_LIST_PAGE = 100;

/**
 * Caps the EXPENSIVE per-run job fetches, and does so per workflow so a busy
 * workflow cannot starve a quiet one out of the sample.
 */
export const MAX_RUNS_PER_WORKFLOW = 12;

/**
 * Caps how many `jobs` pages a single run's job list can page through. A run
 * with >100 jobs (a wide matrix) needs more than one page to be fully counted,
 * but a bad or wildly wrong `total_count` from the API must not spin the
 * collector forever — 5 pages (500 jobs) is far beyond any real run.
 */
export const MAX_JOB_PAGES = 5;

/**
 * Past this share of failed job reads the sample is degraded: the survivors are
 * whichever runs happened to succeed, so their median could be biased and the
 * gate could manufacture a regression. Skip gating instead.
 */
export const MAX_READ_FAILURE_RATIO = 0.25;

/** PR runs execute a different job set with different cache state. */
export const SAMPLE_EVENT = "push";

/** Below this many minutes a worst-observed line is not worth printing. */
export const MIN_REPORTED_QUEUE_MIN = 1;

/**
 * The org repos audited: the 8-repo `sha-pins` matrix in `org-drift-sweep.yml`
 * plus `Nimbus` itself — that matrix excludes Nimbus because it is the checkout
 * host for the other jobs, not an audit target, but a latency gate that skipped
 * the repo it exists to protect would miss most of what motivates it.
 */
export const AUDITED_REPOS: readonly string[] = [
  "Nimbus",
  "nimbus-client",
  "nimbus-sdk",
  "nimbus-vscode",
  "nimbus-web-clipper",
  ".github",
  "linux-repo",
  "homebrew-tap",
  "scoop-bucket",
];
