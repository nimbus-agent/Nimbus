# SonarCloud Cleanup 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the `nimbus-agent_Nimbus` SonarCloud project to a clean state — fix the stale project config, remediate all 1,442 open issues **in code** (no blanket rule exclusions; test files held to the same standard as production), flip Reliability and Security from **D** to **A**, **cut duplication density below 0.5%**, and **raise test coverage as high as possible** (every package comfortably above its CI floor, pushing toward ≥90% overall).

**Architecture:** Staged into independent PRs, smallest-risk and highest-rating-impact first. PR 1 corrects the dead project key (pure config). PR 2 fixes the real bugs. PR 3 remediates the 329 hardcoded-temp-path findings with `mkdtempSync` (security + cross-platform fix, not suppression). PR 4 de-hardcodes test IP literals. PR 5+ burns down the smells. Each rule-group is enumerated live from the SonarCloud `api/issues/search` endpoint at execution time (line attribution drifts after squash-merges, so re-fetch per PR), transformed with the canonical fix shown here, and verified with `bun run preflight`/`preflight:fast` before commit.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, Biome, SonarCloud (org `nimbus-agent`, project `nimbus-agent_Nimbus`, "Sonar way" profile).

**Policy (decided 2026-06-05):** **Fix, don't exclude.** No `sonar.issue.ignore` rule exclusions are added. Test files are remediated to the same standard as production. `// NOSONAR` / mark-safe is reserved ONLY for genuinely unfixable cases with a written justification (currently just S6324 on the ANSI-escape regex), recorded in `docs/structure-audit/sonarqube-rule-tuning.md`. See memory `sonar-prefer-fix-over-exclude`.

**Live enumeration query (re-run per rule):**

```text
https://sonarcloud.io/api/issues/search?componentKeys=nimbus-agent_Nimbus&resolved=false&rules=<RULE>&ps=200&p=1
```

Parse `.issues[].component` (strip the `nimbus-agent_Nimbus:` prefix to get the repo-relative path) and `.issues[].line`.

**Non-negotiables that constrain fixes:**

- No `any` (use `unknown`). TypeScript strict stays on.
- Never weaken a security invariant (I1–I17) to satisfy a smell. If a Sonar fix conflicts with an invariant, suppress the Sonar issue (justified) instead.
- Cross-platform: build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators (CLAUDE.md non-negotiable #5).
- Branch hygiene: all work on `dev/asafgolombek/sonar-cleanup-6` (current worktree branch).

---

## Rule inventory (baseline 2026-06-05)

| Rule | Count | Type | Disposition |
|---|---|---|---|
| S5443 | 329 | Vuln | **Fix:** hardcoded `/tmp/...` literals → `mkdtempSync(join(tmpdir(),…))` — PR 3 |
| S4325 | 622 | Smell | Remove redundant cast / non-null assertion — PR 6 (split by package) |
| S3863 | 83 | Smell | Merge duplicate imports — PR 5 |
| S2871 | 59 | Bug | Add `.sort()` comparator — PR 2 |
| S1313 | 19 | Smell | **Fix:** hardcoded IP literals → shared test-host constant — PR 4 |
| S7780/S7721/S7748/S7778/S7735/S7744/S7763/S7758/S7749/S7755/S7786/S7781/S7764/S7787/S7773/S7776/S7765/S7767/S7754 | ~210 | Smell | Modern-JS rules; per-rule transform — PR 7 |
| S6551/S6557/S6594/S6571/S6582/S6353/S6598/S6606/S6647 | ~60 | Smell | Type/nullish cleanups — PR 7 |
| S3776 | 21 | Smell | Cognitive complexity — refactor, PR 8 |
| S3358 | 15 | Smell | Nested ternary — PR 7 |
| shelldre:S7688/S1066/S7682/S7679 | 14 | Smell | Shell-script smells — PR 7 |
| S1186 | 6 | Smell | Empty function — PR 5 |
| S4323/S5869/S4624/S7722/S4030/S2933/S4138/S4043/S3735/S2486 | ~25 | Smell | Long tail — PR 7 |
| S4158 | 4 | Bug | Empty-collection access — investigate, PR 2 |
| S6324 | 4 | Bug | Control char in ANSI regex (intentional) — **justified suppress**, PR 2 |

---

## PR 1 — Fix the stale SonarCloud project config (+ stop Automatic Analysis)

**Goal:** Correct the dead project key/org so the live dashboard (and CI gate) actually reflect this repo, AND ensure the CI scanner — not SonarCloud Automatic Analysis — is the analysis method. Pure config; no rule exclusions.

**Root-cause context (load-bearing):** The `asafgolombek_Nimbus` project 404s — the live project is `nimbus-agent_Nimbus` under org `nimbus-agent`. Strong evidence the live project is on **Automatic Analysis**, not our CI scanner: (a) the `coverage` measure is **empty** (autoscan cannot ingest `lcov`), and (b) files in our `sonar.cpd.exclusions` (e.g. `mcp-connectors/*/src/tools.ts`) still report high duplication. The CI step that disables autoscan targets the **dead key**, so it never applied. Fixing the key + pointing the disable call at the live key switches analysis to the scanner, which **re-applies our `cpd.exclusions` + `coverage.exclusions` + lcov coverage** — this alone deflates part of the 5.8% duplication and populates coverage before any code change.

**Files:**

- Modify: `sonar-project.properties`
- Modify: `.github/workflows/_test-suite.yml` (autoscan `projectKey`)
- Modify: `docs/structure-audit/sonarqube-rule-tuning.md`

- [ ] **Step 1: Correct the project key and organization**

In `sonar-project.properties`:

```properties
sonar.organization=nimbus-agent
# Must match the SonarCloud project key.
sonar.projectKey=nimbus-agent_Nimbus
```

- [ ] **Step 2: Update the autoscan projectKey in CI**

In `.github/workflows/_test-suite.yml`, change the autoscan-disable curl target:

```text
'https://sonarcloud.io/api/autoscan/activation?projectKey=nimbus-agent_Nimbus&enable=false'
```

- [ ] **Step 3: Record the key migration in the audit doc (no rules disabled)**

In `docs/structure-audit/sonarqube-rule-tuning.md`, keep the disable table at `_none_` (policy: fix, don't exclude) and add a header note:

```markdown
**2026-06-05:** Project key migrated `asafgolombek_Nimbus` → `nimbus-agent_Nimbus`
(org `asafgolombek` → `nimbus-agent`). Cleanup 6 policy: **fix in code, do not
disable rules.** The only inline suppression is `S6324` on the ANSI-escape regex
in `scripts/cast-driver/normalize.ts` (literal ESC/BEL bytes are intrinsic to
OSC parsing; mirrors the existing `biome-ignore`).
```

- [ ] **Step 4: Validate and commit**

Run: `bun run preflight:fast`
Expected: PASS (no code touched).

```bash
git add sonar-project.properties .github/workflows/_test-suite.yml docs/structure-audit/sonarqube-rule-tuning.md
git commit -m "fix(sonar): correct stale project key (asafgolombek→nimbus-agent)"
```

---

## PR 2 — Fix the 67 real bugs (Reliability D→A)

**Goal:** Clear all BUG-type issues: 59× S2871 (sort comparator), 4× S4158 (empty-collection), 4× S6324 (control-char regex, justified suppress).

### Task 2a: S2871 — provide a `.sort()` comparator

**Files:** 59 sites from the `typescript:S2871` query (e.g. `packages/gateway/src/federation/namespace-store.test.ts:49`, `scripts/coverage-floor/check.ts:117`, `scripts/cleanup/survey-comments.ts:67`).

- [ ] **Step 1: Enumerate the sites**

Run the live query for `typescript:S2871` (ps=200). Build the `path:line` list.

- [ ] **Step 2: Apply the canonical comparator at each site (type-driven)**

Read each site's element type. Strings → `localeCompare`; numbers → numeric:

```typescript
// string array
names.sort();                 // → names.sort((a, b) => a.localeCompare(b));
// number array (default sort is a genuine bug: lexicographic on numbers)
ids.sort();                   // → ids.sort((a, b) => a - b);
```

**Nullish guard:** `undefined` elements are never passed to a comparator (the spec sorts them to the end with or without one), so `localeCompare` is safe there. But `null` elements (or mixed types) ARE passed and `null.localeCompare(...)` throws. Read the element type first: if it's a clean `string[]` / `number[]` (the common case here), apply directly; if the array can hold `null`, narrow/filter before sorting or use a null-safe comparator (`(a, b) => (a ?? "").localeCompare(b ?? "")`). Do not blindly template.

- [ ] **Step 3: Verify the affected test files still pass**

Run, per touched package, e.g. `bun test packages/gateway/src/federation/ packages/gateway/src/index/migrations/`
Expected: PASS. (If an assertion relied on a specific tie order, fix the assertion to match the deterministic comparator — don't revert the comparator.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(sonar): provide explicit sort comparators (S2871, 59 sites)"
```

### Task 2b: S4158 — empty-collection access in `spawn-gateway.test.ts`

**Files:** `packages/cli/src/lib/spawn-gateway.test.ts` (lines ~55, 62, 66, 73 — the `liveProcs` Set iteration in `afterEach`/`afterAll`).

- [ ] **Step 1: Determine whether `liveProcs` is ever populated**

Read the whole file. Search for `liveProcs.add(`.

- If **nothing adds** to it: the cleanup loops are dead code — remove the `liveProcs` Set + both hooks, OR wire the missing `.add()` if a spawned proc was meant to be tracked (check whether tests spawn real subprocesses that leak).
- If something **does add** conditionally below the analyzed region: Sonar FP — add `// NOSONAR S4158: populated by the spawn helper below` on each flagged line and note why in the commit.

- [ ] **Step 2: Verify**

Run: `bun test packages/cli/src/lib/spawn-gateway.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/lib/spawn-gateway.test.ts
git commit -m "fix(sonar): resolve S4158 empty-collection access in spawn-gateway.test"
```

### Task 2c: S6324 — control char in ANSI regex (justified suppress)

**Files:** `scripts/cast-driver/normalize.ts:14` (the `ANSI_OSC` regex; 4 control-char hits: `\x1b`, `\x07`).

- [ ] **Step 1: Suppress — the control chars are required and unfixable**

This regex parses ANSI OSC escape sequences; the literal `\x1b` (ESC) and `\x07` (BEL) bytes are intrinsic, and the file already carries a `biome-ignore` for the same reason. This is the one sanctioned suppression in this workstream. Add a trailing `// NOSONAR`:

```typescript
const ANSI_OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g; // NOSONAR S6324: ANSI OSC parsing requires literal ESC/BEL control bytes
```

- [ ] **Step 2: Verify lint + the normalizer's tests**

Run: `bun run lint` and `bun test scripts/` (or the cast-driver test if present).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/cast-driver/normalize.ts
git commit -m "fix(sonar): suppress S6324 on required ANSI control-byte regex (justified)"
```

### Task 2d: Verify the full bug class is clear

- [ ] **Step 1: preflight:fast; after next CI scan `types=BUG` total should be 0.**

Run: `bun run preflight:fast` → PASS.

---

## PR 3 — S5443: remediate hardcoded temp-path literals (329, fix not exclude)

**Goal:** Replace hardcoded `/tmp/...` string literals (security-sensitive *and* a cross-platform footgun — they pass today only because they're fake mock paths) with real, unique, cross-platform temp dirs via `mkdtempSync`. Clears S5443 the compliant way, adds parallel-test isolation, and removes the `/`-separator hazard. Split by package; each package commits independently.

**Files:** 329 sites from `typescript:S5443`, all `*.test.ts` (+ a couple `mcp-connectors/*/test`), bucketed by package. Examples: `packages/cli/src/commands/doctor-core.test.ts:44-49`, `packages/gateway/src/embedding/model.test.ts:40`, `packages/cli/src/commands/update.test.ts:132`.

- [ ] **Step 1: Enumerate and bucket by package**

Run the live query for `typescript:S5443` (paginate p=1..2; 329 > ps=200). Bucket `component` paths by top-level package.

- [ ] **Step 2: Per file, create one `mkdtempSync` root in `beforeAll` and build paths from it**

The canonical transform — initialize the temp root in a `beforeAll` hook (NOT at module scope: Bun executes module-level code on import, so a filtered/skipped file would still create — and possibly leak — a temp dir). Assign to a `let`, derive all fake paths via `join`, clean up in `afterAll`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let FAKE_PATHS: CliPlatformPaths;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-doctor-test-")); // unique per-file prefix
  FAKE_PATHS = {
    configDir: join(tmpRoot, "config"),
    dataDir: join(tmpRoot, "data"),
    logDir: join(tmpRoot, "data", "logs"),
    socketPath: join(tmpRoot, "gateway.sock"),
    extensionsDir: join(tmpRoot, "data", "extensions"),
    tempDir: join(tmpRoot, "tmp"),
  } as unknown as CliPlatformPaths;
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});
```

Notes:

- Works for **pure-mock fixtures** (never written to disk) too — it just creates an empty real temp dir, which is honest and clears S5443 without suppression.
- Where a module-level `const FAKE_PATHS` was consumed by other module-level constants, those consumers must also move into the hook / lazy accessor — a small per-file restructure. If a file's fixture is referenced only inside test bodies, the `let` + `beforeAll` swap is mechanical.
- Sonar flags the temp-dir *reference literal*; once paths derive from a `mkdtempSync` variable, only the compliant `mkdtempSync(join(tmpdir(), …))` call remains.
- Use a per-file unique prefix (`"nimbus-<area>-test-"`) so concurrent runs don't collide.
- Do NOT replace a `/tmp/x` literal with `os.tmpdir()`-joined-but-not-mkdtemp — `os.tmpdir()` alone is still S5443-flagged.

- [ ] **Step 3: Verify per package and commit per package**

Run, per package: `bun test <package path>` (+ `bun run typecheck` if imports changed).
Expected: PASS. Watch for tests that asserted on the literal string `/tmp/...` — update those assertions to derive from `tmpRoot`.

```bash
git commit -m "fix(sonar): replace hardcoded temp-path literals with mkdtempSync in <package> (S5443)"
```

- [ ] **Step 4: Full preflight before PR**

Run: `bun run preflight` (touches many files across packages) → PASS.

---

## PR 4 — S1313: de-hardcode test IP literals (19, fix not exclude)

**Goal:** Remove hardcoded IP literals from tests. **Correction (from review):** extracting `const TEST_LOOPBACK = "127.0.0.1"` does NOT clear S1313 — the rule fires on the literal wherever it sits, including the constant declaration. So the real fix is hostname-based where loopback semantics allow, with a single justified suppression only where IPv4-loopback is strictly required.

**Files:** 19 sites from `typescript:S1313`.

- [ ] **Step 1: Enumerate and guard the I6 invariant**

Run the live query for `typescript:S1313`. Confirm every site is a test `127.0.0.1`/`::1` loopback literal. If any hit is a production `0.0.0.0` bind, STOP — that would be an I6 violation; fix that site separately and flag it. Expected: all 19 in tests.

- [ ] **Step 2: Per site — prefer `"localhost"`; classify the few that need the IP literal**

For each site, decide:

- **Behavior-equivalent → use `"localhost"`** (a hostname, not an IP — clears S1313 entirely, zero suppression). Applies where the test connects to a loopback server it also started, and the resolver choice doesn't matter.
- **IPv4-loopback strictly required → keep the literal** (e.g. a server explicitly bound to `127.0.0.1` won't accept a `::1` connection, or the test asserts on IP *parsing*/formatting). `"localhost"` is NOT a safe swap here — it can resolve to `::1`.

```typescript
connect("127.0.0.1", port);   // loopback-equivalent → connect("localhost", port);
```

- [ ] **Step 3: For the IPv4-required remainder, consolidate to ONE site + one justified suppression**

Put the single literal in one shared test helper with a `// NOSONAR S1313` and a comment, and import it everywhere it's needed — so there is at most ONE suppressed line, not 19:

```typescript
// packages/<pkg>/test/_helpers/loopback.ts
export const IPV4_LOOPBACK = "127.0.0.1"; // NOSONAR S1313: tests that require IPv4-loopback semantics (server bound to 127.0.0.1 rejects ::1)
```

Record this single exception in `docs/structure-audit/sonarqube-rule-tuning.md`. (If Step 2 converts every site to `localhost`, this step is skipped and there is zero suppression.)

- [ ] **Step 4: Verify and commit**

Run: affected packages' `bun test` + `bun run typecheck` → PASS. (Watch for tests that bound to `127.0.0.1` but now connect via `localhost` — confirm the bind host matches, or keep the literal per Step 2.)

```bash
git add -A
git commit -m "refactor(sonar): de-hardcode test IP literals — localhost where equivalent (S1313)"
```

---

## PR 5 — Safe mechanical smells

**Goal:** Clear S3863 (83 duplicate imports) plus the small behavior-preserving rules (S6571, S6582, S4138, S1186, S6594, S4323, S4043, S2933).

### Task 5a: S3863 — merge duplicate imports

**Files:** 83 sites from `typescript:S3863` (all `*.test.ts`, importing `cli-mocks.ts` etc. twice).

- [ ] **Step 1: Enumerate; try `bun run lint` first (Biome `organizeImports` may auto-merge a subset).**
- [ ] **Step 2: Hand-merge the remainder:**

```typescript
import { makeMockGateway } from "./cli-mocks.ts";
import { fakeProc } from "./cli-mocks.ts";
// → import { fakeProc, makeMockGateway } from "./cli-mocks.ts";
```

Keep `import type` separate only if merging changes emit; else `import { type B, a }`.

- [ ] **Step 3: Verify** — `bun run typecheck` + `bun test packages/cli/src/commands/` → PASS.
- [ ] **Step 4: Commit** — `refactor(sonar): merge duplicate imports (S3863, 83 sites)`

### Task 5b: Small behavior-preserving rules (one rule → one commit)

- [ ] **Step 1: For each of S6582, S6571, S4138, S1186, S6594, S4323, S4043, S2933 — enumerate, apply the canonical fix, verify, commit.**

Canonical fixes:

- **S6582** prefer optional chaining: `a && a.b` → `a?.b`.
- **S6571** redundant union member: drop the member already subsumed (e.g. keep `unknown`).
- **S4138** use `for...of` over index loop on a plain array.
- **S1186** empty function: add `/* intentionally empty */`, or remove if dead.
- **S6594** `RegExp.exec` over `String.match` when not using `/g`: `str.match(re)` → `re.exec(str)`.
- **S4323** extract a repeated union into a `type` alias.
- **S4043** clone before sort/reverse on a param: `[...xs].sort(...)`.
- **S2933** mark a never-reassigned-after-ctor field `readonly`.

After each rule: `bun run typecheck` + affected `bun test`. Commit `refactor(sonar): <rule> — <one-line>`.

- [ ] **Step 2: `bun run preflight:fast` before PR → PASS.**

---

## PR 6 — S4325 redundant casts / non-null assertions (622, split by package)

**Goal:** Remove redundant `as T` casts and `!` assertions. Highest-risk class — `tsc` is the oracle. Split by package; each sub-commit must typecheck.

**Files:** enumerated live from `typescript:S4325`, grouped by package (paginate p=1..4; 622 > ps=200).

- [ ] **Step 1: Enumerate and bucket by package.**
- [ ] **Step 2: Per package, delete each redundant cast/assertion:**

```typescript
const n = (x as number) + 1;   // → const n = x + 1;
foo(bar!.baz);                 // → foo(bar.baz);
```

**Guard rail:** after removal, run `bun run typecheck`. If it now errors on that line, the assertion was NOT redundant (Sonar's model diverged from `tsc`) — restore it and add `// NOSONAR S4325`. Never silence with `any` or a looser type.

- [ ] **Step 3: Verify + commit per package** — `bun run typecheck` + package `bun test`; `refactor(sonar): drop redundant casts/non-null in <package> (S4325)`.
- [ ] **Step 4: `bun run preflight` before PR (largest churn) → PASS.**

---

## PR 7 — Modern-JS + long-tail smells

**Goal:** Clear the S77xx modern-JS rules (~210), S6xxx type/nullish (~60), S3358 nested ternary (15), `shelldre:*` shell smells (14), and the remaining long tail.

- [ ] **Step 1: Re-enumerate the `types=CODE_SMELL&facets=rules` list (it shifts as PRs 5–6 land). For each rule key, open its SonarCloud rule description for the exact transform (S77xx are recent SonarJS "modern syntax" rules — e.g. `Array.prototype.flat`, `String.prototype.replaceAll`, `Object.hasOwn`, top-level `await`).**
- [ ] **Step 2: One rule → one commit.** Enumerate, apply, `bun run typecheck` + affected `bun test`, commit `refactor(sonar): <rule> — <summary>`. `shelldre:*` rules are in shell scripts / workflow `run:` blocks — fix per ShellCheck guidance (quote expansions, drop useless `cat`).
- [ ] **Step 3: `bun run preflight:fast` before PR → PASS.**

---

## PR 8 — Cognitive complexity (S3776, 21)

**Goal:** Reduce the 21 over-threshold functions by extracting helpers. Behavior-preserving; highest review burden, kept last.

- [ ] **Step 1: Enumerate the 21 sites (each names the function + score vs threshold 15).**
- [ ] **Step 2: Per function, extract cohesive sub-steps into named same-file helpers. Don't change the public signature/behavior. For load-bearing subsystems (executor, query-gate, lan-server) cross-check `nimbus-architecture` and keep extractions in-file (don't move logic across module boundaries / risk an invariant).**
- [ ] **Step 3: Verify per file + commit per function** — file `bun test` + `bun run typecheck`; `refactor(sonar): reduce cognitive complexity of <fn> (S3776)`.
- [ ] **Step 4: `bun run preflight` + final re-scan — confirm the quality gate is green and Reliability/Security/Maintainability are all A.**

---

## PR 9 — Cut code duplication below 0.5%

**Goal:** Drive `duplicated_lines_density` from 5.8% to **< 0.5%**. Order: (1) let PR 1's autoscan→scanner switch re-apply the existing `cpd.exclusions` (connector `tools.ts`/`server.ts`, `*-sync.ts`/`*-mapping.ts`, SQL templates, perf fixtures, `gw-state-helpers`) and re-measure; (2) **dedup genuine copy-paste** in test boilerplate via shared harnesses (the bulk); (3) for any *remaining* duplication that is **deliberate, documented parallelism**, extend `sonar.cpd.exclusions` with a rationale comment (the established repo pattern — distinct from issue-suppression, which the policy forbids).

**Duplication hotspots (baseline, mostly shared test setup):**
`phase3-config.test.ts` (921), `connector-rpc-handlers/auth.test.ts` (681), `credential-orchestration.test.ts` (443, 77%), `flush-scheduler.test.ts` (255), CLI command tests `connector`/`index-cmd`/`catchup`/`impact`/`expert`/`ask`.test.ts (60%+ each, all duplicating the `cli-mocks` harness), the connector `*-sync.test.ts` family (github-actions/github/gitlab/circleci/discord/bitbucket/slack — duplicated paged-walk + assertion scaffolds), `oauth-registry.test.ts` (185), extension auto-update tests, `wake-word.test.ts`.

**Package-boundary guard rail (from review):** every extracted harness MUST stay within its own package — `packages/cli` test harnesses live under `packages/cli/`, gateway/connector harnesses under `packages/gateway/`, and `mcp-connectors` share only via the existing `packages/mcp-connectors/shared/` (relative-import, dep-constrained — see memory `shared-folder-external-deps`). A CLI test must never import gateway source, and no harness may introduce a cross-package import that violates the dependency rules. If two packages share a test pattern, duplicate the small harness per package rather than create a cross-package dependency.

- [ ] **Step 1: Re-baseline after PR 1**

After PR 1 merges and a scanner analysis runs, re-fetch `component_tree` for `duplicated_lines_density` (the `&qualifiers=FIL` query in this doc's header) and recompute the gap to 0.5%. Drop any hotspot already neutralised by an existing exclusion.

- [ ] **Step 2: Extract a shared CLI-command test harness**

The largest cluster is ~30 `packages/cli/src/commands/*.test.ts` files repeating the same mock-gateway + captureOutput + arg-parse scaffold. Create `packages/cli/src/commands/_test-harness.ts` (or extend the existing `cli-mocks.ts`) exposing a single factory, e.g.:

```typescript
export function withCommandHarness(opts: CommandHarnessOpts): CommandHarness {
  const out = captureOutput();
  const gateway = makeMockGateway(opts.rpc ?? {});
  const client = makeMockIpcClient(gateway).client;
  return { out, client, gateway, run: (argv) => runCommand(argv, { client }) };
}
```

Replace the per-file duplicated setup with one `withCommandHarness(...)` call. Verify after each file: `bun test packages/cli/src/commands/<file>`.

- [ ] **Step 3: Extract a shared connector-sync test harness**

The `*-sync.test.ts` family duplicates the fake-HTTP-server + paged-walk + IndexedItem-assertion scaffold. Add a shared helper under `packages/gateway/test/unit/connectors/_sync-test-harness.ts` that takes the per-connector fixtures and runs the common assertions. Migrate each `*-sync.test.ts` to it. Verify per file.

- [ ] **Step 4: Dedup the large gateway unit tests**

`phase3-config.test.ts`, `auth.test.ts`, `credential-orchestration.test.ts`, `flush-scheduler.test.ts` have big internal repetition — extract per-file local helpers / `describe.each` table-driven cases for the repeated blocks. Keep behavior identical; verify per file.

- [ ] **Step 5: For residual *deliberate* parallelism only — extend cpd.exclusions with rationale**

If, after Steps 2–4, specific files remain duplicated **by design** (e.g. a deliberately byte-identical fixture pair), add them to `sonar.cpd.exclusions` in `sonar-project.properties` **with a comment** explaining why dedup would harm clarity/isolation — matching the existing documented exclusions. Do NOT use this to dodge real copy-paste.

- [ ] **Step 6: Verify < 0.5% and commit per cluster**

After each cluster: `bun run typecheck` + the affected package's `bun test`. Commit per cluster (`refactor(test): shared CLI command harness — dedup`, etc.). Final check after CI scan: `duplicated_lines_density < 0.5`.

```bash
git commit -m "refactor(test): extract shared harness, dedup <cluster> (duplication)"
```

---

## PR 10 — Raise test coverage as high as possible

**Goal:** With coverage measurement restored by PR 1 (scanner ingests `lcov`), lift every package comfortably above its CI floor and push overall toward **≥90%**, lowest-covered files first. Iterative — runs until coverage plateaus or the user calls it.

**CI floors to clear/exceed (from `_test-suite.yml` / `nimbus-commands`):** Engine ≥85%, Vault ≥90%, Embedding ≥80%, plus scheduler/rate-limiter/people thresholds, and the file-level `audit:coverage-floor` (Linux-authoritative). Coverage-excluded files (`sonar.coverage.exclusions` — entry-point `server.ts`/`main.ts`/`index.ts`, SQL templates, sandbox PAL, perf surfaces) stay excluded; don't write tests just to cover structurally-untestable entry points.

- [ ] **Step 1: Generate the current coverage map**

Run: `bun run test:ci` (writes `coverage/lcov.info`) or the per-package coverage command. Parse lcov for the lowest-covered non-excluded files. Rank by `(uncovered lines × subsystem importance)`.

- [ ] **Step 2: Per low-covered file, add tests using the right layer**

Follow `nimbus-testing` to pick the layer (unit / integration with real SQLite / E2E CLI with real Gateway subprocess). For each target: identify uncovered branches from lcov, write focused tests (TDD where adding behavior; characterization tests where locking existing behavior), verify the file crosses its floor.

```bash
bun test <file> --coverage-reporter=lcov   # confirm the file's % rose
```

- [ ] **Step 3: Respect isolation + flake rules**

Real SQLite + fresh temp dirs per test (now via `mkdtempSync` from PR 3). Prefer **DI over `mock.module`** (process-global leak contaminates siblings on CI-Linux — recorded gotcha). New temp dirs must be cleaned up.

- [ ] **Step 4: Verify on CI-Linux (coverage-floor is Linux-authoritative)**

A file can read ≥ floor on Windows yet `<` on Linux in the combined run. Before claiming a floor cleared, reproduce in the Docker `oven/bun` harness (CLAUDE.md recipe) or push and read the Ubuntu gate.

- [ ] **Step 5: Commit per subsystem; stop at plateau**

Commit `test(<subsystem>): raise coverage to <N>%`. Continue lowest-first until overall ≥90% or marginal files are all structurally-untestable; report the final per-package numbers.

- [ ] **Step 6: Full preflight + final scan**

Run: `bun run preflight` → PASS. Confirm SonarCloud quality gate green; Reliability/Security/Maintainability **A**; duplication **< 0.5%**; coverage at target.

---

## Self-review notes

- **Spec coverage:** every rule in the baseline inventory maps to a PR (config: PR 1; bugs: PR 2; S5443: PR 3; S1313: PR 4; safe smells: PR 5; casts: PR 6; long tail: PR 7; complexity: PR 8). Duplication < 0.5%: PR 9. Coverage as high as possible: PR 10.
- **Duplication strategy:** dedup genuine copy-paste (shared harnesses) is the bulk; `cpd.exclusions` is used ONLY for documented deliberate parallelism (existing repo pattern), never to hide real duplication. PR 1's autoscan→scanner switch is a prerequisite (it re-applies the existing exclusions + restores coverage measurement).
- **Policy consistency:** no `sonar.issue.ignore` exclusions anywhere; the only suppression is the justified S6324 ANSI case (PR 2c), recorded in the audit doc.
- **Invariant safety:** PR 4 Step 1 guards I6 (no `0.0.0.0` site swept into the IP refactor); PR 6 Step 2 forbids `any`-silencing; PR 8 Step 2 routes invariant-bearing files through `nimbus-architecture`.
- **Cross-platform win:** PR 3 turns the hardcoded `/tmp` + `/`-separator literals into `mkdtempSync`/`join` — fixes a latent Windows hazard, not just the Sonar finding.
- **Line-drift caveat:** SonarCloud line attribution goes stale after squash-merges (prior workstreams) — every PR re-enumerates from the live API, not this doc's line numbers.
- **Ordering rationale:** config first (gate must point at the live project); real bugs next (rating flip, low risk); S5443 before the smell sweeps (largest single-rule fix, isolated change shape).
