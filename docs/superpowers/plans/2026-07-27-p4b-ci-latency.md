# P4b — CI latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track per-job CI execution, runner queue and DAG wait across all 9 org repos, and fail when a job's execution regresses beyond its own measured noise band.

**Architecture:** Mirrors `audit:coverage-floor`. Pure functions (`summarize`, `baseline`, `evaluate`) do all the reasoning and are table-tested offline; one impure collector walks the Actions API; one `import.meta.main` shell wires them and supports `--update-baseline`. The committed baseline lives beside `coverage-baseline.json`.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, `gh` CLI via the existing `runGh`, Biome. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-07-27-p4b-ci-latency-design.md`](../specs/2026-07-27-p4b-ci-latency-design.md) (+ its review and review-response).

## Global Constraints

- **Runtime:** Bun v1.2+, TypeScript 6.x strict. **No `any`** — narrow external JSON with `isRecord` from `_gh-audit.ts`.
- **`exactOptionalPropertyTypes: true`** — an optional field needs an explicit `?: T | undefined`.
- **Linter:** run `bunx biome check scripts .github docs` — **NOT** `bun run lint`, which reports "Checked 0 files" and exits 1 inside a `.claude/worktrees/` checkout.
- **Branch:** all work on `dev/asafgolombek/p4b-latency` in the worktree `.claude/worktrees/p4b-latency`. Never commit on `main`; verify with `git rev-parse --abbrev-ref HEAD`.
- **Gate contract:** fail-soft locally, hard under `--strict` / `GITHUB_ACTIONS`. Reuse `isStrict` / `strictSkip` / `classifyReadFailure` from `_gh-audit.ts`.
- **Never write files with Python on Windows** — it emits CRLF and biome's formatter rejects it. Use the Write/Edit tools, or `open(p,"wb")` with explicit `\n`.
- **Markdown:** every heading, list and fenced block needs a blank line around it, fences need a language, no trailing spaces (`lint:markdown` enforces MD022/MD031/MD032/MD040/MD009).
- **Pre-push:** `bun test scripts/` and `bunx tsc -p scripts/tsconfig.json --noEmit` must pass.

## Constants (single source of truth — `scripts/ci-latency/constants.ts`)

| Constant | Value | Why |
| --- | --- | --- |
| `MIN_SAMPLES` | 3 | fewer observations is `insufficient-data`, skipped not failed; 71% of keys qualify |
| `MIN_SAMPLES_FOR_RATCHET` | 7 | lowering a bound demands more evidence than enforcing one |
| `MIN_ABSOLUTE_DELTA_MIN` | 1 | ratios are meaningless on a 0.3-min job |
| `UNSTABLE_SPREAD_RATIO` | 0.5 | spread > 50% of median ⇒ reported `unstable`, never failed |
| `RUN_LIST_PAGE` | 100 | one cheap list request at the API maximum |
| `MAX_RUNS_PER_WORKFLOW` | 12 | caps the *expensive* job fetches where the volume is |
| `MAX_READ_FAILURE_RATIO` | 0.25 | past this the sample is degraded — skip gating, never gate on it |
| `SAMPLE_EVENT` | `"push"` | PR runs execute a different job set; mixing compares unlike things |

**Why the window is per-workflow, not per-repo.** An earlier revision capped 30
runs per *repo*. Measured: those 30 push runs span 8 workflows, so `CI` itself
got only **4** — and no CI job could ever exceed 4 samples, which left just
**2% of keys** able to ratchet and made any threshold above 5 unreachable. At a
100-run list, `CI` gets **12**. Capping the job fetches per workflow buys that
depth without the ~900 requests a flat 100-per-repo would have cost.

---

## File Structure

- **Create** `scripts/ci-latency/constants.ts` — the table above. Exists separately so tests and the shell cannot drift apart.
- **Create** `scripts/ci-latency/types.ts` — `JobObservation`, `KeySummary`, `BaselineEntry`, `LatencyBaseline`, `Finding`, `CheckResult`.
- **Create** `scripts/ci-latency/summarize.ts` — **pure**: `JobObservation[]` → `Map<key, KeySummary>` (median exec/queue/dagWait + p90 spread + sample count).
- **Create** `scripts/ci-latency/baseline.ts` — **pure**: `parseBaseline`, `serializeBaseline`, `computeUpdatedBaseline`.
- **Create** `scripts/ci-latency/evaluate.ts` — **pure**: summaries + baseline → `Finding[]`.
- **Create** `scripts/ci-latency/collect.ts` — **impure**: Actions API → `JobObservation[]`.
- **Create** `scripts/ci-latency/check.ts` — the `import.meta.main` shell + `--update-baseline`.
- **Create** the four test files alongside (`summarize.test.ts`, `baseline.test.ts`, `evaluate.test.ts`, `collect.test.ts`).
- **Create** `docs/structure-audit/ci-latency-baseline.json` — generated in Task 6, committed.
- **Modify** `package.json` — `audit:ci-latency` + `audit:ci-latency:update-baseline`.
- **Modify** `scripts/lib/preflight-gates.ts` — add to `CI_ONLY_GATES` (network-backed; never the local FAST tier).
- **Modify** `.github/workflows/org-drift-sweep.yml` — a new `ci-latency` job.
- **Modify** `docs/infrastructure-roadmap.md` — record the delivery.

---

## Task 1: Constants and types

**Files:**

- Create: `scripts/ci-latency/constants.ts`, `scripts/ci-latency/types.ts`

**Interfaces:**

- Produces: every constant in the table above, and the types every later task consumes.

- [ ] **Step 1: Create the constants**

```ts
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
 * Past this share of failed job reads the sample is degraded: the survivors are
 * whichever runs happened to succeed, so their median could be biased and the
 * gate could manufacture a regression. Skip gating instead.
 */
export const MAX_READ_FAILURE_RATIO = 0.25;

/** PR runs execute a different job set with different cache state. */
export const SAMPLE_EVENT = "push";

/** The org repos audited, mirroring the sha-pins matrix in org-drift-sweep.yml. */
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
```

- [ ] **Step 2: Create the types**

```ts
/** One successful job from one run. Minutes throughout — never milliseconds. */
export interface JobObservation {
  repo: string;
  workflow: string;
  job: string;
  exec: number;
  queue: number;
  dagWait: number;
}

/** A key is `<repo> :: <workflow> :: <job>`. */
export interface KeySummary {
  key: string;
  samples: number;
  execMedian: number;
  /** p90 − median of exec: the job's own noise band. */
  execSpread: number;
  queueMedian: number;
  dagWaitMedian: number;
}

export interface BaselineEntry {
  execMedian: number;
  execSpread: number;
}

export interface LatencyBaseline {
  version: 1;
  generated_at: string;
  entries: Map<string, BaselineEntry>;
}

export type FindingKind =
  | "regression"
  | "insufficient-data"
  | "unstable"
  | "new-key"
  | "stale-baseline-entry";

export interface Finding {
  key: string;
  kind: FindingKind;
  detail: string;
}

export interface CheckResult {
  findings: Finding[];
  /** Only `regression` findings can fail the gate. */
  regressions: Finding[];
}
```

- [ ] **Step 3: Typecheck and commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/ci-latency/constants.ts scripts/ci-latency/types.ts
git commit -m "feat(audit): ci-latency constants + types"
```

---

## Task 2: `summarize` — observations to per-key medians

**Files:**

- Create: `scripts/ci-latency/summarize.ts`, `scripts/ci-latency/summarize.test.ts`

**Interfaces:**

- Consumes: `JobObservation`, `KeySummary` from `types.ts`.
- Produces: `observationKey(o: JobObservation): string`, `median(xs: readonly number[]): number`, `p90(xs: readonly number[]): number`, `summarize(obs: readonly JobObservation[]): Map<string, KeySummary>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";

import { median, observationKey, p90, summarize } from "./summarize.ts";
import type { JobObservation } from "./types.ts";

const obs = (over: Partial<JobObservation> = {}): JobObservation => ({
  repo: "Nimbus",
  workflow: "CI",
  job: "Unit + Coverage",
  exec: 10,
  queue: 1,
  dagWait: 0,
  ...over,
});

describe("median", () => {
  test("odd count takes the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  test("even count averages the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test("a single outlier cannot drag it (this is why not a mean)", () => {
    // mean would be 12.6; the median ignores the contended 58-minute run.
    expect(median([3, 3, 4, 4, 58])).toBe(4);
  });
  test("empty is 0", () => {
    expect(median([])).toBe(0);
  });
});

describe("p90", () => {
  test("picks the 90th-percentile value", () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });
  test("small samples fall back to the max", () => {
    expect(p90([2, 5])).toBe(5);
  });
  test("empty is 0", () => {
    expect(p90([])).toBe(0);
  });
});

describe("observationKey", () => {
  test("keys on repo, workflow and job so matrix legs stay distinct", () => {
    expect(observationKey(obs({ job: "Static — windows-2025" }))).toBe(
      "Nimbus :: CI :: Static — windows-2025",
    );
  });
});

describe("summarize", () => {
  test("groups by key and counts samples", () => {
    const m = summarize([obs({ exec: 10 }), obs({ exec: 12 }), obs({ exec: 14 })]);
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.samples).toBe(3);
    expect(s?.execMedian).toBe(12);
  });

  test("execSpread is p90 minus median — the job's own noise band", () => {
    const m = summarize([2, 2, 2, 2, 2, 2, 2, 2, 2, 20].map((e) => obs({ exec: e })));
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.execMedian).toBe(2);
    expect(s?.execSpread).toBe(18);
  });

  test("a stable job has a near-zero spread", () => {
    const m = summarize([12, 12.2, 12.1].map((e) => obs({ exec: e })));
    expect(m.get("Nimbus :: CI :: Unit + Coverage")?.execSpread).toBeLessThan(0.5);
  });

  test("queue and dagWait are summarised independently of exec", () => {
    const m = summarize([
      obs({ exec: 10, queue: 30, dagWait: 5 }),
      obs({ exec: 10, queue: 2, dagWait: 5 }),
      obs({ exec: 10, queue: 2, dagWait: 5 }),
    ]);
    const s = m.get("Nimbus :: CI :: Unit + Coverage");
    expect(s?.queueMedian).toBe(2);
    expect(s?.dagWaitMedian).toBe(5);
  });

  test("different repos never share a key", () => {
    const m = summarize([obs(), obs({ repo: "nimbus-sdk" })]);
    expect(m.size).toBe(2);
  });

  test("no observations yields an empty map", () => {
    expect(summarize([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/ci-latency/summarize.test.ts`
Expected: FAIL — module `./summarize.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Pure reduction from raw observations to per-key statistics.
 *
 * Medians everywhere, never means: a single contended run produced a 58-minute
 * observation in the sample that motivated this gate, and a mean would let that
 * one outlier redefine the job.
 */

import type { JobObservation, KeySummary } from "./types.ts";

export function observationKey(o: JobObservation): string {
  return `${o.repo} :: ${o.workflow} :: ${o.job}`;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * 90th percentile by nearest-rank. On a small sample this collapses to the max,
 * which is the honest answer: with three observations there is no distinguishing
 * a p90 from a maximum.
 */
export function p90(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * s.length);
  return s[Math.min(rank, s.length) - 1] as number;
}

export function summarize(obs: readonly JobObservation[]): Map<string, KeySummary> {
  const grouped = new Map<string, JobObservation[]>();
  for (const o of obs) {
    const k = observationKey(o);
    const list = grouped.get(k) ?? [];
    list.push(o);
    grouped.set(k, list);
  }

  const out = new Map<string, KeySummary>();
  for (const [key, list] of grouped) {
    const execs = list.map((o) => o.exec);
    const execMedian = median(execs);
    out.set(key, {
      key,
      samples: list.length,
      execMedian,
      execSpread: Math.max(0, p90(execs) - execMedian),
      queueMedian: median(list.map((o) => o.queue)),
      dagWaitMedian: median(list.map((o) => o.dagWait)),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/ci-latency/summarize.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/ci-latency/summarize.ts scripts/ci-latency/summarize.test.ts
git commit -m "feat(audit): ci-latency summarize — per-key medians + noise band"
```

---

## Task 3: `baseline` — parse, serialise, ratchet

**Files:**

- Create: `scripts/ci-latency/baseline.ts`, `scripts/ci-latency/baseline.test.ts`

**Interfaces:**

- Consumes: `LatencyBaseline`, `BaselineEntry`, `KeySummary`; `MIN_SAMPLES_FOR_RATCHET`.
- Produces: `parseBaseline(json: string): LatencyBaseline`, `serializeBaseline(b: LatencyBaseline): string`, `computeUpdatedBaseline(current: LatencyBaseline, summaries: ReadonlyMap<string, KeySummary>, now: string): LatencyBaseline`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";

import { computeUpdatedBaseline, parseBaseline, serializeBaseline } from "./baseline.ts";
import type { KeySummary, LatencyBaseline } from "./types.ts";

const sum = (over: Partial<KeySummary> & { key: string }): KeySummary => ({
  samples: 10,
  execMedian: 10,
  execSpread: 1,
  queueMedian: 0,
  dagWaitMedian: 0,
  ...over,
});

const base = (entries: Record<string, { execMedian: number; execSpread: number }>): LatencyBaseline => ({
  version: 1,
  generated_at: "2026-07-27T00:00:00Z",
  entries: new Map(Object.entries(entries)),
});

describe("parseBaseline / serializeBaseline", () => {
  test("round-trips entries", () => {
    const json = serializeBaseline(base({ "a :: b :: c": { execMedian: 5, execSpread: 1 } }));
    const back = parseBaseline(json);
    expect(back.entries.get("a :: b :: c")).toEqual({ execMedian: 5, execSpread: 1 });
  });
  test("an empty baseline parses to an empty map, not a throw", () => {
    expect(parseBaseline('{"version":1,"generated_at":"x","entries":{}}').entries.size).toBe(0);
  });
  test("malformed JSON throws with a message naming the file's purpose", () => {
    expect(() => parseBaseline("{nope")).toThrow(/ci-latency baseline/i);
  });
  test("serialised output ends with a newline so the file is diff-clean", () => {
    expect(serializeBaseline(base({})).endsWith("\n")).toBe(true);
  });
  test("entries serialise sorted, so a re-run never reorders the diff", () => {
    const json = serializeBaseline(
      base({ "z :: z :: z": { execMedian: 1, execSpread: 0 }, "a :: a :: a": { execMedian: 1, execSpread: 0 } }),
    );
    expect(json.indexOf("a :: a :: a")).toBeLessThan(json.indexOf("z :: z :: z"));
  });
});

describe("computeUpdatedBaseline", () => {
  const now = "2026-07-28T00:00:00Z";

  test("records a key seen for the first time", () => {
    const next = computeUpdatedBaseline(base({}), new Map([["k", sum({ key: "k", execMedian: 8 })]]), now);
    expect(next.entries.get("k")?.execMedian).toBe(8);
  });

  test("ratchets DOWN when a job gets faster", () => {
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 10, execSpread: 2 } }),
      new Map([["k", sum({ key: "k", execMedian: 6, execSpread: 1 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(6);
    // the band travels with the median, so the lowered bound stays achievable
    expect(next.entries.get("k")?.execSpread).toBe(1);
  });

  test("does NOT ratchet down on too few samples", () => {
    // A few hot-cache runs is a plausible window; lowering demands more evidence
    // than gating does. 6 < MIN_SAMPLES_FOR_RATCHET (7).
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 10, execSpread: 2 } }),
      new Map([["k", sum({ key: "k", execMedian: 6, samples: 6 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(10);
  });

  test("raises the baseline when a job legitimately got slower", () => {
    // --update-baseline is an explicit human action accepting the new reality.
    const next = computeUpdatedBaseline(
      base({ k: { execMedian: 5, execSpread: 1 } }),
      new Map([["k", sum({ key: "k", execMedian: 9, execSpread: 2 })]]),
      now,
    );
    expect(next.entries.get("k")?.execMedian).toBe(9);
  });

  test("drops a key that no longer appears (renamed or deleted job)", () => {
    const next = computeUpdatedBaseline(base({ gone: { execMedian: 5, execSpread: 1 } }), new Map(), now);
    expect(next.entries.has("gone")).toBe(false);
  });

  test("ignores a key with too few samples to be trusted at all", () => {
    const next = computeUpdatedBaseline(base({}), new Map([["k", sum({ key: "k", samples: 1 })]]), now);
    expect(next.entries.has("k")).toBe(false);
  });

  test("stamps generated_at", () => {
    expect(computeUpdatedBaseline(base({}), new Map(), now).generated_at).toBe(now);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/ci-latency/baseline.test.ts`
Expected: FAIL — module `./baseline.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * The committed baseline: one `execMedian` + `execSpread` per key.
 *
 * The spread is stored, not recomputed at check time, because the gate compares
 * today's median against the noise band the baseline was TAKEN with. Recomputing
 * it from the current window would let a job that is becoming erratic widen its
 * own tolerance, which is exactly backwards.
 */

import { MIN_SAMPLES, MIN_SAMPLES_FOR_RATCHET } from "./constants.ts";
import type { BaselineEntry, KeySummary, LatencyBaseline } from "./types.ts";

interface RawBaseline {
  version?: unknown;
  generated_at?: unknown;
  entries?: unknown;
}

export function parseBaseline(json: string): LatencyBaseline {
  let raw: RawBaseline;
  try {
    raw = JSON.parse(json) as RawBaseline;
  } catch {
    throw new Error("ci-latency baseline: file is not valid JSON");
  }
  const entries = new Map<string, BaselineEntry>();
  const rawEntries = raw.entries;
  if (typeof rawEntries === "object" && rawEntries !== null) {
    for (const [k, v] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as { execMedian?: unknown; execSpread?: unknown };
      if (typeof e.execMedian !== "number" || typeof e.execSpread !== "number") continue;
      entries.set(k, { execMedian: e.execMedian, execSpread: e.execSpread });
    }
  }
  return {
    version: 1,
    generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
    entries,
  };
}

export function serializeBaseline(b: LatencyBaseline): string {
  // Sorted so a regenerated baseline produces a minimal, reviewable diff.
  const obj: Record<string, BaselineEntry> = {};
  for (const k of [...b.entries.keys()].sort()) {
    const e = b.entries.get(k);
    if (e) obj[k] = { execMedian: round2(e.execMedian), execSpread: round2(e.execSpread) };
  }
  return `${JSON.stringify({ version: 1, generated_at: b.generated_at, entries: obj }, null, 2)}\n`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The ratchet. Raising is unconditional (an explicit `--update-baseline` accepts
 * the new reality); LOWERING requires `MIN_SAMPLES_FOR_RATCHET` observations,
 * because a wrongly-low bound produces a permanently red gate and three
 * consecutive hot-cache runs is a plausible window.
 *
 * A key absent from the current window is dropped: it was renamed or deleted,
 * and keeping it would strand a baseline entry nothing can ever satisfy.
 */
export function computeUpdatedBaseline(
  current: LatencyBaseline,
  summaries: ReadonlyMap<string, KeySummary>,
  now: string,
): LatencyBaseline {
  const entries = new Map<string, BaselineEntry>();
  for (const [key, s] of summaries) {
    if (s.samples < MIN_SAMPLES) continue;
    const prev = current.entries.get(key);
    if (prev && s.execMedian < prev.execMedian && s.samples < MIN_SAMPLES_FOR_RATCHET) {
      entries.set(key, prev);
      continue;
    }
    entries.set(key, { execMedian: s.execMedian, execSpread: s.execSpread });
  }
  return { version: 1, generated_at: now, entries };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/ci-latency/baseline.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/ci-latency/baseline.ts scripts/ci-latency/baseline.test.ts
git commit -m "feat(audit): ci-latency baseline + evidence-asymmetric ratchet"
```

---

## Task 4: `evaluate` — the gate decision

**Files:**

- Create: `scripts/ci-latency/evaluate.ts`, `scripts/ci-latency/evaluate.test.ts`

**Interfaces:**

- Consumes: `KeySummary`, `LatencyBaseline`, `Finding`, `CheckResult`; `MIN_SAMPLES`, `MIN_ABSOLUTE_DELTA_MIN`, `UNSTABLE_SPREAD_RATIO`.
- Produces: `evaluate(summaries: ReadonlyMap<string, KeySummary>, baseline: LatencyBaseline): CheckResult`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";

import { evaluate } from "./evaluate.ts";
import type { KeySummary, LatencyBaseline } from "./types.ts";

const sum = (over: Partial<KeySummary> & { key: string }): KeySummary => ({
  samples: 10,
  execMedian: 10,
  execSpread: 1,
  queueMedian: 0,
  dagWaitMedian: 0,
  ...over,
});
const base = (e: Record<string, { execMedian: number; execSpread: number }>): LatencyBaseline => ({
  version: 1,
  generated_at: "x",
  entries: new Map(Object.entries(e)),
});
const kinds = (r: { findings: { key: string; kind: string }[] }, key: string) =>
  r.findings.filter((f) => f.key === key).map((f) => f.kind);

describe("evaluate", () => {
  test("a job within its noise band is not a finding", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 10.5 })]]),
      base({ k: { execMedian: 10, execSpread: 2 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("a regression beyond the band fails", () => {
    // Ubuntu Unit+Coverage: median 12.2, spread 2.0 — a 4-minute regression must
    // fail. Under a flat 50% tolerance it needed 6.1 and would have passed.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 16.2 })]]),
      base({ k: { execMedian: 12.2, execSpread: 2 } }),
    );
    expect(r.regressions.map((f) => f.key)).toEqual(["k"]);
    expect(r.regressions[0]?.detail).toContain("12.2");
  });

  test("a noisy job gets its own wide band, not a global constant", () => {
    // Windows Unit+Coverage: median 13.2, spread 14.5. A 10-minute swing is this
    // job's normal behaviour and must NOT fail; a global 3-minute cap would.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 23.2 })]]),
      base({ k: { execMedian: 13.2, execSpread: 14.5 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("MIN_ABSOLUTE_DELTA floors the band on a sub-minute job", () => {
    // 0.3 -> 0.5 is +67% but irrelevant; the 1-minute floor absorbs it.
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 0.5 })]]),
      base({ k: { execMedian: 0.3, execSpread: 0 } }),
    );
    expect(r.regressions).toEqual([]);
  });

  test("too few samples is insufficient-data, never a regression", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 99, samples: 2 })]]),
      base({ k: { execMedian: 1, execSpread: 0 } }),
    );
    expect(kinds(r, "k")).toContain("insufficient-data");
    expect(r.regressions).toEqual([]);
  });

  test("a key absent from the baseline is new-key, never a regression", () => {
    const r = evaluate(new Map([["k", sum({ key: "k" })]]), base({}));
    expect(kinds(r, "k")).toContain("new-key");
    expect(r.regressions).toEqual([]);
  });

  test("a baseline entry with no observations is stale, never a regression", () => {
    const r = evaluate(new Map(), base({ gone: { execMedian: 5, execSpread: 1 } }));
    expect(kinds(r, "gone")).toContain("stale-baseline-entry");
    expect(r.regressions).toEqual([]);
  });

  test("an erratic job is reported unstable but never failed for it", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 13.2, execSpread: 14.5 })]]),
      base({ k: { execMedian: 13.2, execSpread: 14.5 } }),
    );
    expect(kinds(r, "k")).toContain("unstable");
    expect(r.regressions).toEqual([]);
  });

  test("a stable job is not reported unstable", () => {
    const r = evaluate(
      new Map([["k", sum({ key: "k", execMedian: 12, execSpread: 1 })]]),
      base({ k: { execMedian: 12, execSpread: 1 } }),
    );
    expect(kinds(r, "k")).not.toContain("unstable");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/ci-latency/evaluate.test.ts`
Expected: FAIL — module `./evaluate.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * The gate decision. ONLY `regression` can fail the run.
 *
 * `queue`, `dagWait` and `unstable` are deliberately observation-only: none is
 * caused by the change under test. Queue wait moves with how many PRs happen to
 * be open, and a flaky job is flaky regardless of the diff — failing a
 * contributor for either would report a condition they cannot fix, which the
 * infrastructure roadmap names as the way a gate becomes one everybody ignores.
 */

import { MIN_ABSOLUTE_DELTA_MIN, MIN_SAMPLES, UNSTABLE_SPREAD_RATIO } from "./constants.ts";
import type { CheckResult, Finding, KeySummary, LatencyBaseline } from "./types.ts";

const r1 = (n: number): string => n.toFixed(1);

export function evaluate(
  summaries: ReadonlyMap<string, KeySummary>,
  baseline: LatencyBaseline,
): CheckResult {
  const findings: Finding[] = [];

  for (const [key, s] of summaries) {
    if (s.execSpread > s.execMedian * UNSTABLE_SPREAD_RATIO && s.execMedian > 0) {
      findings.push({
        key,
        kind: "unstable",
        detail: `spread ${r1(s.execSpread)}m on a ${r1(s.execMedian)}m median — flaky, not a regression`,
      });
    }

    if (s.samples < MIN_SAMPLES) {
      findings.push({
        key,
        kind: "insufficient-data",
        detail: `${s.samples} sample(s), need ${MIN_SAMPLES} — skipped, and no retry creates more history`,
      });
      continue;
    }

    const prev = baseline.entries.get(key);
    if (!prev) {
      findings.push({
        key,
        kind: "new-key",
        detail: `not in the baseline (median ${r1(s.execMedian)}m) — recorded on the next --update-baseline`,
      });
      continue;
    }

    const allowed = Math.max(MIN_ABSOLUTE_DELTA_MIN, prev.execSpread);
    if (s.execMedian > prev.execMedian + allowed) {
      findings.push({
        key,
        kind: "regression",
        detail: `${r1(s.execMedian)}m vs baseline ${r1(prev.execMedian)}m (+${r1(s.execMedian - prev.execMedian)}m, allowed +${r1(allowed)}m)`,
      });
    }
  }

  for (const key of baseline.entries.keys()) {
    if (!summaries.has(key)) {
      findings.push({
        key,
        kind: "stale-baseline-entry",
        detail: "in the baseline but not observed — renamed or deleted; fix with --update-baseline",
      });
    }
  }

  return { findings, regressions: findings.filter((f) => f.kind === "regression") };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/ci-latency/evaluate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/ci-latency/evaluate.ts scripts/ci-latency/evaluate.test.ts
git commit -m "feat(audit): ci-latency evaluate — per-key band, exec-only gating"
```

---

## Task 5: `collect` — the Actions API reader

**Files:**

- Create: `scripts/ci-latency/collect.ts`, `scripts/ci-latency/collect.test.ts`

**Interfaces:**

- Consumes: `runGh`, `isRecord` from `../structure-audit/_gh-audit.ts`; `RUN_LIST_PAGE`, `MAX_RUNS_PER_WORKFLOW`, `SAMPLE_EVENT`, `AUDITED_REPOS`.
- Produces: `parseRunMeta(json: string): RunMeta[]`, `selectRuns(runs: readonly RunMeta[]): RunMeta[]`, `parseJobObservations(json, repo, workflow, runStartedAt): JobObservation[]`, `collectRepo(repo: string): CollectResult`, `collectAll(repos?: readonly string[]): CollectResult`, and `interface CollectResult { observations: JobObservation[]; attempted: number; readFailures: number; sawNeedsWorkflow: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";

import { parseJobObservations, parseRunMeta, selectRuns } from "./collect.ts";

describe("parseRunMeta", () => {
  test("reads id, workflow name and run_started_at", () => {
    const m = parseRunMeta(
      '{"workflow_runs":[{"id":1,"name":"CI","run_started_at":"2026-07-27T10:00:00Z"}]}',
    );
    expect(m).toEqual([{ id: "1", name: "CI", runStartedAt: "2026-07-27T10:00:00Z" }]);
  });
  test("empty on malformed JSON — an unreadable list is never a finding", () => {
    expect(parseRunMeta("{nope")).toEqual([]);
  });
  test("skips entries missing any required field", () => {
    expect(parseRunMeta('{"workflow_runs":[{"id":"x","name":"CI","run_started_at":"t"}]}')).toEqual(
      [],
    );
  });
});

describe("selectRuns", () => {
  const run = (name: string, i: number) => ({ id: `${name}-${i}`, name, runStartedAt: "t" });

  test("caps per WORKFLOW, so a busy workflow cannot starve a quiet one", () => {
    // The whole reason this exists: a flat per-repo cap gave CI only 4 of 30
    // runs, which made every ratchet threshold above 5 unreachable.
    const runs = [
      ...Array.from({ length: 40 }, (_, i) => run("Scorecard", i)),
      ...Array.from({ length: 40 }, (_, i) => run("CI", i)),
    ];
    const sel = selectRuns(runs);
    expect(sel.filter((r) => r.name === "CI")).toHaveLength(12);
    expect(sel.filter((r) => r.name === "Scorecard")).toHaveLength(12);
  });

  test("keeps every run of a workflow that has fewer than the cap", () => {
    expect(selectRuns([run("CI", 1), run("CI", 2)])).toHaveLength(2);
  });

  test("preserves API order (newest first) within a workflow", () => {
    const sel = selectRuns(Array.from({ length: 20 }, (_, i) => run("CI", i)));
    expect(sel[0]?.id).toBe("CI-0");
  });
});

describe("parseJobObservations", () => {
  const t0 = "2026-07-27T10:00:00Z";
  const job = (over: Record<string, unknown> = {}) => ({
    name: "Unit + Coverage",
    conclusion: "success",
    created_at: "2026-07-27T10:00:00Z",
    started_at: "2026-07-27T10:02:00Z",
    completed_at: "2026-07-27T10:12:00Z",
    ...over,
  });
  const payload = (jobs: unknown[]) => JSON.stringify({ jobs });

  test("exec is completed minus started", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.exec).toBe(10);
  });

  test("queue is started minus CREATED — DAG-free contention", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.queue).toBe(2);
  });

  test("dagWait is created minus run start, so a needs-blocked job is not charged as queue", () => {
    // A job gated by `needs` is CREATED only once its dependencies finish, so
    // charging created-minus-run-start to queue would bill it for their work.
    const [o] = parseJobObservations(
      payload([job({ created_at: "2026-07-27T10:20:00Z", started_at: "2026-07-27T10:21:00Z", completed_at: "2026-07-27T10:26:00Z" })]),
      "Nimbus",
      "CI",
      t0,
    );
    expect(o?.dagWait).toBe(20);
    expect(o?.queue).toBe(1);
    expect(o?.exec).toBe(5);
  });

  test("a root job has zero dagWait", () => {
    const [o] = parseJobObservations(payload([job()]), "Nimbus", "CI", t0);
    expect(o?.dagWait).toBe(0);
  });

  test("skips jobs that did not succeed — a failed job's duration is meaningless", () => {
    expect(parseJobObservations(payload([job({ conclusion: "failure" })]), "Nimbus", "CI", t0)).toEqual([]);
  });

  test("skips jobs with a missing timestamp rather than emitting NaN", () => {
    expect(parseJobObservations(payload([job({ completed_at: null })]), "Nimbus", "CI", t0)).toEqual([]);
  });

  test("empty on malformed JSON", () => {
    expect(parseJobObservations("{nope", "Nimbus", "CI", t0)).toEqual([]);
  });

  test("carries repo and workflow through onto every observation", () => {
    const [o] = parseJobObservations(payload([job()]), "nimbus-sdk", "Release", t0);
    expect(o?.repo).toBe("nimbus-sdk");
    expect(o?.workflow).toBe("Release");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/ci-latency/collect.test.ts`
Expected: FAIL — module `./collect.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * The only impure module: walks the Actions API and returns raw observations.
 * Every parser is exported and pure so the whole shape is table-tested offline.
 *
 * Restricted to `push` on the default branch: PR runs execute a different job
 * set against different cache state, so mixing them compares unlike things.
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import {
  AUDITED_REPOS,
  MAX_RUNS_PER_WORKFLOW,
  RUN_LIST_PAGE,
  SAMPLE_EVENT,
} from "./constants.ts";
import type { JobObservation } from "./types.ts";

const MS_PER_MIN = 60_000;

export interface RunMeta {
  id: string;
  name: string;
  runStartedAt: string;
}

export interface CollectResult {
  observations: JobObservation[];
  /** Job-list fetches attempted, for the failure-ratio check. */
  attempted: number;
  readFailures: number;
  /** True once any observation carried a non-zero dagWait — the created_at guard. */
  sawNeedsWorkflow: boolean;
}

export function parseRunMeta(json: string): RunMeta[] {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p) || !Array.isArray(p["workflow_runs"])) return [];
    const out: RunMeta[] = [];
    for (const r of p["workflow_runs"]) {
      if (!isRecord(r)) continue;
      const id = r["id"];
      const name = r["name"];
      const started = r["run_started_at"];
      if (typeof id !== "number" || typeof name !== "string" || typeof started !== "string") {
        continue;
      }
      out.push({ id: String(id), name, runStartedAt: started });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Keep at most `MAX_RUNS_PER_WORKFLOW` runs of each workflow.
 *
 * Capping per workflow rather than per repo is the whole point: a flat per-repo
 * cap let the noisiest workflow consume the window, leaving `CI` with 4 of 30
 * runs and every ratchet threshold above 5 permanently unreachable.
 */
export function selectRuns(runs: readonly RunMeta[]): RunMeta[] {
  const seen = new Map<string, number>();
  const out: RunMeta[] = [];
  for (const r of runs) {
    const n = seen.get(r.name) ?? 0;
    if (n >= MAX_RUNS_PER_WORKFLOW) continue;
    seen.set(r.name, n + 1);
    out.push(r);
  }
  return out;
}

function minutesBetween(later: unknown, earlier: unknown): number | null {
  if (typeof later !== "string" || typeof earlier !== "string") return null;
  const a = new Date(later).getTime();
  const b = new Date(earlier).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (a - b) / MS_PER_MIN;
}

export function parseJobObservations(
  json: string,
  repo: string,
  workflow: string,
  runStartedAt: string,
): JobObservation[] {
  try {
    const p: unknown = JSON.parse(json);
    if (!isRecord(p) || !Array.isArray(p["jobs"])) return [];
    const out: JobObservation[] = [];
    for (const j of p["jobs"]) {
      if (!isRecord(j)) continue;
      if (j["conclusion"] !== "success") continue;
      const name = j["name"];
      if (typeof name !== "string") continue;
      const exec = minutesBetween(j["completed_at"], j["started_at"]);
      const queue = minutesBetween(j["started_at"], j["created_at"]);
      const dagWait = minutesBetween(j["created_at"], runStartedAt);
      if (exec === null || queue === null || dagWait === null) continue;
      out.push({
        repo,
        workflow,
        job: name,
        exec,
        queue: Math.max(0, queue),
        dagWait: Math.max(0, dagWait),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * All observations for one repo. An unreadable repo yields none — never a
 * finding — but read failures are COUNTED, because a partial sample is more
 * dangerous than no sample: the survivors are whichever runs happened to
 * succeed, so their median can be biased and the gate could manufacture a
 * regression from it.
 */
export function collectRepo(repo: string): CollectResult {
  const empty: CollectResult = {
    observations: [],
    attempted: 0,
    readFailures: 0,
    sawNeedsWorkflow: false,
  };
  const res = runGh([
    "gh",
    "api",
    `repos/nimbus-agent/${repo}/actions/runs?per_page=${RUN_LIST_PAGE}&event=${SAMPLE_EVENT}&status=success`,
  ]);
  if (!res.ok) return empty;

  const out: JobObservation[] = [];
  let attempted = 0;
  let readFailures = 0;
  let sawNeedsWorkflow = false;

  for (const run of selectRuns(parseRunMeta(res.stdout))) {
    attempted++;
    const jobs = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    ]);
    if (!jobs.ok) {
      readFailures++;
      continue;
    }
    const obs = parseJobObservations(jobs.stdout, repo, run.name, run.runStartedAt);
    if (obs.some((o) => o.dagWait > 0)) sawNeedsWorkflow = true;
    out.push(...obs);
  }
  return { observations: out, attempted, readFailures, sawNeedsWorkflow };
}

export function collectAll(repos: readonly string[] = AUDITED_REPOS): CollectResult {
  const merged: CollectResult = {
    observations: [],
    attempted: 0,
    readFailures: 0,
    sawNeedsWorkflow: false,
  };
  for (const repo of repos) {
    const r = collectRepo(repo);
    merged.observations.push(...r.observations);
    merged.attempted += r.attempted;
    merged.readFailures += r.readFailures;
    merged.sawNeedsWorkflow ||= r.sawNeedsWorkflow;
  }
  return merged;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/ci-latency/collect.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts
git add scripts/ci-latency/collect.ts scripts/ci-latency/collect.test.ts
git commit -m "feat(audit): ci-latency collector — DAG-free queue via job created_at"
```

---

## Task 6: The shell, the generated baseline, and registration

**Files:**

- Create: `scripts/ci-latency/check.ts`, `docs/structure-audit/ci-latency-baseline.json`
- Modify: `package.json`, `scripts/lib/preflight-gates.ts`, `.github/workflows/org-drift-sweep.yml`

**Interfaces:**

- Consumes: everything from Tasks 1–5.
- Produces: no new exports — the shell is `import.meta.main` only.

- [ ] **Step 1: Write the shell**

Create `scripts/ci-latency/check.ts`:

```ts
#!/usr/bin/env bun

/**
 * audit:ci-latency — per-job CI execution, runner queue and DAG wait across the
 * org, gated against a committed baseline.
 *
 * ONLY execution regressions fail. Queue wait, DAG wait and job instability are
 * reported and never gated: none is caused by the change under test, and a gate
 * that reports a condition nobody can fix is one everybody learns to ignore.
 *
 * See docs/superpowers/specs/2026-07-27-p4b-ci-latency-design.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isStrict, strictSkip } from "../structure-audit/_gh-audit.ts";
import { MAX_READ_FAILURE_RATIO } from "./constants.ts";
import { computeUpdatedBaseline, parseBaseline, serializeBaseline } from "./baseline.ts";
import { collectAll } from "./collect.ts";
import { evaluate } from "./evaluate.ts";
import { summarize } from "./summarize.ts";

const BASELINE_PATH = join(import.meta.dir, "..", "..", "docs", "structure-audit", "ci-latency-baseline.json");

function readBaselineFile(): string {
  try {
    return readFileSync(BASELINE_PATH, "utf8");
  } catch {
    return '{"version":1,"generated_at":"","entries":{}}';
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const strict = isStrict(argv, process.env);
  const updateMode = argv.includes("--update-baseline");
  const label = "audit:ci-latency";

  const collected = collectAll();
  const { observations, attempted, readFailures, sawNeedsWorkflow } = collected;

  if (observations.length === 0) {
    // Nothing readable at all: no gh, no auth, or a total API outage.
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  if (readFailures > 0) {
    console.warn(`::warning::${label}: ${readFailures}/${attempted} job-list read(s) failed`);
  }
  // A partial sample is worse than none: the survivors are whichever runs
  // happened to succeed, so gating on their median could manufacture a
  // regression. Degrade to a skip rather than gate on degraded data.
  if (attempted > 0 && readFailures / attempted > MAX_READ_FAILURE_RATIO) {
    const outcome = strictSkip(
      label,
      strict,
      `${readFailures}/${attempted} job reads failed — sample too degraded to gate on`,
    );
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }
  // The created_at eligibility assumption is undocumented API behaviour. If it
  // ever changes, dagWait silently goes to zero everywhere and `queue` quietly
  // re-absorbs dependency execution — with no error anywhere. Warn, never fail:
  // an upstream API change is not something a contributor's PR can fix.
  if (!sawNeedsWorkflow) {
    console.warn(
      `::warning::${label}: dagWait is zero for every observation — the created_at eligibility assumption may have changed; queue figures may now include dependency execution`,
    );
  }

  const summaries = summarize(observations);
  const baseline = parseBaseline(readBaselineFile());

  if (updateMode) {
    const next = computeUpdatedBaseline(baseline, summaries, new Date().toISOString());
    writeFileSync(BASELINE_PATH, serializeBaseline(next));
    console.log(`${label}: baseline updated — ${next.entries.size} key(s) from ${observations.length} observation(s)`);
    process.exit(0);
  }

  const result = evaluate(summaries, baseline);

  // Observational lines first, so a red is read in context.
  const worstQueue = [...summaries.values()].sort((a, b) => b.queueMedian - a.queueMedian)[0];
  if (worstQueue && worstQueue.queueMedian > 1) {
    console.warn(
      `::warning::${label}: worst median runner queue ${worstQueue.queueMedian.toFixed(1)}m on "${worstQueue.key}" — contention, not a code regression`,
    );
  }
  for (const f of result.findings) {
    if (f.kind === "regression") continue;
    console.warn(`::warning::${label}: ${f.key}: ${f.detail} (${f.kind})`);
  }
  for (const f of result.regressions) {
    console.error(`::error::${label}: ${f.key}: ${f.detail}`);
  }

  if (result.regressions.length > 0) {
    console.error(`${label}: FAILED — ${result.regressions.length} job(s) slower than baseline`);
    process.exit(1);
  }
  console.log(`${label}: OK (${summaries.size} key(s), ${observations.length} observation(s))`);
}
```

- [ ] **Step 2: Register the scripts**

In `package.json`, immediately after the `"audit:pin-freshness"` line:

```json
    "audit:ci-latency": "bun scripts/ci-latency/check.ts",
    "audit:ci-latency:update-baseline": "bun scripts/ci-latency/check.ts --update-baseline",
```

In `scripts/lib/preflight-gates.ts`, add both to `CI_ONLY_GATES` immediately after the `"audit:pin-freshness"` entry:

```ts
  "audit:ci-latency", // needs network + gh (Actions API across 9 repos); runs only in org-drift-sweep.yml with --strict, never the local FAST tier
  "audit:ci-latency:update-baseline", // explicit human action that rewrites the committed baseline; never a gate
```

- [ ] **Step 3: Generate and inspect the baseline**

Run: `GH_TOKEN=$(gh auth token) bun run audit:ci-latency:update-baseline`
Expected: `baseline updated — N key(s) from M observation(s)`, and `docs/structure-audit/ci-latency-baseline.json` now exists.

Open the file and sanity-check it before trusting it:

- every `execMedian` is a plausible number of **minutes** (not seconds, not ms);
- `Nimbus :: CI :: ...` keys are present;
- `Unit + Coverage — windows-2025` carries a large `execSpread` (~14) while
  `Static — ubuntu-24.04` carries a small one (~1). If both are ~0 the sample
  collapsed to one run and the baseline is not trustworthy — investigate rather
  than commit.

- [ ] **Step 4: Run the gate against the fresh baseline**

Run: `GH_TOKEN=$(gh auth token) bun run audit:ci-latency`
Expected: **exit 0**, `OK (N key(s), M observation(s))`, plus a `::warning::` naming the worst median runner queue and any `unstable` / `insufficient-data` keys.

Green is correct here and is not evidence the gate works — the baseline was just generated from this same data, so nothing can exceed it by construction. The red-proof is the unit test in Task 4 (`a regression beyond the band fails`).

- [ ] **Step 5: Verify the degradation path**

Run: `BUNDIR=$(dirname "$(which bun)"); env -u GH_TOKEN -u GITHUB_TOKEN PATH="$BUNDIR" "$BUNDIR/bun" scripts/ci-latency/check.ts`
Expected: a soft `::warning::` skip and **exit 0** — never a stack trace.

Then: `... scripts/ci-latency/check.ts --strict`
Expected: `::error::` and **exit 1**.

- [ ] **Step 6: Add the sweep job**

In `.github/workflows/org-drift-sweep.yml`, after the `pin-freshness` job:

```yaml
  ci-latency:
    name: ci-latency
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      contents: read
      actions: read
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest
      # `actions: read` is all the Actions API needs for runs + jobs. Every
      # audited repo is public, so the default github.token reaches them.
      - name: Audit CI latency
        env:
          GH_TOKEN: ${{ github.token }}
        run: bun scripts/ci-latency/check.ts --strict
```

- [ ] **Step 7: Full verification**

Run: `bun test scripts/ && bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check scripts .github docs && bun run audit:action-sha-pins`
Expected: all pass. The sha-pin audit matters because Step 6 added two `uses:` refs.

- [ ] **Step 8: Commit**

```bash
git add scripts/ci-latency/check.ts docs/structure-audit/ci-latency-baseline.json package.json scripts/lib/preflight-gates.ts .github/workflows/org-drift-sweep.yml
git commit -F - <<'EOF'
feat(audit): audit:ci-latency — per-job exec gate, queue observed

Only execution regressions fail. Queue wait, DAG wait and job instability are
reported and never gated: none is caused by the change under test, so failing a
PR for them would report a condition the contributor cannot fix.
EOF
```

---

## Task 7: Documentation

**Files:**

- Modify: `docs/infrastructure-roadmap.md`

- [ ] **Step 1: Update the P4b row**

In the sub-programs table, replace the P4b row with:

```markdown
| P4b | Latency | 🔨 measurement shipped | `audit:ci-latency` tracks per-job execution, runner queue and DAG wait across the 9 org repos and fails when a job's execution regresses beyond its own measured noise band. Tuning is deliberately NOT in this slice — the first measurement showed execution is not the binding constraint. |
```

- [ ] **Step 2: Add the P4b progress log**

Add a new `### P4b progress log` section immediately before `### P5 progress log`:

```markdown
### P4b progress log

- **Delivered (measurement, 2026-07-27):** `audit:ci-latency` collects per-job
  timings from the Actions API across all 9 org repos and gates execution
  against a committed baseline (`docs/structure-audit/ci-latency-baseline.json`),
  mirroring `audit:coverage-floor`.
- **The first measurement contradicted the design of record's hunch.** That
  document proposed cache tuning, matrix sharding and finer path filters. On the
  slowest sampled run (73.8min) the longest single job *executed* for 12.3min,
  while the longest DAG wait was 33.9min and the longest runner queue 31.6min —
  so execution is not the binding constraint, and sharding would worsen it by
  adding jobs to the same contended pool. Principle #3 ("only against
  measurement, never against a hunch") earned its keep on first use.
- **An earlier revision of the design claimed "~80% of wall-clock is queueing".
  That was wrong** and the design review caught it: it measured
  `started_at − run_started_at`, which charges a job for its *dependencies'*
  execution. A job's `created_at` tracks eligibility, so `started_at − created_at`
  is DAG-free contention and the DAG cost is recorded separately. Contention is
  real but concentrated almost entirely on **macOS** runners.
- **Tolerance is a per-key noise band, not a constant.** Measured spreads over 11
  samples: `Static — ubuntu` 0.7min, `Unit + Coverage — ubuntu` 2.0min,
  `Unit + Coverage — windows` **14.5min**. No global constant fits both, so the
  baseline stores each job's own spread and the gate allows
  `max(1min, spread)`. A job whose spread exceeds half its median is reported
  `unstable` — observed, never failed, since flakiness is not caused by the
  contributor's change.
- **Remaining:** the tuning slice itself, which must be justified against this
  data. The clearest lead is macOS runner contention.
```

- [ ] **Step 3: Validate the docs**

Run: `bun run lint:markdown && bun run audit:doc-refs && "$HOME/.cargo/bin/lychee" --offline --no-progress --config lychee.toml 'docs/**/*.md' '*.md'`
Expected: 0 markdown errors, all refs resolve, 0 link errors.

- [ ] **Step 4: Commit**

```bash
git add docs/infrastructure-roadmap.md
git commit -m "docs(infra): record P4b — CI latency measurement shipped"
```

---

## Post-implementation (not a task — for the PR author)

- **PR description:** state plainly that the gate ships **green by construction**
  (the baseline is generated from the same window it is checked against), so the
  red-proof is the unit test in Task 4 rather than a live finding. Paste the
  Task 6 Step 4 output.
- **Sweep proof:** after merge, dispatch `org-drift-sweep.yml` and record the run
  number in the P4b progress log, matching how P2 and P5 were closed.
- **The tuning slice is the follow-up**, and macOS contention is its first lead.

---

## Self-Review

**Spec coverage:**

- Three metrics, exec/queue/dagWait separated → Task 5 `parseJobObservations` + Task 2 `summarize`. ✓
- Only exec gated; queue/dagWait/unstable observed → Task 4 `evaluate` + Task 6 shell. ✓
- `queue = started_at − created_at` (DAG-free) → Task 5, with a test asserting a `needs`-blocked job is not charged. ✓
- Sparse sampling → `MIN_SAMPLES`, `insufficient-data` skipped not failed → Tasks 1, 4. ✓
- Single event class (`push`) → Task 1 `SAMPLE_EVENT`, Task 5 query string. ✓
- Per-key noise band replacing a flat tolerance → Task 3 stores `execSpread`, Task 4 applies `max(MIN_ABSOLUTE_DELTA, spread)`. ✓
- `MIN_ABSOLUTE_DELTA` floor for sub-minute jobs → Task 4 test. ✓
- `unstable` observation at `UNSTABLE_SPREAD_RATIO` → Task 4. ✓
- Ratchet down needs `MIN_SAMPLES_FOR_RATCHET` (5) vs 3 to gate → Task 3 test. ✓
- Spread travels down with the median → Task 3 test. ✓
- Stale baseline entry / new key are never failures → Task 4 tests. ✓
- Org-wide, 9 repos → Task 1 `AUDITED_REPOS` (mirrors the sha-pins matrix). ✓
- Sweep job, `--strict`, not the fast tier → Task 6 Steps 2 and 6. ✓
- Fail-soft locally / hard strict → Task 6 Step 5. ✓
- Ships green by construction; red-proof is a unit test → Task 6 Step 4 + Task 4. ✓
- No tuning in scope → nothing in any task changes a workflow's execution; the only workflow edit adds a job. ✓

**Placeholder scan:** no TBD/TODO; every code step carries complete code. ✓

**Type consistency:** `JobObservation`, `KeySummary`, `BaselineEntry`, `LatencyBaseline`, `Finding`, `FindingKind`, `CheckResult` are each defined once in Task 1 and referenced with identical shapes throughout. `summarize` / `parseBaseline` / `serializeBaseline` / `computeUpdatedBaseline` / `evaluate` / `collectAll` keep one signature across tasks. `execSpread` is named identically in the summary, the baseline entry and the evaluator. ✓
