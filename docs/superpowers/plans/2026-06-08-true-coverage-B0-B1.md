# True Coverage Sub-project B — B0 (test-helper exclusions + reseed helper) & B1 (engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first two Sub-project B PRs — **B0** removes 4 test-only helper files from the branch-coverage baseline and adds the `reseed-docker.sh` reseed helper; **B1** raises the 7 `gateway/engine` files to ≥80% branch coverage and shrinks the baseline accordingly.

**Architecture:** Pure coverage work on the dual line+branch floor gate shipped in Sub-project A (PR #530). No production behavior changes. Each PR follows the fixed per-PR loop in the [B design spec](../specs/2026-06-08-true-coverage-B-close-branch-gaps-design.md) §3: branch from fresh main → `git merge origin/main` → TDD tests for uncovered BRDA branches → Docker-Linux reseed → gate green → PR (one CI round).

**Tech Stack:** Bun 1.2+/TypeScript strict, Biome, `bun:test`, Istanbul-instrumented coverage (Babel preset-typescript + babel-plugin-istanbul), Docker `oven/bun:latest`, the `scripts/coverage-floor/*` gate.

---

## Load-bearing context (read before any task)

- **The gate / ratchet:** `scripts/coverage-floor/check.ts`. `computeUpdatedBaseline` ratchets each file's watermark via `Math.max(existing, actual)` per axis and **drops** a file once it clears both 80% floors. Baseline: `docs/structure-audit/coverage-baseline.json` (v2: `{min_line_pct, min_branch_pct}`).
- **Exclusions:** `scripts/coverage-floor/exclusions.ts` — tagged union `{kind:"exact"|"dirPrefix"|"basenameRegex"|"pathRegex", ...}`, `EXCLUSIONS` is `Object.freeze([...])`. There is an exclusion-**parity** test (count assertion) that fails if you add an entry without bumping the expected count — find it and update it (Task B0.1 Step 2).
- **No `any`** in tests (repo non-negotiable #7) — use `unknown` + narrowing/cast, or `as never` for exhaustive defaults. Tests pass Biome + `tsc --noEmit`.
- **Unreachable-branch policy** (spec §5): prefer triggering a defensive guard with a type-safe cast; if truly unreachable, leave it (ratchet holds it) and note it as a Sub-project D candidate — never add `/* istanbul ignore */` in B.
- **Reseed is Linux-authoritative** — generate the reseed lcov only via Docker (`reseed-docker.sh`) or CI, never a raw Windows run.
- **Per-test timeout** under instrumentation is `--timeout 60000` (already in `build-lcov.sh`); the fast dev-loop `bun test` stays at 5000ms.
- **Fresh/restored worktree:** run `bun install` + `cd packages/client && bun run build` before any local typecheck/merge step.
- **Commit trailers:** the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer in every commit message below is a Claude Code harness requirement for commits *this* agent authors. An executor running under a different harness/identity (a human, another model) should substitute their own attribution per their git config — the trailer is not a project convention, just the authoring agent's mandated footer.

---

## File Structure

**B0 creates/modifies:**

- Create: `scripts/coverage-floor/reseed-docker.sh` — Docker-Linux lcov generator + host reseed/gate. One responsibility: produce a CI-authoritative `coverage/lcov.info` and run the gate.
- Modify: `scripts/coverage-floor/exclusions.ts` — add 4 `exact` test-helper exclusions.
- Modify: `scripts/coverage-floor/exclusions.test.ts` (or wherever the parity-count test lives) — bump expected count.
- Modify: `docs/structure-audit/coverage-baseline.json` — remove the 4 excluded entries.

**B1 modifies (per engine file: its co-located `.test.ts`) + the baseline:**

- `packages/gateway/src/engine/delegated-approval-broker.test.ts`
- `packages/gateway/src/engine/delegation-store.test.ts`
- `packages/gateway/src/engine/search-ranking.test.ts`
- `packages/gateway/src/engine/coordinator.test.ts`
- `packages/gateway/src/engine/planner.test.ts`
- `packages/gateway/src/engine/delegated-request-remote.test.ts`
- `packages/gateway/src/engine/run-ask.test.ts`
- Modify: `docs/structure-audit/coverage-baseline.json` — reseed (those files raise watermark / drop out).

---

## PR B0 — Test-helper exclusions + reseed helper

**Branch:** `dev/asafgolombek/true-coverage-B0` (already created; worktree `.claude/worktrees/tc-B0`). The B-design spec + review are already committed here. Continue on this branch.

### Task B0.1: Exclude the 4 test-only helper files

**Files:**

- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `scripts/coverage-floor/exclusions.test.ts` (add `isExempt` regression cases — Step 3)

The 4 files were verified test-only on 2026-06-08 (imported only by `*.test.ts`): `tui/test-helpers/context.ts`, `commands/cli-test-helpers.ts`, `identity/identity-test-helpers.ts`, `updater/updater-test-fixtures.ts`. (`tui/ipc-context.ts` was rejected — it is production code; do **not** exclude it.)

> **Note (verified 2026-06-08):** `exclusions.test.ts` asserts specific `isExempt(path)` results + the frozen-registry shape — there is **no `EXCLUSIONS.length` count assertion** to bump. `check-exclusion-parity.ts` is one-directional (it only checks every Sonar `sonar.coverage.exclusions` pattern has a covering *local* exemption), so adding *local-only* exclusions cannot break parity and needs no `sonar-project.properties` change. Add positive `isExempt` regression tests instead (Step 3).

- [ ] **Step 1: Re-verify test-only status (guard against drift)**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-B0
for f in "tui/test-helpers/context" "commands/cli-test-helpers" "identity/identity-test-helpers" "updater/updater-test-fixtures"; do
  echo "--- $f ---"
  grep -rln "$f" packages --include=*.ts --include=*.tsx | grep -vE "\.test\.(ts|tsx)$" | grep -v "$f.ts"
done
```

Expected: no output under any file (all importers are `*.test.ts`). If any production importer appears, STOP and report — that file is not excludable.

- [ ] **Step 2: Add the 4 exclusions**

In `scripts/coverage-floor/exclusions.ts`, inside the `EXCLUSIONS` array (next to the other `exact` entries), add:

```ts
  // Test-only support files (imported solely by *.test.ts; not shipped logic). Verified
  // 2026-06-08 by import grep. Sub-project B0; D may relocate these under a `testing/` dir
  // (which discoverSourceFiles already auto-skips) to make the exemption self-enforcing.
  { kind: "exact", path: "packages/cli/src/tui/test-helpers/context.ts" },
  { kind: "exact", path: "packages/cli/src/commands/cli-test-helpers.ts" },
  { kind: "exact", path: "packages/gateway/src/identity/identity-test-helpers.ts" },
  { kind: "exact", path: "packages/gateway/src/updater/updater-test-fixtures.ts" },
```

- [ ] **Step 3: Add `isExempt` regression tests for the 4 new exclusions**

In `scripts/coverage-floor/exclusions.test.ts`, add a new `describe` block (mirroring the existing per-category blocks) so the exemption is locked by a test:

```ts
describe("isExempt — test-only support files (B0)", () => {
  test("tui/test-helpers/context.ts is exempt", () => {
    expect(isExempt("packages/cli/src/tui/test-helpers/context.ts")).toBe(true);
  });
  test("commands/cli-test-helpers.ts is exempt", () => {
    expect(isExempt("packages/cli/src/commands/cli-test-helpers.ts")).toBe(true);
  });
  test("identity/identity-test-helpers.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/identity/identity-test-helpers.ts")).toBe(true);
  });
  test("updater/updater-test-fixtures.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/updater/updater-test-fixtures.ts")).toBe(true);
  });
  test("ipc-context.ts (production) is NOT exempt", () => {
    expect(isExempt("packages/cli/src/tui/ipc-context.ts")).toBe(false);
  });
});
```

- [ ] **Step 4: Run the exclusions unit tests**

Run:

```bash
bun test scripts/coverage-floor/exclusions.test.ts
```

Expected: PASS, including the 5 new cases (4 exempt, 1 not-exempt).

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts scripts/coverage-floor/exclusions.test.ts
git commit -m "test(coverage): exempt 4 test-only helper files from the coverage floor (B0)

Imported solely by *.test.ts; verified test-only 2026-06-08. ipc-context.ts
was rejected as production code. Adds isExempt regression cases.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B0.2: Drop the 4 excluded entries from the baseline

**Files:**

- Modify: `docs/structure-audit/coverage-baseline.json`

The baseline still lists these 4 files. Because they are now exempt, they must leave the baseline. This is a purely subtractive hand-edit (safe; relaxes nothing else) — main's verified watermarks for all other files stay byte-identical, so the gate stays green on CI without a reseed.

- [ ] **Step 1: Remove the 4 entries**

Delete these 4 keys (and their `{min_line_pct, min_branch_pct}` objects) from `coverage-baseline.json`:

```text
packages/cli/src/tui/test-helpers/context.ts
packages/cli/src/commands/cli-test-helpers.ts
packages/gateway/src/identity/identity-test-helpers.ts
packages/gateway/src/updater/updater-test-fixtures.ts
```

- [ ] **Step 2: Verify the JSON is valid and the count dropped by 4**

Run:

```bash
node -e 'const b=require("./docs/structure-audit/coverage-baseline.json"); console.log("entries:", Object.keys(b.files).length); ["packages/cli/src/tui/test-helpers/context.ts","packages/cli/src/commands/cli-test-helpers.ts","packages/gateway/src/identity/identity-test-helpers.ts","packages/gateway/src/updater/updater-test-fixtures.ts"].forEach(k=>{if(b.files[k])throw new Error("still present: "+k)}); console.log("4 removed OK")'
```

Expected: `entries: 185` then `4 removed OK` (189 − 4).

- [ ] **Step 3: Commit**

```bash
git add docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage): drop the 4 newly-exempt test-helper entries from the baseline (B0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B0.3: Author `reseed-docker.sh`

**Files:**

- Create: `scripts/coverage-floor/reseed-docker.sh`

It streams the working tree (node_modules excluded) into `oven/bun:latest`, installs with a **named cache volume** (bun install paid once), runs `build-lcov.sh`, copies the lcov back to the host, then reseeds + gates on the host. Streaming the working tree (not bind-mounting the repo) keeps the host's Windows `node_modules` untouched.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# reseed-docker.sh — generate a CI-Linux-authoritative coverage/lcov.info via Docker,
# then reseed the branch-coverage baseline + run the gate on the host. Use before every
# Sub-project B PR so the ratchet sees Linux branch percentages, never per-OS-skewed local
# numbers. The host's node_modules is never touched (working tree is streamed in; install
# happens inside the container against a named cache volume).
#
# Usage: scripts/coverage-floor/reseed-docker.sh [--clean|-c]
#   --clean / -c   drop + recreate the bun-cache volume first (use if deps changed or the
#                  cache is corrupt; the next run re-installs from scratch).
set -euo pipefail

# Git Bash / MSYS on Windows rewrites container-internal paths (/out, /src, /root/...) and
# the `-v host:container` colon args into Windows paths, breaking docker. Disable that.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="oven/bun:latest"        # bun 1.3.14 == CI
CACHE_VOL="nimbus-bun-cache"   # named volume: bun install cache, paid once

if [[ "${1:-}" == "--clean" || "${1:-}" == "-c" ]]; then
  echo "--- cleaning bun-cache volume ${CACHE_VOL} ---"
  docker volume rm "${CACHE_VOL}" 2>/dev/null || true
fi

cd "${REPO_ROOT}"
docker volume create "${CACHE_VOL}" >/dev/null
mkdir -p coverage

echo "--- docker: build instrumented lcov (oven/bun:latest) ---"
# Stream tracked + untracked working-tree files (node_modules/.git/coverage/dist excluded)
# into the container, extract, install, build the client, run build-lcov.sh, copy lcov out.
tar --exclude=node_modules --exclude=.git --exclude=coverage --exclude=dist \
    --exclude=.claude -c -C "${REPO_ROOT}" . \
  | docker run --rm -i \
      -v "${CACHE_VOL}:/root/.bun/install/cache" \
      -v "${REPO_ROOT}/coverage:/out" \
      -w /src \
      "${IMAGE}" \
      bash -c '
        set -euo pipefail
        mkdir -p /src && tar -x -C /src
        bun install --frozen-lockfile
        (cd packages/client && bun run build)
        bash scripts/coverage-floor/build-lcov.sh
        cp coverage/lcov.info /out/lcov.info
      '

echo "--- host: reseed baseline + gate (lcov is Docker/Linux) ---"
bun run audit:coverage-floor:update-baseline
bun run audit:coverage-floor
```

- [ ] **Step 2: Make it executable + Biome/format check**

Run:

```bash
chmod +x scripts/coverage-floor/reseed-docker.sh
bunx biome check scripts/coverage-floor/reseed-docker.sh || true   # shell file: biome ignores; no error expected
bash -n scripts/coverage-floor/reseed-docker.sh && echo "shell syntax OK"
```

Expected: `shell syntax OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage-floor/reseed-docker.sh
git commit -m "build(coverage): add reseed-docker.sh — Linux-authoritative lcov reseed helper (B0)

Streams the working tree into oven/bun:latest (named bun-cache volume), runs
build-lcov.sh, reseeds + gates on the host. Host node_modules untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task B0.4: Validate end-to-end (smoke-test the script + gate)

**Files:** none (validation only)

- [ ] **Step 1: Run the reseed helper (first real Docker run — validates the script)**

Run:

```bash
bash scripts/coverage-floor/reseed-docker.sh
```

Expected: a `coverage/lcov.info` is produced; the final line prints `coverage-floor: ok (...)`. The `build-lcov.sh` summary should report thousands of `BRDA` records (e.g. ~24000) and ~700+ source files. If Docker errors on the tar stream or `bun install`, fix the script and re-commit (amend Task B0.3).

- [ ] **Step 2: Confirm the 4 excluded files are absent from the fresh lcov gate**

Run:

```bash
git diff --stat docs/structure-audit/coverage-baseline.json
```

Expected: **either no change** (the Docker reseed reproduced main's watermarks exactly — keep the hand-edited baseline from B0.2) **or** only watermark jitter on unrelated files. If the reseed reintroduced any of the 4 excluded keys, the exclusion wiring is wrong — STOP and re-check Task B0.1. If it produced large unrelated drift, discard it (`git checkout docs/structure-audit/coverage-baseline.json`) and rely on the hand-edited baseline + CI.

- [ ] **Step 3: Restore the hand-edited baseline if the reseed only jittered**

The hand-edited baseline (B0.2) matches main's verified watermarks. Unless the Docker reseed produced a *materially better* baseline (real coverage gains — there are none in B0), keep the hand-edit:

```bash
git checkout docs/structure-audit/coverage-baseline.json   # only if Step 2 showed jitter-only drift
bun run audit:coverage-floor                               # re-confirm green against the existing lcov
```

Expected: `coverage-floor: ok`.

- [ ] **Step 4: Open the B0 PR**

```bash
git merge origin/main   # keep current; resolve baseline via §3.2 if it conflicts
git push -u origin dev/asafgolombek/true-coverage-B0
gh pr create --base main --title "test(coverage): B0 — exempt test-helpers + reseed-docker.sh (Sub-project B)" \
  --body "Sub-project B, PR 0. Exempts 4 verified test-only helper files from the branch-coverage floor (−4 baseline entries → 185) and adds scripts/coverage-floor/reseed-docker.sh (Linux-authoritative reseed helper). No production behavior change.

See docs/superpowers/specs/2026-06-08-true-coverage-B-close-branch-gaps-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: CI `Unit + Coverage` job green in one round (subtractive change). The chronic `Cross-platform (gateway, windows-2025)` flake may be red — rerun it, it is not B0's.

---

## PR B1 — engine subsystem to ≥80% branch

**Branch:** `dev/asafgolombek/true-coverage-B1` from fresh main **after B0 merges** (so B0's exclusions + the reseed helper are present).

7 engine files are below the branch floor (day-1 watermarks; re-pull current values from the baseline at start):

| File | branch% | line% |
|---|---|---|
| `delegated-approval-broker.ts` | 50 | 80 |
| `delegation-store.ts` | 60 | 80 |
| `search-ranking.ts` | 66.67 | 80 |
| `coordinator.ts` | 75 | 80 |
| `planner.ts` | 75 | 80 |
| `delegated-request-remote.ts` | 76.92 | 80 |
| `run-ask.ts` | 76.98 | 80 |

**Do NOT touch** `engine/executor.ts` (HITL slice I2–I4) or `engine/tool-output-envelope.ts` (I11) — those are reserved for the ★ 100% flagship and are already ≥80% (not in this list).

### Task B1.0: Branch + baseline lcov

- [ ] **Step 1: Create the branch from fresh main**

```bash
cd C:/gitrep/Nimbus
git fetch origin main
git worktree add -b dev/asafgolombek/true-coverage-B1 .claude/worktrees/tc-B1 origin/main
cd .claude/worktrees/tc-B1
bun install && (cd packages/client && bun run build)
```

- [ ] **Step 2: Generate a baseline engine lcov to read uncovered branches from**

Run the helper once to get a current `coverage/lcov.info` (this also reseeds, but discard that — we only want the lcov to read BRDA from):

```bash
bash scripts/coverage-floor/reseed-docker.sh
git checkout docs/structure-audit/coverage-baseline.json   # keep main's baseline; we reseed for real after writing tests
```

Expected: `coverage/lcov.info` exists.

- [ ] **Step 3: Extract uncovered branches for the 7 engine files**

For each engine file, list its `BRDA` records whose `taken` is `-` or `0` (uncovered), mapped to line numbers:

```bash
for f in delegated-approval-broker delegation-store search-ranking coordinator planner delegated-request-remote run-ask; do
  echo "=== engine/$f.ts uncovered branches (line,block,branch) ==="
  awk -v want="packages/gateway/src/engine/$f.ts" '
    $0=="SF:"want {on=1; next}
    on && /^SF:/ {on=0}
    on && /^BRDA:/ {split(substr($0,6),a,","); if(a[4]=="-"||a[4]=="0") print a[1]","a[2]","a[3]}
  ' coverage/lcov.info
done
```

Keep this output — it is the work-list for Tasks B1.1–B1.7. (`BRDA:<line>,<block>,<branch>,<taken>`.)

### Task B1.1: `delegated-approval-broker.ts` → 100% branch (worked exemplar)

**Files:**

- Modify: `packages/gateway/src/engine/delegated-approval-broker.test.ts`

Source is 47 lines. The existing test (`delegated-approval-broker.test.ts`) covers the happy `respond()` path and the timeout path. The uncovered branch is `respond()` when the `requestId` is unknown — `if (p === undefined) return false;` (broker.ts:39) — and `listPending()` (broker.ts:19-21) is never called.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("delegatedApprovalBroker", …)` block in `delegated-approval-broker.test.ts`:

```ts
  it("respond() to an unknown requestId returns false (no pending entry)", () => {
    const ok = delegatedApprovalBroker.respond("does-not-exist", "peer:bob", true);
    expect(ok).toBe(false);
  });

  it("listPending() reflects open requests and clears after respond()", () => {
    const ids: string[] = [];
    delegatedApprovalBroker.setBroadcast((requestId) => ids.push(requestId));
    const p = delegatedApprovalBroker.request({ prompt: "ship it?" }, 5000);
    const pending = delegatedApprovalBroker.listPending();
    expect(pending.some((e) => e.requestId === ids[0] && e.prompt === "ship it?")).toBe(true);
    delegatedApprovalBroker.respond(ids[0]!, "peer:ann", false);
    expect(delegatedApprovalBroker.listPending().some((e) => e.requestId === ids[0])).toBe(false);
    return p; // settle the pending promise so the test doesn't leak a timer
  });
```

- [ ] **Step 2: Run to verify they pass against current source (coverage-only; behavior already exists)**

Run:

```bash
bun test packages/gateway/src/engine/delegated-approval-broker.test.ts
```

Expected: PASS (these assert existing behavior on previously-uncovered branches). If `respond()` of an unknown id returned anything but `false`, that is a real bug — STOP and report per systematic-debugging.

- [ ] **Step 3: Confirm no `any` / types clean**

Run:

```bash
bunx biome check packages/gateway/src/engine/delegated-approval-broker.test.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/engine/delegated-approval-broker.test.ts
git commit -m "test(engine): cover delegated-approval-broker unknown-id + listPending branches (B1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Tasks B1.2–B1.7: remaining engine files (same loop, per file)

For each of `delegation-store.ts`, `search-ranking.ts`, `coordinator.ts`, `planner.ts`, `delegated-request-remote.ts`, `run-ask.ts`, repeat the **exemplar loop** from Task B1.1, driven by that file's uncovered-branch list from Task B1.0 Step 3:

- [ ] **Step 1 (per file): Read the source + map each uncovered BRDA line.** Open `packages/gateway/src/engine/<file>.ts`, go to each `<line>` from the work-list, and identify the decision (a guard `if`, a `?:`, a `&&`/`||` short-circuit, a `switch` arm, an optional-chain fallback, a default parameter). Read the existing `<file>.test.ts` to see what is already exercised.
- [ ] **Step 2 (per file): Write a failing/asserting test per uncovered branch.** Add cases to `<file>.test.ts` that drive the input down the uncovered side and **assert the resulting behavior** (return value, thrown error, emitted record) — not mere execution. For a defensive guard with no natural caller, follow the spec §5 policy: trigger it with a type-safe cast (input as `unknown` then narrowed, or `as never`) — **never `any`**; if genuinely unreachable, leave it and add a one-line `// B/D: unreachable defensive guard — see spec §5` note in the test file describing why, and move on (the ratchet holds it).
- [ ] **Step 3 (per file): Run the file's tests.**
  Run: `bun test packages/gateway/src/engine/<file>.test.ts`
  Expected: PASS. A failing assertion here that contradicts the source is a real bug → STOP, switch to systematic-debugging, report before "fixing" by weakening the test.
- [ ] **Step 4 (per file): Biome/type check.**
  Run: `bunx biome check packages/gateway/src/engine/<file>.test.ts`
  Expected: no errors.
- [ ] **Step 5 (per file): Commit.**

  ```bash
  git add packages/gateway/src/engine/<file>.test.ts
  git commit -m "test(engine): cover <file> uncovered branches (B1)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

Per-file notes (current watermarks, to right-size effort):

- `delegation-store.ts` (br 60, 105 lines): a CRUD-ish store; expect uncovered branches in not-found / empty-result / duplicate guards.
- `search-ranking.ts` (br 66.67): ranking math; expect uncovered tie-break / empty-input / clamp branches.
- `coordinator.ts`, `planner.ts` (br 75): orchestration; expect uncovered error/empty-plan/degenerate-input branches — these may need DI of a fake sub-agent/connector (follow existing `*.test.ts` patterns, prefer DI over `mock.module`).
- `delegated-request-remote.ts` (br 76.92): remote delegation path; expect uncovered timeout / peer-invalid / fallback-to-local branches (relates to I20).
- `run-ask.ts` (br 76.98): the ask entry; expect uncovered local-vs-remote / error-shaping branches.

### Task B1.8: Reseed the baseline (Linux) + verify the gate + open PR

**Files:**

- Modify: `docs/structure-audit/coverage-baseline.json`

- [ ] **Step 1: Keep current with main**

```bash
git merge origin/main   # resolve a baseline conflict via spec §3.2 (checkout --theirs + reseed)
```

- [ ] **Step 2: Reseed from a fresh Docker-Linux lcov**

Run:

```bash
bash scripts/coverage-floor/reseed-docker.sh
```

Expected final line: `coverage-floor: ok (...)`. The 7 engine files should now either show a **raised** branch watermark (still <80 but higher) or be **absent** from the baseline (cleared both floors).

- [ ] **Step 3: Confirm the baseline shrank / engine files improved**

Run:

```bash
node -e 'const b=require("./docs/structure-audit/coverage-baseline.json"); const e=Object.entries(b.files).filter(([f])=>f.includes("/engine/")); console.log("engine entries remaining:", e.length); e.forEach(([f,v])=>console.log(v.min_branch_pct, f)); console.log("total entries:", Object.keys(b.files).length)'
```

Expected: fewer engine entries than the 7 we started with (those that hit ≥80 are gone), and total entries ≤ the pre-B1 count. Any engine file *still* listed must have a **raised** branch watermark vs the table above (the ratchet went up).

- [ ] **Step 4: Final local gate**

Run:

```bash
bun run audit:coverage-floor
```

Expected: `coverage-floor: ok`.

- [ ] **Step 5: Commit the reseeded baseline + open the PR**

```bash
git add docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage): reseed baseline after engine branch-coverage gains (B1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin dev/asafgolombek/true-coverage-B1
gh pr create --base main --title "test(coverage): B1 — engine subsystem to ≥80% branch (Sub-project B)" \
  --body "Sub-project B, PR 1. Adds branch-coverage tests for the 7 gateway/engine files below the floor (broker, delegation-store, search-ranking, coordinator, planner, delegated-request-remote, run-ask) and reseeds the baseline (Linux). No production behavior change. Avoids the ★-flagship executor/tool-output-envelope files.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: `Unit + Coverage` green in one round. Rerun the chronic windows-2025 cross-platform flake if red.

---

## Self-Review

- **Spec coverage:** B0 implements spec §2.2 (exclude 4 test-helpers) + §3.1 (reseed-docker.sh). B1 implements spec §4 row B1 (engine) via the §3 loop and the §5 unreachable-branch policy. The §3.2 conflict-resolution and the Linux-authoritative reseed (§3 invariants) are wired into B1.8. ✔
- **Type consistency:** `reseed-docker.sh`, `audit:coverage-floor`, `audit:coverage-floor:update-baseline`, `computeUpdatedBaseline`, `isExempt`, `EXCLUSIONS` referenced consistently with the codebase. ✔
- **No fabricated assertions:** B1.1 test code is grounded in the real broker source (verified). B1.2–B1.7 are discovery-driven (read source + lcov BRDA) by design — coverage tests cannot be authored against an lcov that does not yet exist; the plan supplies the exact discovery commands + the no-`any` / unreachable policy instead of inventing assertions. ✔
- **Granularity:** each step is one action (write/run/commit). ✔
