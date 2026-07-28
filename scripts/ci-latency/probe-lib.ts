/**
 * Pure helpers for the two P4b diagnostic probes.
 *
 * They live apart from the probes so the arithmetic is unit-testable without a
 * network call. The probes themselves are thin: fetch, map, print.
 */

import { isRecord } from "../structure-audit/_gh-audit.ts";

export interface CompletedJob {
  name: string;
  completed_at: string | null;
}

export interface Job {
  name: string;
  created_at: string;
  /** Null when the job was skipped rather than executed. */
  started_at: string | null;
  completed_at: string | null;
}

/**
 * Parses the `jobs` array of a GitHub Actions "list jobs for a workflow run"
 * API payload. Shared by both probes — they used to each carry a byte-for-byte
 * copy of this function, which is exactly the kind of drift risk `pageJobs`
 * below was already extracted to avoid.
 *
 * `started_at` is deliberately NOT part of the validity check: a skipped job
 * (e.g. a Linux-only coverage leg skipped on macOS/Windows) can lack it while
 * still being a real, completed job that must count toward `pageJobs`'s
 * completeness reconciliation against the API's `total_count`. Dropping such
 * a record here would make that total unreachable and the read would be
 * misjudged incomplete. Metrics that need `started_at` (e.g.
 * `concurrencySeries`) exclude such jobs themselves, at the point of
 * calculation — never here, where doing so would corrupt completeness.
 */
export function asJobs(value: unknown): Job[] {
  if (!isRecord(value) || !Array.isArray(value["jobs"])) return [];
  const out: Job[] = [];
  for (const j of value["jobs"]) {
    if (!isRecord(j)) continue;
    const name = j["name"];
    const created = j["created_at"];
    const started = j["started_at"];
    const completed = j["completed_at"];
    if (typeof name !== "string" || typeof created !== "string") continue;
    out.push({
      name,
      created_at: created,
      started_at: typeof started === "string" ? started : null,
      completed_at: typeof completed === "string" ? completed : null,
    });
  }
  return out;
}

export interface RunningJob {
  /**
   * Null when the job never reported a start (e.g. it was skipped rather than
   * executed — this branch's Linux-only coverage legs are skipped on macOS
   * and Windows). Such a job cannot contribute to a per-minute concurrency
   * count and is excluded from that metric, not treated as started at time 0.
   */
  started_at: string | null;
  completed_at: string | null;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  if (s.length % 2 === 1) return s[Math.floor(mid)] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Whole minutes from `b` to `a`. Unparseable input yields 0, never NaN. */
export function minutesBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return (ta - tb) / 60_000;
}

/**
 * The upstream job whose completion gated a dependent job — i.e. the last one
 * to finish at or before `eligibleAt` (the moment the dependent job became
 * eligible to run, e.g. its `created_at`).
 *
 * The cutoff matters structurally, not just cosmetically: a candidate that
 * finished LATER than `eligibleAt` cannot have gated anything — it simply
 * happened to run long. Taking the unrestricted global max would misattribute
 * gating to whichever candidate was slowest, rather than whichever candidate
 * the dependent job actually waited on. Returns null when no candidate
 * completed at or before the cutoff — including when `eligibleAt` itself does
 * not parse, since an unparseable cutoff must never be treated as "no
 * cutoff" (that would silently fall back to the unrestricted global max this
 * function exists to avoid).
 */
export function bindingUpstream(jobs: CompletedJob[], eligibleAt: string): CompletedJob | null {
  const cutoff = Date.parse(eligibleAt);
  if (Number.isNaN(cutoff)) return null;
  let best: CompletedJob | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const j of jobs) {
    if (j.completed_at === null) continue;
    const at = Date.parse(j.completed_at);
    if (Number.isNaN(at) || at <= bestAt) continue;
    if (at > cutoff) continue;
    bestAt = at;
    best = j;
  }
  return best;
}

/**
 * Tallies each leg's binding upstream job into `into`, returning how many legs
 * were DROPPED because no candidate completed at or before their eligibility
 * moment (`bindingUpstream` returned null).
 *
 * The drop count is not bookkeeping. A dropped leg contributes nothing to the
 * attribution tally and, before this counted them, vanished with no output at
 * all. That was tolerable while the gating margin was ~60 minutes — a null was
 * close to impossible. Narrowing `e2e-desktop` to `needs: [ci-rust]` collapses
 * the margin to ~1.2 minutes, so a leg created a few seconds before its
 * upstream's `completed_at` timestamp is now plausible. This probe is the ONLY
 * instrument that can show the narrowing worked, so it must not silently
 * measure fewer legs than ran.
 */
export function accumulateBinding(
  into: Map<string, number>,
  upstream: CompletedJob[],
  legs: readonly { created_at: string }[],
): number {
  let dropped = 0;
  for (const leg of legs) {
    const gatedBy = bindingUpstream(upstream, leg.created_at);
    if (gatedBy === null) {
      dropped++;
      continue;
    }
    into.set(gatedBy.name, (into.get(gatedBy.name) ?? 0) + 1);
  }
  return dropped;
}

/**
 * How many jobs were running at each whole-minute offset from `runStartedAt`.
 *
 * A job missing either timestamp cannot contribute to this metric and is
 * EXCLUDED from it — never counted as running (from `started_at` defaulting
 * to time 0) or as never-running (from being silently kept in the
 * denominator elsewhere). The filter lives here, not in the caller, so every
 * caller gets the same guarantee regardless of what it passes in.
 */
export function concurrencySeries(jobs: RunningJob[], runStartedAt: string): number[] {
  const t0 = Date.parse(runStartedAt);
  const usable = jobs.filter(
    (j): j is RunningJob & { started_at: string; completed_at: string } =>
      j.started_at !== null && j.completed_at !== null,
  );
  if (Number.isNaN(t0) || usable.length === 0) return [];
  const end = Math.max(...usable.map((j) => Date.parse(j.completed_at)));
  if (!Number.isFinite(end)) return [];
  const span = Math.ceil((end - t0) / 60_000);
  const series: number[] = [];
  for (let m = 0; m <= span; m++) {
    const at = t0 + m * 60_000;
    series.push(
      usable.filter((j) => Date.parse(j.started_at) <= at && Date.parse(j.completed_at) > at)
        .length,
    );
  }
  return series;
}

export interface PagedJobs<J> {
  jobs: J[];
  /** Whether the read reconciled against the API's `total_count`. */
  complete: boolean;
  /** `total_count` as last reported by the API, if any page reported one. */
  expected: number | undefined;
}

/**
 * Pages through a run's jobs via `fetchPage`, tracking whether the read is
 * COMPLETE — i.e. whether the accumulated job count reconciles against the
 * API's `total_count`.
 *
 * Job count is this slice's headline metric, so a silently truncated read
 * would report fewer jobs than really ran and be read as proof the change
 * worked. An instrument that fails toward its own hypothesis is worse than
 * none — the same hazard `MAX_READ_FAILURE_RATIO` guards against in the gate
 * itself. This logic used to be duplicated between the two probes and had
 * already drifted once (one copy lost the "verdict computed after the loop,
 * not just inside it" guard); it now lives in exactly one place.
 *
 * `fetchPage` returns the parsed JSON payload for the given 1-indexed page,
 * or `null` on a FAILED read — never on "no more pages" (an exhausted feed is
 * signaled by `parseBatch` returning an empty array). Taking a callback
 * rather than doing network I/O itself keeps this testable without a network
 * call.
 */
export function pageJobs<J>(
  fetchPage: (page: number) => unknown,
  parseBatch: (payload: unknown) => J[],
  maxPages = 5,
): PagedJobs<J> {
  const jobs: J[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const payload = fetchPage(page);
    if (payload === null) return { jobs, complete: false, expected }; // read FAILED, not "no more pages"
    const total = isRecord(payload) ? payload["total_count"] : undefined;
    if (typeof total === "number") expected = total;
    const batch = parseBatch(payload);
    if (batch.length === 0) break;
    jobs.push(...batch);
    if (expected !== undefined && jobs.length >= expected) break;
  }
  return { jobs, complete: expected !== undefined && jobs.length >= expected, expected };
}
