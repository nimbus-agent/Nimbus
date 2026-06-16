# Perf Phase 2 (Bencher) — PR-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add advisory Bencher Cloud ingest alongside the existing `github-action-benchmark` (g-a-b) trend dashboard — a pure `HistoryLine → Bencher Metric Format` mapper, a thin CLI emitter, and `_perf.yml` / `_perf-reference.yml` workflow steps — so the gha-ubuntu (and future M1 Air) perf trend flows to Bencher for a soak window, before g-a-b is retired in a later PR-2.

**Architecture:** Mirror the Phase-1 g-a-b emitter exactly. A pure, floor-gated `toBencherBmf(line)` in `packages/gateway/src/perf/bencher-bmf.ts` maps every `gateClass === "trend"` surface (ALL metric kinds, including the throughput/tokens surfaces g-a-b defers) to BMF JSON; a thin `scripts/perf/emit-bencher-bmf.ts` CLI writes it; new `_perf.yml` steps run `bencher run --adapter json --file …` per matrix leg, gated on the `BENCHER_API_KEY` secret being present and the BMF being non-empty, `continue-on-error: true` (advisory). The in-code `gateClass` comparator remains the sole gate; Bencher never blocks a merge.

**Tech Stack:** Bun v1.2+ / TypeScript strict · `bun test` · GitHub Actions · Bencher Cloud (`bencher run` CLI via `bencherdev/bencher`).

**Spec:** [`docs/superpowers/specs/2026-06-16-perf-phase2-bencher-design.md`](../specs/2026-06-16-perf-phase2-bencher-design.md)

---

## Manual ops prerequisites (operator, NOT part of any code task)

These cannot be done by a PR. They can land in **either order** relative to PR-1 (the secret-presence guard in Task 3 makes the workflow steps skip cleanly until the secret exists); do them just before/after merging PR-1 so the soak clock starts. See spec §6.

- [ ] Create the public Bencher Cloud project `nimbus`.
- [ ] Pre-create the 5 Measures with correct units + direction: `latency` (ms, ↓), `memory` (bytes, ↓), `first_token` (ms, ↓), `throughput` (items/sec, ↑), `tokens` (tps, ↑).
- [ ] Generate a project-scoped `bencher_run_*` API key → store as the `BENCHER_API_KEY` GitHub Actions secret (least privilege; not a user key).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/perf/bencher-bmf.ts` (NEW) | Pure `toBencherBmf(line) → BmfReport` + `MEASURE_BY_METRIC`. Floor-gated, unit-tested. |
| `packages/gateway/src/perf/bencher-bmf.test.ts` (NEW) | Unit tests for the mapper (coverage ≥80% line+branch). |
| `scripts/perf/emit-bencher-bmf.ts` (NEW) | Thin CLI: `--in run-history.jsonl --out bencher.json`. |
| `scripts/perf/emit-bencher-bmf.test.ts` (NEW) | CLI exit-code + output tests. |
| `.github/workflows/_perf.yml` (MODIFY) | Job-level `env`, Bencher install/emit/publish steps (push + same-repo PR, all legs). |
| `.github/workflows/_perf-reference.yml` (MODIFY) | Dormant reference-runner ingest step. |
| `docs/CHANGELOG.md` (MODIFY) | One-line Phase-2-soak entry. |

---

## Task 1: Pure BMF mapper (`bencher-bmf.ts`)

**Files:**

- Create: `packages/gateway/src/perf/bencher-bmf.ts`
- Test: `packages/gateway/src/perf/bencher-bmf.test.ts`

Mirrors `scripts/perf/emit-benchmark-json.ts`'s `toBenchmarkPoints`, but: (a) emits **all** metric kinds (not just `p95_ms`/`rss_bytes_p95`), (b) outputs nested BMF rather than a points array, (c) lives under the gateway src tree so it is coverage-floor-gated. Metric names are identical to the `HistoryLineSurface` field names, so `surface[slo.metric]` reads the value directly.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/perf/bencher-bmf.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "./history-line.ts";
import { toBencherBmf } from "./bencher-bmf.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-16T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("toBencherBmf", () => {
  test("maps a trend latency surface (S1) to the `latency` measure", () => {
    expect(toBencherBmf(baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } }))).toEqual({
      S1: { latency: { value: 812.5 } },
    });
  });

  test("maps a trend memory surface (S7-a) to the `memory` measure", () => {
    expect(
      toBencherBmf(baseLine({ "S7-a": { samples_count: 5, rss_bytes_p95: 134_217_728 } })),
    ).toEqual({ "S7-a": { memory: { value: 134_217_728 } } });
  });

  test("INCLUDES throughput trend surfaces (S10) — the gap vs the g-a-b emitter", () => {
    expect(
      toBencherBmf(baseLine({ S10: { samples_count: 5, throughput_per_sec: 999 } })),
    ).toEqual({ S10: { throughput: { value: 999 } } });
  });

  test("does NOT emit gate-class surfaces (S2-a)", () => {
    expect(toBencherBmf(baseLine({ "S2-a": { samples_count: 5, p95_ms: 12.3 } }))).toEqual({});
  });

  test("does NOT emit reference-class surfaces (S9)", () => {
    expect(toBencherBmf(baseLine({ S9: { samples_count: 5, tokens_per_sec: 41 } }))).toEqual({});
  });

  test("skips a stub surface (samples_count===0)", () => {
    expect(toBencherBmf(baseLine({ S4: { samples_count: 0, stub_reason: "stub" } }))).toEqual({});
  });

  test("skips a trend surface whose metric value is absent", () => {
    expect(toBencherBmf(baseLine({ S1: { samples_count: 5 } }))).toEqual({});
  });

  test("ignores a non-finite metric value", () => {
    expect(
      toBencherBmf(baseLine({ S1: { samples_count: 5, p95_ms: Number.POSITIVE_INFINITY } })),
    ).toEqual({});
  });

  test("emits multiple surfaces keyed by surfaceId", () => {
    expect(
      toBencherBmf(
        baseLine({
          S1: { samples_count: 5, p95_ms: 800 },
          "S7-a": { samples_count: 5, rss_bytes_p95: 100 },
          S10: { samples_count: 5, throughput_per_sec: 999 },
        }),
      ),
    ).toEqual({
      S1: { latency: { value: 800 } },
      "S7-a": { memory: { value: 100 } },
      S10: { throughput: { value: 999 } },
    });
  });

  test("returns an empty object when no trend surface has data (skip-on-empty input)", () => {
    expect(toBencherBmf(baseLine({}))).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/perf/bencher-bmf.test.ts`
Expected: FAIL — `Cannot find module './bencher-bmf.ts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/gateway/src/perf/bencher-bmf.ts`:

```ts
import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import { SLO_THRESHOLDS, type SloThreshold, thresholdsBySurface } from "./slo-thresholds.ts";

/** One Bencher Metric Format measure value (we emit only the central `value`). */
export interface BmfMetric {
  value: number;
}

/** Bencher Metric Format: { benchmarkName: { measureSlug: { value } } }. */
export type BmfReport = Record<string, Record<string, BmfMetric>>;

/**
 * Maps each SloThreshold metric to its Bencher Measure slug. The slug's
 * lower-vs-higher-is-better direction is configured once on the Bencher project
 * (spec §6): latency/memory/first_token are lower-is-better; throughput/tokens
 * are higher-is-better — matching `isFloorMetric`.
 */
const MEASURE_BY_METRIC: Record<SloThreshold["metric"], string> = {
  p95_ms: "latency",
  p50_ms: "latency",
  rss_bytes_p95: "memory",
  throughput_per_sec: "throughput",
  tokens_per_sec: "tokens",
  first_token_ms: "first_token",
};

/**
 * Map the latest HistoryLine into a Bencher Metric Format report for every
 * `trend`-class surface carrying a finite metric value. Unlike the
 * github-action-benchmark emitter (`toBenchmarkPoints`), this includes ALL
 * metric kinds — throughput/tokens trend surfaces are charted here.
 * Stub surfaces (`samples_count === 0`) and non-finite values are skipped.
 * An all-stub line yields an empty `{}` (the workflow skips publishing it).
 * Metric names equal `HistoryLineSurface` field names, so `surface[metric]`
 * reads the value directly.
 */
export function toBencherBmf(line: HistoryLine): BmfReport {
  const bySurface = thresholdsBySurface();
  const out: BmfReport = {};
  for (const slo of SLO_THRESHOLDS) {
    if (bySurface.get(slo.surfaceId)?.gateClass !== "trend") continue;
    const surface: HistoryLineSurface | undefined = line.surfaces[slo.surfaceId];
    if (surface === undefined || surface.samples_count === 0) continue;
    const raw = surface[slo.metric];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    out[slo.surfaceId] = { [MEASURE_BY_METRIC[slo.metric]]: { value: raw } };
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/perf/bencher-bmf.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck the gateway package**

Run: `bunx tsc --noEmit -p packages/gateway/tsconfig.json`
Expected: no errors. (`surface[slo.metric]` typechecks because every metric union member is an optional numeric key of `HistoryLineSurface`.)

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/perf/bencher-bmf.ts packages/gateway/src/perf/bencher-bmf.test.ts
git commit -m "feat(perf): pure HistoryLine -> Bencher Metric Format mapper"
```

---

## Task 2: CLI emitter (`emit-bencher-bmf.ts`)

**Files:**

- Create: `scripts/perf/emit-bencher-bmf.ts`
- Test: `scripts/perf/emit-bencher-bmf.test.ts`

Thin wrapper mirroring `scripts/perf/emit-benchmark-json.ts`'s `runEmitBenchmarkJsonMain` (same flag parsing, same error handling, same exit codes 0/1/2). Reuses the shared `parseLastHistoryLine`.

- [ ] **Step 1: Write the failing test**

Create `scripts/perf/emit-bencher-bmf.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { runEmitBencherBmfMain } from "./emit-bencher-bmf.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-16T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("runEmitBencherBmfMain", () => {
  test("returns 2 when required flags are missing", async () => {
    expect(await runEmitBencherBmfMain([])).toBe(2);
  });

  test("returns 1 (not an uncaught crash) when the input file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const code = await runEmitBencherBmfMain([
      "--in",
      join(dir, "missing.jsonl"),
      "--out",
      join(dir, "out.json"),
    ]);
    expect(code).toBe(1);
  });

  test("writes BMF and returns 0 on a valid input file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const inPath = join(dir, "run-history.jsonl");
    const outPath = join(dir, "bencher.json");
    const line: HistoryLine = baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } });
    writeFileSync(inPath, `${JSON.stringify(line)}\n`, "utf8");
    const code = await runEmitBencherBmfMain(["--in", inPath, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({
      S1: { latency: { value: 812.5 } },
    });
  });

  test("writes an empty object for an all-stub line and still returns 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const inPath = join(dir, "run-history.jsonl");
    const outPath = join(dir, "bencher.json");
    writeFileSync(inPath, `${JSON.stringify(baseLine({}))}\n`, "utf8");
    const code = await runEmitBencherBmfMain(["--in", inPath, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/perf/emit-bencher-bmf.test.ts`
Expected: FAIL — `Cannot find module './emit-bencher-bmf.ts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/perf/emit-bencher-bmf.ts`:

```ts
#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import { toBencherBmf } from "../../packages/gateway/src/perf/bencher-bmf.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export async function runEmitBencherBmfMain(args: string[]): Promise<number> {
  const inPath = takeFlag(args, "--in");
  const outPath = takeFlag(args, "--out");
  if (inPath === undefined || outPath === undefined) {
    process.stderr.write(
      "usage: emit-bencher-bmf.ts --in <run-history.jsonl> --out <bencher.json>\n",
    );
    return 2;
  }
  try {
    const text = await Bun.file(inPath).text();
    const line = parseLastHistoryLine(text);
    const report = toBencherBmf(line);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const count = Object.keys(report).length;
    process.stdout.write(`wrote ${count} trend surface(s) to ${outPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runEmitBencherBmfMain(process.argv.slice(2));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/perf/emit-bencher-bmf.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Smoke-test the CLI end to end**

Run:

```bash
printf '%s\n' '{"schema_version":2,"run_id":"r","timestamp":"2026-06-16T00:00:00.000Z","runner":"gha-ubuntu","os_version":"linux x64","nimbus_git_sha":"abc","bun_version":"1.2.0","surfaces":{"S1":{"samples_count":5,"p95_ms":800},"S10":{"samples_count":5,"throughput_per_sec":42}}}' > /tmp/rh.jsonl
bun scripts/perf/emit-bencher-bmf.ts --in /tmp/rh.jsonl --out /tmp/bencher.json
cat /tmp/bencher.json
```

Expected stdout: `wrote 2 trend surface(s) to /tmp/bencher.json`, and the file contains `{"S1":{"latency":{"value":800}},"S10":{"throughput":{"value":42}}}` (pretty-printed).

- [ ] **Step 6: Commit**

```bash
git add scripts/perf/emit-bencher-bmf.ts scripts/perf/emit-bencher-bmf.test.ts
git commit -m "feat(perf): emit-bencher-bmf CLI wrapper"
```

---

## Task 3: Wire Bencher ingest into `_perf.yml`

**Files:**

- Modify: `.github/workflows/_perf.yml`

Add a job-level `env` exposing the secret, the `bencherdev/bencher` install, and emit+publish steps. Steps run on the same legs that produce an artifact (existing `ubuntu || not-schedule || sunday` gate), skip cleanly when the secret is absent or the BMF is empty, skip fork PRs, and are `continue-on-error: true`. g-a-b steps are untouched.

> **Note — SHA pin:** resolve the latest `bencherdev/bencher` release commit at implementation time:
> `gh api repos/bencherdev/bencher/releases/latest --jq .tag_name` then
> `gh api repos/bencherdev/bencher/git/refs/tags/<tag> --jq .object.sha`.
> Use `uses: bencherdev/bencher@<sha> # <tag>` (Scorecard pin policy, like the g-a-b action).

- [ ] **Step 1: Add a job-level `env` for the secret-presence guard**

In `.github/workflows/_perf.yml`, in the `benchmark:` job, add an `env:` block at job level (sibling of `permissions:` / `concurrency:`, before `steps:`):

```yaml
    env:
      # Copied to a job-level env so step-level `if:` can gate on the secret's
      # presence (secrets cannot be referenced directly in `if:`). Absent secret
      # => Bencher steps skip cleanly (forks, repo copies, pre-ops-setup window).
      BENCHER_API_KEY: ${{ secrets.BENCHER_API_KEY }}
```

- [ ] **Step 2: Add the Bencher CLI install step**

Immediately AFTER the existing `- name: Upload run history artifact` step, add:

```yaml
      # ── Bencher Cloud advisory trend ingest (perf strategy Phase 2) ──────────
      # Runs alongside github-action-benchmark during the soak window. Advisory
      # only: the in-code gateClass comparator stays the sole gate. Skips when
      # BENCHER_API_KEY is unset (forks / pre-ops-setup) and on fork PRs.
      - name: Install Bencher CLI
        # Same secret-presence + leg gate as the emit/publish steps so a
        # provision-then-skip nightly leg (macOS/Windows Mon–Sat) doesn't install
        # the CLI for nothing.
        if: |
          env.BENCHER_API_KEY != '' && (
            matrix.os == 'ubuntu-24.04' ||
            github.event_name != 'schedule' ||
            github.event.schedule == '0 4 * * 0'
          )
        continue-on-error: true # advisory: an install hiccup on any leg must never red the perf job
        uses: bencherdev/bencher@<sha> # <tag>
```

- [ ] **Step 3: Add the BMF emit step (with a non-empty output flag)**

After the install step:

```yaml
      - name: Emit Bencher BMF
        id: bencher-emit
        if: |
          env.BENCHER_API_KEY != '' && (
            matrix.os == 'ubuntu-24.04' ||
            github.event_name != 'schedule' ||
            github.event.schedule == '0 4 * * 0'
          )
        continue-on-error: true # advisory: a BMF-emit failure must never red the perf job (publish then skips on the empty `surfaces` output)
        shell: bash
        run: |
          set -euo pipefail
          bun scripts/perf/emit-bencher-bmf.ts \
            --in "${RUNNER_TEMP}/run-history.jsonl" \
            --out "${RUNNER_TEMP}/bencher.json"
          # Expose the surface count so the publish step can skip an empty BMF.
          surfaces="$(jq 'length' "${RUNNER_TEMP}/bencher.json")"
          echo "surfaces=${surfaces}" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 4: Add the publish step (push + same-repo PR, all legs)**

After the emit step:

```yaml
      - name: Publish to Bencher
        # Skip empty BMF (all-stub run) and fork PRs (secrets unavailable). On
        # push -> branch main; on a same-repo PR -> the head ref with main as the
        # start point. Advisory: no thresholds configured => never fails; the
        # `continue-on-error` makes a transient API error non-blocking too.
        if: |
          steps.bencher-emit.outputs.surfaces != '' &&
          steps.bencher-emit.outputs.surfaces != '0' && (
            github.event_name != 'pull_request' ||
            github.event.pull_request.head.repo.full_name == github.repository
          )
        continue-on-error: true
        shell: bash
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          RUNNER_ID: ${{ steps.runner-id.outputs.id }}
        run: |
          set -euo pipefail
          common=(
            --project nimbus
            --key "${BENCHER_API_KEY}"
            --adapter json
            --file "${RUNNER_TEMP}/bencher.json"
            --testbed "${RUNNER_ID}"
            --github-actions "${GITHUB_TOKEN}"
          )
          if [[ "${GITHUB_EVENT_NAME}" == "pull_request" ]]; then
            bencher run \
              "${common[@]}" \
              --branch "${GITHUB_HEAD_REF}" \
              --start-point main \
              --start-point-hash "${BASE_SHA}" \
              --start-point-clone-thresholds \
              --start-point-reset \
              --ci-only-thresholds
          else
            bencher run "${common[@]}" --branch main
          fi
```

- [ ] **Step 5: Validate the workflow YAML**

Run: `bunx actionlint .github/workflows/_perf.yml`
Expected: no errors. (If `actionlint` is unavailable, parse-check instead: `bun -e "import {load} from 'js-yaml'; load(require('fs').readFileSync('.github/workflows/_perf.yml','utf8')); console.log('ok')"` — expect `ok`.)

- [ ] **Step 6: Confirm g-a-b steps are still present (soak coexistence)**

Run: `grep -c "github-action-benchmark" .github/workflows/_perf.yml`
Expected: `>= 1` (the g-a-b publish step is untouched — both pipelines run during the soak).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/_perf.yml
git commit -m "ci(perf): advisory Bencher ingest in _perf.yml (soak alongside g-a-b)"
```

---

## Task 4: Dormant reference-runner ingest in `_perf-reference.yml`

**Files:**

- Modify: `.github/workflows/_perf-reference.yml`

Add a Bencher ingest for the `reference-m1air` testbed. It runs only when this workflow runs — i.e. once the M1 Air self-hosted runner is provisioned — so it is dormant (zero-risk) until then. It reads the last line of `docs/perf/history.jsonl` (the just-appended reference line). Add the same job-level secret env + the install + emit + publish steps, scoped to push-equivalent (`--branch main`).

- [ ] **Step 1: Add the job-level secret env**

In the `reference-run:` job, add (sibling of `permissions:`):

```yaml
    env:
      BENCHER_API_KEY: ${{ secrets.BENCHER_API_KEY }}
```

- [ ] **Step 2: Add install + emit + publish steps**

Immediately AFTER the existing `- name: Run reference benchmark (3 runs, all surfaces)` step (so the new history line exists), add:

```yaml
      # ── Bencher Cloud advisory reference-trend ingest (perf strategy Phase 2)
      # Dormant until the self-hosted reference-m1air runner is provisioned (this
      # workflow only runs then). Advisory; skips when BENCHER_API_KEY is unset.
      - name: Install Bencher CLI
        if: ${{ env.BENCHER_API_KEY != '' }}
        continue-on-error: true # advisory: an install hiccup on any leg must never red the perf job
        uses: bencherdev/bencher@<sha> # <tag>

      - name: Emit Bencher BMF (reference)
        id: bencher-emit
        if: ${{ env.BENCHER_API_KEY != '' }}
        continue-on-error: true # advisory: a BMF-emit failure must never red the reference run
        shell: bash
        run: |
          set -euo pipefail
          bun scripts/perf/emit-bencher-bmf.ts \
            --in "${{ github.workspace }}/docs/perf/history.jsonl" \
            --out "${RUNNER_TEMP}/bencher.json"
          surfaces="$(jq 'length' "${RUNNER_TEMP}/bencher.json")"
          echo "surfaces=${surfaces}" >> "$GITHUB_OUTPUT"

      - name: Publish to Bencher (reference)
        if: ${{ steps.bencher-emit.outputs.surfaces != '' && steps.bencher-emit.outputs.surfaces != '0' }}
        continue-on-error: true
        shell: bash
        run: |
          set -euo pipefail
          bencher run \
            --project nimbus \
            --key "${BENCHER_API_KEY}" \
            --adapter json \
            --file "${RUNNER_TEMP}/bencher.json" \
            --testbed reference-m1air \
            --branch main
```

> Note: use the SAME resolved `bencherdev/bencher@<sha> # <tag>` as Task 3.

- [ ] **Step 3: Validate the workflow YAML**

Run: `bunx actionlint .github/workflows/_perf-reference.yml`
Expected: no errors (or the `js-yaml` parse-check fallback from Task 3 Step 5).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/_perf-reference.yml
git commit -m "ci(perf): dormant Bencher reference-m1air ingest (activates with the runner)"
```

---

## Task 5: CHANGELOG entry

**Files:**

- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add a dated entry**

Add under the top/most-recent dated section of `docs/CHANGELOG.md` (match the file's existing heading style):

```markdown
- **perf:** Phase 2 (Bencher) — advisory Bencher Cloud trend ingest now runs
  alongside `github-action-benchmark` during a soak window. Adds per-runner
  testbeds and charts the throughput/tokens trend surfaces for the first time.
  The in-code `gateClass` comparator remains the sole gate. `github-action-benchmark`
  retires in a follow-up PR after the soak.
```

- [ ] **Step 2: Lint the doc**

Run: `bunx markdownlint-cli2 docs/CHANGELOG.md` (or `bun run lint:markdown` if defined).
Expected: no errors (run `markdownlint-cli2 --fix` if it flags formatting, then re-check).

- [ ] **Step 3: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(perf): changelog entry for Phase 2 Bencher soak"
```

---

## Task 6: Pre-flight (full CI-parity before first push)

**Files:** none (verification only). Per the ship-readiness rule: never push-and-see — run the full gate set locally first.

- [ ] **Step 1: Scoped tests for the new perf code**

Run: `bun test packages/gateway/src/perf/bencher-bmf.test.ts scripts/perf/emit-bencher-bmf.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 2: Typecheck (full, sequential to avoid the OOM fan-out)**

Run: `bun run typecheck` (if it false-fails on `@nimbus-dev/client` in the worktree, first run `cd packages/client && bun run build`).
Expected: no errors.

- [ ] **Step 3: Static gates**

Run: `bunx biome check packages scripts` (NOT `bun run lint` — biome `check .` reports 0 files / fails inside `.claude/worktrees/`).
Expected: no errors.

- [ ] **Step 4: SLO sheet drift check (unchanged thresholds → must stay green)**

Run: `bun scripts/regen-slo.ts --check`
Expected: PASS (no `SloThreshold` fields changed).

- [ ] **Step 5: Coverage floor (Docker-Linux-authoritative) for the new floor-gated file**

Run the repo's Linux-authoritative lcov build + check (per the nimbus-preflight skill / `reseed-docker.sh`), then `bun scripts/structure-audit/<coverage-floor check>` (a.k.a. `audit:coverage-floor`).
Expected: `bencher-bmf.ts` ≥80% line+branch; baseline unchanged (it is a brand-new file that must clear the floor on its own — the 10 unit tests cover every branch). `scripts/perf/*` is NOT under the floor scan roots, so `emit-bencher-bmf.ts` is not floor-gated.

- [ ] **Step 6: Full preflight**

Run: `bun run preflight` (full CI parity).
Expected: all gates green. Investigate any red before pushing — do not push-and-see.

- [ ] **Step 7: Whole-branch code review**

Run `/code-review` (high effort) over the branch diff. Triage findings; fix real issues, record by-design ones.

- [ ] **Step 8: Push + open the PR (labelled `perf`)**

```bash
git push -u origin HEAD
gh pr create --base main --label perf \
  --title "perf: Phase 2 (Bencher) — advisory trend ingest (soak alongside g-a-b)" \
  --body "Implements PR-1 of docs/superpowers/specs/2026-06-16-perf-phase2-bencher-design.md. Advisory Bencher Cloud ingest runs alongside github-action-benchmark for a soak window; the in-code gateClass comparator stays the sole gate. g-a-b retires in PR-2 after the soak."
```

The `perf` label makes `_perf.yml` run on the PR, validating the new steps end-to-end (Bencher steps skip cleanly if the `BENCHER_API_KEY` secret isn't set up yet).

---

## PR-2 — retirement (DEFERRED until after the soak; do NOT execute now)

A separate plan/PR after ~2 weeks / ~10 main pushes confirm Bencher's dashboard matches the perf-data trend (spec §7). For reference, PR-2 will:

- Remove the `Emit trend benchmark JSON` + `Publish to github-action-benchmark` steps from `_perf.yml`.
- Delete `scripts/perf/emit-benchmark-json.ts` + `scripts/perf/emit-benchmark-json.test.ts`.
- Flip the dashboard link in `docs/perf/slo.md` (the "What this sheet is not" note) and in `pr-comment-formatter.ts` (`DEV_BENCH_DASHBOARD_PATH`) to the Bencher project URL.
- Archive the `perf-data` orphan branch (rename → `perf-data-archive`, read-only for forensics).
- Confirm `drift-check.ts` is unaffected (it reads the gha-ubuntu run-history artifacts, not the `perf-data` branch).

---

## Self-review

**Spec coverage:** §4 mapper → Task 1; §4.2 BMF shape → Task 1; §5.1 floor-gated placement → Task 1 + Task 6 Step 5; §5.2 CLI → Task 2; §5.3 install + secret-presence guard → Task 3 Steps 1-2; §5.4 branch/event + testbed-from-runner-id + fork guard → Task 3 Steps 3-4; §5.5 advisory `--ci-only-thresholds` → Task 3 Step 4; §5.6 `continue-on-error` (ALL Bencher steps — install/emit/publish — are fail-soft) + skip-empty → Task 3 Steps 2-4, Task 4 Step 2; §6 ops prereqs → Manual checklist; §7 dormant reference ingest → Task 4; §9 testing → Tasks 1-2 + Task 6; §10 rollout/relaxed ordering → secret guard (Task 3) + Task 6; CHANGELOG convention → Task 5. PR-2 (§7 retirement) intentionally deferred. No gaps.

**Placeholder scan:** The only `<sha> # <tag>` tokens are the GitHub Action pin, with the exact resolve commands given in Task 3 — a release SHA genuinely not knowable until impl time, not a content placeholder. No TBD/TODO in code.

**Type consistency:** `toBencherBmf` / `BmfReport` / `BmfMetric` used identically across Task 1 (def) and Task 2 (consumer); `runEmitBencherBmfMain` signature matches between test and impl; `MEASURE_BY_METRIC` covers all six `SloThreshold["metric"]` members; the `bencher-emit` step id + `surfaces` output are referenced consistently in Tasks 3-4.
