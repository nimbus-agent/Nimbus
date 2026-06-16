# Hybrid Perf Strategy — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nimbus perf CI trustworthy — hard-gate only the deterministic in-process surfaces, trend the spawn/IO-noisy ones, so a red perf check always means a real regression.

**Architecture:** A declared `gateClass` partition (`gate | trend | reference`) on `SloThreshold` drives the comparator; latency aggregates via a trimmed-pool p95 (drop the worst run, pool the rest); push-to-main publishes the baseline only while PRs gate `gate`-class surfaces; `trend` surfaces feed a `github-action-benchmark` dashboard plus a rolling-median sustained-drift alert; the M1 Air reference run becomes a nightly full-surface gate authority.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, GitHub Actions, `benchmark-action/github-action-benchmark`.

**Spec:** `docs/superpowers/specs/2026-06-14-hybrid-perf-strategy-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/gateway/src/perf/slo-thresholds.ts` | Modify | Add `gateClass`; remove redundant `gated`/`linuxOnlyGate` |
| `packages/gateway/src/perf/threshold-comparator.ts` | Modify | `gate` fails on any runner; `trend`/`reference` skip on GHA; `gate`-only failure |
| `packages/gateway/src/perf/bench-harness.ts` | Modify | Trimmed-pool p95 (`poolTrimmedSamples`) in `buildLatencyResult` |
| `packages/gateway/src/perf/bench-ci.ts` | Modify | Event-aware exit: publish-only on push, gate on PR |
| `packages/gateway/src/perf/history-line.ts` | Modify | `schema_version` 1 → 2 |
| `packages/gateway/src/perf/pr-comment-formatter.ts` | Modify | Condensed `gate`-class summary + dashboard link |
| `scripts/perf/emit-benchmark-json.ts` | Create | Map `trend` surfaces → `github-action-benchmark` JSON |
| `scripts/perf/drift-check.ts` | Create | Rolling-median sustained-drift detector + gh issue upsert |
| `.github/workflows/_perf.yml` | Modify | Push-only `github-action-benchmark` trend step |
| `.github/workflows/_perf-reference.yml` | Modify | Nightly `schedule` cron (gate authority) |
| `docs/perf/slo.md` | Modify | Regenerate + repoint the trend note at `/dev/bench` |

**PR grouping:** PR1 = Tasks 1–6 (core gating change) · PR2 = Tasks 7–10 (trend pipeline + drift + comment) · PR3 = Tasks 11–12 (reference cron + docs). Each PR is independently shippable and green.

---

### Task 1: Add `gateClass` to `SloThreshold` (additive partition field)

**Files:**

- Modify `packages/gateway/src/perf/slo-thresholds.ts` (interface ~L3-19; every row in `NON_S8_THRESHOLDS` L21-211; the `buildS8Cells` row L213-229)
- Test: `packages/gateway/src/perf/slo-thresholds.test.ts` (add a new `describe` block; existing tests stay green because this step is purely additive)

This step ADDS `gateClass` alongside the existing `gated`/`linuxOnlyGate` fields. Task 3 removes the redundant fields once the comparator (Task 2) no longer reads them. Keeping them coexisting here means Task 1 + Task 2 each ship green.

- [ ] **Step 1: Write the failing partition test.** Append this block to the end of `packages/gateway/src/perf/slo-thresholds.test.ts` (before the file's final closing — it is its own top-level `describe`, so insert it after the existing `describe(...)` block closes on L134):

```ts
describe("SLO_THRESHOLDS — gateClass partition (spec § 4.1)", () => {
  const GATE_IDS: ReadonlySet<string> = new Set([
    "S2-a",
    "S2-b",
    "S8-l50-b1",
    "S8-l50-b8",
    "S8-l50-b32",
    "S8-l50-b64",
    "S8-l500-b1",
    "S8-l500-b8",
    "S8-l500-b32",
    "S8-l500-b64",
    "S8-l5000-b1",
    "S8-l5000-b8",
    "S8-l5000-b32",
    "S8-l5000-b64",
  ]);
  const TREND_IDS: ReadonlySet<string> = new Set([
    "S1",
    "S4",
    "S6-drive",
    "S6-gmail",
    "S6-github",
    "S7-a",
    "S7-b",
    "S10",
    "S11-a",
    "S11-b",
  ]);
  const REFERENCE_IDS: ReadonlySet<string> = new Set(["S2-c", "S7-c", "S9"]);
  const STUB_IDS: ReadonlySet<string> = new Set(["S3", "S5"]);

  test("every row carries a gateClass of gate | trend | reference", () => {
    for (const row of SLO_THRESHOLDS) {
      expect(["gate", "trend", "reference"]).toContain(row.gateClass);
    }
  });

  test("the partition is exhaustive over all 29 surfaces with no overlap", () => {
    const seen = new Set<string>();
    for (const row of SLO_THRESHOLDS) {
      expect(seen.has(row.surfaceId)).toBe(false);
      seen.add(row.surfaceId);
    }
    expect(seen.size).toBe(29);
  });

  test("gate-class set matches the spec § 3 table (S2-a, S2-b + 12 S8 cells)", () => {
    const gate = SLO_THRESHOLDS.filter((r) => r.gateClass === "gate").map((r) => r.surfaceId);
    expect(new Set(gate)).toEqual(GATE_IDS);
  });

  test("trend-class set matches the spec § 3 table (S1, S4, S6-*, S7-a/b, S10, S11-a/b)", () => {
    const trend = SLO_THRESHOLDS.filter((r) => r.gateClass === "trend").map((r) => r.surfaceId);
    expect(new Set(trend)).toEqual(TREND_IDS);
  });

  test("reference-class set matches the spec § 3 table (S2-c, S7-c, S9)", () => {
    const ref = SLO_THRESHOLDS.filter((r) => r.gateClass === "reference").map((r) => r.surfaceId);
    expect(new Set(ref)).toEqual(REFERENCE_IDS);
  });

  test("S3/S5 stubs are classified trend (spawn-driver pending) and S4 is trend", () => {
    for (const id of STUB_IDS) {
      const row = SLO_THRESHOLDS.find((r) => r.surfaceId === id);
      expect(row?.gateClass).toBe("trend");
    }
    expect(SLO_THRESHOLDS.find((r) => r.surfaceId === "S4")?.gateClass).toBe("trend");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/slo-thresholds.test.ts`. Expected: the new `describe("SLO_THRESHOLDS — gateClass partition ...")` tests fail — `every row carries a gateClass ...` fails with `expect(received).toContain(expected)` where `received` is `["gate","trend","reference"]` and the value `undefined` is not in it (because `row.gateClass` does not exist yet). TypeScript also flags `Property 'gateClass' does not exist on type 'SloThreshold'` — that is fine for the RED step.

- [ ] **Step 3: Add the field to the interface and set it on every row.** In `packages/gateway/src/perf/slo-thresholds.ts`, edit the interface to add `gateClass` (place it right after `surfaceId`):

```ts
export interface SloThreshold {
  surfaceId: BenchSurfaceId;
  gateClass: "gate" | "trend" | "reference";
  metric:
    | "p95_ms"
    | "p50_ms"
    | "throughput_per_sec"
    | "rss_bytes_p95"
    | "tokens_per_sec"
    | "first_token_ms";
  refMax?: number;
  ghaMax: number | "tbd-c2" | "skipped";
  gated: boolean;
  noiseFloorPct: number;
  noiseFloorAbs: number;
  noiseFloorAbsUnit: "ms" | "items_per_sec" | "bytes" | "tps";
  linuxOnlyGate?: true;
}
```

Then add `gateClass` to each row in `NON_S8_THRESHOLDS`. Add it immediately after the `surfaceId` line in each object literal:

- `S1` → `gateClass: "trend",`
- `S2-a` → `gateClass: "gate",`
- `S2-b` → `gateClass: "gate",`
- `S2-c` → `gateClass: "reference",`
- `S3` → `gateClass: "trend",`
- `S4` → `gateClass: "trend",`
- `S5` → `gateClass: "trend",`
- `S11-a` → `gateClass: "trend",`
- `S11-b` → `gateClass: "trend",`
- `S6-drive` → `gateClass: "trend",`
- `S6-gmail` → `gateClass: "trend",`
- `S6-github` → `gateClass: "trend",`
- `S7-a` → `gateClass: "trend",`
- `S7-b` → `gateClass: "trend",`
- `S7-c` → `gateClass: "reference",`
- `S9` → `gateClass: "reference",`
- `S10` → `gateClass: "trend",`

Concretely, for the S1 row (currently L22-44) the head becomes:

```ts
  {
    surfaceId: "S1",
    gateClass: "trend",
    metric: "p95_ms",
```

For S2-a (L45-54):

```ts
  {
    surfaceId: "S2-a",
    gateClass: "gate",
    metric: "p95_ms",
```

Apply the same single-line insertion to every remaining `NON_S8_THRESHOLDS` row using the class mapping above.

Finally, in `buildS8Cells()` (L213-229) add `gateClass: "gate"` to the pushed object — S8 cells are the `gate` class per the spec table:

```ts
function buildS8Cells(): readonly SloThreshold[] {
  const out: SloThreshold[] = [];
  for (const length of S8_LENGTHS) {
    for (const batch of S8_BATCHES) {
      out.push({
        surfaceId: `S8-l${length}-b${batch}`,
        gateClass: "gate",
        metric: "throughput_per_sec",
        ghaMax: "tbd-c2",
        gated: false,
        noiseFloorPct: 25,
        noiseFloorAbs: 5,
        noiseFloorAbsUnit: "items_per_sec",
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it, expect PASS.** Command: `cd packages/gateway && bun test src/perf/slo-thresholds.test.ts`. Expected: all tests pass (the new partition block plus all pre-existing schema-invariant tests, which still assert the unchanged `gated`/`linuxOnlyGate` fields). Expected tail: `0 fail`.

- [ ] **Step 5: Typecheck.** Command: `cd packages/gateway && bun run typecheck`. Expected: no errors (additive field, every literal supplies it). Lint: `bunx biome check packages/gateway/src/perf/slo-thresholds.ts packages/gateway/src/perf/slo-thresholds.test.ts` — expected `Checked N files ... No fixes applied` / no diagnostics.

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/slo-thresholds.ts packages/gateway/src/perf/slo-thresholds.test.ts
git commit -m "$(cat <<'EOF'
feat(perf): add gateClass partition field to SloThreshold (additive)

Classify every SLO surface as gate | trend | reference per the hybrid-perf
spec § 4.1 table. Additive only — gated/linuxOnlyGate stay until the
comparator is rewired off them. S2-a/S2-b + 12 S8 cells = gate; S1/S4/S6/S7-a/
S7-b/S10/S11-a/S11-b + S3/S5 stubs = trend; S2-c/S7-c/S9 = reference.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rewire `threshold-comparator.ts` to consult `gateClass`

**Files:**

- Modify `packages/gateway/src/perf/threshold-comparator.ts` (ComparisonStatus union L5-10; `classifySkip` L47-58; `isFailingComparison` L127-130)
- Test: `packages/gateway/src/perf/threshold-comparator.test.ts` (add a new `describe` block; existing tests stay green because the runtime semantics are equivalent — `trend`/`reference` GHA surfaces still resolve to a `skipped` status, and `gate`-class rows still gate)

This step makes the comparator read `gateClass` instead of `gated`/`linuxOnlyGate`, and adds the `"trend-only"` skip reason. `classifySkip` becomes: on a non-reference runner a `trend` surface → `skipped: "trend-only"`, a `reference` surface (or `ghaMax === "skipped"`) → `skipped: "reference-only"`. `isFailingComparison` fails only for `gateClass === "gate"`.

- [ ] **Step 1: Write the failing test.** Append this block to the end of `packages/gateway/src/perf/threshold-comparator.test.ts`:

```ts
describe("compareAgainstHistory — gateClass-driven skip classification", () => {
  test("trend surface (S1) on gha-ubuntu resolves to skipped(trend-only)", () => {
    const current = fakeLine("gha-ubuntu", { S1: { samples_count: 301, p95_ms: 99_999 } });
    const previous = fakeLine("gha-ubuntu", { S1: { samples_count: 301, p95_ms: 600 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s1 = out.find((c) => c.surfaceId === "S1");
    expect(s1?.status).toEqual({ kind: "skipped", reason: "trend-only" });
  });

  for (const runner of ["gha-ubuntu", "gha-macos", "gha-windows"] as const) {
    test(`trend surface (S11-b) on ${runner} resolves to skipped(trend-only)`, () => {
      const current = fakeLine(runner, { "S11-b": { samples_count: 301, p95_ms: 99_999 } });
      const previous = fakeLine(runner, { "S11-b": { samples_count: 301, p95_ms: 600 } });
      const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, runner);
      const c = out.find((x) => x.surfaceId === "S11-b");
      expect(c?.status).toEqual({ kind: "skipped", reason: "trend-only" });
    });
  }

  test("trend RSS surface (S7-a) on gha-macos resolves to skipped(trend-only)", () => {
    const current = fakeLine("gha-macos", {
      "S7-a": { samples_count: 60, rss_bytes_p95: 100_000_000 },
    });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-macos");
    const s7a = out.find((c) => c.surfaceId === "S7-a");
    expect(s7a?.status).toEqual({ kind: "skipped", reason: "trend-only" });
  });

  test("reference surface (S2-c) on gha-ubuntu resolves to skipped(reference-only)", () => {
    const current = fakeLine("gha-ubuntu", {});
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "gha-ubuntu");
    const s2c = out.find((c) => c.surfaceId === "S2-c");
    expect(s2c?.status).toEqual({ kind: "skipped", reason: "reference-only" });
  });

  test("on reference-m1air a trend surface is EVALUATED (not skipped) via refMax", () => {
    // S1 refMax=2000; measured 12000 → absolute-fail on the reference runner.
    const current = fakeLine("reference-m1air", { S1: { samples_count: 301, p95_ms: 12_000 } });
    const out = compareAgainstHistory(current, null, SLO_THRESHOLDS, "reference-m1air");
    const s1 = out.find((c) => c.surfaceId === "S1");
    expect(s1?.status).toEqual({ kind: "absolute-fail", measured: 12_000, threshold: 2_000 });
  });

  test("gate surface (S2-a) on gha-ubuntu is EVALUATED (not skipped)", () => {
    const current = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 65 } });
    const previous = fakeLine("gha-ubuntu", { "S2-a": { samples_count: 500, p95_ms: 50 } });
    const out = compareAgainstHistory(current, previous, SLO_THRESHOLDS, "gha-ubuntu");
    const s2a = out.find((c) => c.surfaceId === "S2-a");
    expect(s2a?.status).toMatchObject({ kind: "delta-fail", previous: 50, current: 65 });
  });
});

describe("isFailingComparison — gateClass gating", () => {
  test("a trend-class surface can never fail the build", () => {
    const slo = SLO_THRESHOLDS.find((r) => r.surfaceId === "S1")!;
    expect(slo.gateClass).toBe("trend");
    expect(
      isFailingComparison(
        {
          surfaceId: "S1",
          metric: "p95_ms",
          status: { kind: "absolute-fail", measured: 12_000, threshold: 10_000 },
        },
        slo,
      ),
    ).toBe(false);
  });

  test("a reference-class surface can never fail the build", () => {
    const slo = SLO_THRESHOLDS.find((r) => r.surfaceId === "S9")!;
    expect(slo.gateClass).toBe("reference");
    expect(
      isFailingComparison(
        {
          surfaceId: "S9",
          metric: "tokens_per_sec",
          status: { kind: "absolute-fail", measured: 1, threshold: 100 },
        },
        slo,
      ),
    ).toBe(false);
  });

  test("a gate-class surface fails on absolute-fail / delta-fail", () => {
    const slo = SLO_THRESHOLDS.find((r) => r.surfaceId === "S2-a")!;
    expect(slo.gateClass).toBe("gate");
    expect(
      isFailingComparison(
        {
          surfaceId: "S2-a",
          metric: "p95_ms",
          status: { kind: "absolute-fail", measured: 300, threshold: 200 },
        },
        slo,
      ),
    ).toBe(true);
    expect(
      isFailingComparison(
        {
          surfaceId: "S2-a",
          metric: "p95_ms",
          status: { kind: "delta-fail", previous: 50, current: 200, deltaPct: 300, floorPct: 25 },
        },
        slo,
      ),
    ).toBe(true);
    expect(
      isFailingComparison({ surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } }, slo),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/threshold-comparator.test.ts`. Expected failures:
  - `trend surface (S1) on gha-ubuntu resolves to skipped(trend-only)` fails: the current `classifySkip` resolves S1 (which still carries `linuxOnlyGate`) to `{ reason: "linux-only-gate" }` on a non-ubuntu runner, but on `gha-ubuntu` S1 is NOT skipped today (the old code lets it through), so `received` is a `pass`/`delta-fail` not `{ kind: "skipped", reason: "trend-only" }`.
  - `a trend-class surface can never fail the build` fails: today `isFailingComparison` reads `slo.gated` (S1.gated === true) and returns `true`.
  - TypeScript also flags `"trend-only"` as not assignable to the `reason` union until Step 3.

- [ ] **Step 3: Rewire the comparator.** Edit `packages/gateway/src/perf/threshold-comparator.ts`.

First, add `"trend-only"` to the `skipped` reason union (L9):

```ts
export type ComparisonStatus =
  | { kind: "pass" }
  | { kind: "absolute-fail"; measured: number; threshold: number }
  | { kind: "delta-fail"; previous: number; current: number; deltaPct: number; floorPct: number }
  | { kind: "skipped"; reason: "tbd-c2" | "trend-only" | "reference-only" | "stub" }
  | { kind: "no-baseline"; current: number };
```

Note: `"linux-only-gate"` is removed from the union — the next test that referenced it lives in this same file's existing block and is replaced wholesale by Task 2's new tests plus the deletions in Task 3 Step 1. The existing `for (const surfaceId of ["S1", "S11-b"] ...)` block (L65-75) and the `S7-a ... linux-only-gate` test (L109-116) assert `linux-only-gate`; they are removed in Task 3. Within THIS task, leave those two existing blocks in place but expect them to now fail against the new `"trend-only"` behavior — they are deleted in Task 3 Step 1. To keep Task 2 self-contained and green, perform the deletion of those two now-obsolete assertion blocks as part of Step 3 here:

Delete the existing block at L60-75 (the `for (const surfaceId of ["S1", "S11-b"] ...)` loop and its leading comment) and the existing `test("S7-a on gha-macos resolves to skipped(linux-only-gate)", ...)` at L109-116 from `threshold-comparator.test.ts` — they are superseded by the new `trend-only` tests written in Step 1.

Now rewrite `classifySkip` (L47-58):

```ts
function classifySkip(slo: SloThreshold, runner: RunnerKind): ComparisonStatus | null {
  // On the consistent-hardware reference runner, every class with a refMax is evaluated.
  if (runner === "reference-m1air") {
    if (slo.gateClass === "reference" && slo.refMax === undefined) {
      return { kind: "skipped", reason: "reference-only" };
    }
    if (slo.ghaMax === "tbd-c2" && slo.refMax === undefined) {
      return { kind: "skipped", reason: "tbd-c2" };
    }
    return null;
  }
  // On any GHA shared runner, only gate-class surfaces are evaluated.
  if (slo.gateClass === "reference" || slo.ghaMax === "skipped") {
    return { kind: "skipped", reason: "reference-only" };
  }
  if (slo.gateClass === "trend") {
    return { kind: "skipped", reason: "trend-only" };
  }
  if (slo.ghaMax === "tbd-c2") {
    return { kind: "skipped", reason: "tbd-c2" };
  }
  return null;
}
```

Then rewrite `isFailingComparison` (L127-130):

```ts
export function isFailingComparison(c: SurfaceComparison, slo: SloThreshold): boolean {
  if (slo.gateClass !== "gate") return false;
  return c.status.kind === "absolute-fail" || c.status.kind === "delta-fail";
}
```

(Note: `isFailingComparison` no longer reads `slo.gated`, and `classifySkip` no longer reads `slo.linuxOnlyGate` — those fields are now dead in production code, which Task 3 removes.)

- [ ] **Step 4: Run it, expect PASS.** Command: `cd packages/gateway && bun test src/perf/threshold-comparator.test.ts`. Expected: all tests pass (the new `gateClass`-driven blocks plus the surviving pre-existing tests — the S1 cold-start floor test on L46-58 now resolves `skipped(trend-only)` rather than `pass`).

  IMPORTANT — one pre-existing test changes meaning: the test `S1 cold-start jitter (...) → pass (Linux)` (L46-58) asserts `{ kind: "pass" }` on `gha-ubuntu`. Under `gateClass`, S1 on `gha-ubuntu` is now `skipped(trend-only)`. Update that single assertion: change its `expect(s1?.status).toEqual({ kind: "pass" });` to `expect(s1?.status).toEqual({ kind: "skipped", reason: "trend-only" });` and update its title/comment to `"S1 on gha-ubuntu is trend-only (no longer gated on shared runners)"`. Likewise `isFailingComparison` existing block at L245-299 uses S1 and asserts `true` for `absolute-fail`/`delta-fail` — S1 is now `trend`, so retarget those two `true`-expecting cases to `S2-a` (a `gate` surface): change the `slo` lookup at L262 to `SLO_THRESHOLDS.find((r) => r.surfaceId === "S2-a")!` and the four `surfaceId`/`metric` literals in that block from `"S1"`/`p95_ms` to `"S2-a"`/`p95_ms` (S2-a is also `p95_ms`, so thresholds line up). The `returns false ... gated === false` test at L246-259 reads `slo.gated`; change `expect(slo.gated).toBe(false);` to `expect(slo.gateClass).toBe("trend");`.

  Expected tail: `0 fail`.

- [ ] **Step 5: Typecheck + lint.** `cd packages/gateway && bun run typecheck` (expected: no errors — note any remaining `slo.gated`/`slo.linuxOnlyGate` reads are gone from production, only the still-present interface fields remain, removed in Task 3). `bunx biome check packages/gateway/src/perf/threshold-comparator.ts packages/gateway/src/perf/threshold-comparator.test.ts` — expected no diagnostics.

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/threshold-comparator.ts packages/gateway/src/perf/threshold-comparator.test.ts
git commit -m "$(cat <<'EOF'
feat(perf): rewire threshold-comparator off gated/linuxOnlyGate onto gateClass

classifySkip now resolves trend surfaces to skipped(trend-only) and reference
surfaces to skipped(reference-only) on every GHA runner, evaluating the full
refMax set only on reference-m1air. isFailingComparison fails only gate-class
surfaces. Adds the "trend-only" reason to the ComparisonStatus skipped union
and drops "linux-only-gate". Production code no longer reads gated/
linuxOnlyGate (removed next).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove the redundant `gated` + `linuxOnlyGate` fields

**Files:**

- Modify `packages/gateway/src/perf/slo-thresholds.ts` (interface L14 + L18; every row that sets `gated:` / `linuxOnlyGate:`; `buildS8Cells`)
- Modify `packages/gateway/src/perf/threshold-comparator.test.ts` (the inline `floorRow` fixture at L143-152, which sets `gated: true`)
- Test: `packages/gateway/src/perf/slo-thresholds.test.ts` (rewrite the four tests that assert `gated`/`linuxOnlyGate`, and the two exact-row snapshot tests)

`gateClass` (Task 1) + the comparator rewire (Task 2) make `gated` and `linuxOnlyGate` dead. This removes them and repairs every assertion.

- [ ] **Step 1: Rewrite the failing assertions in `slo-thresholds.test.ts`.** Make these exact edits:

(a) `every UX row is gated and has both refMax and ghaMax populated` (L10-32) → drop the `gated` assertion and assert `gateClass`. Replace L23 (`expect(row.gated).toBe(true);`) with:

```ts
      expect(["gate", "trend"]).toContain(row.gateClass);
```

(UX rows are either `gate` (S2-a/S2-b), `trend` (S1/S3/S4/S5/S11-a/S11-b), or `reference` (S2-c) — but the loop already special-cases S2-c's `ghaMax === "skipped"`, and S2-c is `reference`, so broaden the allowed set to all three and rename the test.) Replace L23 instead with:

```ts
      expect(["gate", "trend", "reference"]).toContain(row.gateClass);
```

and rename the test title to `"every UX row carries a gateClass and has refMax populated"`.

(b) `every workload row is ungated and has ghaMax === 'tbd-c2' or 'skipped'` (L34-53) → replace L46 (`expect(row!.gated).toBe(false);`) with:

```ts
      expect(["trend", "reference"]).toContain(row!.gateClass);
```

Wait — S8 cells are `gate` and match this filter (`id.startsWith("S8-")`). Exclude S8 from the gateClass assertion by guarding it; replace L46 with:

```ts
      if (id.startsWith("S8-")) {
        expect(row!.gateClass).toBe("gate");
      } else {
        expect(["trend", "reference"]).toContain(row!.gateClass);
      }
```

and rename the test title to `"every workload row carries a gateClass and has ghaMax === 'tbd-c2' or 'skipped'"`.

(c) Delete the test `S7-a, S7-b, S7-c carry linuxOnlyGate (spec § 3.3)` (L55-60) entirely (the partition test in Task 1 already covers S7's classification).

(d) Delete the test `S1, S11-b carry linuxOnlyGate (latency spawn-jitter, gated on Linux only)` (L86-91) entirely.

(e) Rewrite the exact-row snapshot test `S1 row matches spec § 3.2 exactly` (L69-84) to drop `gated`/`linuxOnlyGate` and add `gateClass`:

```ts
  test("S1 row matches spec § 3.2 exactly", () => {
    const s1 = SLO_THRESHOLDS.find((r) => r.surfaceId === "S1");
    expect(s1).toEqual({
      surfaceId: "S1",
      gateClass: "trend",
      metric: "p95_ms",
      refMax: 2_000,
      ghaMax: 10_000,
      noiseFloorPct: 25,
      noiseFloorAbs: 300,
      noiseFloorAbsUnit: "ms",
    } satisfies SloThreshold);
  });
```

(f) Rewrite the exact-row snapshot test `S2-a row matches spec § 3.2 exactly` (L93-105):

```ts
  test("S2-a row matches spec § 3.2 exactly", () => {
    const s2a = SLO_THRESHOLDS.find((r) => r.surfaceId === "S2-a");
    expect(s2a).toEqual({
      surfaceId: "S2-a",
      gateClass: "gate",
      metric: "p95_ms",
      refMax: 30,
      ghaMax: 200,
      noiseFloorPct: 25,
      noiseFloorAbs: 5,
      noiseFloorAbsUnit: "ms",
    } satisfies SloThreshold);
  });
```

(g) In `threshold-comparator.test.ts`, the inline `floorRow` fixture (L143-152) sets `gated: true` and is typed `SloThreshold`. Replace it with a `gateClass`-bearing literal:

```ts
  const floorRow: SloThreshold = {
    surfaceId: "S6-drive",
    gateClass: "gate",
    metric: "throughput_per_sec",
    refMax: 100,
    ghaMax: 60,
    noiseFloorPct: 25,
    noiseFloorAbs: 5,
    noiseFloorAbsUnit: "items_per_sec",
  };
```

(This fixture is used by the `compareAgainstHistory — floor metrics` describe block, which passes `[floorRow]` and asserts `absolute-fail`/`delta-fail` on `gha-ubuntu`. With `gateClass: "gate"`, `classifySkip` does NOT skip it on `gha-ubuntu` — the `throughput_per_sec` floor-metric absolute/delta logic still runs — so those tests stay green. Note `ghaMax: 60` is a number, not `"tbd-c2"`, so the tbd-c2 skip does not fire.)

- [ ] **Step 2: Run, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/slo-thresholds.test.ts src/perf/threshold-comparator.test.ts`. Expected: the two exact-row `toEqual` snapshots fail because the actual rows STILL contain `gated`/`linuxOnlyGate` (not yet removed from `slo-thresholds.ts`), so `toEqual` reports extra keys `gated` and (for S1) `linuxOnlyGate` in `received`.

- [ ] **Step 3: Remove the fields from the source.** In `packages/gateway/src/perf/slo-thresholds.ts`:

Remove `gated: boolean;` (L14) and `linuxOnlyGate?: true;` (L18) from the interface:

```ts
export interface SloThreshold {
  surfaceId: BenchSurfaceId;
  gateClass: "gate" | "trend" | "reference";
  metric:
    | "p95_ms"
    | "p50_ms"
    | "throughput_per_sec"
    | "rss_bytes_p95"
    | "tokens_per_sec"
    | "first_token_ms";
  refMax?: number;
  ghaMax: number | "tbd-c2" | "skipped";
  noiseFloorPct: number;
  noiseFloorAbs: number;
  noiseFloorAbsUnit: "ms" | "items_per_sec" | "bytes" | "tps";
}
```

Then delete every `gated: ...,` line and every `linuxOnlyGate: true,` line from all rows in `NON_S8_THRESHOLDS` and from the `buildS8Cells()` pushed object. There are 17 `gated:` occurrences (one per `NON_S8_THRESHOLDS` row) + 1 in `buildS8Cells`, and 5 `linuxOnlyGate: true,` occurrences (S1, S11-b, S7-a, S7-b, S7-c). After this the S1 row reads:

```ts
  {
    surfaceId: "S1",
    gateClass: "trend",
    metric: "p95_ms",
    refMax: 2_000,
    ghaMax: 10_000,
    noiseFloorPct: 25,
    // ... (keep the existing explanatory comment block, but its references to
    // "linuxOnlyGate" are now stale — trim the comment to describe the trend
    // classification, see below)
    noiseFloorAbs: 300,
    noiseFloorAbsUnit: "ms",
  },
```

Also fix the now-stale prose comments that name `linuxOnlyGate`: in the S1 comment (L36-37) and the S11-b comment (L124-127), replace the "gated on Linux only (linuxOnlyGate)" phrasing with "trend-class: charted on every runner, gated only on the reference-m1air run (see gateClass)". Exact replacement for the S1 comment tail (currently L36-37):

```ts
    // like the S7 memory surfaces — S1 is trend-class: charted on every runner
    // but gated only on the consistent-hardware reference-m1air run.
```

and for the S11-b comment tail (currently L124-127):

```ts
    // property, not a code signal, so S11-b is trend-class (charted on every
    // runner, gated only on the reference-m1air run via refMax). The 900 ms
    // ceiling + 40 % floor apply there to catch a true >=2x spawn regression.
```

The `buildS8Cells()` object after removal:

```ts
      out.push({
        surfaceId: `S8-l${length}-b${batch}`,
        gateClass: "gate",
        metric: "throughput_per_sec",
        ghaMax: "tbd-c2",
        noiseFloorPct: 25,
        noiseFloorAbs: 5,
        noiseFloorAbsUnit: "items_per_sec",
      });
```

- [ ] **Step 4: Run, expect PASS.** Command: `cd packages/gateway && bun test src/perf/slo-thresholds.test.ts src/perf/threshold-comparator.test.ts`. Expected: `0 fail`. Then run the full perf suite to confirm no other consumer broke: `cd packages/gateway && bun test src/perf/`. Expected: `0 fail`.

- [ ] **Step 5: Typecheck + lint.** `cd packages/gateway && bun run typecheck`. Expected: no errors. This is the key gate — any remaining reference to `.gated` or `.linuxOnlyGate` anywhere in the package now fails the compile (confirms Task 2 removed the production reads). `bunx biome check packages/gateway/src/perf/slo-thresholds.ts packages/gateway/src/perf/slo-thresholds.test.ts packages/gateway/src/perf/threshold-comparator.test.ts` — expected no diagnostics.

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/slo-thresholds.ts packages/gateway/src/perf/slo-thresholds.test.ts packages/gateway/src/perf/threshold-comparator.test.ts
git commit -m "$(cat <<'EOF'
refactor(perf): remove redundant gated + linuxOnlyGate fields

gateClass is now the single source of truth for where a surface gates, so the
gated:boolean and linuxOnlyGate?:true flags are dead. Drop both from the
SloThreshold interface, every row, and the inline test fixtures; fix the exact-
row snapshots and the gated/linuxOnlyGate assertions to read gateClass. tsc
confirms no remaining .gated/.linuxOnlyGate reads.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Trimmed-pool p95 in `buildLatencyResult`

**Files:**

- Modify `packages/gateway/src/perf/bench-harness.ts` (add `poolTrimmedSamples` helper; rewrite `buildLatencyResult` L79-107; check/remove the now-unused `median` import path L11-21)
- Test: `packages/gateway/src/perf/bench-harness.test.ts` (existing `invokes the surface fn ... returns median-of-medians` test L5-21 changes meaning; add new pooled/trim/stability tests)

Replace the median-of-per-run-p95 latency aggregation with a single p95 over a pooled, run-level-outlier-trimmed sample set, per spec § 4.2. The `median()` helper is still used by `buildThroughputResult`, so it stays — only the latency path stops calling it.

- [ ] **Step 1: Write the failing tests.** Replace the existing first test in `bench-harness.test.ts` (L5-21, `invokes the surface fn ... returns median-of-medians`) and add the new pooled/trim/stability tests. Replace L5-21 with:

```ts
  test("invokes the surface fn `runs` times and returns a pooled p95", async () => {
    let calls = 0;
    const fn = async (): Promise<number[]> => {
      calls += 1;
      return Array.from({ length: 100 }, (_, i) => i + calls);
    };
    const result = await runBench("S2-a", fn, {
      runs: 5,
      runner: "local-dev",
      corpus: "small",
    });
    expect(calls).toBe(5);
    expect(result.surfaceId).toBe("S2-a");
    expect(result.samplesCount).toBe(500);
    // Worst run (calls=5, values 6..105) is trimmed; pool is runs 1..4 (values 1..104).
    expect(result.p95Ms).toBeGreaterThan(90);
    expect(result.p95Ms).toBeLessThan(105);
  });
```

Then append a new `describe` block to the file:

```ts
import { poolTrimmedSamples } from "./bench-harness.ts";
```

(Add `poolTrimmedSamples` to the existing top-of-file import: change `import { runBench } from "./bench-harness.ts";` to `import { poolTrimmedSamples, runBench } from "./bench-harness.ts";`.)

```ts
describe("poolTrimmedSamples", () => {
  test("with fewer than 3 non-empty runs, returns all samples flattened (no trim)", () => {
    expect(poolTrimmedSamples([[1, 2], [3, 4]])).toEqual([1, 2, 3, 4]);
    expect(poolTrimmedSamples([[1, 2]])).toEqual([1, 2]);
  });

  test("filters out empty runs before counting toward the trim threshold", () => {
    // 2 non-empty runs + an empty one → still < 3 non-empty → no trim, empties dropped.
    expect(poolTrimmedSamples([[1, 2], [], [3, 4]])).toEqual([1, 2, 3, 4]);
  });

  test("with >=3 non-empty runs, drops the single worst run (highest per-run p95)", () => {
    // Run C's p95 (~1000) is the highest; it is dropped, leaving A+B pooled.
    const a = [1, 2, 3, 4, 5];
    const b = [2, 3, 4, 5, 6];
    const c = [900, 950, 1000, 1000, 1000];
    const pooled = poolTrimmedSamples([a, b, c]);
    expect(pooled.sort((x, y) => x - y)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(pooled).not.toContain(1000);
  });

  test("a single catastrophically-contended run does not enter the pooled p95", async () => {
    // 4 calm runs + 1 disk-thrash run; the thrash run is trimmed → stable aggregate.
    const calm = Array.from({ length: 100 }, (_, i) => 10 + i * 0); // all 10ms
    const runs = [calm, calm, calm, calm, Array(100).fill(100_000)];
    const pooled = poolTrimmedSamples(runs);
    expect(pooled).not.toContain(100_000);
    expect(pooled.length).toBe(400);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/bench-harness.test.ts`. Expected: `poolTrimmedSamples` is not exported → TypeScript error `Module '"./bench-harness.ts"' has no exported member 'poolTrimmedSamples'`, and the rewritten first test fails because the current median-of-per-run-p95 path produces a different number (the median of the five per-run p95 values, which equals the 3rd run's p95 ≈ 98, not the trimmed-pool p95). The new `describe("poolTrimmedSamples")` tests fail to even resolve the import.

- [ ] **Step 3: Implement the helper and rewrite `buildLatencyResult`.** Edit `packages/gateway/src/perf/bench-harness.ts`.

Add the exported helper (place it after the `median` function, before `RunBenchDeps`):

```ts
/**
 * Pool per-run samples for the latency aggregate, dropping the single worst run.
 * One catastrophically-contended run (disk thrash / network hang spiking *all*
 * its samples) would otherwise skew the pooled p95, so with >=3 non-empty runs we
 * rank runs by their own p95 and discard the highest before flattening. With
 * fewer than 3 non-empty runs there is too little to trim, so we pool everything.
 */
export function poolTrimmedSamples(perRunSamples: number[][]): number[] {
  const runs = perRunSamples.filter((r) => r.length > 0);
  if (runs.length < 3) {
    return runs.flat();
  }
  const ranked = [...runs].sort((a, b) => {
    const pa = computePercentiles(a).p95 ?? Number.POSITIVE_INFINITY;
    const pb = computePercentiles(b).p95 ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  return ranked.slice(0, -1).flat();
}
```

Rewrite `buildLatencyResult` (L79-107) to use the pooled samples:

```ts
function buildLatencyResult(
  surfaceId: BenchSurfaceId,
  perRunSamples: number[][],
  totalSamples: number,
): BenchSurfaceResult {
  const pooled = poolTrimmedSamples(perRunSamples);
  const p = computePercentiles(pooled);
  return {
    surfaceId,
    samplesCount: totalSamples,
    ...(p.p50 !== undefined && { p50Ms: p.p50 }),
    ...(p.p95 !== undefined && { p95Ms: p.p95 }),
    ...(p.p99 !== undefined && { p99Ms: p.p99 }),
    ...(p.max !== undefined && { maxMs: p.max }),
  };
}
```

Now check the `median` import: `median` is a local function (L11-21), NOT an import — it is still referenced by `buildThroughputResult` (L51, L56). So it stays. There is no `median` *import* to remove (the contract's "remove unused median import" guard applies only if it had become unused; here `buildThroughputResult` still uses it, so leave it). Confirm with biome in Step 5 — if biome reports `median` as unused (it will not, given `buildThroughputResult`), only then remove it.

- [ ] **Step 4: Run, expect PASS.** Command: `cd packages/gateway && bun test src/perf/bench-harness.test.ts`. Expected: `0 fail`. Verify specifically that the `resultKind` block (L59-86) still passes — `'throughput' kind populates throughputPerSec from per-run medians` (L68-74) is unaffected (it exercises `buildThroughputResult`, which still uses `median`), and `default 'latency' behaviour` (L60-66) with `runs: 3` over `[10,20,30,40,50]` now pools the 2 best of 3 runs and yields a defined `p50Ms` (still `> 0`). Expected tail: `0 fail`.

- [ ] **Step 5: Typecheck + lint.** `cd packages/gateway && bun run typecheck`. Expected: no errors. `bunx biome check packages/gateway/src/perf/bench-harness.ts packages/gateway/src/perf/bench-harness.test.ts`. Expected: no diagnostics — in particular confirm biome does NOT flag `median` as unused (it is still used by `buildThroughputResult`).

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/bench-harness.ts packages/gateway/src/perf/bench-harness.test.ts
git commit -m "$(cat <<'EOF'
fix(perf): trimmed-pool p95 latency aggregate (drop the worst run, then pool)

buildLatencyResult reported the median of per-run p95s (max-like, volatile).
Replace with poolTrimmedSamples: with >=3 non-empty runs rank by per-run p95,
drop the single worst, flatten the rest, and compute one p95 over the pool;
fewer than 3 runs pool everything. Aligns latency with the RSS surface and
absorbs a single catastrophically-contended run. Keeps the p95_ms meaning.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Bump `schema_version` 1 → 2 in `history-line.ts`

**Files:**

- Modify `packages/gateway/src/perf/history-line.ts` (interface literal type L22)
- Modify every constructed `HistoryLine` literal that hard-codes `schema_version: 1` — the test fixtures in `threshold-comparator.test.ts` (L13, `fakeLine`) and `bench-ci.test.ts` (L16, `passingLine`)
- Test: `packages/gateway/src/perf/history-line.test.ts` (if it exists; otherwise the typecheck across the package is the gate)

The trimmed-pool p95 (Task 4) makes old aggregates non-comparable, so bump the schema version and reset trend history per spec § 4.2. The literal type narrows to `2`, which forces every constructor to update — tsc finds them all.

- [ ] **Step 1: Find every `schema_version` constructor and write/adjust a test.** First confirm whether a dedicated test file exists and locate all literals. Command: `cd packages/gateway && bun test src/perf/ 2>&1 | head -5` is not the discovery step — instead grep is already known: the literal `schema_version: 1` appears in `threshold-comparator.test.ts` L13 and `bench-ci.test.ts` L16. Add an explicit version-pinning test. If `packages/gateway/src/perf/history-line.test.ts` does not exist, create it:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistoryLine, type HistoryLine } from "./history-line.ts";

describe("history-line schema_version", () => {
  test("a constructed HistoryLine pins schema_version to 2", () => {
    const line: HistoryLine = {
      schema_version: 2,
      run_id: "r",
      timestamp: "2026-06-14T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04",
      nimbus_git_sha: "abc",
      bun_version: "1.3.14",
      surfaces: {},
    };
    expect(line.schema_version).toBe(2);
  });

  test("appendHistoryLine round-trips a v2 line to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "history-line-"));
    try {
      const path = join(dir, "run-history.jsonl");
      const line: HistoryLine = {
        schema_version: 2,
        run_id: "r",
        timestamp: "2026-06-14T00:00:00Z",
        runner: "gha-ubuntu",
        os_version: "ubuntu-24.04",
        nimbus_git_sha: "abc",
        bun_version: "1.3.14",
        surfaces: { "S2-a": { samples_count: 100, p95_ms: 12 } },
      };
      appendHistoryLine(path, line);
      const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as HistoryLine;
      expect(parsed.schema_version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/history-line.test.ts`. Expected: TypeScript error — `Type 'number' is not assignable to type '1'` on `schema_version: 2` (the interface literal type is still `1`). The test does not compile.

- [ ] **Step 3: Bump the literal type.** In `packages/gateway/src/perf/history-line.ts`, change L22:

```ts
export interface HistoryLine {
  schema_version: 2;
```

There is no constructed `HistoryLine` object literal inside `history-line.ts` itself (only the interface), so no other in-file change. The constructors live in the test files (next step) and in the bench-runner that emits history — verify no production emitter hard-codes `schema_version: 1`. Command: `cd packages/gateway && bun run typecheck` will list every literal that must change.

- [ ] **Step 4: Fix the test-fixture constructors and re-run.** Update the two known fixtures:
  - `packages/gateway/src/perf/threshold-comparator.test.ts` L13: change `schema_version: 1,` to `schema_version: 2,` inside `fakeLine`.
  - `packages/gateway/src/perf/bench-ci.test.ts` L16: change `schema_version: 1,` to `schema_version: 2,` inside `passingLine`.

  If `bun run typecheck` (Step 3) surfaced any additional `schema_version: 1` literal in a production emitter (e.g. a bench-runner that builds the `HistoryLine`), change it to `2` as well. Then run: `cd packages/gateway && bun test src/perf/`. Expected: `0 fail` across the whole perf suite.

- [ ] **Step 5: Typecheck + lint.** `cd packages/gateway && bun run typecheck`. Expected: no errors (the literal-type narrowing has no remaining `1` constructors). `bunx biome check packages/gateway/src/perf/history-line.ts packages/gateway/src/perf/history-line.test.ts packages/gateway/src/perf/threshold-comparator.test.ts packages/gateway/src/perf/bench-ci.test.ts`. Expected: no diagnostics.

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/history-line.ts packages/gateway/src/perf/history-line.test.ts packages/gateway/src/perf/threshold-comparator.test.ts packages/gateway/src/perf/bench-ci.test.ts
git commit -m "$(cat <<'EOF'
feat(perf)!: bump HistoryLine schema_version 1 -> 2 (trimmed-pool p95 reset)

The trimmed-pool p95 latency aggregate makes pre-existing p95 history non-
comparable, so reset the trend baseline by bumping the schema literal type to
2. tsc narrows every constructor; fixtures updated.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Event-aware exit in `bench-ci.ts`

**Files:**

- Modify `packages/gateway/src/perf/bench-ci.ts` (`runBenchCiMain` L155-190 — insert the push-only short-circuit just before `return decideExit(comparisons);` at L189)
- Test: `packages/gateway/src/perf/bench-ci.test.ts` (add a test proving a `gate`-class delta-fail on a `push` event returns 0; existing tests already prove PR gating)

On a `push` to `main` there is no PR to attribute a regression to, so the run publishes the baseline + feeds the trend and never gates. PRs still gate (gate-class only, via `isFailingComparison`). The check is `env["GITHUB_EVENT_NAME"] !== "pull_request" → return 0`, placed after the comment/summary side effects so push runs still write the step summary.

- [ ] **Step 1: Write the failing test.** Append to `packages/gateway/src/perf/bench-ci.test.ts` (inside the existing `describe("runBenchCiMain", ...)` block, before its closing `});` on L290):

```ts
  test("gate-class delta-fail on a PUSH event returns 0 (publish-only, never gates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      // S2-a is gate-class; current 200ms vs baseline 50ms is a hard delta-fail.
      const current: HistoryLine = {
        ...passingLine,
        surfaces: { "S2-a": { samples_count: 500, p95_ms: 200 } },
      };
      const currentPath = writeHistory(dir, "current.jsonl", current);

      const runs = [{ databaseId: 1, headSha: "s1" }];
      const prevDir = join(dir, "prev");
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(prevDir, "s1"), { recursive: true });
      const baseline: HistoryLine = {
        ...passingLine,
        surfaces: { "S2-a": { samples_count: 500, p95_ms: 50 } },
      };
      await fs.writeFile(
        join(prevDir, "s1", "run-history.jsonl"),
        `${JSON.stringify(baseline)}\n`,
        "utf8",
      );

      const { spawn } = spawnSequence([
        { exitCode: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: "" }, // run list
        { exitCode: 0, stdout: "", stderr: "" }, // run download
      ]);
      const exit = await runBenchCiMain(
        ["--current", currentPath, "--runner", "gha-ubuntu", "--prev-dir", prevDir],
        { gh: new GhCli({ spawn, sleep: async () => {} }), env: { GITHUB_EVENT_NAME: "push" } },
      );
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate-class delta-fail on a PULL_REQUEST event returns 1 (gates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ci-"));
    try {
      const current: HistoryLine = {
        ...passingLine,
        surfaces: { "S2-a": { samples_count: 500, p95_ms: 200 } },
      };
      const currentPath = writeHistory(dir, "current.jsonl", current);

      const runs = [{ databaseId: 1, headSha: "s1" }];
      const prevDir = join(dir, "prev");
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(prevDir, "s1"), { recursive: true });
      const baseline: HistoryLine = {
        ...passingLine,
        surfaces: { "S2-a": { samples_count: 500, p95_ms: 50 } },
      };
      await fs.writeFile(
        join(prevDir, "s1", "run-history.jsonl"),
        `${JSON.stringify(baseline)}\n`,
        "utf8",
      );

      const { spawn } = spawnSequence([
        { exitCode: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: "" }, // run list
        { exitCode: 0, stdout: "", stderr: "" }, // run download
        { exitCode: 0, stdout: "[]\n", stderr: "" }, // pr comment list
        { exitCode: 0, stdout: "", stderr: "" }, // pr comment create
      ]);
      const exit = await runBenchCiMain(
        ["--current", currentPath, "--runner", "gha-ubuntu", "--prev-dir", prevDir],
        {
          gh: new GhCli({ spawn, sleep: async () => {} }),
          env: {
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_REPOSITORY: "asafgolombek/Nimbus",
            GITHUB_REF: "refs/pull/99/merge",
          },
        },
      );
      expect(exit).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run, expect FAIL.** Command: `cd packages/gateway && bun test src/perf/bench-ci.test.ts`. Expected: `gate-class delta-fail on a PUSH event returns 0` fails with `expect(received).toBe(expected)` — `received: 1`, `expected: 0`, because today `runBenchCiMain` returns `decideExit(comparisons)` unconditionally and the S2-a delta-fail (a `gate`-class surface after Task 2) gates regardless of event. The `PULL_REQUEST` companion test passes already.

  Note: this test depends on Task 2 (S2-a is `gate`-class) and Task 4 (the trimmed-pool aggregate does not change the fixture, which sets `p95_ms` directly on the surface) and Task 5 (`passingLine.schema_version === 2`). It is sequenced last in PR-1, so those are in place.

- [ ] **Step 3: Implement the push-only short-circuit.** In `packages/gateway/src/perf/bench-ci.ts`, edit the tail of `runBenchCiMain` (currently L176-189). After the PR-comment side-effect block and before the final return, add the guard:

```ts
  if (env["GITHUB_EVENT_NAME"] === "pull_request") {
    const pr = readPullRequestNumber(env);
    if (pr !== null) {
      try {
        await upsertComment(deps.gh, pr, runner, body, tmpRoot, env);
      } catch (err) {
        stderr(
          `bench-ci: comment upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Push-to-main publishes the baseline + feeds the trend; it has no PR to
  // attribute a regression to, so it never gates. Only pull_request events gate
  // (gate-class only, via isFailingComparison inside decideExit).
  if (env["GITHUB_EVENT_NAME"] !== "pull_request") return 0;

  return decideExit(comparisons);
}
```

- [ ] **Step 4: Run, expect PASS.** Command: `cd packages/gateway && bun test src/perf/bench-ci.test.ts`. Expected: `0 fail` — both new tests pass and every pre-existing `bench-ci` test stays green (the existing `UX absolute-fail on PR run → exits 1` test uses `GITHUB_EVENT_NAME: "pull_request"`, so it still reaches `decideExit`; the existing `push`-event tests already expected `0`). Then run the full perf suite: `cd packages/gateway && bun test src/perf/`. Expected: `0 fail`.

- [ ] **Step 5: Typecheck + lint.** `cd packages/gateway && bun run typecheck`. Expected: no errors. `bunx biome check packages/gateway/src/perf/bench-ci.ts packages/gateway/src/perf/bench-ci.test.ts`. Expected: no diagnostics.

- [ ] **Step 6: Commit.**

```bash
git add packages/gateway/src/perf/bench-ci.ts packages/gateway/src/perf/bench-ci.test.ts
git commit -m "$(cat <<'EOF'
feat(perf): event-aware exit — push-to-main publishes only, PRs gate

A push-to-main bench compares main-vs-main with no PR to attribute a regression
to, so a non-zero exit is pure red noise. Return 0 on any non-pull_request
event after writing the step summary / artifact; pull_request events still gate
(gate-class only, via decideExit -> isFailingComparison).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `emit-benchmark-json.ts` — pure HistoryLine → github-action-benchmark mapper + thin CLI

**Files:**

- Create: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\emit-benchmark-json.ts`
- Test: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\emit-benchmark-json.test.ts`

**Preconditions (from PR-1, already landed in this branch's earlier cluster):** `SloThreshold` has `gateClass: "gate" | "trend" | "reference"` (and `gated`/`linuxOnlyGate` removed); `HistoryLine.schema_version` is `2`. This task imports `SLO_THRESHOLDS` + `thresholdsBySurface` from `packages/gateway/src/perf/slo-thresholds.ts` and the `HistoryLine`/`HistoryLineSurface` types from `packages/gateway/src/perf/history-line.ts`. It does NOT modify those files.

**Contract for the mapper:**

- `BenchmarkPoint` = `{ name: string; unit: string; value: number }` (exact github-action-benchmark shape).
- `toBenchmarkPoints(line: HistoryLine): BenchmarkPoint[]` — for every surface whose threshold `gateClass === "trend"` AND whose metric is one of the two smaller-is-better trend surfaces this phase emits (`p95_ms` → unit `"ms"`; `rss_bytes_p95` → unit `"bytes"`), if the line carries a numeric value for that metric, emit one point. `name` = ``${surfaceId} ${metricLabel}`` where label is `"p95"` for `p95_ms` and `"rss_p95"` for `rss_bytes_p95`. Throughput trend surfaces (`throughput_per_sec`/`tokens_per_sec`) are deferred (customBiggerIsBetter file, Phase 2) and intentionally NOT emitted here.
- Stub surfaces (`samples_count === 0`) emit nothing (no numeric metric).
- Output is deterministic: iterate `SLO_THRESHOLDS` in declared order.

- [ ] **Step 1: Write the failing test (COMPLETE code).**

Create `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\emit-benchmark-json.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { toBenchmarkPoints } from "./emit-benchmark-json.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-14T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("toBenchmarkPoints", () => {
  test("emits a p95_ms point for a trend latency surface (S1)", () => {
    const points = toBenchmarkPoints(baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } }));
    expect(points).toEqual([{ name: "S1 p95", unit: "ms", value: 812.5 }]);
  });

  test("emits an rss_bytes_p95 point for a trend memory surface (S7-a)", () => {
    const points = toBenchmarkPoints(
      baseLine({ "S7-a": { samples_count: 5, rss_bytes_p95: 134_217_728 } }),
    );
    expect(points).toEqual([{ name: "S7-a rss_p95", unit: "bytes", value: 134_217_728 }]);
  });

  test("does NOT emit gate-class surfaces (S2-a) even with a p95_ms value", () => {
    const points = toBenchmarkPoints(baseLine({ "S2-a": { samples_count: 5, p95_ms: 12.3 } }));
    expect(points).toEqual([]);
  });

  test("does NOT emit reference-class surfaces (S2-c)", () => {
    const points = toBenchmarkPoints(baseLine({ "S2-c": { samples_count: 5, p95_ms: 250 } }));
    expect(points).toEqual([]);
  });

  test("does NOT emit throughput trend surfaces (S6-drive) — deferred this phase", () => {
    const points = toBenchmarkPoints(
      baseLine({ "S6-drive": { samples_count: 5, throughput_per_sec: 42 } }),
    );
    expect(points).toEqual([]);
  });

  test("skips a stub surface (samples_count===0, no metric value)", () => {
    const points = toBenchmarkPoints(baseLine({ S4: { samples_count: 0, stub_reason: "stub" } }));
    expect(points).toEqual([]);
  });

  test("skips a trend surface whose metric value is absent", () => {
    const points = toBenchmarkPoints(baseLine({ S1: { samples_count: 5 } }));
    expect(points).toEqual([]);
  });

  test("emits multiple points in SLO_THRESHOLDS declared order", () => {
    const points = toBenchmarkPoints(
      baseLine({
        "S7-a": { samples_count: 5, rss_bytes_p95: 100 },
        S1: { samples_count: 5, p95_ms: 800 },
        S10: { samples_count: 5, throughput_per_sec: 999 },
      }),
    );
    // S1 (p95_ms) precedes S7-a in SLO_THRESHOLDS; S10 is throughput → omitted.
    expect(points).toEqual([
      { name: "S1 p95", unit: "ms", value: 800 },
      { name: "S7-a rss_p95", unit: "bytes", value: 100 },
    ]);
  });

  test("ignores a non-finite metric value", () => {
    const points = toBenchmarkPoints(
      baseLine({ S1: { samples_count: 5, p95_ms: Number.POSITIVE_INFINITY } }),
    );
    expect(points).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && bun test scripts/perf/emit-benchmark-json.test.ts
```

Expected: fail to resolve `./emit-benchmark-json.ts` (module not found) — `error: Cannot find module './emit-benchmark-json.ts'`. (The implementation file does not exist yet.)

- [ ] **Step 3: Write the implementation (COMPLETE code).**

Create `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\emit-benchmark-json.ts`:

```ts
#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import type { HistoryLine, HistoryLineSurface } from "../../packages/gateway/src/perf/history-line.ts";
import { SLO_THRESHOLDS, thresholdsBySurface } from "../../packages/gateway/src/perf/slo-thresholds.ts";

/** A github-action-benchmark `customSmallerIsBetter` data point. */
export interface BenchmarkPoint {
  name: string;
  unit: string;
  value: number;
}

/**
 * Smaller-is-better trend metrics emitted this phase. Throughput trend surfaces
 * (`throughput_per_sec` / `tokens_per_sec`) are bigger-is-better and deferred to
 * a separate `customBiggerIsBetter` file (Phase 2) — intentionally not here.
 */
const TREND_METRICS: ReadonlyArray<{
  metric: "p95_ms" | "rss_bytes_p95";
  field: keyof HistoryLineSurface;
  label: string;
  unit: string;
}> = [
  { metric: "p95_ms", field: "p95_ms", label: "p95", unit: "ms" },
  { metric: "rss_bytes_p95", field: "rss_bytes_p95", label: "rss_p95", unit: "bytes" },
];

/**
 * Map the latest HistoryLine into github-action-benchmark points for every
 * `trend`-class surface that carries a finite smaller-is-better metric value.
 * Deterministic: iterates `SLO_THRESHOLDS` in declared order.
 */
export function toBenchmarkPoints(line: HistoryLine): BenchmarkPoint[] {
  const bySurface = thresholdsBySurface();
  const out: BenchmarkPoint[] = [];
  for (const slo of SLO_THRESHOLDS) {
    if (bySurface.get(slo.surfaceId)?.gateClass !== "trend") continue;
    const surface = line.surfaces[slo.surfaceId];
    if (surface === undefined || surface.samples_count === 0) continue;
    for (const trend of TREND_METRICS) {
      if (trend.metric !== slo.metric) continue;
      const raw = surface[trend.field];
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      out.push({ name: `${slo.surfaceId} ${trend.label}`, unit: trend.unit, value: raw });
    }
  }
  return out;
}

function parseLastHistoryLine(text: string): HistoryLine {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("run-history.jsonl is empty");
  }
  return JSON.parse(last) as HistoryLine;
}

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export async function runEmitBenchmarkJsonMain(args: string[]): Promise<number> {
  const inPath = takeFlag(args, "--in");
  const outPath = takeFlag(args, "--out");
  if (inPath === undefined || outPath === undefined) {
    process.stderr.write("usage: emit-benchmark-json.ts --in <run-history.jsonl> --out <points.json>\n");
    return 2;
  }
  const text = await Bun.file(inPath).text();
  const line = parseLastHistoryLine(text);
  const points = toBenchmarkPoints(line);
  writeFileSync(outPath, `${JSON.stringify(points, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${points.length} trend point(s) to ${outPath}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runEmitBenchmarkJsonMain(process.argv.slice(2));
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && bun test scripts/perf/emit-benchmark-json.test.ts
```

Expected: `10 pass, 0 fail` (9 mapper assertions across 9 `test(...)` blocks; count is the number of `test` blocks = 9 — confirm all green, 0 fail).

- [ ] **Step 5: Typecheck + lint.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy/packages/gateway && bun run typecheck
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && bunx biome check scripts/perf/emit-benchmark-json.ts scripts/perf/emit-benchmark-json.test.ts
```

Expected: `tsc --noEmit` exits 0 (no errors). Biome reports `Checked 2 files` with no diagnostics. (No `any`, no unused imports — `writeFileSync` is used by the CLI, `HistoryLineSurface` by `TREND_METRICS`.) If biome flags import ordering, run `bunx biome check --write scripts/perf/emit-benchmark-json.ts scripts/perf/emit-benchmark-json.test.ts` and re-run the check.

- [ ] **Step 6: Commit.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && git add scripts/perf/emit-benchmark-json.ts scripts/perf/emit-benchmark-json.test.ts && git commit -m "$(cat <<'EOF'
feat(perf): emit github-action-benchmark JSON for trend-class surfaces

Pure toBenchmarkPoints(HistoryLine) maps every trend-class p95_ms/
rss_bytes_p95 surface to a customSmallerIsBetter {name,unit,value} point,
plus a thin --in/--out CLI reading the last run-history.jsonl line.
Throughput trend surfaces deferred (bigger-is-better, Phase 2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `_perf.yml` — push-only github-action-benchmark trend step

**Files:**

- Modify: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\.github\workflows\_perf.yml` (insert two steps immediately after the `Upload run history artifact` step, currently lines 164–175; before the `Compare + post PR-comment delta` step at line 177).

No unit test (workflow YAML). Verification is `bunx actionlint` + a Bun YAML parse.

The new steps are gated on `github.event_name == 'push'` (push-to-main only; the trend dashboard is fed from the canonical main baseline, never from PRs or nightly schedules). The first new step runs the Task-7 emitter to produce `${RUNNER_TEMP}/benchmark.json`; the second feeds it to `github-action-benchmark@v1`.

- [ ] **Step 1: Add the `actions: write` + `contents: write` permission needed for `auto-push` to the orphan branch.**

The `benchmark` job currently grants (lines 76–79):

```yaml
    permissions:
      contents: read
      pull-requests: write   # for `gh pr comment` upsert in bench-ci.ts
      actions: read          # for `gh run list` + `gh run view` + `gh run download`
```

`github-action-benchmark` with `auto-push: true` pushes commits to the `perf-data` branch, which requires `contents: write`. Edit the block to:

```yaml
    permissions:
      contents: write        # `github-action-benchmark` auto-push to the `perf-data` orphan branch (push events only)
      pull-requests: write   # for `gh pr comment` upsert in bench-ci.ts
      actions: read          # for `gh run list` + `gh run view` + `gh run download`
```

(Exact edit: change the single line `contents: read` within that block to `contents: write        # github-action-benchmark auto-push to the perf-data orphan branch (push events only)`. The `detect-trigger` job's `contents: read` at lines 40–41 is unchanged.)

- [ ] **Step 2: Insert the two new steps after `Upload run history artifact`.**

The `Upload run history artifact` step ends at line 175 (`retention-days: 90`). The `Compare + post PR-comment delta` step begins at line 177. Insert the following YAML between them (i.e. after line 175, before line 177), preserving the existing blank line:

```yaml
      # Push-to-main only: feed the trend-class p95/RSS surfaces to the
      # github-action-benchmark dashboard on the orphan `perf-data` branch.
      # Advisory only (fail-on-alert: false) — gating lives in the Compare
      # step (PR events) and the M1-Air reference cron. Never runs on PRs or
      # nightly schedules, so the dashboard tracks the canonical main baseline.
      - name: Emit trend benchmark JSON
        if: github.event_name == 'push'
        shell: bash
        run: |
          set -euo pipefail
          bun scripts/perf/emit-benchmark-json.ts \
            --in "${RUNNER_TEMP}/run-history.jsonl" \
            --out "${RUNNER_TEMP}/benchmark.json"

      - name: Publish to github-action-benchmark trend dashboard
        if: github.event_name == 'push'
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: customSmallerIsBetter
          output-file-path: ${{ runner.temp }}/benchmark.json
          gh-pages-branch: perf-data
          benchmark-data-dir-path: dev/bench
          auto-push: true
          fail-on-alert: false
          comment-on-alert: true
          alert-threshold: "200%"
          max-items-in-chart: 500
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

After this edit, the step order in the `benchmark` job is: Run bench → Upload run history artifact → **Emit trend benchmark JSON** → **Publish to github-action-benchmark trend dashboard** → Compare + post PR-comment delta.

- [ ] **Step 3: Verify with actionlint.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && bunx actionlint .github/workflows/_perf.yml
```

Expected: exits 0 with no output (clean). If `bunx actionlint` cannot fetch the binary in this environment, fall back to the system `actionlint` if present (`actionlint .github/workflows/_perf.yml`). Either way the expected result is no diagnostics.

Note: actionlint does not pin third-party action SHAs, but this repo elsewhere pins actions to commit SHAs (see `harden-runner`/`checkout` above). `benchmark-action/github-action-benchmark@v1` is intentionally tag-pinned here to match the spec §4.4; if the repo's Scorecard/pin-check gate flags it in CI, re-pin to the matching commit SHA for the `v1` tag and append `# v1` — keep the `with:` block identical.

- [ ] **Step 4: Verify the file parses as valid YAML and the two new steps + permission edit are present.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && bun -e '
import { parse } from "yaml";
const doc = parse(await Bun.file(".github/workflows/_perf.yml").text());
const steps = doc.jobs.benchmark.steps.map((s) => s.name);
const perms = doc.jobs.benchmark.permissions;
const emit = doc.jobs.benchmark.steps.find((s) => s.name === "Publish to github-action-benchmark trend dashboard");
if (!steps.includes("Emit trend benchmark JSON")) throw new Error("missing emit step");
if (emit?.uses !== "benchmark-action/github-action-benchmark@v1") throw new Error("wrong action ref");
if (emit?.if !== "github.event_name == '"'"'push'"'"'") throw new Error("step not push-gated: " + emit?.if);
if (emit?.with["gh-pages-branch"] !== "perf-data") throw new Error("wrong branch");
if (emit?.with["max-items-in-chart"] !== 500) throw new Error("wrong max-items");
if (emit?.with["fail-on-alert"] !== false) throw new Error("fail-on-alert must be false");
if (perms.contents !== "write") throw new Error("contents perm not write: " + perms.contents);
console.log("OK steps:", steps.join(" | "));
'
```

Expected output: a single line `OK steps: Harden Runner | Checkout | Setup Bun and install dependencies | Linux — libsecret + D-Bus (gateway vault init) | macOS — Strip quarantine from native SQLite extensions | macOS — Create and unlock CI Keychain (gateway vault init) | Derive runner id | Run bench | Upload run history artifact | Emit trend benchmark JSON | Publish to github-action-benchmark trend dashboard | Compare + post PR-comment delta` and exit 0. (Uses the `yaml` package already in the repo's lockfile; if unavailable, substitute `Bun.YAML.parse` once on Bun ≥1.2.20, otherwise install with `bun add -d yaml` is NOT needed — `yaml` is a transitive dep. If the import fails, the simpler check `bun -e 'await Bun.file(".github/workflows/_perf.yml").text()'` plus a manual `bunx actionlint` from Step 3 is the floor.)

- [ ] **Step 5: Commit.**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy && git add .github/workflows/_perf.yml && git commit -m "$(cat <<'EOF'
ci(perf): publish trend-class surfaces to github-action-benchmark on push

Push-to-main only: emit-benchmark-json.ts -> github-action-benchmark@v1
on the perf-data orphan branch (dev/bench dashboard). Advisory only
(fail-on-alert false, comment-on-alert true, 200% alert, 500 chart cap);
auto-push needs contents:write. PRs/nightly schedules skip it so the
dashboard tracks the canonical main baseline. Verified via actionlint.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

**Notes for the executing session:**

- Task 7 depends on PR-1 having landed `gateClass` on `SloThreshold` and `schema_version: 2` on `HistoryLine`. If those are not yet on the branch, the test's `schema_version: 2` literal and the `gateClass === "trend"` filter will not typecheck/behave correctly. Verify with `grep -n "gateClass" packages/gateway/src/perf/slo-thresholds.ts` before starting.
- The emitter reads `${RUNNER_TEMP}/run-history.jsonl` — the exact path `_perf.yml`'s `Run bench` and `Upload run history artifact` steps already write/consume (lines 161, 174). The trend step is inserted between the upload and the compare so it runs on the freshly-written file without a re-download.
- `scripts/perf/` is a new directory created by this cluster's first file write (Task 7); no pre-existing files there.

**Key file facts confirmed:** `_perf.yml` `benchmark` job steps span lines 89–190; the artifact-upload step (164–175) and compare step (177–190) are the insertion anchors. `HistoryLineSurface` exposes `p95_ms?`/`rss_bytes_p95?`/`samples_count` (history-line.ts:6–19). `SLO_THRESHOLDS` + `thresholdsBySurface()` are the public exports from slo-thresholds.ts:231–235; the `metric` union includes `"p95_ms"` and `"rss_bytes_p95"`. The trend partition per the spec §3 table (`trend` = S1, S4, S6-*, S7-a/b, S10, S11-a/b) is the set the emitter filters to via `gateClass === "trend"`, of which only `p95_ms` (S1, S11-a, S11-b, and S4 when implemented) and `rss_bytes_p95` (S7-a, S7-b) surfaces are emitted this phase.

---

### Task 9: `scripts/perf/drift-check.ts` — pure `detectDrift` + gh-issue upsert wrapper

**Files:**

- Create: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\drift-check.ts`
- Test: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\drift-check.test.ts`

The pure core `detectDrift(history, noiseFloorPct, k=7, n=3)` is fully unit-tested. The I/O wrapper (`runDriftCheckMain`) that reads recent `main` run values and upserts one gh issue per drifting surface via `Bun.spawn` is described and implemented in full, but is NOT unit-tested (gh is not invoked in tests).

- [ ] **Step 1: Write the failing test for the pure `detectDrift` core.**

  Create `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\drift-check.test.ts` with the complete contents:

  ```ts
  import { describe, expect, test } from "bun:test";

  import { detectDrift } from "./drift-check.ts";

  describe("detectDrift", () => {
    test("returns false when there is not enough history to fill the window", () => {
      // Fewer than k samples => no rolling median => never drifting.
      expect(detectDrift([{ value: 100 }, { value: 100 }], 10)).toBe(false);
    });

    test("a single late spike does NOT trip drift (needs n consecutive worse samples)", () => {
      // Rolling median of the first 7 stable samples is 100; only the very last
      // sample is worse, so the consecutive-worse run length is 1 (< n=3).
      const history = [
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 200 },
      ];
      expect(detectDrift(history, 10)).toBe(false);
    });

    test("a sustained regression (n consecutive samples worse than the rolling median) trips drift", () => {
      // Stable at 100, then 3 consecutive samples well above the +10% floor.
      const history = [
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 200 },
        { value: 200 },
        { value: 200 },
      ];
      expect(detectDrift(history, 10)).toBe(true);
    });

    test("worse-but-within-the-noise-floor does not trip drift", () => {
      // Each tail sample is only +5% over the rolling median; floor is 10%.
      const history = [
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 105 },
        { value: 105 },
        { value: 105 },
      ];
      expect(detectDrift(history, 10)).toBe(false);
    });

    test("a worse sample that breaks the consecutive run resets the counter", () => {
      // worse, worse, then back-to-baseline, then worse — never 3 in a row.
      const history = [
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 200 },
        { value: 200 },
        { value: 100 },
        { value: 200 },
      ];
      expect(detectDrift(history, 10)).toBe(false);
    });

    test("the rolling median is over the last k samples, not the whole history", () => {
      // First 6 samples are huge outliers; the window slides past them so the
      // effective median for the tail is the recent ~100 plateau, making the
      // 200-tail a real regression.
      const history = [
        { value: 9000 },
        { value: 9000 },
        { value: 9000 },
        { value: 9000 },
        { value: 9000 },
        { value: 9000 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 200 },
        { value: 200 },
        { value: 200 },
      ];
      expect(detectDrift(history, 10)).toBe(true);
    });

    test("honors a custom k and n", () => {
      // k=3 window, n=2 consecutive: median of [100,100,100]=100, then two
      // +50% samples in a row trip with the smaller n.
      const history = [
        { value: 100 },
        { value: 100 },
        { value: 100 },
        { value: 150 },
        { value: 150 },
      ];
      expect(detectDrift(history, 10, 3, 2)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm it FAILS.**

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bun test scripts/perf/drift-check.test.ts
  ```

  Expected: the run fails to resolve the import — `error: Cannot find module './drift-check.ts'` (or, once the file exists with a stub, `detectDrift is not a function`). No tests pass.

- [ ] **Step 3: Create `scripts/perf/drift-check.ts` with the pure core plus the (un-tested) I/O wrapper.**

  Create `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\scripts\perf\drift-check.ts` with the complete contents:

  ```ts
  #!/usr/bin/env bun

  import { mkdirSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";

  import { GhCli } from "../../packages/gateway/src/perf/bench-ci-gh.ts";
  import type { HistoryLine, HistoryLineSurface } from "../../packages/gateway/src/perf/history-line.ts";
  import { medianBaseline } from "../../packages/gateway/src/perf/baseline-median.ts";
  import { SLO_THRESHOLDS } from "../../packages/gateway/src/perf/slo-thresholds.ts";
  import { isFloorMetric } from "../../packages/gateway/src/perf/threshold-comparator.ts";
  import type { BenchSurfaceId, RunnerKind } from "../../packages/gateway/src/perf/types.ts";

  /** One historical metric sample for a single surface, oldest-first. */
  export interface DriftSample {
    value: number;
  }

  /**
   * Pure drift detector. Walks a rolling median of the last `k` samples and reports
   * drift only when the `n` most recent samples are EACH worse than that window's
   * median by more than `noiseFloorPct` percent. A lone spike never trips (it cannot
   * fill an `n`-long consecutive run); a sustained regression does.
   *
   * "Worse" is always "larger" here: drift-check runs only over smaller-is-better
   * trend surfaces (p95_ms / rss_bytes_p95), so a higher value is a regression.
   */
  export function detectDrift(
    history: readonly DriftSample[],
    noiseFloorPct: number,
    k = 7,
    n = 3,
  ): boolean {
    if (history.length < k + n) return false;
    let consecutive = 0;
    // Evaluate each of the last (history.length - k) positions against the rolling
    // median of the k samples that immediately precede it.
    for (let i = k; i < history.length; i += 1) {
      const window = history.slice(i - k, i).map((s) => s.value);
      const med = rollingMedian(window);
      const current = history[i]?.value;
      if (current === undefined || med <= 0) {
        consecutive = 0;
        continue;
      }
      const worsePct = ((current - med) / med) * 100;
      if (worsePct > noiseFloorPct) {
        consecutive += 1;
        if (consecutive >= n) return true;
      } else {
        consecutive = 0;
      }
    }
    return false;
  }

  function rollingMedian(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length === 0) return 0;
    if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }

  // ---------------------------------------------------------------------------
  // I/O wrapper (NOT unit-tested: it shells out to `gh`). The detection logic it
  // depends on (`detectDrift`) is fully covered above.
  // ---------------------------------------------------------------------------

  const TREND_METRIC_BY_SURFACE: ReadonlyMap<BenchSurfaceId, keyof HistoryLineSurface> =
    new Map(
      SLO_THRESHOLDS.filter((s) => s.gateClass === "trend").map((s) => [
        s.surfaceId,
        historyFieldFor(s.metric),
      ]),
    );

  function historyFieldFor(metric: (typeof SLO_THRESHOLDS)[number]["metric"]): keyof HistoryLineSurface {
    switch (metric) {
      case "p95_ms":
        return "p95_ms";
      case "p50_ms":
        return "p50_ms";
      case "throughput_per_sec":
        return "throughput_per_sec";
      case "rss_bytes_p95":
        return "rss_bytes_p95";
      case "tokens_per_sec":
        return "tokens_per_sec";
      case "first_token_ms":
        return "first_token_ms";
    }
  }

  const DRIFT_LABEL = "perf-drift";
  const DRIFT_NOISE_FLOOR_PCT = 20;
  const DRIFT_RUN_COUNT = 14;

  function driftIssueTitle(surfaceId: BenchSurfaceId): string {
    return `perf drift: ${surfaceId} regressing on main`;
  }

  /**
   * Read the last `DRIFT_RUN_COUNT` successful `main` perf runs for `runner`, and
   * for each smaller-is-better trend surface that has drifted, upsert (create or
   * comment-on) exactly ONE open gh issue. We only emit smaller-is-better surfaces
   * here, so detectDrift's "larger == worse" assumption holds.
   */
  export async function runDriftCheckMain(deps: {
    gh: GhCli;
    runner: RunnerKind;
    env?: Record<string, string | undefined>;
    tmpDir?: string;
    stderr?: (s: string) => void;
  }): Promise<void> {
    const { gh, runner } = deps;
    const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
    const tmpRoot = deps.tmpDir ?? tmpdir();

    const lines = await downloadRecentMainLines(gh, runner, tmpRoot, stderr);
    if (lines.length === 0) return;

    for (const [surfaceId, field] of TREND_METRIC_BY_SURFACE) {
      if (isFloorMetric(metricOf(surfaceId))) continue; // bigger-is-better trends deferred
      const series: DriftSample[] = [];
      for (const line of lines) {
        const surface = line.surfaces[surfaceId];
        const v = surface === undefined ? undefined : surface[field];
        if (typeof v === "number") series.push({ value: v });
      }
      if (!detectDrift(series, DRIFT_NOISE_FLOOR_PCT)) continue;
      try {
        await upsertDriftIssue(gh, surfaceId, runner, series);
      } catch (err) {
        stderr(`drift-check: issue upsert for ${surfaceId} failed: ${errMsg(err)}`);
      }
    }
  }

  function metricOf(surfaceId: BenchSurfaceId): (typeof SLO_THRESHOLDS)[number]["metric"] {
    const row = SLO_THRESHOLDS.find((s) => s.surfaceId === surfaceId);
    return row?.metric ?? "p95_ms";
  }

  async function downloadRecentMainLines(
    gh: GhCli,
    runner: RunnerKind,
    tmpRoot: string,
    stderr: (s: string) => void,
  ): Promise<HistoryLine[]> {
    let runs: { databaseId: number; headSha: string }[];
    try {
      runs = await gh.runListRecentSuccesses({
        workflow: "_perf.yml",
        branch: "main",
        limit: DRIFT_RUN_COUNT,
      });
    } catch (err) {
      stderr(`drift-check: gh run list failed: ${errMsg(err)}`);
      return [];
    }
    const prevDir = join(tmpRoot, `drift-check-${runner}`);
    mkdirSync(prevDir, { recursive: true });
    const lines: HistoryLine[] = [];
    // gh returns newest-first; reverse so detectDrift sees oldest-first.
    for (const { databaseId, headSha } of [...runs].reverse()) {
      const dir = join(prevDir, headSha);
      try {
        mkdirSync(dir, { recursive: true });
        const ok = await gh.runDownloadArtifact({
          runId: databaseId,
          name: `perf-${runner}-${headSha}`,
          dir,
        });
        if (!ok) continue;
        const raw = await Bun.file(join(dir, "run-history.jsonl")).text();
        const last = raw
          .split("\n")
          .filter((s) => s.trim() !== "")
          .at(-1);
        if (last !== undefined) lines.push(JSON.parse(last) as HistoryLine);
      } catch (err) {
        stderr(`drift-check: artifact (${headSha}) unreadable: ${errMsg(err)}; skipping`);
      }
    }
    // medianBaseline import kept available for callers wanting a single summary line.
    void medianBaseline;
    return lines;
  }

  async function upsertDriftIssue(
    gh: GhCli,
    surfaceId: BenchSurfaceId,
    runner: RunnerKind,
    series: readonly DriftSample[],
  ): Promise<void> {
    const title = driftIssueTitle(surfaceId);
    const latest = series.at(-1)?.value ?? 0;
    const body = [
      `Automated drift detection flagged \`${surfaceId}\` on \`${runner}\`.`,
      "",
      `Latest value: \`${latest}\`. The last ${series.length} \`main\` runs show a sustained`,
      `regression (rolling-median + ${DRIFT_NOISE_FLOOR_PCT}% floor over 3 consecutive runs).`,
      "",
      "See the [/dev/bench dashboard](../../tree/perf-data/dev/bench) for the trend chart.",
    ].join("\n");

    const open = await ghIssueList(gh, DRIFT_LABEL);
    const existing = open.find((i) => i.title === title);
    if (existing === undefined) {
      await ghSpawn(gh, [
        "issue",
        "create",
        "--title",
        title,
        "--label",
        DRIFT_LABEL,
        "--body",
        body,
      ]);
    } else {
      await ghSpawn(gh, ["issue", "comment", String(existing.number), "--body", body]);
    }
  }

  async function ghIssueList(
    gh: GhCli,
    label: string,
  ): Promise<{ number: number; title: string }[]> {
    const r = await ghSpawn(gh, [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      label,
      "--json",
      "number,title",
    ]);
    const out = r.stdout.trim();
    if (out === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      // `gh` can emit warnings/notices before the JSON payload; degrade gracefully
      // (treat as "no open issues") rather than crash the advisory drift checker.
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const result: { number: number; title: string }[] = [];
    for (const x of parsed) {
      if (typeof x === "object" && x !== null) {
        const rec = x as Record<string, unknown>;
        if (typeof rec["number"] === "number" && typeof rec["title"] === "string") {
          result.push({ number: rec["number"], title: rec["title"] });
        }
      }
    }
    return result;
  }

  /** Thin pass-through so the wrapper can issue raw `gh` verbs not on GhCli. */
  async function ghSpawn(
    _gh: GhCli,
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`gh ${args[0] ?? "?"} failed (${exitCode}): ${stderr || stdout}`);
    }
    return { exitCode, stdout, stderr };
  }

  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  if (import.meta.main) {
    const runner = (process.env["NIMBUS_PERF_RUNNER"] as RunnerKind | undefined) ?? "gha-ubuntu";
    await runDriftCheckMain({ gh: new GhCli(), runner });
  }
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bun test scripts/perf/drift-check.test.ts
  ```

  Expected: `7 pass, 0 fail`.

- [ ] **Step 5: Typecheck and lint.**

  Run:

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway" && bun run typecheck
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bunx biome check scripts/perf/drift-check.ts scripts/perf/drift-check.test.ts
  ```

  Expected: typecheck exits 0 (no errors); biome reports `No fixes needed` / 0 errors. If biome flags the unused `void medianBaseline;` line as a no-op, delete both that line and the `medianBaseline` import (it is not load-bearing for drift detection).

- [ ] **Step 6: Commit.**

```bash
cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && git add scripts/perf/drift-check.ts scripts/perf/drift-check.test.ts && git commit -m "$(cat <<'EOF'

feat(perf): add drift-check pure detector + gh-issue upsert wrapper

detectDrift(values, noiseFloorPct, k=7, n=3) trips only on a sustained
regression (n consecutive samples worse than the rolling median of the
last k by > floor), so a lone spike never gates. The I/O wrapper reads
recent main run history per surface and upserts one gh issue per drifting
trend surface; only the pure core is unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"

```

  Expected: one commit created with both files staged.

---

### Task 10: Extend `pr-comment-formatter.ts` with a condensed gate-class summary + dashboard link

**Files:**

- Modify: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway\src\perf\pr-comment-formatter.ts` (add a new exported `formatCondensedGateSummary`; lines ~72–98 untouched, append below)
- Test: `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway\src\perf\pr-comment-formatter.test.ts` (append a new `describe` block)

The new function renders a short table containing only `gate`-class surfaces plus a single link line to the `/dev/bench` dashboard. It is exported for use alongside the existing full `formatPrComment` table.

- [ ] **Step 1: Write the failing tests for `formatCondensedGateSummary`.**

  Append the following to the END of `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway\src\perf\pr-comment-formatter.test.ts` (before the file's final newline; add the import at the top of the existing import list). First update the import line:

  Change:

  ```ts
  import { COMMENT_MARKER_PREFIX, formatPrComment } from "./pr-comment-formatter.ts";
  ```

  to:

  ```ts
  import {
    COMMENT_MARKER_PREFIX,
    formatCondensedGateSummary,
    formatPrComment,
  } from "./pr-comment-formatter.ts";
  ```

  Then append this block after the closing `});` of the existing `describe("formatPrComment", ...)`:

  ```ts
  describe("formatCondensedGateSummary", () => {
    test("includes only gate-class surfaces and omits trend/reference rows", () => {
      const out = formatCondensedGateSummary(
        [
          { surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } },
          { surfaceId: "S2-b", metric: "p95_ms", status: { kind: "pass" } },
          {
            surfaceId: "S1",
            metric: "p95_ms",
            status: { kind: "skipped", reason: "trend-only" },
          },
          {
            surfaceId: "S9",
            metric: "tokens_per_sec",
            status: { kind: "skipped", reason: "reference-only" },
          },
        ],
        fakeLine("gha-ubuntu"),
      );
      expect(out).toContain("S2-a");
      expect(out).toContain("S2-b");
      expect(out).not.toContain("S1");
      expect(out).not.toContain("S9");
    });

    test("renders a /dev/bench dashboard link line", () => {
      const out = formatCondensedGateSummary(
        [{ surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } }],
        fakeLine("gha-ubuntu"),
      );
      expect(out).toContain("/dev/bench");
      expect(out).toMatch(/\[.*dashboard.*\]\(.*dev\/bench.*\)/i);
    });

    test("marks a gate-class failure with a fail glyph", () => {
      const out = formatCondensedGateSummary(
        [
          {
            surfaceId: "S2-a",
            metric: "p95_ms",
            status: { kind: "absolute-fail", measured: 300, threshold: 200 },
          },
        ],
        fakeLine("gha-ubuntu"),
      );
      expect(out).toContain("S2-a");
      expect(out).toContain("❌");
    });

    test("reports an all-clear line when every gate-class surface passes", () => {
      const out = formatCondensedGateSummary(
        [
          { surfaceId: "S2-a", metric: "p95_ms", status: { kind: "pass" } },
          { surfaceId: "S2-b", metric: "p95_ms", status: { kind: "pass" } },
        ],
        fakeLine("gha-ubuntu"),
      );
      expect(out).toContain("All 2 gate-class surfaces passed");
    });

    test("renders an empty-gate-set note when no gate-class surface is present", () => {
      const out = formatCondensedGateSummary(
        [
          {
            surfaceId: "S1",
            metric: "p95_ms",
            status: { kind: "skipped", reason: "trend-only" },
          },
        ],
        fakeLine("gha-ubuntu"),
      );
      expect(out).toContain("No gate-class surfaces evaluated");
    });
  });
  ```

- [ ] **Step 2: Run the tests and confirm they FAIL.**

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bun test packages/gateway/src/perf/pr-comment-formatter.test.ts
  ```

  Expected: failure — `error: Export named 'formatCondensedGateSummary' not found in module '.../pr-comment-formatter.ts'`. The 5 new tests do not run; existing `formatPrComment` tests still pass.

- [ ] **Step 3: Implement `formatCondensedGateSummary` in `pr-comment-formatter.ts`.**

  First update the imports at the top of `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway\src\perf\pr-comment-formatter.ts`.

  Change:

  ```ts
  import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
  import { isFloorMetric, type SurfaceComparison } from "./threshold-comparator.ts";
  ```

  to:

  ```ts
  import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
  import { thresholdsBySurface } from "./slo-thresholds.ts";
  import { isFloorMetric, type SurfaceComparison } from "./threshold-comparator.ts";
  ```

  Then append the following to the END of the file (after the closing `}` of `formatPrComment`):

  ```ts
  /** Path of the github-action-benchmark dashboard published on the `perf-data` branch. */
  const DEV_BENCH_DASHBOARD_PATH = "../../tree/perf-data/dev/bench";

  function isGateClass(surfaceId: string): boolean {
    return thresholdsBySurface().get(surfaceId as keyof HistoryLine["surfaces"])?.gateClass === "gate";
  }

  function condensedStatusCell(c: SurfaceComparison): string {
    switch (c.status.kind) {
      case "pass":
        return "✅";
      case "absolute-fail": {
        const op = isFloorMetric(c.metric) ? "<" : ">";
        return `❌ (${fmtNum(c.status.measured)} ${op} ${fmtNum(c.status.threshold)})`;
      }
      case "delta-fail":
        return `❌ (+${c.status.deltaPct.toFixed(1)}%)`;
      case "no-baseline":
        return "🆕";
      case "skipped":
        return `⏭ ${c.status.reason}`;
    }
  }

  /**
   * A short, gate-class-only summary table plus a single link to the `/dev/bench`
   * trend dashboard. Rendered ALONGSIDE the full `formatPrComment` table so reviewers
   * see the build-gating verdict at a glance; trend/reference surfaces are intentionally
   * omitted here because they never gate the build.
   */
  export function formatCondensedGateSummary(
    comparisons: readonly SurfaceComparison[],
    current: HistoryLine,
  ): string {
    const gate = comparisons.filter((c) => isGateClass(c.surfaceId));
    const lines: string[] = [`#### Gate-class summary — ${current.runner}`, ""];

    if (gate.length === 0) {
      lines.push("> No gate-class surfaces evaluated on this runner.");
    } else {
      const failing = gate.filter(
        (c) => c.status.kind === "absolute-fail" || c.status.kind === "delta-fail",
      );
      if (failing.length === 0) {
        lines.push(`> All ${gate.length} gate-class surfaces passed.`);
      }
      lines.push("", "| Surface | Metric | Status |", "|---|---|---|");
      for (const c of gate) {
        lines.push(`| ${c.surfaceId} | ${c.metric} | ${condensedStatusCell(c)} |`);
      }
    }

    lines.push(
      "",
      `📈 [Full trend dashboard](${DEV_BENCH_DASHBOARD_PATH}) (/dev/bench, published on \`perf-data\`).`,
    );
    return lines.join("\n");
  }
  ```

- [ ] **Step 4: Run the tests and confirm they PASS.**

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bun test packages/gateway/src/perf/pr-comment-formatter.test.ts
  ```

  Expected: all tests pass (the original `formatPrComment` suite plus the 5 new `formatCondensedGateSummary` tests) — e.g. `13 pass, 0 fail`.

- [ ] **Step 5: Typecheck and lint.**

  ```bash
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway" && bun run typecheck
  cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && bunx biome check packages/gateway/src/perf/pr-comment-formatter.ts packages/gateway/src/perf/pr-comment-formatter.test.ts
  ```

  Expected: typecheck exits 0; biome reports 0 errors. Note: `thresholdsBySurface().get(...)` is keyed by `BenchSurfaceId`; the `as keyof HistoryLine["surfaces"]` cast mirrors the existing `readSurfaceMetric` pattern in this same file and keeps strict mode happy with no `any`.

- [ ] **Step 6: Commit.**

```bash
cd "C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy" && git add packages/gateway/src/perf/pr-comment-formatter.ts packages/gateway/src/perf/pr-comment-formatter.test.ts && git commit -m "$(cat <<'EOF'

feat(perf): add condensed gate-class PR summary + /dev/bench link

formatCondensedGateSummary renders a short table of only gate-class
surfaces (the build-gating verdict) plus a link line to the /dev/bench
trend dashboard, for use alongside the existing full delta table. Trend
and reference surfaces are intentionally omitted since they never gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"

```

  Expected: one commit created with both files staged.

---

Key implementation notes for the caller:

- Both tasks depend on the `gateClass` field on `SloThreshold` (replacing `gated`/`linuxOnlyGate`) and the `"trend-only"` reason added to the `skipped` status union — both delivered by the earlier partition/comparator tasks per the shared contract. Task 9's wrapper reads `s.gateClass === "trend"`; Task 10's `isGateClass` reads `=== "gate"`.
- Task 9 unit-tests ONLY the pure `detectDrift` (7 tests, no `gh`); the `runDriftCheckMain` I/O wrapper is implemented in full but deliberately untested, and reuses `GhCli` from `bench-ci-gh.ts` for list/download plus a thin `Bun.spawn(["gh", ...])` pass-through for `issue list`/`create`/`comment`, mirroring `defaultSpawn`'s style.
- `detectDrift` requires `history.length >= k + n` before it can trip, which is what makes the single-spike test return `false` and the sustained-regression test return `true`.
- Relevant files read to ground the code: `pr-comment-formatter.ts`, `pr-comment-formatter.test.ts`, `bench-ci.ts`, `bench-ci-gh.ts` (GhCli), `history-line.ts`, `threshold-comparator.ts`, `slo-thresholds.ts`, `types.ts` — all under `C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\packages\gateway\src\perf\`.

---

### Task 11: Add a nightly `schedule` cron to `_perf-reference.yml`

**Files:**

- Modify: `.github/workflows/_perf-reference.yml` (header comment lines 3–10; `on:` trigger block lines 12–24; protocol-attestation step lines 50–56)

This is a workflow-YAML task (no unit test), so the TDD shape is: write the exact diff, then verify with a YAML parse + a grep-based trigger assertion, then commit.

- [ ] **Step 1: Replace the trigger-doc comment block (lines 3–10) to record the new schedule trigger.**

  Replace:

  ```yaml
  # Triggers (spec §4.2 + design D-T):
  #   - workflow_dispatch only. Operator manually triggers from the Actions UI
  #     after preparing the M1 Air per the §4.2 protocol checklist.
  #
  # This workflow runs on the self-hosted runner registered with the
  # `reference-m1air` label (see docs/perf/reference-runner-setup.md). It
  # performs the bench, sanity-checks the resulting history.jsonl line, and
  # opens a `perf`-labelled bot PR for review.
  ```

  with:

  ```yaml
  # Triggers (spec §4.2 + design D-T):
  #   - workflow_dispatch — operator manually triggers from the Actions UI
  #     after preparing the M1 Air per the §4.2 protocol checklist.
  #   - schedule (nightly 05:00 UTC) — an unattended run. The M1 Air is a
  #     dedicated, persistent self-hosted runner kept in the §4.2 protocol
  #     state between runs, so a scheduled dispatch treats the protocol as
  #     already attested (see the `protocol_attested` default-resolution in
  #     the attestation step below). `schedule` only ever fires on the
  #     default branch of THIS repo — GitHub never runs scheduled workflows
  #     for forks or fork PRs — so this trigger stays non-fork-triggered.
  #
  # This workflow runs on the self-hosted runner registered with the
  # `reference-m1air` label (see docs/perf/reference-runner-setup.md). It
  # performs the bench, sanity-checks the resulting history.jsonl line, and
  # opens a `perf`-labelled bot PR for review.
  ```

- [ ] **Step 2: Add the `schedule` trigger alongside `workflow_dispatch` in the `on:` block (lines 12–24).**

  Replace:

  ```yaml
  on:
    workflow_dispatch:
      inputs:
        protocol_attested:
          description: "Have you completed the §4.2 reference protocol checklist? (AC powered, Low Power Mode off, fresh reboot ≥5 min, no Spotlight/Time Machine/iCloud/Messages activity, display on)"
          required: true
          type: boolean
          default: false
        notes:
          description: "Optional free-form notes (e.g., thermal state, deviations from protocol). Goes into PR body, not the history line."
          required: false
          type: string
          default: ""
  ```

  with:

  ```yaml
  on:
    # Nightly unattended reference run. cron is 5-field UTC. The dedicated
    # M1 Air is held in the §4.2 protocol state, so no inputs are supplied;
    # the attestation step below resolves the missing `inputs.protocol_attested`
    # to `true` for the `schedule` event. GitHub runs `schedule` only on the
    # default branch of this repo — never for forks/fork PRs.
    schedule:
      - cron: "0 5 * * *"
    workflow_dispatch:
      inputs:
        protocol_attested:
          description: "Have you completed the §4.2 reference protocol checklist? (AC powered, Low Power Mode off, fresh reboot ≥5 min, no Spotlight/Time Machine/iCloud/Messages activity, display on)"
          required: true
          type: boolean
          default: false
        notes:
          description: "Optional free-form notes (e.g., thermal state, deviations from protocol). Goes into PR body, not the history line."
          required: false
          type: string
          default: ""
  ```

  Rationale (how a scheduled run supplies the protocol-attested input default): on a `schedule` event there are no `inputs.*` — `inputs.protocol_attested` evaluates to the empty string, not the `workflow_dispatch` default of `false` (workflow_dispatch input defaults apply only to the `workflow_dispatch` event). The existing attestation step gates on `inputs.protocol_attested != true`, which would spuriously fail every scheduled run. Step 3 fixes that by treating `github.event_name == 'schedule'` as already-attested, since the dedicated runner is held in the §4.2 protocol state.

- [ ] **Step 3: Make the attestation step accept a scheduled run as pre-attested (lines 50–56).**

  Replace:

  ```yaml
        - name: Validate protocol attestation
          if: inputs.protocol_attested != true
          run: |
            echo "::error::Reference run requires §4.2 protocol attestation."
            echo "Re-dispatch with protocol_attested=true after completing the checklist."
            echo "See docs/perf/reference-runner-setup.md and spec §4.2."
            exit 1
  ```

  with:

  ```yaml
        - name: Validate protocol attestation
          # Manual dispatch must explicitly attest. A scheduled run is
          # implicitly attested: the dedicated M1 Air is kept in the §4.2
          # protocol state between runs (see header comment + spec §4.2), and
          # `schedule` only fires on this repo's default branch, never on
          # forks. The `workflow_dispatch` input default (`false`) does NOT
          # apply to the `schedule` event, so we branch on the event name.
          if: github.event_name != 'schedule' && inputs.protocol_attested != true
          run: |
            echo "::error::Reference run requires §4.2 protocol attestation."
            echo "Re-dispatch with protocol_attested=true after completing the checklist."
            echo "See docs/perf/reference-runner-setup.md and spec §4.2."
            exit 1
  ```

- [ ] **Step 4: Verify the YAML parses and the triggers are exactly as intended (actionlint is not installed locally; use a Python YAML parse + assertions).**

  Run:

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
python -c "

import yaml, sys

# PyYAML maps the bare \`on:\` key to the Python bool True; read raw if needed

d = yaml.safe_load(open('.github/workflows/_perf-reference.yml', encoding='utf-8'))
on = d.get('on', d.get(True))
assert 'schedule' in on, f'schedule trigger missing: {on!r}'
assert on['schedule'] == [{'cron': '0 5 ** *'}], f'cron wrong: {on[\"schedule\"]!r}'
assert 'workflow_dispatch' in on, 'workflow_dispatch trigger missing'
assert 'protocol_attested' in on['workflow_dispatch']['inputs'], 'protocol_attested input missing'
print('OK: schedule(0 5* **) + workflow_dispatch both present, inputs intact')
"

```

  Expected output:

  ```text

  OK: schedule(0 5 ** *) + workflow_dispatch both present, inputs intact

  ```

  Then confirm the attestation gate now branches on the event name:

  ```bash
  cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
  grep -n "github.event_name != 'schedule' && inputs.protocol_attested != true" .github/workflows/_perf-reference.yml
  ```

  Expected output: one matching line (the `if:` of the "Validate protocol attestation" step), e.g.

  ```text
  58:        if: github.event_name != 'schedule' && inputs.protocol_attested != true
  ```

  If `actionlint` is later available on the path, also run it (optional, non-blocking — it is not installed in this environment):

  ```bash
  bunx actionlint .github/workflows/_perf-reference.yml && echo "actionlint OK"
  ```

  Expected: `actionlint OK` (no diagnostics).

- [ ] **Step 5: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
git add .github/workflows/_perf-reference.yml
git commit -m "$(cat <<'EOF'

feat(perf): nightly schedule cron for the M1 Air reference run

Add a `schedule` trigger (cron "0 5 ** *", 05:00 UTC) alongside the
existing `workflow_dispatch` on _perf-reference.yml so the dedicated
reference runner produces an unattended nightly baseline.

GitHub runs `schedule` only on the default branch of this repo, never
for forks or fork PRs, so the trigger stays non-fork-triggered.

The `workflow_dispatch` input default (`protocol_attested: false`) does
not apply to a `schedule` event, so the attestation step now branches on
`github.event_name`: a scheduled run is treated as already-attested (the
M1 Air is held in the §4.2 protocol state between runs), while manual
dispatch must still explicitly attest.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"

```

---

### Task 12: Regenerate `docs/perf/slo.md` and point the "not a regression-tracking document" note at the `/dev/bench` dashboard

**Files:**

- Modify: `scripts/regen-slo.ts` (`FOOTER` template literal, lines 109–117) — the doc is *generated*, so the note text is edited in the generator, not by hand in the `.md`.
- Modify (regenerated, not hand-edited): `docs/perf/slo.md` (the "What this sheet is not" section, line 70) — produced by re-running the script.

This task has no unit test (the generator's round-trip is itself verified by `--check`); the TDD shape is: change the source string, regenerate, then assert `--check` passes and the new dashboard link is present.

- [ ] **Step 1: Update the `FOOTER` "Not a regression-tracking document." note in `scripts/regen-slo.ts` (lines 109–117) to point at the `/dev/bench` trend dashboard.**

  Replace:

  ```ts
  const FOOTER = `
  ## What this sheet is not

  - **Not a regression-tracking document.** The ongoing per-run history lives in workflow artifacts (GHA) and \`docs/perf/history.jsonl\` (reference machine).

  ---

  *This file is generated from \`packages/gateway/src/perf/slo-thresholds.ts\`. Run \`bun scripts/regen-slo.ts\` after changing thresholds. CI runs \`bun scripts/regen-slo.ts --check\` to fail the build on drift.*
  `;
  ```

  with:

  ```ts
  const FOOTER = `
  ## What this sheet is not

  - **Not a regression-tracking document.** This sheet pins the absolute SLO *thresholds*. Trend-over-time tracking lives in the **[/dev/bench dashboard](https://asafgolombek.github.io/Nimbus/dev/bench/)** — the github-action-benchmark chart published from \`main\` on every push (data in the \`perf-data\` branch under \`dev/bench/\`). The reference machine's per-run aggregates are recorded in \`docs/perf/history.jsonl\`.

  ---

  *This file is generated from \`packages/gateway/src/perf/slo-thresholds.ts\`. Run \`bun scripts/regen-slo.ts\` after changing thresholds. CI runs \`bun scripts/regen-slo.ts --check\` to fail the build on drift.*
  `;
  ```

  (The `/dev/bench` path is the `benchmark-data-dir-path` published by github-action-benchmark to the `perf-data` `gh-pages-branch`, per the trend-pipeline contract in the shared spec. The URL follows the GitHub Pages convention `https://<owner>.github.io/<repo>/dev/bench/` for the `asafgolombek/Nimbus` repo.)

- [ ] **Step 2: Regenerate the doc.**

  ```bash
  cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
  bun scripts/regen-slo.ts
  ```

  Expected output (path is `os.tmpdir()`-independent — it is the repo doc path):

  ```text
  regen-slo: wrote C:\gitrep\Nimbus\.claude\worktrees\hybrid-perf-strategy\docs\perf\slo.md
  ```

- [ ] **Step 3: Verify the regenerated note is present in `docs/perf/slo.md` and the old wording is gone.**

  ```bash
  cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
  grep -n "dev/bench dashboard" docs/perf/slo.md
  grep -c "The ongoing per-run history lives in workflow artifacts" docs/perf/slo.md
  ```

  Expected output:

  ```text
  70:- **Not a regression-tracking document.** This sheet pins the absolute SLO *thresholds*. Trend-over-time tracking lives in the **[/dev/bench dashboard](https://asafgolombek.github.io/Nimbus/dev/bench/)** — ...
  0
  ```

  (The first grep prints the rewritten line; the second prints `0` — the old sentence is gone.)

- [ ] **Step 4: Verify the generator round-trips — `--check` must pass with exit code 0.**

  ```bash
  cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
  bun scripts/regen-slo.ts --check
  echo "exit=$?"
  ```

  Expected output:

  ```text
  exit=0
  ```

  (No `regen-slo: ... is out of date` stderr line; clean exit means on-disk `slo.md` exactly equals the generator output.)

- [ ] **Step 5: Lint the changed script (warnings-as-errors / no-any / no-unused per #627).**

  ```bash
  cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
  bunx biome check scripts/regen-slo.ts
  ```

  Expected output: `Checked 1 file ... No fixes applied.` with no errors (exit 0). The change is text-only inside an existing `const FOOTER` template literal — no new imports, types, or symbols — so no `tsc`/biome surface changes.

- [ ] **Step 6: Commit both the generator and the regenerated doc together.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/hybrid-perf-strategy"
git add scripts/regen-slo.ts docs/perf/slo.md
git commit -m "$(cat <<'EOF'

docs(perf): point slo.md trend note at the /dev/bench dashboard

The SLO sheet pins absolute thresholds, not trends. Update the
"Not a regression-tracking document" note in the regen-slo.ts FOOTER
to direct readers to the github-action-benchmark /dev/bench dashboard
(published from main on every push to the perf-data branch) for
trend-over-time tracking, and regenerate docs/perf/slo.md.

Verified `bun scripts/regen-slo.ts --check` passes (round-trips clean).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"

```

---

Notes for the executor (load-bearing facts I verified against the real files):

- `docs/perf/slo.md` is fully generated by `scripts/regen-slo.ts`; the "not a regression-tracking document" string lives in the `FOOTER` constant (lines 109–117), so it must be edited there and regenerated — hand-editing the `.md` would fail `--check` (CI runs `bun scripts/regen-slo.ts --check`). Both files commit together.
- `_perf-reference.yml` currently triggers on `workflow_dispatch` only (lines 12–24) and gates on `inputs.protocol_attested != true` (line 51). `workflow_dispatch` input defaults do **not** apply to `schedule` events, which is why Task 11 Step 3 branches the attestation gate on `github.event_name`.
- `actionlint` is **not** installed in this environment (`bunx actionlint` only resolves the package and `~/.cargo/bin/actionlint` is absent), so Task 11's verification uses a PyYAML parse (python is on PATH); the `bunx actionlint` step is listed as optional/non-blocking.
- PyYAML quirk noted in the verify step: the bare `on:` key parses to Python `True`, so the assertion reads `d.get('on', d.get(True))`.
