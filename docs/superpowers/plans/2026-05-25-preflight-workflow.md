# Pre-flight Workflow Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full CI gate set runnable locally in one fail-fast `preflight` command, keep local==CI from drifting (a test enforces it), catch the cross-platform footgun class statically, de-flake SonarQube, and add opt-in git guardrails.

**Architecture:** A single gate **manifest** (`scripts/lib/preflight-gates.ts`) is the source of truth for what `preflight`/`preflight:fast` run; a **drift test** parses the workflows and fails if any `bun run`/`bunx` gate is missing from the manifest or an explicit CI-only allowlist. A narrow regex **cross-platform audit** runs in the fast tier and CI. SonarQube becomes `continue-on-error`. Opt-in `.githooks/` add a branch-guard pre-commit and a `preflight:fast` pre-push.

**Tech Stack:** Bun + TypeScript (scripts), `bun:test`, GitHub Actions YAML, POSIX-sh git hooks.

**Spec:** [`docs/superpowers/specs/2026-05-25-preflight-workflow-design.md`](../specs/2026-05-25-preflight-workflow-design.md)

> **Branch:** work on `dev/asafgolombek/preflight-workflow` (already created from `main`). Never commit on `main`/`develop`.

---

## File map

| File | Responsibility |
|---|---|
| `scripts/lib/preflight-gates.ts` | **Create.** `Gate`/`GateTier` types, `PREFLIGHT_GATES`, `CI_ONLY_GATES`, pure `selectGates(tier)`. |
| `scripts/preflight.ts` | **Create.** CLI runner: `--fast`/`--list`/`--no-bail`; spawns gates, fail-fast, prints summary. |
| `scripts/preflight.test.ts` | **Create.** Drift test: every workflow `bun run`/`bunx` gate ∈ manifest ∪ CI-only allowlist. |
| `scripts/audit/check-cross-platform.ts` | **Create.** Narrow regex audit over `*.test.ts(x)` path assertions; `// cross-platform-ok` escape hatch. |
| `scripts/audit/check-cross-platform.test.ts` | **Create.** Unit tests for the detector (seeded violation + suppression). |
| `package.json` | **Modify.** Add `preflight`, `preflight:fast`, `audit:cross-platform`, `hooks:install`. |
| `.github/workflows/_test-suite.yml` | **Modify.** `continue-on-error: true` on SonarQube step (line 343); add an `audit:cross-platform` step. |
| `.githooks/pre-commit` | **Create.** Block commits on `main`/`develop` (override env); fast staged-file lint. |
| `.githooks/pre-push` | **Create.** Print skip hint, run `preflight:fast`. |
| `scripts/install-hooks.ts` | **Create.** Set `core.hooksPath`; warn+`--force` if already set elsewhere. Pure `decideHookInstall()` helper. |
| `scripts/install-hooks.test.ts` | **Create.** Unit tests for `decideHookInstall()`. |
| `CLAUDE.md` / `GEMINI.md` | **Modify.** Pre-flight command, branch hygiene, cross-platform note, skill ref. |
| `.claude/commands/nimbus-preflight.md` | **Create.** The skill. |

> **TDD note:** logic-bearing files (manifest selection, drift extractor, cross-platform detector, hook-install decision) get real unit tests first. YAML/bash/docs are verified by running them. Every inserted markdown heading/list/table needs blank lines around it (markdownlint MD022/MD032).

---

## Task 1: Gate manifest + runner + npm scripts

**Files:**
- Create: `scripts/lib/preflight-gates.ts`
- Create: `scripts/preflight.ts`
- Create: `scripts/lib/preflight-gates.test.ts`
- Modify: `package.json` (scripts block, after line 84 `audit:package-readmes` and near line 90 `test:ci`)

- [ ] **Step 1: Write the failing test for the manifest + selection**

Create `scripts/lib/preflight-gates.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CI_ONLY_GATES, PREFLIGHT_GATES, selectGates } from "./preflight-gates.ts";

describe("preflight gate manifest", () => {
  test("every gate has a name and a non-empty argv", () => {
    for (const g of PREFLIGHT_GATES) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.cmd.length).toBeGreaterThan(0);
      expect(["fast", "full"]).toContain(g.tier);
    }
  });

  test("gate names are unique", () => {
    const names = PREFLIGHT_GATES.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("selectGates('fast') returns only fast-tier gates", () => {
    expect(selectGates("fast").every((g) => g.tier === "fast")).toBe(true);
  });

  test("selectGates('full') returns fast THEN full, fast-tier first", () => {
    const full = selectGates("full");
    const firstFullIdx = full.findIndex((g) => g.tier === "full");
    const lastFastIdx = full.map((g) => g.tier).lastIndexOf("fast");
    expect(lastFastIdx).toBeLessThan(firstFullIdx);
  });

  test("CI_ONLY_GATES is a non-empty list of strings", () => {
    expect(CI_ONLY_GATES.length).toBeGreaterThan(0);
    expect(CI_ONLY_GATES.every((s) => typeof s === "string")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test scripts/lib/preflight-gates.test.ts`
Expected: FAIL — `Cannot find module './preflight-gates.ts'`.

- [ ] **Step 3: Implement the manifest**

Create `scripts/lib/preflight-gates.ts`:

```ts
/**
 * Single source of truth for what `bun run preflight[:fast]` executes.
 * The drift test (scripts/preflight.test.ts) asserts every `bun run`/`bunx`
 * gate referenced in .github/workflows/ appears here or in CI_ONLY_GATES.
 */

export type GateTier = "fast" | "full";

export interface Gate {
  /** Human label shown in the summary. */
  readonly name: string;
  /** argv executed via Bun.spawn (no shell). */
  readonly cmd: readonly string[];
  /** "fast" = cheap static; "full" = heavy (also runs in full tier). */
  readonly tier: GateTier;
  /** Report failure but do not fail the run. Default false. */
  readonly soft?: boolean;
}

/** Fast tier — cheap static gates, ~2-3 min, no full test run. */
const FAST: readonly Gate[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"], tier: "fast" },
  { name: "lint (biome)", cmd: ["bun", "run", "lint"], tier: "fast" },
  { name: "lint:markdown", cmd: ["bun", "run", "lint:markdown"], tier: "fast" },
  { name: "audit:doc-refs", cmd: ["bun", "run", "audit:doc-refs"], tier: "fast" },
  { name: "audit:openapi-drift", cmd: ["bun", "run", "audit:openapi-drift"], tier: "fast" },
  { name: "audit:boundaries", cmd: ["bun", "run", "audit:boundaries"], tier: "fast" },
  { name: "audit:invariants", cmd: ["bun", "run", "audit:invariants"], tier: "fast" },
  { name: "audit:any", cmd: ["bun", "run", "audit:any", "--check"], tier: "fast" },
  { name: "audit:release-please", cmd: ["bun", "run", "audit:release-please"], tier: "fast" },
  { name: "audit:js-licenses", cmd: ["bun", "run", "audit:js-licenses"], tier: "fast" },
  { name: "audit:svg-assets", cmd: ["bun", "run", "audit:svg-assets"], tier: "fast" },
  { name: "audit:readme-cli", cmd: ["bun", "run", "audit:readme-cli"], tier: "fast" },
  { name: "audit:package-readmes", cmd: ["bun", "run", "audit:package-readmes"], tier: "fast" },
  { name: "audit:cross-platform", cmd: ["bun", "run", "audit:cross-platform"], tier: "fast" },
  { name: "audit:exclusion-parity", cmd: ["bun", "run", "audit:exclusion-parity"], tier: "fast" },
  // jscpd flags mirror ci.yml's duplication job exactly (keep in sync).
  {
    name: "duplication (jscpd)",
    cmd: [
      "bunx", "jscpd", "--min-lines", "10", "--min-tokens", "50", "--threshold", "5",
      "--reporters", "console",
      "-i", "**/node_modules/**,**/*.test.ts,**/*.test.tsx,**/*.vitest.tsx",
      "packages/",
    ],
    tier: "fast",
  },
];

/** Full tier — heavy: build + full suite + coverage floor (needs lcov from the run). */
const FULL: readonly Gate[] = [
  { name: "build", cmd: ["bun", "run", "build"], tier: "full" },
  { name: "test:ci (suite + coverage)", cmd: ["bun", "run", "test:ci"], tier: "full" },
  { name: "coverage-floor: build lcov", cmd: ["bun", "run", "audit:coverage-floor:build-lcov"], tier: "full" },
  { name: "audit:coverage-floor", cmd: ["bun", "run", "audit:coverage-floor"], tier: "full" },
];

export const PREFLIGHT_GATES: readonly Gate[] = [...FAST, ...FULL];

/**
 * Workflow `bun run`/`bunx` invocations that CI runs but preflight intentionally
 * does NOT (external services, packaging, publish, slow benches). The drift test
 * requires every workflow gate to be here OR in PREFLIGHT_GATES.
 */
export const CI_ONLY_GATES: readonly string[] = [
  "test:scripts",                       // run by `bun test scripts` separately
  "audit:coverage-floor:build-lcov",    // composed into the full-tier gate above
  "package:headless",
  "package:installers:linux",
  "docs:build",
];

/** Pure: fast → [fast...]; full → [fast..., full...]. */
export function selectGates(tier: GateTier): Gate[] {
  if (tier === "fast") return PREFLIGHT_GATES.filter((g) => g.tier === "fast");
  return [...PREFLIGHT_GATES];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/lib/preflight-gates.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the runner**

Create `scripts/preflight.ts`:

```ts
#!/usr/bin/env bun
/**
 * Local CI-parity pre-flight. `bun run preflight` (full) / `bun run preflight:fast`.
 * Flags: --fast (fast tier only), --list (print gates, run nothing), --no-bail
 * (run all gates, don't stop at first failure).
 */
import { type Gate, type GateTier, selectGates } from "./lib/preflight-gates.ts";

const argv = Bun.argv.slice(2);
const fast = argv.includes("--fast");
const list = argv.includes("--list");
const noBail = argv.includes("--no-bail");
const tier: GateTier = fast ? "fast" : "full";
const gates = selectGates(tier);

if (list) {
  console.log(`preflight (${tier}) — ${gates.length} gates:`);
  for (const g of gates) console.log(`  - ${g.name}: ${g.cmd.join(" ")}${g.soft ? " (soft)" : ""}`);
  process.exit(0);
}

async function runGate(g: Gate): Promise<boolean> {
  const started = Date.now();
  process.stdout.write(`\n▶ ${g.name} …\n`);
  const proc = Bun.spawn(g.cmd as string[], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = code === 0;
  process.stdout.write(`${ok ? "✓" : "✗"} ${g.name} (${secs}s)\n`);
  return ok || Boolean(g.soft);
}

const results: Array<{ gate: Gate; ok: boolean }> = [];
let hardFail = false;
for (const g of gates) {
  const ok = await runGate(g);
  results.push({ gate: g, ok });
  if (!ok) {
    hardFail = true;
    if (!noBail) break;
  }
}

// Output stays live (inherit) so long gates (build, test:ci) show progress.
// Rather than buffer failing stderr — which would hide that progress — re-print
// the exact command for each failed gate so the user can reproduce it in
// isolation without scrolling (review S2).
process.stdout.write(`\n── preflight (${tier}) summary ──\n`);
for (const r of results) process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${r.gate.name}\n`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  process.stdout.write("\nFailed gate(s) — re-run individually to see the failure:\n");
  for (const r of failed) process.stdout.write(`  ${r.gate.cmd.join(" ")}\n`);
}
process.stdout.write(hardFail ? "\npreflight FAILED\n" : "\npreflight PASSED\n");
process.exit(hardFail ? 1 : 0);
```

- [ ] **Step 6: Add npm scripts**

In `package.json`, after the `"audit:package-readmes": …` line add:

```json
    "audit:cross-platform": "bun scripts/audit/check-cross-platform.ts",
```

And after the `"lint:markdown": …` line (before `test:ci`) add:

```json
    "preflight": "bun scripts/preflight.ts",
    "preflight:fast": "bun scripts/preflight.ts --fast",
    "hooks:install": "bun scripts/install-hooks.ts",
```

- [ ] **Step 7: Verify the runner lists gates**

Run: `bun run preflight:fast --list`
Expected: prints the fast-tier gate list (includes `audit:cross-platform`). `audit:cross-platform` will not yet run (added in Task 3); `--list` does not execute.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/preflight-gates.ts scripts/lib/preflight-gates.test.ts scripts/preflight.ts package.json
git commit -m "$(cat <<'EOF'
feat(preflight): gate manifest + fail-fast runner + npm scripts

Single source of truth (PREFLIGHT_GATES) for local CI-parity; preflight / preflight:fast.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Drift test (local==CI guard)

**Files:**
- Create: `scripts/preflight.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/preflight.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./structure-audit/lib.ts";
import { CI_ONLY_GATES, PREFLIGHT_GATES } from "./lib/preflight-gates.ts";

/**
 * Extract `bun run <script>` and `bunx <tool>` gate ids from a workflow file.
 * Flag-tolerant: matches `bun run X`, `bun --bun run X`, `bunx X`, `bunx --bun X`
 * so an intervening runtime flag can't silently hide a gate (review Q1).
 */
export function extractWorkflowGates(yaml: string): string[] {
  const gates = new Set<string>();
  for (const m of yaml.matchAll(/\bbun(?:\s+--?[\w-]+)*\s+run\s+([a-z][\w:-]+)/g)) gates.add(m[1] as string);
  for (const m of yaml.matchAll(/\bbunx(?:\s+--?[\w-]+)*\s+([a-z][\w@/-]+)/g)) gates.add(m[1] as string);
  return [...gates];
}

function manifestScriptIds(): Set<string> {
  const ids = new Set<string>();
  for (const g of PREFLIGHT_GATES) {
    // "bun run X" -> X ; "bunx Y ..." -> Y
    if (g.cmd[0] === "bun" && g.cmd[1] === "run" && g.cmd[2]) ids.add(g.cmd[2]);
    if (g.cmd[0] === "bunx" && g.cmd[1]) ids.add(g.cmd[1]);
  }
  for (const c of CI_ONLY_GATES) ids.add(c);
  return ids;
}

describe("preflight drift guard", () => {
  test("extractWorkflowGates pulls bun run + bunx ids", () => {
    const y = "      - run: bun run audit:boundaries\n      - run: bunx jscpd packages/\n";
    expect(extractWorkflowGates(y).sort()).toEqual(["audit:boundaries", "jscpd"]);
  });

  test("extractWorkflowGates tolerates intervening flags (--bun)", () => {
    const y = "      - run: bun --bun run audit:any\n      - run: bunx --bun vitest run\n";
    expect(extractWorkflowGates(y).sort()).toEqual(["audit:any", "vitest"]);
  });

  test("every workflow bun run/bunx gate is in the manifest or CI_ONLY_GATES", () => {
    const dir = join(REPO_ROOT, ".github", "workflows");
    const known = manifestScriptIds();
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
      const gates = extractWorkflowGates(readFileSync(join(dir, f), "utf8"));
      for (const g of gates) if (!known.has(g)) missing.push(`${f}: ${g}`);
    }
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect it to fail with the real drift list**

Run: `bun test scripts/preflight.test.ts`
Expected: the second test FAILS, printing workflow gates not yet covered (e.g. `audit:high`, `regen-slo`-style scripts, or anything in CI not in the manifest). This is the drift surfacing — good.

- [ ] **Step 3: Resolve each missing gate**

For every entry the test prints, decide: is it a gate `preflight` should run? → add it to the correct tier in `scripts/lib/preflight-gates.ts`. Is it genuinely CI-only (publish, external, packaging, perf bench)? → add its script id to `CI_ONLY_GATES`. Re-run until the list is empty. Record the reasoning for any CI-only addition in a trailing comment on that array entry.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test scripts/preflight.test.ts`
Expected: PASS (2 tests, `missing` empty).

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight.test.ts scripts/lib/preflight-gates.ts
git commit -m "$(cat <<'EOF'
test(preflight): drift guard — every workflow bun run/bunx gate is in the manifest or CI-only allowlist

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Cross-platform static audit

**Files:**
- Create: `scripts/audit/check-cross-platform.ts`
- Create: `scripts/audit/check-cross-platform.test.ts`
- Modify: `.github/workflows/_test-suite.yml` (add an `audit:cross-platform` step near the other `audit:*` steps, ~line 115 after the OpenAPI drift step)

- [ ] **Step 1: Write the failing test**

Create `scripts/audit/check-cross-platform.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { findCrossPlatformIssues } from "./check-cross-platform.ts";

describe("cross-platform audit detector", () => {
  test("flags a hardcoded-separator path in a toBe assertion", () => {
    const src = `expect(p).toBe("/tmp/nimbus/data.db");\n`;
    const issues = findCrossPlatformIssues(src, "x.test.ts");
    expect(issues.length).toBe(1);
    expect(issues[0]?.line).toBe(1);
  });

  test("flags a backslash path in toContain", () => {
    const src = `expect(out).toContain("data\\\\nimbus.db");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(1);
  });

  test("ignores a line with the // cross-platform-ok escape hatch", () => {
    const src = `expect(p).toBe("/tmp/x.db"); // cross-platform-ok\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });

  test("ignores URLs and non-path strings", () => {
    const src = `expect(u).toBe("https://api.example.com/v1/x");\nexpect(s).toBe("hello world");\n`;
    expect(findCrossPlatformIssues(src, "x.test.ts").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test scripts/audit/check-cross-platform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the detector + CLI**

Create `scripts/audit/check-cross-platform.ts`:

```ts
#!/usr/bin/env bun
/**
 * Narrow v1 cross-platform audit: flags filesystem-path string literals with an
 * explicit separator inside test assertions, which break on the other OS unless
 * built with path.join()/os.tmpdir(). Suppress a line with `// cross-platform-ok`.
 * v2 (if noisy): replace the regex with an AST-based check. See the design spec.
 */
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { REPO_ROOT } from "../structure-audit/lib.ts";

export interface CrossPlatformIssue {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

// `toMatch` is intentionally excluded — it is overwhelmingly used with regexes /
// substrings, the largest false-positive source (review Q2). Add it back only
// behind the AST v2 rewrite.
const ASSERTION_RE =
  /\.(toBe|toEqual|toStrictEqual|toContain)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

function looksLikePathWithSeparator(literal: string): boolean {
  const s = literal.replace(/\\\\/g, "\\"); // collapse escaped backslashes
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false; // URL scheme
  if (!/[\\/]/.test(s)) return false; // no separator at all
  if (/^(\/[^/]|[A-Za-z]:\\|\.\.?[\\/]|\\\\)/.test(s)) return true; // absolute / drive / rel / UNC
  if (/[\\/][\w.-]+\.[A-Za-z0-9]{1,6}$/.test(s)) return true; // .../file.ext
  return false;
}

export function findCrossPlatformIssues(source: string, file: string): CrossPlatformIssue[] {
  const issues: CrossPlatformIssue[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("// cross-platform-ok")) continue;
    ASSERTION_RE.lastIndex = 0;
    for (const m of line.matchAll(ASSERTION_RE)) {
      const literal = m[3] ?? "";
      if (looksLikePathWithSeparator(literal)) {
        issues.push({ file, line: i + 1, text: literal });
      }
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const all: CrossPlatformIssue[] = [];
  const glob = new Glob("packages/**/*.test.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: REPO_ROOT })) {
    const abs = `${REPO_ROOT}/${rel}`;
    for (const issue of findCrossPlatformIssues(readFileSync(abs, "utf8"), rel.replaceAll("\\", "/"))) {
      all.push(issue);
    }
  }
  if (all.length === 0) {
    console.log("cross-platform audit: no hardcoded-separator path assertions in test files.");
    return;
  }
  for (const i of all) {
    console.error(
      `::error file=${i.file},line=${i.line}::hardcoded path separator in assertion: "${i.text}" — use path.join()/os.tmpdir(), or add \`// cross-platform-ok\` if intentional`,
    );
  }
  console.error(`\n${all.length} cross-platform issue(s).`);
  process.exit(1);
}

if (import.meta.main) await main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/audit/check-cross-platform.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the audit against the repo and triage**

Run: `bun run audit:cross-platform`
Expected: either clean, OR a list of real findings. For each finding, fix the test to use `join()`/`os.tmpdir()` **or** append `// cross-platform-ok` if the literal is genuinely platform-agnostic (e.g. a POSIX-only fixture). Re-run until exit 0.

**Triage guidance (review Q2 — avoid `// cross-platform-ok` sprawl):** if the initial run is noisy with false positives (coincidental JSON/regex/mock strings), prefer **tightening `looksLikePathWithSeparator` or dropping an assertion matcher** over mass-annotating. Reserve `// cross-platform-ok` for the handful of genuinely-intentional platform-specific literals. If noise persists after reasonable narrowing, that is the signal to do the AST v2 rewrite (see the script header) rather than ship a noisy regex. Never weaken it so far that it misses `/tmp`-style absolute roots — those are the real bugs.

- [ ] **Step 6: Wire the audit into CI**

In `.github/workflows/_test-suite.yml`, find the `- name: OpenAPI drift check` step (runs `bun run audit:openapi-drift`, ~line 115). Add immediately after it (match the surrounding 6-space step indentation, blank line between steps):

```yaml
      - name: Cross-platform audit (test path assertions)
        run: bun run audit:cross-platform
```

- [ ] **Step 7: Commit**

```bash
git add scripts/audit/check-cross-platform.ts scripts/audit/check-cross-platform.test.ts .github/workflows/_test-suite.yml
git commit -m "$(cat <<'EOF'
feat(audit): narrow cross-platform path-assertion audit + CI step

Catches hardcoded-separator paths in test assertions (the createWindowsPaths class) before CI. `// cross-platform-ok` escape hatch; AST is the v2 escalation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SonarQube soft-fail

**Files:**
- Modify: `.github/workflows/_test-suite.yml:343` (SonarQube Cloud analysis step)

- [ ] **Step 1: Add continue-on-error to the SonarQube step**

In `.github/workflows/_test-suite.yml`, the step at line 343 begins:

```yaml
      - name: SonarQube Cloud analysis
```

Its keys currently are `name`, comment lines, `if:`, `uses:`, `env:`. Add a `continue-on-error: true` key to this step — insert it on its own line immediately **after** the `if: runner.os == 'Linux' && env.SONAR_TOKEN != ''` line (line 348), at the same 8-space indentation:

```yaml
        if: runner.os == 'Linux' && env.SONAR_TOKEN != ''
        continue-on-error: true
        uses: SonarSource/sonarqube-scan-action@7006c4492b2e0ee0f816d36501671557c97f5995 # v8.1.0
```

- [ ] **Step 2: Verify the YAML still parses**

Run: `bun -e "import('js-yaml').then(y=>{const fs=require('fs');y.load(fs.readFileSync('.github/workflows/_test-suite.yml','utf8'));console.log('YAML OK')})"`
Expected: `YAML OK` (no parse error). (`js-yaml` is already a dependency.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/_test-suite.yml
git commit -m "$(cat <<'EOF'
ci: make SonarQube Cloud analysis continue-on-error (de-flake; advisory not a gate)

External sonar-scanner exit codes (e.g. 3) no longer fail the build; data still uploads to SonarCloud.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

> Follow-up (not code): confirm SonarQube is not in branch-protection required checks. Document in the skill (Task 7).

---

## Task 5: Git hooks + install script

**Files:**
- Create: `scripts/install-hooks.ts`
- Create: `scripts/install-hooks.test.ts`
- Create: `.githooks/pre-commit`
- Create: `.githooks/pre-push`

- [ ] **Step 1: Write the failing test for the install decision**

Create `scripts/install-hooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decideHookInstall } from "./install-hooks.ts";

describe("decideHookInstall", () => {
  test("installs when hooksPath is unset", () => {
    expect(decideHookInstall(null, false)).toEqual({ action: "install" });
  });
  test("no-op when already .githooks", () => {
    expect(decideHookInstall(".githooks", false)).toEqual({ action: "noop" });
  });
  test("warns when set elsewhere without --force", () => {
    expect(decideHookInstall(".husky", false)).toEqual({ action: "warn", current: ".husky" });
  });
  test("installs when set elsewhere with --force", () => {
    expect(decideHookInstall(".husky", true)).toEqual({ action: "install" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test scripts/install-hooks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement install-hooks**

Create `scripts/install-hooks.ts`:

```ts
#!/usr/bin/env bun
/** Install repo git hooks by pointing core.hooksPath at .githooks. Opt-in. */

export type InstallDecision =
  | { action: "install" }
  | { action: "noop" }
  | { action: "warn"; current: string };

/** Pure decision: what to do given the current core.hooksPath and --force. */
export function decideHookInstall(current: string | null, force: boolean): InstallDecision {
  if (current === ".githooks") return { action: "noop" };
  if (current === null || current === "" || force) return { action: "install" };
  return { action: "warn", current };
}

async function gitConfigGet(key: string): Promise<string | null> {
  const p = Bun.spawn(["git", "config", "--local", "--get", key], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out.length > 0 ? out : null;
}

async function main(): Promise<void> {
  const force = Bun.argv.slice(2).includes("--force");
  const current = await gitConfigGet("core.hooksPath");
  const decision = decideHookInstall(current, force);

  if (decision.action === "noop") {
    console.log("git hooks already installed (core.hooksPath=.githooks).");
    return;
  }
  if (decision.action === "warn") {
    console.error(
      `core.hooksPath is already set to "${decision.current}". Installing .githooks will ` +
        `supersede it AND any manual .git/hooks/ scripts. Re-run with --force to proceed:\n` +
        `  bun run hooks:install --force`,
    );
    process.exit(1);
  }
  const p = Bun.spawn(["git", "config", "--local", "core.hooksPath", ".githooks"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) process.exit(1);
  console.log("Installed git hooks (core.hooksPath=.githooks). pre-commit blocks default-branch commits; pre-push runs preflight:fast.");
}

if (import.meta.main) await main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/install-hooks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the pre-commit hook**

Create `.githooks/pre-commit`:

```sh
#!/bin/sh
# Block commits on the default branches; branch first. Override:
#   NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1 git commit ...
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$branch" = "main" ] || [ "$branch" = "develop" ]; then
  if [ "$NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT" != "1" ]; then
    echo "✗ Refusing to commit on '$branch'. Create a feature branch first:" >&2
    echo "    git switch -c dev/<you>/<topic>" >&2
    echo "  (override: NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1)" >&2
    exit 1
  fi
fi
# GUI git clients often don't load your shell profile, so bun may be off PATH.
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ 'bun' not found on PATH. If committing from a GUI/IDE, ensure your shell" >&2
  echo "  profile is loaded for git, or commit from a terminal." >&2
  exit 1
fi
# Fast formatting/lint check on staged files (non-fatal hint if biome missing).
bun run lint >/dev/null 2>&1 || {
  echo "✗ Biome check failed. Run 'bun run lint:fix' and re-stage." >&2
  exit 1
}
exit 0
```

- [ ] **Step 6: Create the pre-push hook**

Create `.githooks/pre-push`:

```sh
#!/bin/sh
# Runs the fast pre-flight before pushing. Skip (emergency/trivial):
#   NIMBUS_SKIP_PREPUSH=1 git push
if [ "$NIMBUS_SKIP_PREPUSH" = "1" ]; then
  echo "↷ pre-push: skipped via NIMBUS_SKIP_PREPUSH=1"
  exit 0
fi
# GUI git clients often don't load your shell profile, so bun may be off PATH.
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ 'bun' not found on PATH. If pushing from a GUI/IDE, ensure your shell" >&2
  echo "  profile is loaded for git, or push from a terminal (or NIMBUS_SKIP_PREPUSH=1)." >&2
  exit 1
fi
echo "▶ pre-push: running 'bun run preflight:fast' (skip with NIMBUS_SKIP_PREPUSH=1) …"
bun run preflight:fast || {
  echo "✗ preflight:fast failed — push aborted. Fix, or NIMBUS_SKIP_PREPUSH=1 to bypass." >&2
  exit 1
}
exit 0
```

- [ ] **Step 7: Make hooks executable + verify install logic end-to-end**

Run:
```bash
chmod +x .githooks/pre-commit .githooks/pre-push
bun run hooks:install
git config --local --get core.hooksPath
```
Expected: prints install confirmation, then `.githooks`.

Run (verify branch-guard, from a non-default branch — should pass; the guard only blocks main/develop):
```bash
git rev-parse --abbrev-ref HEAD
```
Expected: `dev/asafgolombek/preflight-workflow` (not main/develop → commits allowed).

- [ ] **Step 8: Commit**

```bash
git add scripts/install-hooks.ts scripts/install-hooks.test.ts .githooks/pre-commit .githooks/pre-push
git commit -m "$(cat <<'EOF'
feat(hooks): opt-in .githooks (branch-guard pre-commit + preflight:fast pre-push) + installer

hooks:install warns + requires --force if core.hooksPath is already set elsewhere.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs — CLAUDE.md, GEMINI.md, nimbus-preflight skill

**Files:**
- Modify: `CLAUDE.md` (Development Workflow section, ~line 106-110; Skill References list ~line 123-138)
- Modify: `GEMINI.md` (mirror)
- Create: `.claude/commands/nimbus-preflight.md`

- [ ] **Step 1: Update CLAUDE.md Development Workflow**

In `CLAUDE.md`, replace the line:

```markdown
**Pre-flight before pushing a PR:** `bun run test:ci` (full CI parity). Full command catalogue + coverage thresholds + env-var overrides live in the [`nimbus-commands`](./.claude/commands/nimbus-commands.md) skill. File-location pointers live in [`nimbus-file-map`](./.claude/commands/nimbus-file-map.md).
```

with:

```markdown
**Pre-flight before pushing a PR:** `bun run preflight` (full local CI parity — every gate CI runs) or `bun run preflight:fast` (~2-3 min, all the cheap static gates). **`bun run test:ci` is only the test suite — it is NOT the full gate set; `preflight` is.** The gate manifest lives in `scripts/lib/preflight-gates.ts`; a drift test (`scripts/preflight.test.ts`) fails if a CI gate is missing from it. See the [`nimbus-preflight`](./.claude/commands/nimbus-preflight.md) skill.

**Branch hygiene:** never commit on `main` / `develop` — branch first (`git switch -c dev/<you>/<topic>`) and verify `git rev-parse --abbrev-ref HEAD` before committing. `bun run hooks:install` installs a pre-commit guard that enforces this and a pre-push `preflight:fast`.

**Cross-platform:** build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators — `bun run audit:cross-platform` flags hardcoded-separator path assertions in tests (escape hatch: `// cross-platform-ok`).

Full command catalogue + coverage thresholds + env-var overrides live in the [`nimbus-commands`](./.claude/commands/nimbus-commands.md) skill. File-location pointers live in [`nimbus-file-map`](./.claude/commands/nimbus-file-map.md).
```

- [ ] **Step 2: Add the skill to the CLAUDE.md Skill References list**

In the `## Skill References` block, insert (alphabetical order, after `nimbus-ipc.md`):

```markdown
@.claude/commands/nimbus-preflight.md
```

- [ ] **Step 3: Mirror both edits into GEMINI.md**

Apply the same two edits (Development Workflow text + skill reference) to `GEMINI.md`. Find the equivalent "Pre-flight before pushing a PR" line and skill-reference list; if GEMINI.md's structure differs, match its existing format but carry the same content.

- [ ] **Step 4: Create the skill**

Create `.claude/commands/nimbus-preflight.md`:

```markdown
---
name: nimbus-preflight
description: >
  How to run the local CI-parity pre-flight before pushing a Nimbus PR, why
  `test:ci` is not enough, and the workflow guardrails. Use this skill when the
  user asks "what should I run before pushing", "why did my PR fail CI", "how do
  I avoid CI failures", "pre-flight" / "preflight", "which gates does CI run",
  when wiring a new CI gate (it must be added to the manifest or the drift test
  fails), or when touching cross-platform path code / git hooks / SonarQube CI.
---

# Nimbus Pre-flight & Workflow Guardrails

## Run this before pushing

- `bun run preflight` — **full** local CI parity: every gate CI runs (typecheck, Biome, markdownlint, all `audit:*`, duplication, cross-platform, build, `test:ci`, coverage floor). Fail-fast; `--no-bail` runs them all; `--list` prints the gate list.
- `bun run preflight:fast` — the cheap static gates only (~2-3 min). Catches the majority of PR failures without the full test run.

**`bun run test:ci` runs only the test suite — it is NOT the full gate set.** `preflight` is. The historical habit of running just `test:ci` is the #1 cause of PRs that fail on gates the author never ran locally.

## The gate manifest (single source of truth)

`scripts/lib/preflight-gates.ts` — `PREFLIGHT_GATES` (each `{ name, cmd, tier }`) + `CI_ONLY_GATES` (gates CI runs that preflight intentionally skips: publish, packaging, external services, perf benches).

**Adding a new CI gate?** Add its `bun run`/`bunx` invocation to `PREFLIGHT_GATES` (right tier) — or, if it's genuinely CI-only, to `CI_ONLY_GATES`. The drift test `scripts/preflight.test.ts` parses every workflow's `run:` blocks and **fails** if a `bun run`/`bunx` gate is in neither list. This is what keeps local == CI.

## Cross-platform discipline

Develop on one OS, but CI runs all three. Build paths with `path.join()` / `os.tmpdir()` / `PlatformServices`, never hardcoded `/` or `\` separators or absolute roots (`/tmp`, `C:\`). `bun run audit:cross-platform` flags hardcoded-separator path literals in `*.test.ts` assertions. Genuinely platform-specific literal? End the line with `// cross-platform-ok`. (v1 is a narrow regex; an AST-based rule is the documented v2 if it proves noisy.)

## Git guardrails (opt-in)

`bun run hooks:install` points `core.hooksPath` at `.githooks/` (warns + needs `--force` if you already use another hooks path):
- **pre-commit** refuses commits on `main`/`develop` — branch first. Override: `NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT=1`.
- **pre-push** runs `preflight:fast`. Override (emergency/trivial): `NIMBUS_SKIP_PREPUSH=1`.

## SonarQube

The SonarQube Cloud analysis step is `continue-on-error: true` — an external `sonar-scanner` failure (e.g. exit 3) does not fail the build, and is not a branch-protection required check. Analysis still uploads to the SonarCloud dashboard; review it there.
```

- [ ] **Step 5: Verify doc gates**

Run: `bun run lint:markdown`
Expected: 0 errors.
Run: `bun run audit:doc-refs`
Expected: all refs resolve (the new skill link + manifest path resolve).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md GEMINI.md .claude/commands/nimbus-preflight.md
git commit -m "$(cat <<'EOF'
docs: preflight workflow — CLAUDE.md/GEMINI.md pre-flight + branch hygiene + cross-platform; nimbus-preflight skill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Dogfood + finalize

**Files:** none new (validation).

- [ ] **Step 1: Run the fast pre-flight on the whole change**

Run: `bun run preflight:fast`
Expected: every fast gate ✓, `preflight PASSED`. Fix anything that fails (most likely a cross-platform finding in a new file, a markdownlint issue, or a missing manifest entry).

- [ ] **Step 2: Run the drift + script tests**

Run: `bun test scripts`
Expected: PASS — including `preflight.test.ts` (drift empty), `preflight-gates.test.ts`, `check-cross-platform.test.ts`, `install-hooks.test.ts`.

- [ ] **Step 3: Run the full pre-flight once (true parity)**

Run: `bun run preflight`
Expected: all gates ✓ (this is the heavy run — build + `test:ci` + coverage floor). If a full-tier gate fails for reasons unrelated to this change (pre-existing flake), note it; do not paper over a real failure.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A -- scripts package.json .github CLAUDE.md GEMINI.md .claude .githooks
git commit -m "$(cat <<'EOF'
chore(preflight): dogfood fixes — green preflight + drift test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Do not `git add` `.claude/settings.local.json` — it is an unrelated local modification.)

---

## Self-review (completed by plan author)

**Spec coverage:**
- Component 1 (manifest + runner + scripts) → Task 1. ✓
- Drift test → Task 2. ✓
- Component 2 (cross-platform audit + CI wiring) → Task 3. ✓
- Component 3 (Sonar soft-fail) → Task 4. ✓
- Component 4 (hooks + installer, warn+`--force`, pre-push hint) → Task 5. ✓
- Component 5 (CLAUDE.md/GEMINI.md docs) → Task 6 Steps 1-3. ✓
- Component 6 (nimbus-preflight skill) → Task 6 Step 4. ✓
- DoD #7 (dogfood — change passes `preflight`) → Task 7. ✓
- Review Q1 (drift extracts all `bun run`/`bunx`) → Task 2 extractor. ✓
- Review Q2 (pre-push prints skip hint) → Task 5 Step 6. ✓
- Review S1 (AST v2 deferred, documented) → Task 3 file header + skill. ✓
- Review S2 (install warns + `--force`) → Task 5 `decideHookInstall`. ✓
- Review S3 (Sonar visibility note) → skill SonarQube section. ✓

**Placeholder scan:** none — every code/test/bash/YAML step shows complete content. Task 2 Step 3 and Task 3 Step 5 are *triage* steps (the repo's real state determines the exact entries), which is correct for a drift/audit gate — the code that does the work is fully specified; the human resolves data the tool surfaces.

**Type/term consistency:** `Gate`/`GateTier`/`PREFLIGHT_GATES`/`CI_ONLY_GATES`/`selectGates` (Task 1) used identically in Tasks 2 & runner; `findCrossPlatformIssues`/`CrossPlatformIssue` (Task 3) match their test; `decideHookInstall`/`InstallDecision` (Task 5) match their test; `extractWorkflowGates` (Task 2) used only there. Env-var names (`NIMBUS_ALLOW_DEFAULT_BRANCH_COMMIT`, `NIMBUS_SKIP_PREPUSH`) consistent across hook, docs, and skill.

**Out of scope (unchanged):** matrix-on-PR, knip gate, hook auto-install, Sonar retry/digest, AST cross-platform (v2).
