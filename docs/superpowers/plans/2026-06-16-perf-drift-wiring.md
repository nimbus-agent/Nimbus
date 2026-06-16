# Perf Drift-Check Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant sustained-drift detector — a daily `_perf-drift.yml` runs `drift-check.ts` over recent `main` perf history and files one `perf-drift` GitHub issue per sustained-regressing trend surface — while clearing the four #642-deferred refactors so the unattended issue-filing path is fully tested before it goes live.

**Architecture:** Four small units. A shared `parseLastHistoryLine` (extracted from `emit-benchmark-json.ts`); two new injectable `GhCli` issue methods (`issueList`/`issueCreate`); a `drift-check.ts` refactor (reuse `medianOf`, route `gh` through `GhCli`, switch to one-sample-per-run parsing, make the upsert **create-only** to kill daily-comment spam); and a new daily scheduled workflow that ensures the label exists then runs the script.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-06-16-perf-drift-wiring-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/perf/history-jsonl.ts` | Create | Shared `parseLastHistoryLine(text)` — last non-blank JSONL line → `HistoryLine` |
| `scripts/perf/history-jsonl.test.ts` | Create | Unit tests for the shared parser |
| `scripts/perf/emit-benchmark-json.ts` | Modify | Import the shared parser; delete its private copy |
| `packages/gateway/src/perf/bench-ci-gh.ts` | Modify | Add `issueList` + `issueCreate` to `GhCli` |
| `packages/gateway/src/perf/bench-ci-gh.test.ts` | Modify | Tests for the two new methods |
| `scripts/perf/drift-check.ts` | Modify | `medianOf` reuse; `GhCli` issue ops; one-sample-per-run; create-only upsert |
| `scripts/perf/drift-check.test.ts` | Modify | Migrate `parseHistoryLines` tests → `parseLatestV2Line`; add `runDriftCheckMain` wrapper tests |
| `.github/workflows/_perf-drift.yml` | Create | Daily scheduled workflow: ensure label → run drift-check |

**Single PR.** No schema migration, no new security invariant.

**Branch note:** this branch (`dev/asafgolombek/perf-drift-wiring`) is stacked on the Biome-2.5.0/ovsx fix branch (PR #656). After #656 merges, rebase onto `main`; the two duplicate fix commits drop out cleanly.

---

### Task 1: Shared `parseLastHistoryLine` helper

**Files:**

- Create: `scripts/perf/history-jsonl.ts`
- Create: `scripts/perf/history-jsonl.test.ts`

The identical "last non-blank line of a `run-history.jsonl` → `HistoryLine`" parse is duplicated (private in `emit-benchmark-json.ts`, and drift-check reads all lines). Extract one shared thin parser. Behavior matches the existing `emit-benchmark-json.ts` copy exactly (throws on empty input).

- [ ] **Step 1: Write the failing test.** Create `scripts/perf/history-jsonl.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

function v2(p95: number): string {
  const line: HistoryLine = {
    schema_version: 2,
    run_id: "r",
    timestamp: "2026-06-16T00:00:00Z",
    runner: "gha-ubuntu",
    os_version: "ubuntu-24.04",
    nimbus_git_sha: "abc",
    bun_version: "1.3.14",
    surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
  };
  return JSON.stringify(line);
}

describe("parseLastHistoryLine", () => {
  test("returns the only line", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(100);
  });

  test("returns the LAST of several lines", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n${v2(200)}\n${v2(300)}\n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(300);
  });

  test("tolerates trailing blank lines / whitespace", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n${v2(250)}\n\n   \n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(250);
  });

  test("throws on empty input", () => {
    expect(() => parseLastHistoryLine("   \n\n")).toThrow("run-history.jsonl is empty");
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/history-jsonl.test.ts`. Expected: `error: Cannot find module './history-jsonl.ts'` — the implementation does not exist yet.

- [ ] **Step 3: Implement.** Create `scripts/perf/history-jsonl.ts`:

```ts
import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";

/**
 * Parse the last non-blank line of a `run-history.jsonl` text blob into a
 * HistoryLine. Each perf run writes a fresh single-run history file, so the
 * last line is that run's result. Throws on empty input. Callers that need a
 * schema-version guard apply it to the returned line.
 */
export function parseLastHistoryLine(text: string): HistoryLine {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("run-history.jsonl is empty");
  }
  return JSON.parse(last) as HistoryLine;
}
```

- [ ] **Step 4: Run it, expect PASS.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/history-jsonl.test.ts`. Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Typecheck + lint.** Commands: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun run typecheck` (expected: no errors) and `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx biome check scripts/perf/history-jsonl.ts scripts/perf/history-jsonl.test.ts` (expected: no diagnostics).

- [ ] **Step 6: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add scripts/perf/history-jsonl.ts scripts/perf/history-jsonl.test.ts
git commit -m "$(cat <<'EOF'
refactor(perf): extract shared parseLastHistoryLine helper

One thin last-non-blank-JSONL-line parser, to be shared by
emit-benchmark-json.ts and drift-check.ts (next two tasks). Behavior is
identical to emit's previous private copy: throws on empty input.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Point `emit-benchmark-json.ts` at the shared parser

**Files:**

- Modify `scripts/perf/emit-benchmark-json.ts` (delete the private `parseLastHistoryLine`, import the shared one)
- Test: `scripts/perf/emit-benchmark-json.test.ts` (unchanged — it exercises `runEmitBenchmarkJsonMain`, which must stay green)

- [ ] **Step 1: Confirm the current tests pass (baseline).** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/emit-benchmark-json.test.ts`. Expected: all pass (establishes the green baseline before the refactor).

- [ ] **Step 2: Delete the private copy and import the shared one.** In `scripts/perf/emit-benchmark-json.ts`, remove the local function:

```ts
function parseLastHistoryLine(text: string): HistoryLine {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error("run-history.jsonl is empty");
  }
  return JSON.parse(last) as HistoryLine;
}
```

Then add the import alongside the existing imports at the top of the file (after the existing `import type { HistoryLine, ... }` line):

```ts
import { parseLastHistoryLine } from "./history-jsonl.ts";
```

The call site in `runEmitBenchmarkJsonMain` (`const line = parseLastHistoryLine(text);`) is unchanged.

- [ ] **Step 3: Run the tests, expect PASS.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/emit-benchmark-json.test.ts`. Expected: all pass (same count as Step 1 — behavior is unchanged; the empty-input `runEmitBenchmarkJsonMain` error-path test still hits the shared parser's throw).

- [ ] **Step 4: Typecheck + lint.** Commands: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun run typecheck` (expected: no errors) and `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx biome check scripts/perf/emit-benchmark-json.ts` (expected: no diagnostics; in particular confirm `HistoryLine` is still imported as a type — it is still used by `toBenchmarkPoints`).

- [ ] **Step 5: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add scripts/perf/emit-benchmark-json.ts
git commit -m "$(cat <<'EOF'
refactor(perf): emit-benchmark-json uses shared parseLastHistoryLine

Drop the private copy in favour of the shared scripts/perf/history-jsonl.ts
helper. No behavior change; runEmitBenchmarkJsonMain tests stay green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `issueList` + `issueCreate` to `GhCli`

**Files:**

- Modify `packages/gateway/src/perf/bench-ci-gh.ts` (add two methods after `prCommentEdit`, before the closing `}` of the class)
- Test: `packages/gateway/src/perf/bench-ci-gh.test.ts` (append tests inside the existing `describe("GhCli", ...)` block)

These mirror the existing `prComment*` methods: routed through the retry-wrapped `#run`, body via `--body-file`, list parsed with the existing `parseJsonObjectArray`. `bench-ci-gh.ts` is coverage-floor-gated (≥80% line+branch), so both methods get direct unit tests.

- [ ] **Step 1: Write the failing tests.** Append inside the existing `describe("GhCli", () => { ... })` block in `packages/gateway/src/perf/bench-ci-gh.test.ts` (before its closing `});`):

```ts
  test("issueList: parses number+title array and passes the open+label+json args", async () => {
    const { spawn, calls } = makeFakeRunner([
      {
        exitCode: 0,
        stdout: '[{"number":12,"title":"perf drift A"},{"number":9,"title":"perf drift B"}]\n',
        stderr: "",
      },
    ]);
    const gh = new GhCli({ spawn });
    const out = await gh.issueList({ label: "perf-drift" });
    expect(out).toEqual([
      { number: 12, title: "perf drift A" },
      { number: 9, title: "perf drift B" },
    ]);
    expect(calls[0]?.args).toEqual([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "perf-drift",
      "--json",
      "number,title",
    ]);
  });

  test("issueList: empty stdout → empty array", async () => {
    const { spawn } = makeFakeRunner([{ exitCode: 0, stdout: "\n", stderr: "" }]);
    const gh = new GhCli({ spawn });
    expect(await gh.issueList({ label: "perf-drift" })).toEqual([]);
  });

  test("issueList: non-array JSON → empty array (no throw)", async () => {
    const { spawn } = makeFakeRunner([{ exitCode: 0, stdout: '{"oops":true}\n', stderr: "" }]);
    const gh = new GhCli({ spawn });
    expect(await gh.issueList({ label: "perf-drift" })).toEqual([]);
  });

  test("issueCreate: passes title, label, and --body-file", async () => {
    const { spawn, calls } = makeFakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const gh = new GhCli({ spawn });
    await gh.issueCreate({ title: "perf drift on S1", label: "perf-drift", bodyFile: "/tmp/b.md" });
    expect(calls[0]?.args).toEqual([
      "issue",
      "create",
      "--title",
      "perf drift on S1",
      "--label",
      "perf-drift",
      "--body-file",
      "/tmp/b.md",
    ]);
  });
```

- [ ] **Step 2: Run, expect FAIL.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun test src/perf/bench-ci-gh.test.ts`. Expected: TypeScript error `Property 'issueList' does not exist on type 'GhCli'` (and `issueCreate`), so the four new tests fail to compile.

- [ ] **Step 3: Implement the methods.** In `packages/gateway/src/perf/bench-ci-gh.ts`, add these two methods inside the `GhCli` class, immediately after `prCommentEdit` (before the class's closing `}`):

```ts
  async issueList(args: { label: string }): Promise<{ number: number; title: string }[]> {
    const r = await this.#run([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      args.label,
      "--json",
      "number,title",
    ]);
    const out = r.stdout.trim();
    if (out === "") return [];
    return parseJsonObjectArray(
      out,
      (rec) => typeof rec["number"] === "number" && typeof rec["title"] === "string",
      (rec) => ({ number: rec["number"] as number, title: rec["title"] as string }),
    );
  }

  async issueCreate(args: { title: string; label: string; bodyFile: string }): Promise<void> {
    await this.#run([
      "issue",
      "create",
      "--title",
      args.title,
      "--label",
      args.label,
      "--body-file",
      args.bodyFile,
    ]);
  }
```

- [ ] **Step 4: Run, expect PASS.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun test src/perf/bench-ci-gh.test.ts`. Expected: all GhCli tests pass (the four new + all pre-existing). `0 fail`.

- [ ] **Step 5: Typecheck + lint.** Commands: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun run typecheck` (expected: no errors) and `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx biome check packages/gateway/src/perf/bench-ci-gh.ts packages/gateway/src/perf/bench-ci-gh.test.ts` (expected: no diagnostics).

- [ ] **Step 6: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add packages/gateway/src/perf/bench-ci-gh.ts packages/gateway/src/perf/bench-ci-gh.test.ts
git commit -m "$(cat <<'EOF'
feat(perf): add GhCli.issueList + issueCreate (injectable, retry-wrapped)

Mirror the prComment* methods: routed through #run (retry/backoff) with the
spawn injection seam, body via --body-file, list parsed by parseJsonObjectArray.
Lets drift-check route its gh issue ops through the injectable GhCli (next task)
instead of an ad-hoc ghSpawn, so the upsert path becomes unit-testable.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: drift-check — replace `rollingMedian` with `medianOf`

**Files:**

- Modify `scripts/perf/drift-check.ts` (add the `medianOf` import; inline it in `detectDrift`; delete the local `rollingMedian`)
- Test: `scripts/perf/drift-check.test.ts` (the existing `describe("detectDrift", ...)` block must stay green — no edits)

`medianOf` (`baseline-median.ts`) is the byte-for-byte same median algorithm but throws on empty input; `rollingMedian` returned `0`. `detectDrift` only ever passes a fixed-size `k`-element window, so an empty window never occurs — the guard is defensive and preserves the contract.

- [ ] **Step 1: Confirm `detectDrift` tests pass (baseline).** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/drift-check.test.ts -t detectDrift`. Expected: the 7 `detectDrift` tests pass (green baseline before the swap).

- [ ] **Step 2: Add the import.** In `scripts/perf/drift-check.ts`, add to the import group (after the existing `import { SLO_THRESHOLDS } ...` line):

```ts
import { medianOf } from "../../packages/gateway/src/perf/baseline-median.ts";
```

- [ ] **Step 3: Inline `medianOf` in `detectDrift` and delete `rollingMedian`.** In `detectDrift`, change the line:

```ts
    const med = rollingMedian(window);
```

to:

```ts
    const med = window.length === 0 ? 0 : medianOf(window);
```

Then delete the now-unused local function entirely:

```ts
function rollingMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}
```

- [ ] **Step 4: Run, expect PASS.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/drift-check.test.ts`. Expected: all tests still pass (the `detectDrift` block is behavior-identical; `parseHistoryLines` / `isRunnerKind` blocks untouched). `0 fail`.

- [ ] **Step 5: Typecheck + lint.** Commands: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun run typecheck` (expected: no errors) and `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx biome check scripts/perf/drift-check.ts` (expected: no diagnostics — in particular, no "unused function `rollingMedian`").

- [ ] **Step 6: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add scripts/perf/drift-check.ts
git commit -m "$(cat <<'EOF'
refactor(perf): drift-check reuses medianOf instead of local rollingMedian

medianOf (baseline-median.ts) is the same median algorithm. detectDrift only
ever passes a fixed-size k-element window, so the empty->0 guard is defensive;
the existing detectDrift unit tests stay green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: drift-check — one-sample-per-run + create-only upsert via `GhCli`

**Files:**

- Modify `scripts/perf/drift-check.ts` (replace `parseHistoryLines` with `parseLatestV2Line`; rewrite `upsertDriftIssue` + `runDriftCheckMain`; delete `ghSpawn` + `ghIssueList`)
- Test: `scripts/perf/drift-check.test.ts` (migrate the `parseHistoryLines` describe → `parseLatestV2Line`; add a `runDriftCheckMain` describe)

This is the core wiring change. After it, drift-check depends only on the injectable `GhCli`, reads exactly one sample per run, and never re-comments on an already-open issue.

- [ ] **Step 1: Write the failing tests.** Edit `scripts/perf/drift-check.test.ts`.

First, update the imports. Change the `./drift-check.ts` import line:

```ts
import { detectDrift, isRunnerKind, parseHistoryLines } from "./drift-check.ts";
```

to:

```ts
import {
  detectDrift,
  isRunnerKind,
  parseLatestV2Line,
  runDriftCheckMain,
} from "./drift-check.ts";
```

Change the existing `node:path` import line `import { join } from "node:path";` to add `basename` (merge — do not add a second `node:path` line):

```ts
import { basename, join } from "node:path";
```

And add the `GhCli` import (the existing `node:fs` line already imports `mkdtempSync` + `writeFileSync`, which is all the new tests need — no `mkdirSync`, since `runDriftCheckMain` creates the per-run dir before the fake `gh` writes into it):

```ts
import { GhCli, type GhSpawnFn } from "../../packages/gateway/src/perf/bench-ci-gh.ts";
```

Replace the entire existing `describe("parseHistoryLines", () => { ... });` block with this migrated block (one line per run; returns the line or `null`):

```ts
describe("parseLatestV2Line", () => {
  const tmp = mkdtempSync(join(tmpdir(), "drift-parse-"));
  function writeFile(contents: string): string {
    const p = join(tmp, `h-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, contents, "utf8");
    return p;
  }
  function v2(p95: number): string {
    return JSON.stringify({
      schema_version: 2,
      run_id: "r",
      timestamp: "2026-06-16T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04",
      nimbus_git_sha: "abc",
      bun_version: "1.3.14",
      surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
    });
  }
  const v1 = JSON.stringify({ schema_version: 1, surfaces: { S1: { samples_count: 1, p95_ms: 1 } } });

  test("returns null when the file is unreadable", () => {
    expect(parseLatestV2Line(join(tmpdir(), "definitely-missing-drift.jsonl"))).toBeNull();
  });

  test("returns the last v2 line", () => {
    const line = parseLatestV2Line(writeFile(`${v2(100)}\n${v2(250)}\n`));
    expect(line?.surfaces["S1"]?.p95_ms).toBe(250);
  });

  test("returns null when the last line is schema_version 1 (non-comparable)", () => {
    expect(parseLatestV2Line(writeFile(`${v2(100)}\n${v1}\n`))).toBeNull();
  });

  test("returns null when the last line is malformed JSON", () => {
    expect(parseLatestV2Line(writeFile(`${v2(100)}\n{not json\n`))).toBeNull();
  });

  test("returns null on an empty file", () => {
    expect(parseLatestV2Line(writeFile("\n  \n"))).toBeNull();
  });
});

describe("runDriftCheckMain", () => {
  // 14 runs, oldest-first sha-0..sha-13. The newest 3 (>=11) regress to 130 over
  // a stable 100 baseline → a sustained drift on S1 (and only S1).
  const shas = Array.from({ length: 14 }, (_, i) => `sha-${i}`);
  const driftValue = (sha: string): number => (Number(sha.slice(4)) >= 11 ? 130 : 100);

  function v2Line(p95: number): string {
    return JSON.stringify({
      schema_version: 2,
      run_id: "r",
      timestamp: "2026-06-16T00:00:00Z",
      runner: "gha-ubuntu",
      os_version: "ubuntu-24.04",
      nimbus_git_sha: "abc",
      bun_version: "1.3.14",
      surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
    });
  }

  function fakeGh(opts: {
    valueForSha: (sha: string) => number;
    existingIssues: { number: number; title: string }[];
    calls: string[][];
  }): GhCli {
    const spawn: GhSpawnFn = async (args) => {
      const a = [...args];
      opts.calls.push(a);
      if (a[0] === "run" && a[1] === "list") {
        const newestFirst = [...shas]
          .reverse()
          .map((sha, i) => ({ databaseId: 1000 + i, headSha: sha }));
        return { exitCode: 0, stdout: `${JSON.stringify(newestFirst)}\n`, stderr: "" };
      }
      if (a[0] === "run" && a[1] === "download") {
        const dir = a[a.indexOf("--dir") + 1] as string;
        const sha = basename(dir);
        writeFileSync(join(dir, "run-history.jsonl"), `${v2Line(opts.valueForSha(sha))}\n`, "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (a[0] === "issue" && a[1] === "list") {
        return { exitCode: 0, stdout: `${JSON.stringify(opts.existingIssues)}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return new GhCli({ spawn, sleep: async () => {} });
  }

  test("files exactly one issue for a sustained-drifting surface with no open issue", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({ valueForSha: driftValue, existingIssues: [], calls });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("perf: sustained drift detected on S1 (gha-ubuntu)");
  });

  test("does NOT create when an open issue already exists (create-only)", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({
      valueForSha: driftValue,
      existingIssues: [{ number: 7, title: "perf: sustained drift detected on S1 (gha-ubuntu)" }],
      calls,
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    expect(calls.filter((c) => c[0] === "issue" && c[1] === "create")).toHaveLength(0);
  });

  test("a flat (non-drifting) series files nothing and never lists issues", async () => {
    const calls: string[][] = [];
    const gh = fakeGh({ valueForSha: () => 100, existingIssues: [], calls });
    const tmpDir = mkdtempSync(join(tmpdir(), "drift-wrap-"));
    await runDriftCheckMain({ gh, runner: "gha-ubuntu", tmpDir, stderr: () => {} });
    expect(calls.filter((c) => c[0] === "issue")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/drift-check.test.ts`. Expected: compile/resolve failure — `parseLatestV2Line` and `runDriftCheckMain` behaviors don't match yet (`parseLatestV2Line` is not exported; the create-only / lazy-list logic is not implemented). The `detectDrift` and `isRunnerKind` blocks still pass.

- [ ] **Step 3: Rewrite the drift-check internals.** Edit `scripts/perf/drift-check.ts`.

(a) Update the `node:fs` import to add `writeFileSync` and drop nothing it still uses:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
```

(b) Add the shared-parser import (after the `medianOf` import added in Task 4):

```ts
import { parseLastHistoryLine } from "./history-jsonl.ts";
```

(c) Delete the local `ghSpawn` function and the local `ghIssueList` function entirely (both are replaced by `GhCli` methods).

(d) Replace the exported `parseHistoryLines` function:

```ts
export function parseHistoryLines(path: string): HistoryLine[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: HistoryLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isHistoryLineV2(parsed)) lines.push(parsed);
      // skip schema_version 1 (non-comparable) or otherwise malformed lines
    } catch {
      // skip malformed lines
    }
  }
  return lines;
}
```

with the one-sample-per-run reader:

```ts
/**
 * Read the LAST line of a per-run `run-history.jsonl` artifact and return it only
 * if it is a comparable v2 HistoryLine. Each perf run writes a fresh single-run
 * file, so the last line is that run's result — one sample per run. A missing /
 * unreadable / malformed / non-v2 artifact yields null (skipped by the caller).
 */
export function parseLatestV2Line(path: string): HistoryLine | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let line: HistoryLine;
  try {
    line = parseLastHistoryLine(raw);
  } catch {
    return null;
  }
  return isHistoryLineV2(line) ? line : null;
}
```

(e) Rewrite `upsertDriftIssue` to take the `GhCli` + a tmp root and be create-only:

```ts
async function upsertDriftIssue(
  gh: GhCli,
  surfaceId: BenchSurfaceId,
  runner: RunnerKind,
  existingIssues: GhIssue[],
  tmpRoot: string,
  stderr: (s: string) => void,
): Promise<void> {
  const issueTitle = `perf: sustained drift detected on ${surfaceId} (${runner})`;
  if (existingIssues.some((i) => i.title === issueTitle)) {
    // Create-only: a standing open issue already represents this drift. Posting a
    // fresh comment every daily run would just be noise, so leave it untouched.
    stderr(`drift-check: open issue already tracks ${surfaceId} (${runner}); leaving it`);
    return;
  }
  const bodyDir = mkdtempSync(join(tmpRoot, "drift-issue-"));
  const bodyFile = join(bodyDir, "body.md");
  writeFileSync(
    bodyFile,
    `The rolling-median drift detector has flagged surface \`${surfaceId}\` on runner \`${runner}\`.\n\n` +
      `The last 3+ consecutive \`main\` samples are each more than ${String(DRIFT_NOISE_FLOOR_PCT)}% worse than the rolling median of the preceding 7. This is a sustained regression, not a one-off spike.\n\n` +
      `See the [/dev/bench dashboard](https://github.com/nimbus-agent/Nimbus/tree/perf-data/dev/bench) and investigate recent commits for a regression on this surface.\n`,
    "utf8",
  );
  await gh.issueCreate({ title: issueTitle, label: DRIFT_ISSUE_LABEL, bodyFile });
}
```

(f) Rewrite `runDriftCheckMain` so it parses one sample per run, computes drift first, and only touches the issue API when something drifts:

```ts
export async function runDriftCheckMain(deps: RunDriftCheckDeps): Promise<void> {
  const runner = deps.runner;
  const tmpRoot = deps.tmpDir ?? tmpdir();
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));

  let runs: { databaseId: number; headSha: string }[];
  try {
    runs = await deps.gh.runListRecentSuccesses({
      workflow: PERF_WORKFLOW,
      branch: "main",
      limit: DRIFT_HISTORY_RUNS,
    });
  } catch (err) {
    stderr(`drift-check: gh run list failed: ${errMsg(err)}; aborting`);
    return;
  }
  if (runs.length === 0) {
    stderr("drift-check: no successful main runs found; nothing to check");
    return;
  }

  // `gh run list` is newest-first; detectDrift walks the series as a time axis
  // (index 0 = oldest), so reverse to oldest-first before collecting.
  runs.reverse();

  const scratchDir = mkdtempSync(join(tmpRoot, "drift-check-"));
  const historyLines: HistoryLine[] = [];
  for (const { databaseId, headSha } of runs) {
    const dir = join(scratchDir, headSha);
    mkdirSync(dir, { recursive: true });
    let downloaded = false;
    try {
      downloaded = await deps.gh.runDownloadArtifact({
        runId: databaseId,
        name: `perf-${runner}-${headSha}`,
        dir,
      });
    } catch (err) {
      stderr(`drift-check: download (${headSha}) failed: ${errMsg(err)}; skipping`);
      continue;
    }
    if (!downloaded) continue;
    const line = parseLatestV2Line(join(dir, "run-history.jsonl"));
    if (line !== null) historyLines.push(line);
  }
  if (historyLines.length === 0) {
    stderr("drift-check: no history lines collected; nothing to check");
    return;
  }

  // First pass: which trend (smaller-is-better) surfaces are drifting?
  const drifting: BenchSurfaceId[] = [];
  for (const [surfaceId, field] of TREND_METRIC_BY_SURFACE) {
    const series: DriftSample[] = historyLines
      .map((line) => {
        const surface: HistoryLineSurface | undefined = line.surfaces[surfaceId];
        if (surface === undefined) return null;
        const val = surface[field];
        return typeof val === "number" ? { value: val } : null;
      })
      .filter((s): s is DriftSample => s !== null);
    if (detectDrift(series, DRIFT_NOISE_FLOOR_PCT)) drifting.push(surfaceId);
  }
  if (drifting.length === 0) return; // no drift → no issue API calls at all

  // Fetch open drift issues once (best-effort: a list failure must not abort the
  // create path — worst case is a duplicate issue a human dedups).
  let existingIssues: GhIssue[] = [];
  try {
    existingIssues = await deps.gh.issueList({ label: DRIFT_ISSUE_LABEL });
  } catch (err) {
    stderr(`drift-check: gh issue list failed: ${errMsg(err)}; proceeding with none known`);
  }

  for (const surfaceId of drifting) {
    stderr(`drift-check: drift detected on ${surfaceId} (${runner}); upserting gh issue`);
    try {
      await upsertDriftIssue(deps.gh, surfaceId, runner, existingIssues, tmpRoot, stderr);
    } catch (err) {
      stderr(`drift-check: upsert failed for ${surfaceId}: ${errMsg(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/drift-check.test.ts`. Expected: all pass — `detectDrift` (7), `parseLatestV2Line` (5), `runDriftCheckMain` (3), `isRunnerKind` (2). `0 fail`.

- [ ] **Step 5: Typecheck + lint.** Commands: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring/packages/gateway" && bun run typecheck` (expected: no errors — confirms no dangling reference to `ghSpawn`/`ghIssueList`/`parseHistoryLines`) and `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx biome check scripts/perf/drift-check.ts scripts/perf/drift-check.test.ts` (expected: no diagnostics — in particular no unused `GhIssue`/imports).

- [ ] **Step 6: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add scripts/perf/drift-check.ts scripts/perf/drift-check.test.ts
git commit -m "$(cat <<'EOF'
feat(perf): drift-check one-sample-per-run + create-only upsert via GhCli

Route gh issue ops through the injectable GhCli (issueList/issueCreate),
making runDriftCheckMain unit-testable (new wrapper tests: drift+no-issue ->
one create; drift+open-issue -> no create; flat series -> no issue API calls).
Read one v2 sample per run (parseLatestV2Line + shared parser) instead of all
lines. Upsert is now create-only: an open issue is left untouched, killing the
daily re-comment spam. Drops the ad-hoc ghSpawn/ghIssueList.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Create the `_perf-drift.yml` scheduled workflow

**Files:**

- Create: `.github/workflows/_perf-drift.yml`

No unit test (workflow YAML). Verify with `actionlint` (if available) + a Bun YAML parse asserting triggers/permissions.

- [ ] **Step 1: Write the workflow.** Create `.github/workflows/_perf-drift.yml`:

```yaml
name: Performance Drift Check

# Daily sustained-drift watch over recent `main` perf history. Downloads the last
# 14 gha-ubuntu run-history artifacts, runs the rolling-median detector, and files
# ONE `perf-drift` issue per sustained-regressing trend surface (create-only: an
# already-open issue is left untouched — no daily re-comment). Advisory: it never
# gates a build.
#
# Triggers:
#   - schedule (06:00 UTC daily) — ~2h after _perf.yml's 04:00 bench crons so the
#     latest artifact exists. GitHub runs `schedule` only on this repo's default
#     branch, never for forks/fork PRs, so the `issues: write` grant is
#     non-fork-triggered by construction.
#   - workflow_dispatch — manual smoke test from the Actions UI.

on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

# Default-deny baseline (Scorecard Token-Permissions); the job grants only what
# it uses (per-job, mirroring _perf.yml).
permissions: {}

jobs:
  drift-check:
    name: Perf sustained-drift check
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      contents: read # checkout
      actions: read # gh run list + gh run download (perf artifacts)
      issues: write # gh label create + gh issue list/create (perf-drift)
    concurrency:
      group: perf-drift
      cancel-in-progress: false
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@9af89fc71515a100421586dfdb3dc9c984fbf411 # v2.19.4
        with:
          egress-policy: audit

      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false

      - name: Setup Bun and install dependencies
        uses: ./.github/actions/setup-nimbus-ci

      - name: Ensure perf-drift label exists
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          # `gh issue create --label` FAILS on a missing label (it does not
          # auto-create); --force makes this idempotent (create or update).
          gh label create perf-drift \
            --color B60205 \
            --description "Sustained performance drift detected on a trend surface" \
            --force

      - name: Run drift check
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NIMBUS_PERF_RUNNER: gha-ubuntu
        run: bun scripts/perf/drift-check.ts
```

- [ ] **Step 2: Verify with actionlint (best-effort).** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bunx actionlint .github/workflows/_perf-drift.yml`. Expected: exits 0, no output. If `bunx actionlint` cannot fetch the binary in this environment, skip to Step 3 (the YAML parse is the floor).

- [ ] **Step 3: Verify it parses and the triggers/permissions are exactly as intended.** Command:

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun -e '
import { parse } from "yaml";
const doc = parse(await Bun.file(".github/workflows/_perf-drift.yml").text());
const on = doc.on ?? doc[true];
if (!Array.isArray(on.schedule) || on.schedule[0].cron !== "0 6 * * *") throw new Error("bad schedule: " + JSON.stringify(on.schedule));
if (!("workflow_dispatch" in on)) throw new Error("missing workflow_dispatch");
if (Object.keys(doc.permissions ?? {}).length !== 0) throw new Error("workflow permissions not default-deny");
const job = doc.jobs["drift-check"];
if (job.permissions.contents !== "read" || job.permissions["actions"] !== "read" || job.permissions.issues !== "write")
  throw new Error("wrong job permissions: " + JSON.stringify(job.permissions));
const steps = job.steps.map((s) => s.name);
if (!steps.includes("Ensure perf-drift label exists")) throw new Error("missing label step");
if (!steps.includes("Run drift check")) throw new Error("missing run step");
if (job.concurrency.group !== "perf-drift") throw new Error("wrong concurrency group");
console.log("OK steps:", steps.join(" | "));
'
```

Expected output: a single line `OK steps: Harden Runner | Checkout | Setup Bun and install dependencies | Ensure perf-drift label exists | Run drift check` and exit 0.

- [ ] **Step 4: Lint the workflow comment block (yaml-lint via biome is not applicable; confirm no markdown/format gate touches it).** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && git diff --stat`. Expected: shows only `.github/workflows/_perf-drift.yml` newly added. (Workflow YAML is not covered by biome; the actionlint + parse checks above are the gates.)

- [ ] **Step 5: Commit.**

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git add .github/workflows/_perf-drift.yml
git commit -m "$(cat <<'EOF'
ci(perf): daily _perf-drift.yml runs the sustained-drift detector

Schedule (06:00 UTC) + workflow_dispatch. Ensures the perf-drift label exists
(idempotent gh label create --force — gh issue create --label fails on a missing
label), then runs scripts/perf/drift-check.ts over the gha-ubuntu history.
Workflow-level permissions: {} default-deny; job grants contents:read +
actions:read + issues:write. Advisory only — never gates a build.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full pre-flight before pushing

**Files:** none (verification only)

- [ ] **Step 1: Run the full perf suite.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun test scripts/perf/ packages/gateway/src/perf/`. Expected: `0 fail` across all perf script + gateway-perf tests.

- [ ] **Step 2: Run the fast static gates.** Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun run preflight:fast`. Expected: typecheck ✓, lint ✓. (`lint:markdown` may report pre-existing untracked Slice-8 docs unrelated to this branch — confirm any failure is only those files, not anything in this branch's diff.)

- [ ] **Step 3: Confirm the coverage-floor for the touched gateway file (Docker-Linux-authoritative).** `bench-ci-gh.ts` gained two methods; confirm it still clears ≥80% line+branch. Command: `cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring" && bun run audit:coverage-floor` (or the Docker-Linux variant per the `nimbus-coverage-floor` skill if local Bun coverage diverges from CI). Expected: `bench-ci-gh.ts` is at or above the floor (the four new GhCli tests cover both new methods + their empty/non-array branches). `scripts/perf/*` are not under the floor scan roots, so the new script files are not floor-gated.

- [ ] **Step 4: Push and open the PR.** Command:

```bash
cd "C:/gitrep/Nimbus/.claude/worktrees/perf-drift-wiring"
git push -u origin dev/asafgolombek/perf-drift-wiring
```

Then open a PR titled `feat(perf): wire up the sustained-drift detector (daily _perf-drift.yml)` with the spec summary in the body. Label it `perf` if the bench should validate on-PR. Note in the body that it is stacked on #656 and should merge after it (or rebase onto `main` once #656 lands).

---

## Notes for the executing session

- **Branch is stacked on #656.** The first two commits on this branch are the Biome-2.5.0/ovsx gate fixes. After #656 merges to `main`, run `git fetch origin main && git rebase origin/main` — the two duplicate commits drop out (identical patches), leaving only the drift-wiring commits.
- **`detectDrift` thresholds are untouched** (`k=7`, `n=3`, `DRIFT_NOISE_FLOOR_PCT=10`, `DRIFT_HISTORY_RUNS=14`) — do not change them.
- **The wrapper test's fake `gh`** writes the staged `run-history.jsonl` into the `--dir` that `runDownloadArtifact` is told to use (dir basename = headSha), because `runDriftCheckMain` reads that file after the download returns. This is the only way to drive the real download→read flow with an injected spawn.
- **`gh label create --force`** needs `issues: write` (already granted) — labels are part of the issues write scope.
