# P4b CI Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a push-to-`main` CI run from ~105 jobs to ~69 by running
coverage-threshold gates on Linux only except where the covered code branches on
platform, narrow `e2e-desktop`'s dependency edge, and add a static audit so the
platform classification cannot rot silently.

**Architecture:** Three independent changes to GitHub Actions workflow YAML,
plus one new static audit in the existing `scripts/structure-audit/` pattern
(exported pure functions + `import.meta.main` CLI), plus promotion of two
throwaway measurement probes into `scripts/ci-latency/`.

**Tech Stack:** Bun v1.2+, TypeScript 6 strict, Biome, GitHub Actions YAML,
`bun:test`.

**Spec:** [`../specs/2026-07-27-p4b-ci-tuning-design.md`](../specs/2026-07-27-p4b-ci-tuning-design.md)
and its [review response](../specs/2026-07-27-p4b-ci-tuning-design-review-response.md).

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **Cross-platform paths** — build with `path.join()`; never hardcode separators.
  Normalise to forward slashes for comparison with `.replace(/\\/g, "/")`.
- Audit modules follow `scripts/structure-audit/check-action-sha-pins.ts`:
  exported pure functions returning `{ ok: boolean; errors: string[] }`, a
  `parseRootArg`-style root override where useful, and an `import.meta.main`
  block that prints `<label>: OK` or one `console.error` per error then
  `process.exit(1)`.
- `REPO_ROOT` is exported from `scripts/structure-audit/lib.ts`.
- **Any `bun run <id>` added to a workflow MUST be registered** in
  `PREFLIGHT_GATES` or `CI_ONLY_GATES` in `scripts/lib/preflight-gates.ts`, or
  the drift guard in `scripts/preflight.test.ts` fails.
- The six PAL gate names, verbatim, as they appear in the `_test-suite.yml`
  matrix: `Vault`, `Sandbox`, `Updater`, `Extensions`, `Perf`, `Telemetry`.
- Commit on the branch `dev/asafgolombek/p4b-ci-tuning`. Never on `main`.
- Run `bun run lint:markdown` before committing any Markdown.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/structure-audit/platform-branching-allowlist.ts` (create) | The checked-in classification: every platform-branching source file, the coverage gate that covers it, and why. Data only. |
| `scripts/structure-audit/check-coverage-gate-pal.ts` (create) | Detection + the four assertions. Pure functions + CLI. |
| `scripts/structure-audit/check-coverage-gate-pal.test.ts` (create) | Unit tests over fixtures, plus one test asserting the real repo passes. |
| `.github/workflows/_test-suite.yml` (modify) | `pal` field on all 24 matrix entries + the `if:` gate on `coverage-gates`. |
| `.github/workflows/ci.yml` (modify) | `e2e-desktop` needs edge. |
| `.github/workflows/_structure.yml` (modify) | Run the new audit. |
| `scripts/lib/preflight-gates.ts` (modify) | Register the new gate (FAST tier). |
| `package.json` (modify) | `audit:coverage-gate-pal` script id. |
| `scripts/ci-latency/probe-dag.ts` (create) | Which upstream job gated each E2E leg; per-leg DAG wait. |
| `scripts/ci-latency/probe-concurrency.ts` (create) | Jobs per run, peak concurrent, created-but-waiting at peak. |
| `scripts/ci-latency/probe-lib.ts` (create) | Pure helpers shared by both probes, so the logic is testable without network. |
| `scripts/ci-latency/probe-lib.test.ts` (create) | Unit tests for those helpers. |
| `docs/infrastructure-roadmap.md` (modify) | P4b progress log: before/after figures, the deferral and its trigger. |

---

## Task 1: The platform-branching allowlist and its audit

**Files:**

- Create: `scripts/structure-audit/platform-branching-allowlist.ts`
- Create: `scripts/structure-audit/check-coverage-gate-pal.ts`
- Create: `scripts/structure-audit/check-coverage-gate-pal.test.ts`

**Interfaces:**

- Consumes: `REPO_ROOT` from `scripts/structure-audit/lib.ts`.
- Produces: `auditCoverageGatePal(repoRoot: string): AuditResult`,
  `parseCoverageGateMatrix(yaml: string): GateEntry[]`,
  `detectPlatformBranchingFiles(repoRoot: string): string[]`,
  `PLATFORM_BRANCHING_ALLOWLIST: readonly PlatformFileEntry[]`.

At the end of this task the audit exists and its unit tests pass, but running it
against the real repo **fails** — the matrix has no `pal` fields yet. That red is
the proof the gate works; Task 2 turns it green.

- [ ] **Step 1: Create the allowlist data module**

Create `scripts/structure-audit/platform-branching-allowlist.ts`:

```ts
/**
 * Every source file that branches on the host platform, and which coverage
 * gate covers it.
 *
 * WHY THIS EXISTS: `_test-suite.yml` runs most coverage-threshold gates on
 * Linux only. That is safe exactly while the code those gates cover does not
 * branch on platform. Without this list, the day someone adds
 * `process.platform` to a Linux-only gate's code, coverage on Windows and
 * macOS quietly stops watching it and NOTHING fails.
 *
 * LIMITATION, stated so it is not rediscovered: `gate: "none"` means no
 * coverage-threshold gate covers this file today. Those entries record that the
 * file was classified, not that it is protected. Coverage is measured over
 * files loaded at runtime including transitive imports, which cannot be derived
 * statically from the gate's test paths — so this audit guarantees that new
 * platform-branching code is CLASSIFIED, and that the six PAL gates stay
 * `pal: true`. It does not prove a `gate: "none"` file never becomes covered by
 * a `pal: false` gate.
 */

export interface PlatformFileEntry {
  /** Repo-relative path, forward slashes. */
  readonly file: string;
  /** Coverage-gate `name` from the _test-suite.yml matrix, or "none". */
  readonly gate: string;
  readonly why: string;
}

export const PLATFORM_BRANCHING_ALLOWLIST: readonly PlatformFileEntry[] = [
  // ── Covered by a PAL gate (must be pal: true in the matrix) ────────────────
  {
    file: "packages/gateway/src/vault/win32.ts",
    gate: "Vault",
    why: "DPAPI backend; branches on platform and is win32-named",
  },
  { file: "packages/gateway/src/vault/darwin.ts", gate: "Vault", why: "Keychain backend" },
  { file: "packages/gateway/src/vault/linux.ts", gate: "Vault", why: "libsecret backend" },
  {
    file: "packages/gateway/src/platform/sandbox/win32.ts",
    gate: "Sandbox",
    why: "Windows job-object sandbox",
  },
  {
    file: "packages/gateway/src/platform/sandbox/darwin.ts",
    gate: "Sandbox",
    why: "sandbox-exec profile",
  },
  {
    file: "packages/gateway/src/platform/sandbox/linux.ts",
    gate: "Sandbox",
    why: "bwrap + seccomp",
  },
  {
    file: "packages/gateway/src/updater/factory.ts",
    gate: "Updater",
    why: "selects the per-OS updater implementation",
  },
  {
    file: "packages/gateway/src/updater/platform-target.ts",
    gate: "Updater",
    why: "maps platform to a release asset target",
  },
  {
    file: "packages/gateway/src/extensions/install-from-local.ts",
    gate: "Extensions",
    why: "per-OS install paths and permissions",
  },
  {
    file: "packages/gateway/src/perf/bench-runner.ts",
    gate: "Perf",
    why: "per-OS timing and process handling",
  },
  { file: "packages/gateway/src/perf/bench-cli.ts", gate: "Perf", why: "per-OS bench invocation" },
  { file: "packages/cli/src/commands/bench.ts", gate: "Perf", why: "per-OS bench invocation" },
  {
    file: "packages/gateway/src/telemetry/collector.ts",
    gate: "Telemetry",
    why: "reports host platform",
  },

  // ── Not covered by any coverage-threshold gate ────────────────────────────
  {
    file: "packages/gateway/src/platform/win32.ts",
    gate: "none",
    why: "PAL implementation; no coverage-threshold gate targets src/platform",
  },
  { file: "packages/gateway/src/platform/darwin.ts", gate: "none", why: "PAL implementation" },
  { file: "packages/gateway/src/platform/linux.ts", gate: "none", why: "PAL implementation" },
  {
    file: "packages/gateway/src/platform/browser.ts",
    gate: "none",
    why: "per-OS browser-open command",
  },
  {
    file: "packages/gateway/src/index/registered-roots-store.ts",
    gate: "none",
    why: "per-OS path normalisation",
  },
  {
    file: "packages/gateway/src/index/sqlite-vec-load.ts",
    gate: "none",
    why: "per-OS native extension filename",
  },
  {
    file: "packages/gateway/src/ipc/server/dispatchers.ts",
    gate: "none",
    why: "named pipe vs unix socket",
  },
  { file: "packages/gateway/src/voice/tts.ts", gate: "none", why: "per-OS TTS backend" },
  {
    file: "packages/gateway/src/voice/wake-word.ts",
    gate: "none",
    why: "per-OS audio capture",
  },
  { file: "packages/cli/src/commands/config.ts", gate: "none", why: "per-OS config path display" },
  {
    file: "packages/cli/src/commands/extension.ts",
    gate: "none",
    why: "per-OS extension paths",
  },
  { file: "packages/cli/src/commands/start.ts", gate: "none", why: "per-OS gateway launch" },
  {
    file: "packages/cli/src/lib/resolve-gateway-launch.ts",
    gate: "none",
    why: "per-OS executable resolution",
  },
  { file: "packages/cli/src/lib/spawn-gateway.ts", gate: "none", why: "per-OS spawn flags" },
];
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/structure-audit/check-coverage-gate-pal.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { auditCoverageGatePal, parseCoverageGateMatrix } from "./check-coverage-gate-pal.ts";
import { REPO_ROOT } from "./lib.ts";

const MATRIX = `
  coverage-gates:
    name: Coverage — \${{ matrix.gate.name }}
    needs: unit-coverage
    strategy:
      fail-fast: false
      matrix:
        gate:
          - name: Engine
            script: "test:coverage:engine"
            pal: false
          - name: Vault
            script: "test:coverage:vault"
            pal: true
    steps:
      - name: Checkout
`;

describe("parseCoverageGateMatrix", () => {
  test("reads each gate name and its explicit pal flag", () => {
    expect(parseCoverageGateMatrix(MATRIX)).toEqual([
      { name: "Engine", pal: false },
      { name: "Vault", pal: true },
    ]);
  });

  test("a gate with no pal field parses as null, not as false", () => {
    // A missing flag must be distinguishable from an explicit `false`, so the
    // audit can demand classification rather than silently defaulting.
    const yaml = MATRIX.replace('            pal: false\n', "");
    expect(parseCoverageGateMatrix(yaml)[0]).toEqual({ name: "Engine", pal: null });
  });

  test("stops at the end of the matrix block", () => {
    // `steps:` dedents out of the matrix; nothing after it is a gate.
    expect(parseCoverageGateMatrix(MATRIX).map((g) => g.name)).not.toContain("Checkout");
  });
});

describe("auditCoverageGatePal", () => {
  test("the real repository passes", () => {
    const result = auditCoverageGatePal(REPO_ROOT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test scripts/structure-audit/check-coverage-gate-pal.test.ts`

Expected: FAIL — `Cannot find module './check-coverage-gate-pal.ts'`.

- [ ] **Step 4: Implement the audit**

Create `scripts/structure-audit/check-coverage-gate-pal.ts`:

```ts
#!/usr/bin/env bun

/**
 * audit:coverage-gate-pal — keeps the PAL classification behind the Linux-only
 * coverage gates honest.
 *
 * `_test-suite.yml` runs coverage-threshold gates on Linux only unless the gate
 * is marked `pal: true`. That is safe only while the covered code does not
 * branch on platform. This audit fails when:
 *
 *   1. a source file branches on platform but is absent from the allowlist
 *   2. an allowlist entry names a file that no longer branches on platform
 *      (or no longer exists) — stale entries rot in the other direction
 *   3. an allowlisted file declares a gate that is not `pal: true`
 *   4. a matrix entry carries no explicit `pal` field
 *
 * Rule 4 is why the field is spelled out on all 24 entries: a new gate must be
 * classified deliberately, never by inheriting a default.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PLATFORM_BRANCHING_ALLOWLIST } from "./platform-branching-allowlist.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface GateEntry {
  name: string;
  /** null when the matrix entry carries no `pal` field at all. */
  pal: boolean | null;
}

const TEST_SUITE = ".github/workflows/_test-suite.yml";

/** Runtime platform branching, or a filename that names an OS. */
const BRANCHES_ON_PLATFORM = /process\.platform|os\.platform\(\)/;
const OS_NAMED_FILE = /\/(win32|darwin|linux)\.ts$/;

function collectSources(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every non-test source file under `packages/{*}/src` that branches on the host
 * platform. Tests are excluded deliberately: a cross-platform test branching on
 * `process.platform` is correct, not a finding.
 */
export function detectPlatformBranchingFiles(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    collectSources(join(packagesDir, pkg, "src"), files);
  }
  const hits: string[] = [];
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, "/");
    if (OS_NAMED_FILE.test(`/${rel}`) || BRANCHES_ON_PLATFORM.test(readFileSync(file, "utf8"))) {
      hits.push(rel);
    }
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

/**
 * Line-based parse of the `coverage-gates` matrix. A YAML dependency is not
 * worth taking on for one well-known block, and the sibling audits
 * (check-action-sha-pins) parse workflow YAML the same way.
 */
export function parseCoverageGateMatrix(yaml: string): GateEntry[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{8}gate:\s*$/.test(l));
  if (start === -1) return [];
  const gates: GateEntry[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    // Any line indented 8 spaces or less has dedented out of the matrix block.
    if (/^\s{0,8}\S/.test(line)) break;
    const nameMatch = line.match(/^\s{10}-\s+name:\s*(.+?)\s*$/);
    if (nameMatch?.[1] !== undefined) {
      gates.push({ name: nameMatch[1].replace(/^["']|["']$/g, ""), pal: null });
      continue;
    }
    const palMatch = line.match(/^\s{12}pal:\s*(true|false)\s*$/);
    const last = gates[gates.length - 1];
    if (palMatch?.[1] !== undefined && last) last.pal = palMatch[1] === "true";
  }
  return gates;
}

export function auditCoverageGatePal(repoRoot: string): AuditResult {
  const errors: string[] = [];

  const workflow = join(repoRoot, TEST_SUITE);
  if (!existsSync(workflow)) {
    return { ok: false, errors: [`${TEST_SUITE} not found`] };
  }
  const gates = parseCoverageGateMatrix(readFileSync(workflow, "utf8"));
  if (gates.length === 0) {
    return { ok: false, errors: [`${TEST_SUITE}: no coverage-gates matrix entries found`] };
  }

  // 4. every matrix entry classified explicitly
  for (const g of gates) {
    if (g.pal === null) {
      errors.push(
        `${TEST_SUITE}: coverage gate "${g.name}" has no explicit \`pal:\` field — add \`pal: true\` (runs on all 3 OSes) or \`pal: false\` (Linux only)`,
      );
    }
  }

  const palByName = new Map(gates.map((g) => [g.name, g.pal]));
  const allowByFile = new Map(PLATFORM_BRANCHING_ALLOWLIST.map((e) => [e.file, e]));
  const detected = detectPlatformBranchingFiles(repoRoot);
  const detectedSet = new Set(detected);

  // 1. detected but unclassified
  for (const file of detected) {
    if (!allowByFile.has(file)) {
      errors.push(
        `${file}: branches on platform but is not in PLATFORM_BRANCHING_ALLOWLIST — add an entry naming the coverage gate that covers it (or "none"), then make sure that gate is \`pal: true\``,
      );
    }
  }

  // 2. classified but no longer branching
  for (const entry of PLATFORM_BRANCHING_ALLOWLIST) {
    if (!detectedSet.has(entry.file)) {
      errors.push(
        `${entry.file}: listed in PLATFORM_BRANCHING_ALLOWLIST but no longer branches on platform (or no longer exists) — remove the stale entry`,
      );
    }
  }

  // 3. declared gate must be pal: true
  for (const entry of PLATFORM_BRANCHING_ALLOWLIST) {
    if (entry.gate === "none") continue;
    if (!palByName.has(entry.gate)) {
      errors.push(
        `${entry.file}: declares coverage gate "${entry.gate}", which is not in the ${TEST_SUITE} matrix`,
      );
      continue;
    }
    if (palByName.get(entry.gate) !== true) {
      errors.push(
        `${entry.file}: branches on platform and is covered by gate "${entry.gate}", but that gate is not \`pal: true\` — its coverage would run on Linux only`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditCoverageGatePal(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:coverage-gate-pal: ${err}`);
    process.exit(1);
  }
  console.log(`audit:coverage-gate-pal: OK`);
}
```

- [ ] **Step 5: Run the unit tests**

Run: `bun test scripts/structure-audit/check-coverage-gate-pal.test.ts`

Expected: the three `parseCoverageGateMatrix` tests PASS. The
`"the real repository passes"` test **FAILS** with 24 errors of the form
`coverage gate "Engine" has no explicit \`pal:\` field`. That is correct — the
matrix is not yet classified. Task 2 fixes it.

- [ ] **Step 6: Reconcile the allowlist against reality**

The allowlist above was written from a measurement taken on 2026-07-27. Verify
it still matches the tree rather than trusting it:

```bash
bun -e "import{detectPlatformBranchingFiles}from'./scripts/structure-audit/check-coverage-gate-pal.ts';import{PLATFORM_BRANCHING_ALLOWLIST as A}from'./scripts/structure-audit/platform-branching-allowlist.ts';const d=detectPlatformBranchingFiles(process.cwd());const a=new Set(A.map(e=>e.file));console.log('missing from allowlist:',d.filter(f=>!a.has(f)));console.log('stale in allowlist:',[...a].filter(f=>!d.includes(f)))"
```

Expected: both lists empty. If `missing from allowlist` is non-empty, add each
file with a `gate` (the coverage gate covering it, or `"none"`) and a one-line
`why`. If `stale in allowlist` is non-empty, delete those entries. Do **not**
loosen the detector to make the lists match.

- [ ] **Step 7: Verify types and lint**

Run: `bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check --error-on-warnings scripts`

Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add scripts/structure-audit/platform-branching-allowlist.ts \
        scripts/structure-audit/check-coverage-gate-pal.ts \
        scripts/structure-audit/check-coverage-gate-pal.test.ts
git commit -m "feat(ci): audit that keeps the coverage-gate PAL classification honest

Ships RED against the real repo on purpose: the _test-suite.yml matrix carries
no pal: fields yet, so rule 4 fires 24 times. The next commit classifies the
matrix and turns it green."
```

---

## Task 2: Classify the coverage matrix and gate it to Linux

**Files:**

- Modify: `.github/workflows/_test-suite.yml` — the `coverage-gates` job
  (`if:` line) and all 24 matrix entries.

**Interfaces:**

- Consumes: `auditCoverageGatePal` from Task 1 as the verification tool.
- Produces: a matrix where every entry has an explicit `pal` field; the six PAL
  gates are `pal: true`.

- [ ] **Step 1: Confirm the audit is red before the change**

Run: `bun scripts/structure-audit/check-coverage-gate-pal.ts`

Expected: exit 1, with 24 lines reading
`coverage gate "<name>" has no explicit \`pal:\` field`.

- [ ] **Step 2: Add the `if:` gate to the coverage-gates job**

In `.github/workflows/_test-suite.yml`, in the `coverage-gates:` job, add an
`if:` immediately after the `name:` line so the block reads:

```yaml
  coverage-gates:
    name: Coverage — ${{ matrix.gate.name }} (${{ inputs.runner }})
    # Threshold gates run on Linux only, EXCEPT gates whose covered code
    # branches on platform (`pal: true`). A push run was ~105 jobs against a
    # pool granting ~15 concurrent, and 72 of those were this matrix run once
    # per OS. Skipped matrix legs still create their check context, so no
    # required check is left "Expected — Waiting for status to be reported".
    # `scripts/structure-audit/check-coverage-gate-pal.ts` fails if a Linux-only
    # gate's code ever gains platform branching.
    if: inputs.runner == 'ubuntu-24.04' || matrix.gate.pal
    needs: unit-coverage
```

- [ ] **Step 3: Add `pal: true` to the six PAL entries**

Add a `pal: true` line beneath the `script:` line of exactly these six entries:
`Vault`, `Sandbox`, `Updater`, `Extensions`, `Perf`, `Telemetry`. For example:

```yaml
          - name: Vault
            script: "test:coverage:vault"
            pal: true
```

- [ ] **Step 4: Add `pal: false` to the other eighteen entries**

Add `pal: false` beneath the `script:` line of every remaining entry: `Engine`,
`Agents`, `Sync scheduler`, `Rate limiter`, `People`, `Embedding`, `Workflow`,
`Watcher`, `Config`, `TUI`, `DB layer`, `Deployment`, `Health`, `Metrics`,
`Preflight`, `Doctor`, `MCP`, `LAN`. For example:

```yaml
          - name: Engine
            script: "test:coverage:engine"
            pal: false
```

- [ ] **Step 5: Verify the audit is now green**

Run: `bun scripts/structure-audit/check-coverage-gate-pal.ts`

Expected: `audit:coverage-gate-pal: OK`, exit 0.

- [ ] **Step 6: Verify the parser sees exactly 24 gates, 6 of them PAL**

```bash
bun -e "import{parseCoverageGateMatrix}from'./scripts/structure-audit/check-coverage-gate-pal.ts';const g=parseCoverageGateMatrix(await Bun.file('.github/workflows/_test-suite.yml').text());console.log('total',g.length,'pal',g.filter(x=>x.pal===true).map(x=>x.name),'unclassified',g.filter(x=>x.pal===null).length)"
```

Expected: `total 24`, `pal [ "Vault", "Sandbox", "Updater", "Extensions", "Perf", "Telemetry" ]`, `unclassified 0`.

- [ ] **Step 7: Run the audit's test suite**

Run: `bun test scripts/structure-audit/check-coverage-gate-pal.test.ts`

Expected: all 4 tests PASS, including `"the real repository passes"`.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/_test-suite.yml
git commit -m "perf(ci): run coverage-threshold gates on Linux except PAL-touching ones

Coverage gates 72 -> 36 jobs; a push run 105 -> 69. The six gates whose covered
code branches on platform keep all three OSes. Turns the Task 1 audit green."
```

---

## Task 3: Wire the audit into preflight and CI

**Files:**

- Modify: `package.json` — add the `audit:coverage-gate-pal` script id.
- Modify: `scripts/lib/preflight-gates.ts` — register it in the FAST tier.
- Modify: `.github/workflows/_structure.yml` — run it.

**Interfaces:**

- Consumes: the CLI entry point from Task 1.
- Produces: nothing other tasks depend on.

The drift guard in `scripts/preflight.test.ts` asserts that every
`bun run <id>` appearing in any workflow is registered in `PREFLIGHT_GATES` or
`CI_ONLY_GATES`. Steps 1 and 2 must both land before Step 3, or that test fails.

- [ ] **Step 1: Add the script id to `package.json`**

Next to the other `audit:*` entries, add:

```json
"audit:coverage-gate-pal": "bun scripts/structure-audit/check-coverage-gate-pal.ts",
```

- [ ] **Step 2: Register it in the FAST tier**

In `scripts/lib/preflight-gates.ts`, inside the `FAST` array, after the
`audit:action-sha-pins` entry, add:

```ts
  {
    name: "audit:coverage-gate-pal",
    cmd: ["bun", "run", "audit:coverage-gate-pal"],
    tier: "fast",
  },
```

It belongs in FAST, not `CI_ONLY_GATES`: it reads only local files, needs no
network and no `gh` auth.

- [ ] **Step 3: Run it in `_structure.yml`**

In `.github/workflows/_structure.yml`, after the `audit:invariants` step, add:

```yaml
      - name: Audit coverage-gate PAL classification
        run: bun run audit:coverage-gate-pal
```

- [ ] **Step 4: Verify the drift guard passes**

Run: `bun test scripts/preflight.test.ts scripts/lib/preflight-gates.test.ts`

Expected: PASS. A failure naming `_structure.yml: audit:coverage-gate-pal`
means Step 2 was skipped or misspelled.

- [ ] **Step 5: Verify the gate runs from its script id**

Run: `bun run audit:coverage-gate-pal`

Expected: `audit:coverage-gate-pal: OK`.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/lib/preflight-gates.ts .github/workflows/_structure.yml
git commit -m "ci: wire audit:coverage-gate-pal into preflight and _structure.yml"
```

---

## Task 4: Narrow the E2E Desktop dependency edge

**Files:**

- Modify: `.github/workflows/ci.yml` — the `e2e-desktop` job's `needs:`.

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Confirm the edge carries no artifacts**

Read the `e2e-desktop` job's steps in `.github/workflows/ci.yml`. Confirm there
is no `actions/download-artifact` step and that the job performs its own
`Checkout`, `Setup Bun and install dependencies`, and
`Setup Rust + Tauri (install only, no checks)`.

Expected: no `download-artifact`. The `needs: ci-ts` edge is a pure gate. If a
`download-artifact` step IS present, **stop** — the premise of this task is
wrong; report it rather than proceeding.

- [ ] **Step 2: Narrow the edge**

Replace the `needs:` line of the `e2e-desktop` job with:

```yaml
    # `ci-ts` is the whole _test-suite.yml (30 jobs incl. 24 coverage shards),
    # and `needs:` on a reusable-workflow caller waits for ALL of it — measured
    # at 33.4min median DAG wait. E2E consumes no artifact from it: it does its
    # own checkout, install and Tauri setup. `ci-rust` (1.17-1.72min) is the
    # prerequisite that carries meaning: a broken Tauri build makes E2E
    # unrunnable.
    needs: [ci-rust]
```

- [ ] **Step 3: Verify the workflow still parses**

Run: `bunx biome check --error-on-warnings .github 2>/dev/null; bun test scripts/preflight.test.ts`

Expected: exit 0. (`preflight.test.ts` reads every workflow file; a YAML file it
cannot read surfaces there.)

- [ ] **Step 4: Verify no other job depends on e2e-desktop**

```bash
grep -n "e2e-desktop" .github/workflows/ci.yml
```

Expected: matches only the job definition itself and its own `name:`/`if:`
lines — no other job lists `e2e-desktop` in a `needs:`. If one does, that job's
own dependency chain must be re-checked before proceeding.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "perf(ci): E2E Desktop waits on ci-rust, not the whole TS suite

needs: [ci-ts, ci-rust] made E2E wait 33.4min median for 30 jobs it takes no
artifact from. ci-rust executes in 1.17-1.72min and is the dependency that
actually matters: a broken Tauri build makes E2E unrunnable."
```

---

## Task 5: Promote the measurement probes

**Files:**

- Create: `scripts/ci-latency/probe-lib.ts`
- Create: `scripts/ci-latency/probe-lib.test.ts`
- Create: `scripts/ci-latency/probe-dag.ts`
- Create: `scripts/ci-latency/probe-concurrency.ts`

**Interfaces:**

- Consumes: `runGh(args: string[]): GhResult` from
  `scripts/structure-audit/_gh-audit.ts`, where `GhResult` is
  `{ ok: boolean; stdout: string; stderr: string; httpStatus?: number }`.
  Also `isRecord(v: unknown): v is Record<string, unknown>` from the same module.
- Produces: `median`, `minutesBetween`, `bindingUpstream`, `concurrencySeries`
  from `probe-lib.ts`.

These are the only tools that can verify this slice, since `audit:ci-latency`
gates execution and the win lands in queue and DAG wait. They are diagnostic
commands run by hand, never gates — so they are **not** registered in
`preflight-gates.ts` and must not be added to any workflow.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `scripts/ci-latency/probe-lib.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { bindingUpstream, concurrencySeries, median, minutesBetween } from "./probe-lib.ts";

describe("median", () => {
  test("odd-length picks the middle", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even-length averages the two middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("an empty sample is 0, not NaN", () => {
    // A NaN would propagate silently into every printed figure.
    expect(median([])).toBe(0);
  });
});

describe("minutesBetween", () => {
  test("returns whole minutes between two ISO timestamps", () => {
    expect(minutesBetween("2026-07-27T10:30:00Z", "2026-07-27T10:00:00Z")).toBe(30);
  });

  test("an unparseable timestamp yields 0 rather than NaN", () => {
    expect(minutesBetween("not-a-date", "2026-07-27T10:00:00Z")).toBe(0);
  });
});

describe("bindingUpstream", () => {
  test("picks the upstream job that completed last", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:20:00Z" },
      { name: "c", completed_at: "2026-07-27T10:10:00Z" },
    ];
    expect(bindingUpstream(jobs)?.name).toBe("b");
  });

  test("ignores jobs that never completed", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "running", completed_at: null },
    ];
    expect(bindingUpstream(jobs)?.name).toBe("a");
  });

  test("an empty list yields null", () => {
    expect(bindingUpstream([])).toBeNull();
  });
});

describe("concurrencySeries", () => {
  test("counts jobs running at each minute offset", () => {
    // Two jobs overlap only at minute 1.
    const series = concurrencySeries(
      [
        { started_at: "2026-07-27T10:00:00Z", completed_at: "2026-07-27T10:02:00Z" },
        { started_at: "2026-07-27T10:01:00Z", completed_at: "2026-07-27T10:03:00Z" },
      ],
      "2026-07-27T10:00:00Z",
    );
    expect(series).toEqual([1, 2, 1, 0]);
  });

  test("no jobs yields an empty series", () => {
    expect(concurrencySeries([], "2026-07-27T10:00:00Z")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/ci-latency/probe-lib.test.ts`

Expected: FAIL — `Cannot find module './probe-lib.ts'`.

- [ ] **Step 3: Implement the shared helpers**

Create `scripts/ci-latency/probe-lib.ts`:

```ts
/**
 * Pure helpers for the two P4b diagnostic probes.
 *
 * They live apart from the probes so the arithmetic is unit-testable without a
 * network call. The probes themselves are thin: fetch, map, print.
 */

export interface CompletedJob {
  name: string;
  completed_at: string | null;
}

export interface RunningJob {
  started_at: string;
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
 * to finish. Returns null when nothing has completed.
 */
export function bindingUpstream(jobs: CompletedJob[]): CompletedJob | null {
  let best: CompletedJob | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const j of jobs) {
    if (j.completed_at === null) continue;
    const at = Date.parse(j.completed_at);
    if (Number.isNaN(at) || at <= bestAt) continue;
    bestAt = at;
    best = j;
  }
  return best;
}

/** How many jobs were running at each whole-minute offset from `runStartedAt`. */
export function concurrencySeries(jobs: RunningJob[], runStartedAt: string): number[] {
  const t0 = Date.parse(runStartedAt);
  const usable = jobs.filter((j) => j.completed_at !== null);
  if (Number.isNaN(t0) || usable.length === 0) return [];
  const end = Math.max(...usable.map((j) => Date.parse(j.completed_at ?? "")));
  if (!Number.isFinite(end)) return [];
  const span = Math.ceil((end - t0) / 60_000);
  const series: number[] = [];
  for (let m = 0; m <= span; m++) {
    const at = t0 + m * 60_000;
    series.push(
      usable.filter(
        (j) => Date.parse(j.started_at) <= at && Date.parse(j.completed_at ?? "") > at,
      ).length,
    );
  }
  return series;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/ci-latency/probe-lib.test.ts`

Expected: 10 tests PASS.

- [ ] **Step 5: Implement the DAG probe**

Create `scripts/ci-latency/probe-dag.ts`:

```ts
#!/usr/bin/env bun

/**
 * P4b diagnostic — which upstream job actually gated each `E2E Desktop` leg,
 * and how long each leg waited.
 *
 * Not a gate, and deliberately not registered in preflight-gates.ts: it is the
 * before/after instrument for the tuning slice, because `audit:ci-latency`
 * gates EXECUTION while this slice's win lands in DAG wait.
 *
 * Usage: bun scripts/ci-latency/probe-dag.ts [--runs N]
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import { bindingUpstream, median, minutesBetween } from "./probe-lib.ts";

const REPO = "nimbus-agent/Nimbus";

interface Job {
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
}

function api(path: string): unknown {
  const r = runGh(["gh", "api", path]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function asJobs(value: unknown): Job[] {
  if (!isRecord(value) || !Array.isArray(value["jobs"])) return [];
  const out: Job[] = [];
  for (const j of value["jobs"]) {
    if (!isRecord(j)) continue;
    const name = j["name"];
    const created = j["created_at"];
    const started = j["started_at"];
    const completed = j["completed_at"];
    if (typeof name !== "string" || typeof created !== "string" || typeof started !== "string") {
      continue;
    }
    out.push({
      name,
      created_at: created,
      started_at: started,
      completed_at: typeof completed === "string" ? completed : null,
    });
  }
  return out;
}

function jobsForRun(runId: number): Job[] {
  const jobs: Job[] = [];
  for (let page = 1; page <= 5; page++) {
    const payload = api(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
    const batch = asJobs(payload);
    if (batch.length === 0) break;
    jobs.push(...batch);
    const total = isRecord(payload) ? payload["total_count"] : undefined;
    if (typeof total === "number" && jobs.length >= total) break;
  }
  return jobs;
}

function parseRunsArg(argv: string[]): number {
  const ix = argv.indexOf("--runs");
  if (ix === -1) return 15;
  const n = Number(argv[ix + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
}

if (import.meta.main) {
  const wanted = parseRunsArg(process.argv.slice(2));
  const listed = api(
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&status=success&per_page=${wanted}`,
  );
  const runs = isRecord(listed) && Array.isArray(listed["workflow_runs"]) ? listed["workflow_runs"] : [];
  if (runs.length === 0) {
    console.error("probe-dag: no successful push runs readable — is `gh` authenticated?");
    process.exit(1);
  }

  const binding = new Map<string, number>();
  const waitsByLeg = new Map<string, number[]>();

  for (const run of runs) {
    if (!isRecord(run)) continue;
    const id = run["id"];
    const startedAt = run["run_started_at"];
    if (typeof id !== "number" || typeof startedAt !== "string") continue;
    const jobs = jobsForRun(id);
    const upstream = jobs.filter((j) => /^CI — (TS\/Bun|Rust\/Tauri)/.test(j.name));
    const legs = jobs.filter((j) => j.name.startsWith("E2E Desktop —"));
    const gatedBy = bindingUpstream(upstream);
    for (const leg of legs) {
      if (gatedBy) binding.set(gatedBy.name, (binding.get(gatedBy.name) ?? 0) + 1);
      const wait = minutesBetween(leg.created_at, startedAt);
      waitsByLeg.set(leg.name, [...(waitsByLeg.get(leg.name) ?? []), wait]);
    }
  }

  console.log(`\nruns sampled: ${runs.length}`);
  console.log("\nWHICH upstream job gated E2E (times it was last to finish):");
  for (const [name, n] of [...binding].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}x  ${name}`);
  }
  console.log("\nDAG wait per E2E leg (minutes):");
  for (const [leg, ws] of [...waitsByLeg].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(
      `  ${leg.padEnd(34)} median ${median(ws).toFixed(1).padStart(6)}  max ${Math.max(...ws).toFixed(1).padStart(6)}  n=${ws.length}`,
    );
  }
}
```

- [ ] **Step 6: Implement the concurrency probe**

Create `scripts/ci-latency/probe-concurrency.ts`:

```ts
#!/usr/bin/env bun

/**
 * P4b diagnostic — jobs per run, peak concurrent execution, and how many jobs
 * sat created-but-waiting at that peak.
 *
 * This is the probe that found the slice's premise: a push run demands ~105
 * job slots from a pool granting 13-17. Not a gate; see probe-dag.ts.
 *
 * Usage: bun scripts/ci-latency/probe-concurrency.ts [--runs N]
 */

import { isRecord, runGh } from "../structure-audit/_gh-audit.ts";
import { concurrencySeries } from "./probe-lib.ts";

const REPO = "nimbus-agent/Nimbus";

interface Job {
  name: string;
  created_at: string;
  started_at: string;
  completed_at: string | null;
}

function api(path: string): unknown {
  const r = runGh(["gh", "api", path]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function asJobs(value: unknown): Job[] {
  if (!isRecord(value) || !Array.isArray(value["jobs"])) return [];
  const out: Job[] = [];
  for (const j of value["jobs"]) {
    if (!isRecord(j)) continue;
    const name = j["name"];
    const created = j["created_at"];
    const started = j["started_at"];
    const completed = j["completed_at"];
    if (typeof name !== "string" || typeof created !== "string" || typeof started !== "string") {
      continue;
    }
    out.push({
      name,
      created_at: created,
      started_at: started,
      completed_at: typeof completed === "string" ? completed : null,
    });
  }
  return out;
}

function parseRunsArg(argv: string[]): number {
  const ix = argv.indexOf("--runs");
  if (ix === -1) return 4;
  const n = Number(argv[ix + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

if (import.meta.main) {
  const wanted = parseRunsArg(process.argv.slice(2));
  const listed = api(
    `repos/${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&status=success&per_page=${wanted}`,
  );
  const runs = isRecord(listed) && Array.isArray(listed["workflow_runs"]) ? listed["workflow_runs"] : [];
  if (runs.length === 0) {
    console.error("probe-concurrency: no successful push runs readable — is `gh` authenticated?");
    process.exit(1);
  }

  for (const run of runs) {
    if (!isRecord(run)) continue;
    const id = run["id"];
    const startedAt = run["run_started_at"];
    if (typeof id !== "number" || typeof startedAt !== "string") continue;

    const jobs: Job[] = [];
    for (let page = 1; page <= 5; page++) {
      const payload = api(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100&page=${page}`);
      const batch = asJobs(payload);
      if (batch.length === 0) break;
      jobs.push(...batch);
      const total = isRecord(payload) ? payload["total_count"] : undefined;
      if (typeof total === "number" && jobs.length >= total) break;
    }
    const usable = jobs.filter((j) => j.completed_at !== null);
    if (usable.length === 0) continue;

    const series = concurrencySeries(usable, startedAt);
    const peak = series.length === 0 ? 0 : Math.max(...series);
    const peakMinute = series.indexOf(peak);
    const peakAt = Date.parse(startedAt) + peakMinute * 60_000;
    const waitingAtPeak = usable.filter(
      (j) => Date.parse(j.created_at) <= peakAt && Date.parse(j.started_at) > peakAt,
    ).length;
    const count = (re: RegExp) => usable.filter((j) => re.test(j.name)).length;

    console.log(`\nrun ${id} — ${usable.length} jobs, wall ${series.length - 1}min`);
    console.log(
      `    ubuntu=${count(/ubuntu/)} windows=${count(/windows/)} macos=${count(/macos/)}`,
    );
    console.log(`    PEAK concurrent = ${peak} (minute ${peakMinute})`);
    console.log(`    created-but-waiting at peak = ${waitingAtPeak}`);
    console.log(`    profile: ${series.join(" ")}`);
  }
}
```

- [ ] **Step 7: Verify types, lint and the whole scripts suite**

Run: `bunx tsc -p scripts/tsconfig.json --noEmit && bunx biome check --error-on-warnings scripts && bun test scripts/`

Expected: all three exit 0.

- [ ] **Step 8: Capture the BEFORE measurement**

Run both probes against `main` and save the output — this is the baseline the
roadmap entry in Task 6 quotes:

```bash
bun scripts/ci-latency/probe-dag.ts --runs 15 > /tmp/p4b-before-dag.txt
bun scripts/ci-latency/probe-concurrency.ts --runs 4 > /tmp/p4b-before-concurrency.txt
```

Expected: DAG wait median ~33.4 min per E2E leg; ~105 jobs per run; peak
concurrent 13–17. If the figures differ materially from these, record what was
actually measured — the measurement is the record, not the prediction.

- [ ] **Step 9: Commit**

```bash
git add scripts/ci-latency/probe-lib.ts scripts/ci-latency/probe-lib.test.ts \
        scripts/ci-latency/probe-dag.ts scripts/ci-latency/probe-concurrency.ts
git commit -m "feat(ci): promote the P4b measurement probes out of scratch

audit:ci-latency gates EXECUTION, so it cannot prove this slice worked -- the
win lands in queue and DAG wait, which it reports and never gates. These two
probes are the instrument that can. Pure arithmetic lives in probe-lib.ts so it
is unit-testable without a network call."
```

---

## Task 6: Record the outcome

**Files:**

- Modify: `docs/infrastructure-roadmap.md` — the P4b progress log and the
  sub-programs table row.

**Interfaces:**

- Consumes: the before/after probe figures from Task 5 Step 8 and Step 3 below.
- Produces: nothing.

- [ ] **Step 1: Verify the full local gate set passes**

Run: `bun run preflight:fast`

Expected: every gate passes, including the new `audit:coverage-gate-pal`.
Fix anything red before continuing — do not proceed with a failing gate.

- [ ] **Step 2: Update the P4b sub-programs table row**

In `docs/infrastructure-roadmap.md`, replace the `P4b` row's status and gate
text with:

```markdown
| P4b | Latency | ✅ measurement + tuning shipped | `audit:ci-latency` tracks per-job execution, runner queue and DAG wait across the 9 org repos and fails when a job's execution regresses beyond its own measured noise band. Tuning followed the measurement, not the design of record's hunch: a push run demanded ~105 job slots against a pool granting 13-17, so the fix was cutting the fan-out (coverage gates 72 → 36 jobs, Linux-only except the 6 PAL-touching ones) and narrowing E2E's dependency edge — not the proposed cache tuning or sharding, which would have added jobs to the constrained pool. |
```

- [ ] **Step 3: Capture the AFTER measurement**

Once the branch has merged and at least one push run to `main` has completed
with the new workflow:

```bash
bun scripts/ci-latency/probe-dag.ts --runs 5
bun scripts/ci-latency/probe-concurrency.ts --runs 2
```

Record the actual numbers. Do not write predicted figures into the log.

- [ ] **Step 4: Append the tuning entries to the P4b progress log**

Under `### P4b progress log` in `docs/infrastructure-roadmap.md`, replace the
`- **Remaining:** the tuning slice…` bullet with:

```markdown
- **Delivered (tuning, 2026-07-28):** the measurement's own "clearest lead" was
  wrong, and two probes disproved it. Across 45 `E2E Desktop` legs the binding
  upstream job was ubuntu 30×, windows 15×, **macOS only 3×**, and runner queue
  was ~10min median on every OS. The constraint is not macOS scarcity: a push
  run demands ~105 job slots against a pool granting 13-17, with 32-41 jobs
  created-but-waiting at peak; one sampled run opened with nine consecutive
  minutes at zero running jobs. 72 of those 105 jobs were one 24-entry
  coverage matrix run once per OS.
- **This retired the design of record's sharding proposal.** Sharding adds jobs
  to the pool that IS the constraint.
- **Two changes:** coverage-threshold gates run on Linux only except the six
  whose covered code branches on platform (72 → 36 jobs; a run 105 → 69), and
  `e2e-desktop` now waits on `ci-rust` (1.17-1.72min) instead of `ci-ts` (30
  jobs, 33.4min median DAG wait) — an edge that carried no artifacts.
- **`audit:ci-latency` cannot prove this worked**, since it gates execution
  while the win lands in queue and DAG wait. `scripts/ci-latency/probe-dag.ts`
  and `probe-concurrency.ts` are the instrument; before/after figures recorded
  here.
- **Guarded against silent decay:** `audit:coverage-gate-pal` fails when a
  platform-branching file is unclassified, when a classified file's gate is not
  `pal: true`, or when a new matrix entry carries no explicit `pal` field.
- **Deferred:** guarding E2E against a TypeScript failure on `main`. Measured
  2 of the last 40 `main` commits arrived without a PR, both `ci(cla)` workflow
  commits touching no TypeScript. No standalone fast typecheck job exists to
  depend on (`Static`, 4.57min, sits inside `_test-suite.yml` where `needs:`
  cannot reach it), so guarding costs a duplicate typecheck job on every push.
  **Adopt if** a `main` E2E run is ever seen burning on a TS compile failure.
- **Baseline regeneration is due after ~12 post-change push runs**, when the
  36 abandoned macOS/Windows coverage keys have aged out of the sampling window
  (`MAX_RUNS_PER_WORKFLOW`). Regenerating sooner is a no-op: the window still
  holds pre-change runs carrying those keys.
```

- [ ] **Step 5: Lint the Markdown and check links**

Run: `bun run lint:markdown && bun run audit:doc-refs`

Expected: `0 error(s)` and all refs resolve.

- [ ] **Step 6: Commit**

```bash
git add docs/infrastructure-roadmap.md
git commit -m "docs(infra): record the P4b tuning outcome and its deferrals"
```

---

## Self-Review

**Spec coverage.** Change A → Task 2. Change B → Task 4. Change C → Tasks 1 and
3. Verification/probes → Task 5. Baseline regeneration trigger → Task 6 Step 4.
Deferred finding 2 with its trigger → Task 6 Step 4. Risks table → carried into
the roadmap log. No spec section is unimplemented.

**Placeholder scan.** No "TBD"/"TODO"/"handle edge cases". Every code step
carries the literal code. Task 5 Step 8 and Task 6 Step 3 deliberately record
*measured* rather than predicted figures — that is an instruction to measure,
not a placeholder.

**Type consistency.** `AuditResult` (`{ ok, errors }`) matches
`check-action-sha-pins.ts`. `GateEntry.pal` is `boolean | null` in the
implementation, the tests, and the parser. `PlatformFileEntry` fields
(`file`/`gate`/`why`) are identical in the data module and every consumer.
`bindingUpstream` takes `CompletedJob[]` and returns `CompletedJob | null` in
both the test and the implementation. `runGh` is used with the exact signature
read from `_gh-audit.ts`.

**Known ordering constraint.** Task 1 ships an audit that is RED against the
real repo; Task 2 turns it green. A reviewer seeing Task 1 in isolation should
expect that red — it is the gate's red-proof, stated in the Task 1 preamble and
its commit message.
