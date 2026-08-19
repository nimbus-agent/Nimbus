# `nimbus stats` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nimbus stats <metric> --service <id>`, returning a time series — one value per disjoint bucket — over the already-indexed graph.

**Architecture:** A metric registry (`metrics/stats.ts`) maps six metric ids to evaluators. Four wrap the existing, tested DORA calculators, called once per bucket with `nowMs` bound to the bucket end; two are new SQL counters over real event timestamps. A pure bucket splitter turns a window plus a bucket size into bounds. Each point is a `DoraMetricValue`, so an empty bucket returns `null` plus a named gap rather than a misleading `0`.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict with `exactOptionalPropertyTypes`, `bun:sqlite`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-19-nimbus-stats-design.md`](../specs/2026-08-19-nimbus-stats-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-19-nimbus-stats-design-review-response.md`](../specs/2026-08-19-nimbus-stats-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **Branch:** `dev/asafgolombek/w6b-nimbus-stats`. Never commit on `main`.
- **No schema migration, no new invariant, no new `nimbus.toml` section, no new HTTP route, no Tauri allowlist change.** `ALLOWED_METHODS` stays at **105**.
- **An empty bucket returns `value: null` with a gap — NEVER `0`.** Zero incidents and no incident data are different facts.
- **Every metric buckets on a real event timestamp.** Nothing buckets on `modified_at` or `synced_at`; `item` has no creation timestamp, so those measure last activity (spec F1/D1).
- **Duration parsing is CLI-side only**, via `cli/src/lib/parse-since.ts`'s `parseSinceDurationToMs`. The gateway receives resolved integers. Do **not** use `ipc/metrics-rpc.ts`'s `parseSinceToMs` (`d|h` only) or `index/item-list-query.ts`'s `parseRelativeSinceToWindowMs` (no `w`) — either rejects `1w`, this feature's default bucket.
- **`metrics.stats` appends no `egress_ledger` row** (spec § 7.1) — local SQLite reads only, no connector dispatch, no remote model call.
- **Prefer dependency injection over `mock.module`** — the combined CLI/gateway run on CI Linux leaks `mock.module` state between files.
- Coverage floor: every touched file ≥85% line AND ≥80% branch.
- Run `bun run preflight:fast` before declaring any task done.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/metrics/stats-buckets.ts` | **Create.** Pure bucket splitter + validation. No DB, no I/O. |
| `packages/gateway/src/metrics/stats.ts` | **Create.** The metric registry and `computeStatsSeries`. |
| `packages/gateway/src/ipc/metrics-rpc.ts` | **Modify.** Add a `metrics.stats` arm beside `metrics.dora`. |
| `packages/cli/src/commands/stats.ts` | **Create.** CLI surface, duration parsing, rendering. |
| `packages/cli/src/commands/index.ts` | **Modify.** Export `runStats`. |
| `packages/cli/src/index.ts` | **Modify.** Register `stats` in `COMMAND_HANDLERS`. |
| `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md` | **Modify.** Task 5. |

The splitter is deliberately its own file: it is pure arithmetic with the fiddliest edge cases in the feature, and keeping it DB-free means its tests need no fixture.

---

## Task 1: The bucket splitter

**Files:**

- Create: `packages/gateway/src/metrics/stats-buckets.ts`
- Test: `packages/gateway/src/metrics/stats-buckets.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type StatsBucket = { readonly startMs: number; readonly endMs: number }`
  - `const MAX_BUCKETS = 400`
  - `class StatsBucketError extends Error`
  - `function splitBuckets(untilMs: number, windowMs: number, bucketMs: number): StatsBucket[]`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/metrics/stats-buckets.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { MAX_BUCKETS, StatsBucketError, splitBuckets } from "./stats-buckets.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = 1_700_000_000_000;

describe("splitBuckets", () => {
  test("whole multiple: newest bucket ends exactly at untilMs", () => {
    const b = splitBuckets(NOW, 4 * WEEK, WEEK);
    expect(b.length).toBe(4);
    expect(b[3]?.endMs).toBe(NOW);
    expect(b[0]?.startMs).toBe(NOW - 4 * WEEK);
  });

  test("buckets are contiguous, ascending, and non-overlapping", () => {
    const b = splitBuckets(NOW, 4 * WEEK, WEEK);
    for (let i = 1; i < b.length; i++) {
      expect(b[i]?.startMs).toBe(b[i - 1]?.endMs);
    }
  });

  test("the partial leading bucket keeps its TRUE short bounds, not a padded week", () => {
    // 30 days at weekly granularity = 4 whole weeks + a 2-day remainder.
    const b = splitBuckets(NOW, 30 * DAY, WEEK);
    expect(b.length).toBe(5);
    const oldest = b[0];
    expect(oldest?.startMs).toBe(NOW - 30 * DAY);
    expect((oldest?.endMs ?? 0) - (oldest?.startMs ?? 0)).toBe(2 * DAY);
    expect(b[4]?.endMs).toBe(NOW);
  });

  test("bucket == window yields exactly one bucket", () => {
    const b = splitBuckets(NOW, WEEK, WEEK);
    expect(b.length).toBe(1);
    expect(b[0]).toEqual({ startMs: NOW - WEEK, endMs: NOW });
  });

  // Spec 6.1: unsatisfiable input errors rather than silently collapsing.
  test("bucket > window is an error naming BOTH values", () => {
    let msg = "";
    try {
      splitBuckets(NOW, 3 * DAY, WEEK);
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    expect(msg).toContain(String(3 * DAY));
    expect(msg).toContain(String(WEEK));
  });

  test("zero and negative durations are rejected", () => {
    expect(() => splitBuckets(NOW, 0, WEEK)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, WEEK, 0)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, -WEEK, WEEK)).toThrow(StatsBucketError);
    expect(() => splitBuckets(NOW, WEEK, -DAY)).toThrow(StatsBucketError);
  });

  test("non-integer durations are rejected", () => {
    expect(() => splitBuckets(NOW, 1.5, 1)).toThrow(StatsBucketError);
  });

  // Spec 6.1: over-cap REJECTS, never truncates. A truncated series that looks
  // complete is worse than an error.
  test("exceeding MAX_BUCKETS throws rather than returning the first N", () => {
    const windowMs = (MAX_BUCKETS + 1) * DAY;
    expect(() => splitBuckets(NOW, windowMs, DAY)).toThrow(StatsBucketError);
  });

  test("exactly MAX_BUCKETS is allowed", () => {
    expect(splitBuckets(NOW, MAX_BUCKETS * DAY, DAY).length).toBe(MAX_BUCKETS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/metrics/stats-buckets.test.ts`
Expected: FAIL — cannot resolve module `./stats-buckets.ts`.

- [ ] **Step 3: Implement the splitter**

Create `packages/gateway/src/metrics/stats-buckets.ts`:

```ts
/**
 * Pure bucket arithmetic for `nimbus stats`. No database, no clock, no I/O — the caller
 * supplies `untilMs`, which is why this file's tests need no fixture.
 *
 * BUCKETS WALK BACKWARD FROM `untilMs`, and are deliberately NOT calendar-aligned. The
 * reason is not timezones — UTC would be a defensible fixed choice needing no config. It is
 * that the newest bucket must end exactly at the request time, so the freshest point covers
 * data right up to the moment of asking. Calendar alignment would truncate it at the last
 * boundary, making the newest bucket systematically short and its number systematically low
 * — the worst place for an artefact, because it is the number people read first. See the
 * design spec § 6; `--align` is a recorded follow-up, not an oversight.
 */

export type StatsBucket = { readonly startMs: number; readonly endMs: number };

/**
 * NOT a denial-of-service control — `metrics.stats` has no remote caller (no HTTP route, not
 * Tauri-exposed). This is arithmetic footgun protection: `--window 10y --bucket 1s` is 315
 * million evaluations from a plausible typo. Do not "harden" this as a security limit.
 */
export const MAX_BUCKETS = 400;

export class StatsBucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsBucketError";
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StatsBucketError(`${label} must be a positive integer number of ms, got ${value}`);
  }
}

export function splitBuckets(
  untilMs: number,
  windowMs: number,
  bucketMs: number,
): StatsBucket[] {
  requirePositiveInteger(windowMs, "window");
  requirePositiveInteger(bucketMs, "bucket");
  if (bucketMs > windowMs) {
    throw new StatsBucketError(
      `bucket (${bucketMs}ms) is larger than window (${windowMs}ms) — ` +
        "asking for finer granularity than the window contains",
    );
  }
  const count = Math.ceil(windowMs / bucketMs);
  if (count > MAX_BUCKETS) {
    throw new StatsBucketError(
      `window/bucket yields ${count} buckets, over the ${MAX_BUCKETS} limit — widen the ` +
        "bucket or narrow the window",
    );
  }
  const sinceMs = untilMs - windowMs;
  const out: StatsBucket[] = [];
  // Built oldest-first. The FIRST bucket absorbs the remainder so the LAST one ends exactly
  // at `untilMs` — the freshest point must be complete, and a short bucket is honest only if
  // it is the oldest one, where a reader expects the window edge.
  let cursor = sinceMs;
  const remainder = windowMs % bucketMs;
  if (remainder !== 0) {
    out.push({ startMs: cursor, endMs: cursor + remainder });
    cursor += remainder;
  }
  while (cursor < untilMs) {
    out.push({ startMs: cursor, endMs: cursor + bucketMs });
    cursor += bucketMs;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/metrics/stats-buckets.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/metrics/stats-buckets.ts packages/gateway/src/metrics/stats-buckets.test.ts
git commit -m "feat(metrics): pure bucket splitter for nimbus stats"
```

---

## Task 2: The metric registry

**Files:**

- Create: `packages/gateway/src/metrics/stats.ts`
- Test: `packages/gateway/src/metrics/stats.test.ts`

**Interfaces:**

- Consumes: `splitBuckets`, `StatsBucket`, `StatsBucketError` (Task 1); `ServiceConfig` from `./dora-config.ts`; `deploymentFrequency`, `leadTimeForChanges`, `changeFailureRate`, `mttr`, `type DoraMetricValue`, `type DoraGap` from `./dora.ts`.
- Produces:
  - `type StatsMetricId = "deployment-frequency" | "lead-time" | "change-failure-rate" | "mttr" | "pr-merges" | "incidents-opened"`
  - `type StatsGap = DoraGap | "github_only_merge_data" | "incidents_missing_opened_at"`
  - `type StatsPoint = { start_ms, end_ms, value: number | null, unit: string, sample: number, gap: StatsGap }`
  - `type StatsSeries = { metric: StatsMetricId; service: string; window: { since_ms, until_ms }; bucket_ms: number; points: StatsPoint[] }`
  - `const STATS_METRIC_IDS: readonly StatsMetricId[]`
  - `function computeStatsSeries(db, cfg, metric, untilMs, windowMs, bucketMs): StatsSeries`

**Context the implementer needs:** the four DORA calculators share the signature `(db: Database, cfg: ServiceConfig, nowMs: number, sinceMs: number) => DoraMetricValue`, in which **`sinceMs` is a LOOK-BACK DURATION, not an absolute timestamp** — every calculator computes its lower bound as `nowMs - sinceMs`. So a bucket is "the DORA value for that sub-window" when `nowMs` binds to the bucket's `endMs` and `sinceMs` binds to the bucket's WIDTH, `endMs - startMs`.

> **Corrected 2026-08-19, during the whole-branch review.** This paragraph and the `wrapDora`
> body in Task 2 step 2 both originally said to bind `sinceMs` to the bucket's `startMs` —
> i.e. `fn(db, cfg, endMs, startMs)`. That is wrong by roughly four orders of magnitude:
> `startMs` is an absolute epoch value (~1.7e12), so `nowMs - sinceMs` collapses to a
> near-zero epoch, every bucket's lower bound becomes a no-op, and each point silently
> becomes CUMULATIVE-to-date instead of per-bucket. The shipped binding is
> `fn(db, cfg, endMs, endMs - startMs)`, guarded by the regression test
> "a wrapped DORA metric's newest bucket does not leak an older bucket's data" in
> `metrics/stats.test.ts` — an empty-DB or single-bucket comparison cannot discriminate the
> two bindings, so that test deliberately places one incident inside the OLDER of two buckets
> and asserts the newest is null.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/metrics/stats.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ServiceConfig } from "./dora-config.ts";
import { STATS_METRIC_IDS, computeStatsSeries } from "./stats.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE item (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, type TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT, body_preview TEXT, url TEXT,
    canonical_url TEXT, modified_at INTEGER NOT NULL, author_id TEXT,
    metadata TEXT, synced_at INTEGER NOT NULL, pinned INTEGER DEFAULT 0)`);
  return db;
}

function insertPr(db: Database, id: string, repo: string, mergedAtMs: number | null): void {
  const meta = mergedAtMs === null ? { repo } : { repo, merged_at: mergedAtMs };
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES (?, 'github', 'pr', ?, 'x', ?, ?, ?)`,
    [id, id, NOW, JSON.stringify(meta), NOW],
  );
}

function cfg(repos: ServiceConfig["repos"]): ServiceConfig {
  return {
    serviceId: "checkout-web",
    repos,
    pagerdutyServices: [],
    deployWorkflowPattern: /^[Dd]eploy/,
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

// ParsedDoraRepoUrn is { provider, providerId } — NOT { forge, owner, name }. For GitHub,
// providerId is the "owner/name" string that `metadata.repo` carries on an indexed PR.
const GH: ServiceConfig["repos"] = [{ provider: "github", providerId: "acme/web" }];
const GL: ServiceConfig["repos"] = [
  { provider: "github", providerId: "acme/web" },
  { provider: "gitlab", providerId: "acme/api" },
];

describe("computeStatsSeries — pr-merges", () => {
  test("counts merges into the bucket their merged_at falls in", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 1.5 * DAY); // newest bucket
    insertPr(db, "b", "acme/web", NOW - 2.5 * DAY); // older bucket
    insertPr(db, "c", "acme/web", NOW - 2.6 * DAY); // older bucket
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 4 * DAY, 2 * DAY);
    expect(s.points.length).toBe(2);
    expect(s.points[0]?.value).toBe(2);
    expect(s.points[1]?.value).toBe(1);
  });

  // The single most important assertion in this feature.
  test("an empty bucket is null with a gap, NEVER 0", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 2 * DAY, DAY);
    for (const p of s.points) {
      expect(p.value).toBeNull();
      expect(p.gap).not.toBeNull();
    }
  });

  test("an unmerged PR is not counted", () => {
    const db = makeDb();
    insertPr(db, "open", "acme/web", null);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 2 * DAY, DAY);
    expect(s.points.every((p) => p.value === null)).toBe(true);
  });

  test("malformed metadata JSON does not raise", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('bad', 'github', 'pr', 'bad', 'x', ?, '{not json', ?)`,
      [NOW, NOW],
    );
    insertPr(db, "ok", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  test("a mixed-forge service flags github_only_merge_data", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GL), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.gap).toBe("github_only_merge_data");
  });

  test("a github-only service does NOT flag github_only_merge_data", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.gap).not.toBe("github_only_merge_data");
  });

  // Spec § 5: scoped to the SERVICE's bound repos. Without the metadata.repo predicate this
  // metric counts every PR in the index and silently reports another team's throughput.
  test("a merge in a repo this service does NOT own is not counted", () => {
    const db = makeDb();
    insertPr(db, "ours", "acme/web", NOW - 0.5 * DAY);
    insertPr(db, "theirs", "other/thing", NOW - 0.5 * DAY);
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  test("a service binding no github repos yields no_repos, not zero", () => {
    const db = makeDb();
    insertPr(db, "a", "acme/web", NOW - 0.5 * DAY);
    const gitlabOnly: ServiceConfig["repos"] = [{ provider: "gitlab", providerId: "acme/api" }];
    const s = computeStatsSeries(db, cfg(gitlabOnly), "pr-merges", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("no_repos");
  });
});

// These three pin the corrections in Task 2 step 3 (a), (b) and (c). Without them the plan
// states the rules and nothing enforces them.
describe("computeStatsSeries — incidents-opened", () => {
  function insertIncident(
    db: Database,
    id: string,
    pdService: string,
    openedAtMs: number | null,
    status: string,
    modifiedAt: number,
  ): void {
    const meta: Record<string, unknown> = { pagerduty_service_id: pdService, status };
    if (openedAtMs !== null) meta["opened_at_ms"] = openedAtMs;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES (?, 'pagerduty', 'incident', ?, 'x', ?, ?, ?)`,
      [id, id, modifiedAt, JSON.stringify(meta), NOW],
    );
  }
  const pd = (): ServiceConfig => ({ ...cfg(GH), pagerdutyServices: ["PSVC1"] });

  // (a) buckets on the OPENED time, not modified_at.
  test("an old incident touched recently stays in its ORIGINAL bucket", () => {
    const db = makeDb();
    insertIncident(db, "old", "PSVC1", NOW - 3.5 * DAY, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, 4 * DAY, DAY);
    expect(s.points[3]?.value).toBeNull(); // newest bucket: nothing opened
    expect(s.points[0]?.value).toBe(1); // oldest bucket: where it opened
  });

  // (b) status is NOT filtered — an incident still burning still opened.
  test("an unresolved incident is counted", () => {
    const db = makeDb();
    insertIncident(db, "live", "PSVC1", NOW - 0.5 * DAY, "triggered", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
  });

  // (c) a missing opened_at_ms is EXCLUDED and REPORTED — never coalesced to synced_at.
  test("an incident with no opened_at_ms is excluded and flagged, not back-dated", () => {
    const db = makeDb();
    insertIncident(db, "timed", "PSVC1", NOW - 0.5 * DAY, "resolved", NOW);
    insertIncident(db, "untimed", "PSVC1", null, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBe(1);
    expect(s.points[0]?.gap).toBe("incidents_missing_opened_at");
  });

  test("no pagerduty mapping yields no_pagerduty_mapping, not zero", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
    expect(s.points[0]?.gap).toBe("no_pagerduty_mapping");
  });

  test("an incident belonging to another pagerduty service is not counted", () => {
    const db = makeDb();
    insertIncident(db, "other", "PSVC2", NOW - 0.5 * DAY, "resolved", NOW);
    const s = computeStatsSeries(db, pd(), "incidents-opened", NOW, DAY, DAY);
    expect(s.points[0]?.value).toBeNull();
  });
});

describe("registry totality", () => {
  test("every declared metric id has an evaluator and returns a series", () => {
    const db = makeDb();
    for (const id of STATS_METRIC_IDS) {
      const s = computeStatsSeries(db, cfg(GH), id, NOW, 2 * DAY, DAY);
      expect(s.metric).toBe(id);
      expect(s.points.length).toBe(2);
      expect(typeof s.points[0]?.unit).toBe("string");
    }
  });

  test("the series echoes its own window and bucket", () => {
    const db = makeDb();
    const s = computeStatsSeries(db, cfg(GH), "pr-merges", NOW, 4 * DAY, 2 * DAY);
    expect(s.window).toEqual({ since_ms: NOW - 4 * DAY, until_ms: NOW });
    expect(s.bucket_ms).toBe(2 * DAY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/metrics/stats.test.ts`
Expected: FAIL — cannot resolve module `./stats.ts`.

- [ ] **Step 3: Implement the registry**

Create `packages/gateway/src/metrics/stats.ts`. Read `./dora.ts` first for the calculators' exact signatures and for how `selectResolvedIncidents` scopes to `cfg.pagerdutyServices`; `incidents-opened` must scope the same way rather than inventing its own predicate.

```ts
import type { Database } from "bun:sqlite";
import type { ServiceConfig } from "./dora-config.ts";
import {
  changeFailureRate,
  deploymentFrequency,
  type DoraGap,
  type DoraMetricValue,
  leadTimeForChanges,
  mttr,
} from "./dora.ts";
import { splitBuckets } from "./stats-buckets.ts";

export type StatsMetricId =
  | "deployment-frequency"
  | "lead-time"
  | "change-failure-rate"
  | "mttr"
  | "pr-merges"
  | "incidents-opened";

/** DORA's own union stays frozen; this feature's extra reasons live here. */
export type StatsGap = DoraGap | "github_only_merge_data" | "incidents_missing_opened_at";

export type StatsPoint = {
  // WIRE SHAPE — snake_case, matching the `window_ms`/`bucket_ms` request params and
  // `DoraMetricsResult`'s `since_ms`/`computed_at` on the same namespace.
  readonly start_ms: number;
  readonly end_ms: number;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: StatsGap;
};

export type StatsSeries = {
  readonly metric: StatsMetricId;
  readonly service: string;
  readonly window: { readonly since_ms: number; readonly until_ms: number };
  readonly bucket_ms: number;
  readonly points: readonly StatsPoint[];
};

type Evaluator = (
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
) => DoraMetricValue;

/**
 * A bucket is exactly "the DORA value for that sub-window": `nowMs` binds to the bucket's
 * END, and `sinceMs` — a LOOK-BACK DURATION, never an absolute timestamp — binds to the
 * bucket's WIDTH. Binding `sinceMs` to the bucket's absolute `startMs` instead makes
 * `nowMs - sinceMs` a near-zero epoch value and turns every point cumulative-to-date; see
 * the correction note in Task 2's context paragraph. No DORA logic is reimplemented here —
 * a second copy in SQL is free to drift from the TypeScript original, which is the defect
 * this shape avoids.
 */
const wrapDora =
  (fn: (db: Database, cfg: ServiceConfig, nowMs: number, sinceMs: number) => DoraMetricValue): Evaluator =>
  (db, cfg, startMs, endMs) =>
    fn(db, cfg, endMs, endMs - startMs);

/**
 * `merged_at` is written ONLY by `connectors/github-sync.ts`; gitlab-sync and bitbucket-sync
 * write nothing. `json_valid(metadata)` guards `json_extract`, which RAISES on malformed
 * JSON in this codebase — and the guard is context-dependent, so it must sit in the WHERE
 * clause beside the extract, not merely somewhere in the statement.
 */
function prMerges(db: Database, cfg: ServiceConfig, startMs: number, endMs: number): DoraMetricValue {
  // `ParsedDoraRepoUrn` is `{ provider: DoraProvider; providerId: string }` — there is NO
  // `forge` field. `DoraProvider` is "github" | "gitlab" | "bitbucket" | "jenkins" | "circleci".
  const githubRepos = cfg.repos.filter((r) => r.provider === "github").map((r) => r.providerId);
  if (githubRepos.length === 0) {
    // Either the service binds no repos at all, or none of them are GitHub — and only
    // github-sync.ts writes `merged_at`, so there is nothing this metric can count.
    return { value: null, unit: "merges", sample: 0, gap: "no_repos" };
  }
  const nonGithub = cfg.repos.some((r) => r.provider !== "github");
  const ph = githubRepos.map(() => "?").join(",");
  // Spec § 5: scoped to the SERVICE's bound repos. `metadata.repo` is the key
  // `repoLikeMatchesUrn` (dora.ts:65) matches GitHub URNs on — that helper is module-private
  // in dora.ts, so this mirrors its predicate rather than importing it.
  // `json_valid` guards `json_extract`, which RAISES on malformed JSON here, and the guard is
  // context-dependent — it must sit in the WHERE clause beside every extract.
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM item
       WHERE type = 'pr'
         AND json_valid(metadata)
         AND json_extract(metadata, '$.repo') IN (${ph})
         AND json_extract(metadata, '$.merged_at') IS NOT NULL
         AND json_extract(metadata, '$.merged_at') >= ?
         AND json_extract(metadata, '$.merged_at') < ?`,
    )
    .get(...githubRepos, startMs, endMs) as { c: number } | null;
  const count = row?.c ?? 0;
  if (count === 0) {
    return {
      value: null,
      unit: "merges",
      sample: 0,
      gap: (nonGithub ? "github_only_merge_data" : "low_sample") as DoraGap,
    };
  }
  return {
    value: count,
    unit: "merges",
    sample: count,
    gap: (nonGithub ? "github_only_merge_data" : null) as DoraGap,
  };
}
```

`incidents-opened` is the trickiest evaluator in this feature, and three things about `dora.ts`'s existing incident handling will mislead you if you copy it wholesale. Read `selectResolvedIncidents` (`metrics/dora.ts:286`) first, then note all three:

**(a) Copy the SERVICE scoping, but NOT the time predicate.** That function's outer SQL filters on `i.modified_at >= ? AND i.modified_at <= ?` — a *last-modified* window — and only then uses the opened timestamp for duration arithmetic. For a series of when incidents *opened*, filtering on `modified_at` would bucket a months-old incident into this week because someone touched it, which is exactly the F1 trap this whole feature exists to avoid. Reuse the `service = 'pagerduty' AND type = 'incident' AND json_extract(metadata,'$.pagerduty_service_id') IN (…)` scoping; replace the time predicate.

**(b) Do NOT filter on `status`.** `selectResolvedIncidents` skips anything not `"resolved"` because MTTR needs a resolution time. `incidents-opened` counts incidents *opened* in a window regardless of their current state — an incident still burning is still an incident that opened. Filtering by status here would undercount exactly the ones a reader most wants to see.

**(c) `opened_at_ms` is optional, and the DORA fallback is NOT available to us.** `connectors/pagerduty-sync.ts:90` writes it conditionally (`if (Number.isFinite(openedAtMs))`), and `dora.ts:310` falls back to `r.synced_at` when it is missing. **We cannot take that fallback**: `synced_at` is when *we indexed the row*, not when the incident opened, and this plan's Global Constraints forbid bucketing on it. Neither option is acceptable — filtering on `opened_at_ms` alone silently drops those incidents, and coalescing to `synced_at` silently fabricates an event time.

The honest third answer: **count only incidents with a real `opened_at_ms`, and make the exclusion visible** via a gap rather than swallowing it. Add the gap value to the union in this file:

```ts
export type StatsGap = DoraGap | "github_only_merge_data" | "incidents_missing_opened_at";
```

```ts
function incidentsOpened(
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
): DoraMetricValue {
  if (cfg.pagerdutyServices.length === 0) {
    return { value: null, unit: "incidents", sample: 0, gap: "no_pagerduty_mapping" };
  }
  const ph = cfg.pagerdutyServices.map(() => "?").join(",");
  // `json_valid` guards `json_extract`, which RAISES on malformed JSON here — and the guard
  // is context-dependent, so it must sit in the WHERE clause beside every extract.
  const scope = `FROM item
     WHERE service = 'pagerduty' AND type = 'incident'
       AND json_valid(metadata)
       AND json_extract(metadata, '$.pagerduty_service_id') IN (${ph})`;
  const counted = db
    .query(
      `SELECT COUNT(*) AS c ${scope}
         AND json_extract(metadata, '$.opened_at_ms') >= ?
         AND json_extract(metadata, '$.opened_at_ms') < ?`,
    )
    .get(...cfg.pagerdutyServices, startMs, endMs) as { c: number } | null;
  // Incidents this service owns that carry NO opened timestamp at all. They cannot be placed
  // in any bucket, so they are excluded from every one — and that exclusion is reported
  // rather than hidden. Deliberately not windowed: an untimestamped row cannot be windowed.
  const untimed = db
    .query(`SELECT COUNT(*) AS c ${scope} AND json_extract(metadata, '$.opened_at_ms') IS NULL`)
    .get(...cfg.pagerdutyServices) as { c: number } | null;
  const count = counted?.c ?? 0;
  const missing = (untimed?.c ?? 0) > 0;
  if (count === 0) {
    return {
      value: null,
      unit: "incidents",
      sample: 0,
      gap: (missing ? "incidents_missing_opened_at" : "low_sample") as DoraGap,
    };
  }
  return {
    value: count,
    unit: "incidents",
    sample: count,
    gap: (missing ? "incidents_missing_opened_at" : null) as DoraGap,
  };
}
```

Then the registry and the driver:

```ts
const STATS_METRICS: Readonly<Record<StatsMetricId, Evaluator>> = {
  "deployment-frequency": wrapDora(deploymentFrequency),
  "lead-time": wrapDora(leadTimeForChanges),
  "change-failure-rate": wrapDora(changeFailureRate),
  mttr: wrapDora(mttr),
  "pr-merges": prMerges,
  "incidents-opened": incidentsOpened,
};

/** Derived from the registry so the two cannot disagree. */
export const STATS_METRIC_IDS = Object.keys(STATS_METRICS) as readonly StatsMetricId[];

export function computeStatsSeries(
  db: Database,
  cfg: ServiceConfig,
  metric: StatsMetricId,
  untilMs: number,
  windowMs: number,
  bucketMs: number,
): StatsSeries {
  const evaluate = STATS_METRICS[metric];
  const buckets = splitBuckets(untilMs, windowMs, bucketMs);
  const points = buckets.map((b) => {
    const v = evaluate(db, cfg, b.startMs, b.endMs);
    return { start_ms: b.startMs, end_ms: b.endMs, ...v } as StatsPoint;
  });
  return {
    metric,
    service: cfg.serviceId,
    window: { since_ms: untilMs - windowMs, until_ms: untilMs },
    bucket_ms: bucketMs,
    points,
  };
}
```

Because `STATS_METRICS` is typed `Record<StatsMetricId, Evaluator>`, adding an id to the union without an evaluator is a **compile error**, which is the totality guarantee the spec requires.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/metrics/stats.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify the DORA wrappers delegate rather than reimplement**

Add to `stats.test.ts`:

```ts
test("a single-bucket series agrees with the DORA calculator over the same bounds", () => {
  const db = makeDb();
  const series = computeStatsSeries(db, cfg(GH), "mttr", NOW, DAY, DAY);
  const direct = mttr(db, cfg(GH), NOW, NOW - DAY);
  expect(series.points[0]?.value).toBe(direct.value);
  expect(series.points[0]?.unit).toBe(direct.unit);
  expect(series.points[0]?.sample).toBe(direct.sample);
});
```

Import `mttr` from `./dora.ts` in the test file. Run the file again; expect PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/metrics/stats.ts packages/gateway/src/metrics/stats.test.ts
git commit -m "feat(metrics): six-metric stats registry over real event timestamps"
```

---

## Task 3: The `metrics.stats` IPC arm

**Files:**

- Modify: `packages/gateway/src/ipc/metrics-rpc.ts`
- Test: `packages/gateway/src/ipc/metrics-rpc.test.ts` (append)

**Interfaces:**

- Consumes: `computeStatsSeries`, `STATS_METRIC_IDS`, `type StatsMetricId`, `type StatsSeries` (Task 2); the existing `MetricsRpcContext` and `MetricsRpcError`.
- Produces: `metrics.stats` accepting `{ service: string, metric: string, window_ms: number, bucket_ms: number }` and returning `StatsSeries`.

**Critical:** `dispatchMetricsRpc`'s return type is currently `{ kind: "miss" } | { kind: "hit"; value: DoraMetricsResult }`. Widen the hit arm to `DoraMetricsResult | StatsSeries`. Do **not** reuse `parseSinceToMs` — it accepts `d|h` only and would reject this feature's `1w` default. `metrics.stats` takes **already-resolved integers**; the CLI parses.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/metrics-rpc.test.ts` (mirror the file's existing context-construction helpers):

```ts
describe("metrics.stats", () => {
  test("returns a series with one point per bucket", async () => {
    const out = await dispatchMetricsRpc(
      "metrics.stats",
      { service: "checkout-web", metric: "pr-merges", window_ms: 4 * 86_400_000, bucket_ms: 2 * 86_400_000 },
      ctx,
    );
    expect(out.kind).toBe("hit");
    const v = (out as { value: { points: unknown[] } }).value;
    expect(v.points.length).toBe(2);
  });

  test("an unknown metric id is a -32602, naming the valid ids", async () => {
    let code = 0;
    let msg = "";
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        { service: "checkout-web", metric: "not-a-metric", window_ms: 86_400_000, bucket_ms: 86_400_000 },
        ctx,
      );
    } catch (e) {
      code = (e as { rpcCode: number }).rpcCode;
      msg = (e as Error).message;
    }
    expect(code).toBe(-32602);
    expect(msg).toContain("pr-merges");
  });

  test("non-integer window_ms or bucket_ms is a -32602", async () => {
    for (const params of [
      { service: "checkout-web", metric: "pr-merges", window_ms: "7d", bucket_ms: 1 },
      { service: "checkout-web", metric: "pr-merges", window_ms: 7, bucket_ms: null },
    ]) {
      let code = 0;
      try {
        await dispatchMetricsRpc("metrics.stats", params, ctx);
      } catch (e) {
        code = (e as { rpcCode: number }).rpcCode;
      }
      expect(code).toBe(-32602);
    }
  });

  // A StatsBucketError must not escape as an unhandled 500-class fault.
  test("bucket larger than window surfaces as -32602, not an internal error", async () => {
    let code = 0;
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        { service: "checkout-web", metric: "pr-merges", window_ms: 86_400_000, bucket_ms: 7 * 86_400_000 },
        ctx,
      );
    } catch (e) {
      code = (e as { rpcCode: number }).rpcCode;
    }
    expect(code).toBe(-32602);
  });

  test("an unconfigured service is a -32602 naming the service", async () => {
    let msg = "";
    try {
      await dispatchMetricsRpc(
        "metrics.stats",
        { service: "nope", metric: "pr-merges", window_ms: 86_400_000, bucket_ms: 86_400_000 },
        ctx,
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("nope");
  });

  test("metrics.dora still dispatches unchanged", async () => {
    const out = await dispatchMetricsRpc("metrics.dora", { service: "checkout-web" }, ctx);
    expect(out.kind).toBe("hit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/metrics-rpc.test.ts`
Expected: FAIL — `metrics.stats` returns `{ kind: "miss" }`.

- [ ] **Step 3: Implement the arm**

In `packages/gateway/src/ipc/metrics-rpc.ts`, add imports, a param validator, and the dispatch arm. Note `metrics.dora` returns an `unconfiguredEnvelope` for an unknown service, but `metrics.stats` **errors** instead: an envelope needs one placeholder per metric, and a series has no equivalent shape — a fabricated empty series would be indistinguishable from a real quiet window.

```ts
import {
  computeStatsSeries,
  STATS_METRIC_IDS,
  type StatsMetricId,
  type StatsSeries,
} from "../metrics/stats.ts";
import { StatsBucketError } from "../metrics/stats-buckets.ts";

function requireStatsParams(params: unknown): {
  service: string;
  metric: StatsMetricId;
  windowMs: number;
  bucketMs: number;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new MetricsRpcError(-32602, "metrics.stats requires an object");
  }
  const p = params as Record<string, unknown>;
  if (typeof p["service"] !== "string") {
    throw new MetricsRpcError(-32602, "service must be a string");
  }
  const service = p["service"].trim();
  if (service.length < MIN_SERVICE_LEN || service.length > MAX_SERVICE_LEN) {
    throw new MetricsRpcError(-32602, `service must be ${MIN_SERVICE_LEN}..${MAX_SERVICE_LEN} chars`);
  }
  const metric = p["metric"];
  if (typeof metric !== "string" || !(STATS_METRIC_IDS as readonly string[]).includes(metric)) {
    throw new MetricsRpcError(-32602, `metric must be one of ${STATS_METRIC_IDS.join(", ")}`);
  }
  const windowMs = p["window_ms"];
  const bucketMs = p["bucket_ms"];
  if (!Number.isInteger(windowMs) || !Number.isInteger(bucketMs)) {
    throw new MetricsRpcError(-32602, "window_ms and bucket_ms must be integer milliseconds");
  }
  return {
    service,
    metric: metric as StatsMetricId,
    windowMs: windowMs as number,
    bucketMs: bucketMs as number,
  };
}
```

**Every error this arm raises must be actionable at the terminal**, because the CLI prints it verbatim and a bare `-32602` with a generic message is indistinguishable from a bug. Each one names the offending value: the unknown metric lists the valid ids, the unknown service names the config table to add, and a bucket error names both durations (`StatsBucketError` already does — that is why it is re-wrapped rather than replaced with a generic string). Do not lose the original message when converting.

In `dispatchMetricsRpc`, replace the early `if (method !== "metrics.dora") return { kind: "miss" };` with a branch handling both methods, widen the return type to `DoraMetricsResult | StatsSeries`, and wrap the `computeStatsSeries` call so a `StatsBucketError` becomes a `MetricsRpcError(-32602, …)` rather than escaping:

```ts
  if (method === "metrics.stats") {
    const { service, metric, windowMs, bucketMs } = requireStatsParams(params);
    const nowMs = (ctx.nowMs ?? (() => Date.now()))();
    const cfg = ctx.loadConfig().get(service);
    if (cfg === undefined) {
      throw new MetricsRpcError(-32602, `unknown service '${service}' — add [metrics.dora.${service}] or [ci.service.${service}] to nimbus.toml`);
    }
    try {
      return { kind: "hit", value: computeStatsSeries(ctx.db, cfg, metric, nowMs, windowMs, bucketMs) };
    } catch (e) {
      if (e instanceof StatsBucketError) throw new MetricsRpcError(-32602, e.message);
      throw e;
    }
  }
  if (method !== "metrics.dora") return { kind: "miss" };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/metrics-rpc.test.ts`
Expected: PASS, including the pre-existing `metrics.dora` tests.

- [ ] **Step 5: Confirm the dispatcher reaches it**

Run: `bun test packages/gateway/src/ipc/`
Expected: PASS.

**Reachability is already verified — you do not need to re-investigate it.** `ipc/server/dispatchers.ts:456` guards with `method.startsWith("metrics.")`, not the literal `"metrics.dora"`, so `metrics.stats` is routed to `dispatchMetricsRpc` as soon as your arm exists. It also requires `ctx.options.localIndex` and `ctx.options.configDir` to be defined, both of which production assembly already supplies for `metrics.dora`.

This was checked because a prefix-vs-literal guard is exactly how a feature ships unreachable with every unit test green — the defect the previous branch shipped and had to fix. Here it is genuinely fine.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/metrics-rpc.ts packages/gateway/src/ipc/metrics-rpc.test.ts
git commit -m "feat(ipc): metrics.stats returns a bucketed series"
```

---

## Task 4: The `nimbus stats` CLI

**Files:**

- Create: `packages/cli/src/commands/stats.ts`
- Modify: `packages/cli/src/commands/index.ts` (export `runStats`)
- Modify: `packages/cli/src/index.ts` (add `stats: runStats` to `COMMAND_HANDLERS`)
- Test: `packages/cli/src/commands/stats.test.ts`

**Interfaces:**

- Consumes: `parseSinceDurationToMs` from `../lib/parse-since.ts`; `withGatewayIpc` from `../lib/with-gateway-ipc.ts`; the `metrics.stats` contract from Task 3.
- Produces: `export async function runStats(args: string[]): Promise<void>`.

**Read `packages/cli/src/commands/query.ts` first** — it is the closest existing command: `takeFlag` helper, `withGatewayIpc` call, TTY-vs-piped rendering. Follow it.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/stats.test.ts`. Test the **pure** parts by dependency injection — do not use `mock.module`, which leaks across files on CI Linux. Export the arg parser separately so it is testable without a gateway:

```ts
import { describe, expect, test } from "bun:test";
import { parseStatsArgs } from "./stats.ts";

const DAY = 86_400_000;

describe("parseStatsArgs", () => {
  test("defaults are 90d window and 1w bucket", () => {
    const a = parseStatsArgs(["mttr", "--service", "checkout-web"]);
    expect(a.metric).toBe("mttr");
    expect(a.service).toBe("checkout-web");
    expect(a.windowMs).toBe(90 * DAY);
    expect(a.bucketMs).toBe(7 * DAY);
  });

  // The trap this feature exists downstream of: the gateway's own parsers reject `w`.
  test("1w parses — proving the CLI parser is used, not the gateway's", () => {
    const a = parseStatsArgs(["mttr", "--service", "s", "--bucket", "1w"]);
    expect(a.bucketMs).toBe(7 * DAY);
  });

  test("--window and --bucket accept h and d too", () => {
    const a = parseStatsArgs(["mttr", "--service", "s", "--window", "48h", "--bucket", "24h"]);
    expect(a.windowMs).toBe(2 * DAY);
    expect(a.bucketMs).toBe(DAY);
  });

  test("a missing --service is an error", () => {
    expect(() => parseStatsArgs(["mttr"])).toThrow(/--service/);
  });

  test("a missing metric is an error", () => {
    expect(() => parseStatsArgs(["--service", "s"])).toThrow();
  });

  test("--json is recognised", () => {
    expect(parseStatsArgs(["mttr", "--service", "s", "--json"]).json).toBe(true);
    expect(parseStatsArgs(["mttr", "--service", "s"]).json).toBe(false);
  });

  test("an invalid duration is rejected with the offending value", () => {
    expect(() => parseStatsArgs(["mttr", "--service", "s", "--bucket", "1fortnight"])).toThrow(
      /1fortnight/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/stats.test.ts`
Expected: FAIL — cannot resolve module `./stats.ts`.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/stats.ts`:

```ts
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

const METRICS = [
  "deployment-frequency",
  "lead-time",
  "change-failure-rate",
  "mttr",
  "pr-merges",
  "incidents-opened",
] as const;

const DEFAULT_WINDOW = "90d";
const DEFAULT_BUCKET = "1w";

export type StatsArgs = {
  metric: string;
  service: string;
  windowMs: number;
  bucketMs: number;
  json: boolean;
};

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

/**
 * Durations are parsed HERE, CLI-side. `metrics.stats` receives resolved integers and never
 * re-parses a string — deliberately, because the gateway holds two narrower parsers
 * (`ipc/metrics-rpc.ts`'s `parseSinceToMs` accepts `d|h` only; `index/item-list-query.ts`'s
 * `parseRelativeSinceToWindowMs` has no `w`) and either would reject this command's own
 * `1w` default.
 */
export function parseStatsArgs(args: string[]): StatsArgs {
  const metric = args[0];
  if (metric === undefined || metric.startsWith("--")) {
    throw new Error(`Usage: nimbus stats <${METRICS.join("|")}> --service <id>`);
  }
  const service = takeFlag(args, "--service");
  if (service === undefined || service.trim() === "") {
    throw new Error("Missing --service <id>");
  }
  return {
    metric,
    service: service.trim(),
    windowMs: parseSinceDurationToMs(takeFlag(args, "--window") ?? DEFAULT_WINDOW),
    bucketMs: parseSinceDurationToMs(takeFlag(args, "--bucket") ?? DEFAULT_BUCKET),
    json: args.includes("--json"),
  };
}
```

`runStats` then prints help for no args / `--help`, calls `parseStatsArgs`, invokes `metrics.stats` through `withGatewayIpc`, and renders.

**Rendering rules — three, all load-bearing:**

1. A `null` value prints as `—` with its gap in a trailing column, **never as `0`**. That distinction is the whole point of the null.
2. **Print a summary line beneath the table**, giving how many buckets carried a value out of the total, plus the distinct gap reasons present — e.g. `4 of 13 buckets had data (9 low_sample)`. Without it a sparse series renders as a wall of dashes and reads as breakage. Per spec D2 this is the *expected* shape for a weekly `mttr` bucket, so the summary is what turns "looks broken" into "data is thin, and here's why".
3. If **every** bucket is null, say so in one plain sentence naming the dominant gap rather than printing an all-dash table — that is the case a user is most likely to misread as a bug.

`--json` prints the response verbatim, with no summary — a machine consumer computes its own.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/stats.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Register the command**

Add `export { runStats } from "./stats.ts";` to `packages/cli/src/commands/index.ts`, import it in `packages/cli/src/index.ts`, and add `stats: runStats,` to `COMMAND_HANDLERS`.

- [ ] **Step 6: Verify registration and the CLI suite**

Run: `bun test packages/cli/src`
Expected: PASS. If a test asserts the command list or a README/CLI drift audit exists, update it in this task — `bun run audit:readme-cli` must stay green.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/stats.ts packages/cli/src/commands/stats.test.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(cli): nimbus stats renders a bucketed metric series"
```

---

## Task 5: Documentation

**Files:**

- Modify: `docs/cli-reference.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Document the command**

Add a `nimbus stats` section to `docs/cli-reference.md` beside the existing `nimbus metrics dora` entry: the six metric ids, `--service`/`--window`/`--bucket`/`--json`, the defaults, and three facts a user will otherwise discover the hard way — buckets walk backward from now and are not calendar-aligned; `pr-merges` is **GitHub-only** because only `github-sync.ts` writes `metadata.merged_at`; and a sparse bucket shows `—` with a `low_sample` gap rather than `0`, which for a weekly `mttr` bucket will be common.

- [ ] **Step 2: Add the changelog entry**

Prepend to `## Post-Phase-6 deliveries` in `docs/CHANGELOG.md`, dated **2026-08-19**. Match the surrounding entries' voice: state what shipped, and state what was built *differently* from the roadmap row — the roadmap said "rolling 7-day MTTR trend" but this ships **disjoint** buckets, with rolling recorded as a follow-up; and "PR merge throughput" is GitHub-only. Name the sparse-bucket consequence rather than letting a user discover it.

- [ ] **Step 3: Update the roadmap**

Two edits in `docs/roadmap.md`: mark the "First-class aggregation-over-time queries (W6-B)" row shipped with the disjoint-vs-rolling and GitHub-only corrections recorded inline; and update § Active → "Remaining in S1" so the answer-quality row now names only the **negation** half as outstanding, A2 and aggregation both being done.

- [ ] **Step 4: Verify the doc gates**

Run: `bun run preflight:fast`, then `bun run audit:links`
Expected: PASS both, including `lint:markdown`, `audit:doc-refs` and `audit:readme-cli`.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: nimbus stats reference, changelog entry, roadmap update"
```

---

## Self-Review

**Spec coverage.** § 4 registry → Task 2. § 5 service scoping → Task 2 (`cfg.repos`, `cfg.pagerdutyServices`). § 6 backward buckets + partial oldest bucket → Task 1. § 6.1 parser pin → Tasks 3 and 4 (the gateway takes integers; the CLI parses, with a `1w` test). § 6.1 `bucket > window` error → Task 1 step 1, Task 3's -32602 mapping. § 6.1 cap → Task 1 (`MAX_BUCKETS`, rejects not truncates). § 7 IPC + CLI → Tasks 3 and 4. § 7 no HTTP route / no allowlist change → no task touches either, by construction. § 7.1 I29 exemption → no code; recorded in the spec, and no task adds a dispatch or a fetch. § 8 tests → Tasks 1, 2, 4.

**Placeholder scan.** Task 2 step 3 describes `incidentsOpened` in prose plus a shape contract rather than full source, because it must mirror `dora.ts`'s existing incident scoping, which the implementer has to read anyway; the contract fixes its return values. Task 4 step 3 describes `runStats`'s rendering rather than supplying it, with the one binding rule stated (`null` renders `—`, never `0`). Task 5 describes documentation content, as prose must match surrounding voice. No `TBD`/`TODO`.

**Type consistency.** `StatsMetricId`, `StatsGap`, `StatsPoint`, `StatsSeries`, `computeStatsSeries`, `STATS_METRIC_IDS`, `splitBuckets`, `StatsBucketError`, `MAX_BUCKETS` are used under exactly these names in every task that references them. The IPC wire shape is snake_case throughout — request params `window_ms`/`bucket_ms` and response fields `since_ms`/`until_ms`/`bucket_ms`/`start_ms`/`end_ms` — matching `since_ms`/`computed_at` in `DoraMetricsResult` on the same namespace, and consistent across Tasks 2, 3 and 4. **Corrected 2026-08-19, during the whole-branch review:** this line, and the `StatsPoint`/`StatsSeries` declarations in Task 2, originally shipped the RESPONSE fields as camelCase while the request params were snake, so one method mixed both conventions on the wire. Only CLI-internal types (`StatsArgs`' `windowMs`/`bucketMs`, `stats-buckets.ts`' `StatsBucket`) stay camelCase; they never leave the process.

**Reachability, checked rather than left to the implementer.** The obvious way for this feature to ship dead is a dispatch guard matching the literal `"metrics.dora"` instead of the `metrics.` prefix — every unit test would pass and the CLI would get a method-not-found. Verified on 2026-08-19: `ipc/server/dispatchers.ts:456` guards with `method.startsWith("metrics.")`, and production assembly already supplies the `localIndex` and `configDir` that guard also requires. Task 3 step 5 records the finding so nobody spends the round re-deriving it.

**The wiring this plan does NOT pin with a test**, stated so it is a known bound rather than a discovery: the CLI registration in Task 4 step 5. If `stats: runStats` is omitted from `COMMAND_HANDLERS`, every test in Task 4 still passes, because they exercise `parseStatsArgs` directly. Task 4 step 6 runs the CLI suite and `audit:readme-cli` as the compensating check; an implementer who finds a test that would fail on a missing registration should add it.
