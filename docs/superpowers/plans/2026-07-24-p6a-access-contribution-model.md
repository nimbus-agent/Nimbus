# P6a — Access & Contribution Model (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the org's access model a checked-in, drift-gated property — every
repo reachable through a team, two org settings hardened, the contributor-two
switch set recorded — with two new fail-soft/strict-in-CI gates wired into the
existing org drift sweep.

**Architecture:** Each gate follows the established `scripts/structure-audit/`
shape (pure exported diff function + `import.meta.main` CLI wrapper, unit-tested
against fixtures) and runs as a job in `.github/workflows/org-drift-sweep.yml`
using the `nimbus-release-bot` App token. A tiny shared `_gh-audit.ts` holds the
three-gate-common plumbing (`runGh`, `isStrict`, `strictSkip`) so the
"loud-in-CI" strict behavior is defined once. Desired state lives in checked-in
`.github/` files.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:test`, GitHub Actions,
`gh` CLI.

Design of record:
[`docs/superpowers/specs/2026-07-24-p6a-access-contribution-model-design.md`](../specs/2026-07-24-p6a-access-contribution-model-design.md).

## Global Constraints

- **No `any`** — use `unknown` for external (API) data; TypeScript strict is
  non-negotiable.
- **Never commit on `main`** — work happens on
  `dev/asafgolombek/p6a-access-contribution-model` in the worktree at
  `.claude/worktrees/org-infra-program`. Read/Edit must use the **worktree
  absolute path**; a main-repo path silently edits main.
- **Cross-platform paths** — `path.join()`, never hardcoded separators.
- **Action refs are SHA-pinned** — any new `uses:` needs a full 40-hex SHA;
  `audit:action-sha-pins` rejects tag refs.
- **Every new CI gate is registered** in `package.json` and, because these need
  network + App auth, in `CI_ONLY_GATES` in `scripts/lib/preflight-gates.ts`
  (not the fast tier) — or the preflight-manifest drift test fails.
- **Conventional Commits** — `feat:`, `fix:`, `ci:`, `docs:`, `test:`.
- **Fail-soft locally, strict in CI** — a gate that can't authenticate exits 0
  ("skipped", `::warning::`) locally but exits 1 (`::error::`) under `--strict`
  or `GITHUB_ACTIONS`. Silent-green in the scheduled sweep is the enemy.
- **Verify before claiming done** — run the command, read the output.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/structure-audit/_gh-audit.ts` (create) | Shared plumbing: `runGh`, `isStrict`, `strictSkip` |
| `scripts/structure-audit/_gh-audit.test.ts` (create) | Unit tests for the shared plumbing |
| `scripts/structure-audit/check-ruleset-drift.ts` (modify) | Consume the shared plumbing; add `--strict` |
| `scripts/structure-audit/check-ruleset-drift.test.ts` (modify) | Cover the new strict skip path |
| `.github/org-access.json` (create) | Desired org settings + team-reachability exemptions |
| `scripts/structure-audit/check-org-settings-drift.ts` (create) | Pure `diffOrgSettings` + `loadOrgAccess` + CLI |
| `scripts/structure-audit/check-org-settings-drift.test.ts` (create) | Unit tests |
| `scripts/structure-audit/check-team-reachability.ts` (create) | Pure `findUnreachable` + CLI (`--paginate`, archived-exclude) |
| `scripts/structure-audit/check-team-reachability.test.ts` (create) | Unit tests |
| `.github/rulesets/general-branch.json` (modify) | Add the `$contributor_two` advisory block |
| `.github/workflows/org-drift-sweep.yml` (modify) | Two new jobs + `--strict` on all three gate jobs |
| `package.json` (modify) | Register `audit:org-settings-drift`, `audit:team-reachability` |
| `scripts/lib/preflight-gates.ts` (modify) | Add both to `CI_ONLY_GATES` |
| `docs/infrastructure-roadmap.md` (modify) | Record P6a delivered + gates + deferrals |

---

### Task 1: Shared gh-audit plumbing + migrate `ruleset-drift`

**Files:**

- Create: `scripts/structure-audit/_gh-audit.ts`
- Create: `scripts/structure-audit/_gh-audit.test.ts`
- Modify: `scripts/structure-audit/check-ruleset-drift.ts`
- Modify: `scripts/structure-audit/check-ruleset-drift.test.ts`
- Modify: `scripts/lib/preflight-gates.ts:66` (comment only)

**Interfaces:**

- Consumes: nothing.
- Produces: `runGh(args: string[]): GhResult`,
  `isStrict(argv: string[], env: Record<string, string | undefined>): boolean`,
  `strictSkip(label: string, strict: boolean): AuditOutcome`, and the
  `GhResult` / `AuditOutcome` types. Tasks 2 & 3 import all three.

**Why:** Three gates now share the "run `gh`, and treat a total read-failure as
soft-skip locally / hard-red in CI" logic. Defining it once avoids drift between
gates and keeps the repo's jscpd duplication floor happy.

- [ ] **Step 1: Write the failing test for the shared plumbing**

Create `scripts/structure-audit/_gh-audit.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { isStrict, strictSkip } from "./_gh-audit.ts";

describe("isStrict", () => {
  test("false with neither flag nor env", () => {
    expect(isStrict([], {})).toBe(false);
  });
  test("true when --strict is passed", () => {
    expect(isStrict(["--strict"], {})).toBe(true);
  });
  test("true under GitHub Actions even without the flag", () => {
    expect(isStrict([], { GITHUB_ACTIONS: "true" })).toBe(true);
  });
});

describe("strictSkip", () => {
  test("soft skip (exit 0, ::warning::) when not strict", () => {
    const out = strictSkip("audit:x", false);
    expect(out.code).toBe(0);
    expect(out.message).toContain("::warning::");
    expect(out.message).toContain("skipped");
  });
  test("hard red (exit 1, ::error::) when strict", () => {
    const out = strictSkip("audit:x", true);
    expect(out.code).toBe(1);
    expect(out.message).toContain("::error::");
    expect(out.message).toContain("could not authenticate");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test scripts/structure-audit/_gh-audit.test.ts`
Expected: FAIL — module `./_gh-audit.ts` not found.

- [ ] **Step 3: Implement the shared plumbing**

Create `scripts/structure-audit/_gh-audit.ts`:

```typescript
/**
 * Shared plumbing for the org-drift-sweep audit gates (ruleset-drift,
 * org-settings-drift, team-reachability). Each gate keeps its own diff logic;
 * this holds only what all three do identically: run `gh`, decide strict mode,
 * and render the "nothing could be read" outcome.
 */

export interface GhResult {
  ok: boolean;
  stdout: string;
}

/** Wraps `Bun.spawnSync` so a missing `gh` binary or non-zero exit both surface as `ok: false`. */
export function runGh(args: string[]): GhResult {
  try {
    const proc = Bun.spawnSync(args);
    if (!proc.success) return { ok: false, stdout: "" };
    return { ok: true, stdout: new TextDecoder().decode(proc.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Strict mode makes a "nothing readable" outcome a hard failure instead of a
 * soft green skip. The scheduled sweep passes `--strict`; `GITHUB_ACTIONS` is a
 * safety net so a forgotten flag still hardens CI. Local/preflight runs (no
 * flag, no env) stay soft so an unauthenticated contributor is never blocked.
 */
export function isStrict(argv: string[], env: Record<string, string | undefined>): boolean {
  return argv.includes("--strict") || env.GITHUB_ACTIONS === "true";
}

export interface AuditOutcome {
  code: 0 | 1;
  message: string;
}

/**
 * The outcome when a gate could read *nothing* (no `gh`, no auth, or a broken
 * App permission). Soft skip locally; in the CI sweep (`strict`) the token must
 * work, so this is a loud red — a silent green here is the failure mode P6a's
 * review flagged. Both messages carry an Actions annotation prefix.
 */
export function strictSkip(label: string, strict: boolean): AuditOutcome {
  if (strict) {
    return {
      code: 1,
      message: `::error::${label}: could not authenticate — the App token or a required permission is broken (nothing was readable)`,
    };
  }
  return {
    code: 0,
    message: `::warning::${label}: skipped — gh unavailable or unauthenticated`,
  };
}
```

- [ ] **Step 4: Run the plumbing tests**

Run: `bun test scripts/structure-audit/_gh-audit.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Migrate `check-ruleset-drift.ts` onto the shared plumbing**

In `scripts/structure-audit/check-ruleset-drift.ts`:

1. Add the import near the top (after the existing `node:` imports):

```typescript
import { isStrict, runGh, strictSkip } from "./_gh-audit.ts";
```

1. **Delete** the local `GhResult` interface and the local `runGh` function (now
   imported).

2. Change `decideExit`'s signature and its `queried === 0` branch to use
   `strictSkip`. Replace the existing signature line and the first `if` block:

```typescript
export function decideExit(input: {
  queried: number;
  errors: string[];
  unreachable: string[];
  strict?: boolean;
}): { code: 0 | 1; message: string } {
  const { queried, errors, unreachable, strict = false } = input;

  if (queried === 0) {
    return strictSkip("audit:ruleset-drift", strict);
  }
```

(Leave the `errors.length > 0`, partial-`unreachable`, and final `OK` branches
exactly as they are.)

1. In the `import.meta.main` block, compute strict and pass it. Change the
   `decideExit` call line:

```typescript
  const strict = isStrict(process.argv.slice(2), process.env);
  const outcome = decideExit({ queried, errors: allErrors, unreachable, strict });
```

- [ ] **Step 6: Add the strict regression test**

Append to the `describe("decideExit", ...)` block in
`scripts/structure-audit/check-ruleset-drift.test.ts`:

```typescript
  test("total skip is soft green by default but hard red under strict", () => {
    const soft = decideExit({ queried: 0, errors: [], unreachable: ["nimbus-sdk"] });
    expect(soft.code).toBe(0);
    expect(soft.message).toContain("skipped");

    const hard = decideExit({ queried: 0, errors: [], unreachable: ["nimbus-sdk"], strict: true });
    expect(hard.code).toBe(1);
    expect(hard.message).toContain("could not authenticate");
  });
```

- [ ] **Step 7: Update the CI_ONLY comment for ruleset-drift**

In `scripts/lib/preflight-gates.ts:66`, update the trailing comment to note the
strict flag (the entry itself is unchanged):

```typescript
  "audit:ruleset-drift", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
```

- [ ] **Step 8: Run the ruleset-drift tests + the live gate**

Run: `bun test scripts/structure-audit/check-ruleset-drift.test.ts`
Expected: PASS (all existing tests + the new one).

Run: `bun run audit:ruleset-drift`
Expected: `audit:ruleset-drift: OK (5 repos)` — behaviour unchanged without
`--strict`.

- [ ] **Step 9: Typecheck + lint**

Run: `bunx tsc --noEmit -p scripts/tsconfig.json`
Expected: no output (clean).

Run: `bunx biome check scripts/structure-audit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add scripts/structure-audit/_gh-audit.ts scripts/structure-audit/_gh-audit.test.ts scripts/structure-audit/check-ruleset-drift.ts scripts/structure-audit/check-ruleset-drift.test.ts scripts/lib/preflight-gates.ts
git commit -m "refactor(audit): shared _gh-audit plumbing + --strict for ruleset-drift

Extract runGh + the strict/soft skip decision into _gh-audit.ts so the three
sweep gates share one definition of 'loud in CI, soft locally'. Migrate
ruleset-drift onto it and add --strict (a total read-failure is now red in the
scheduled sweep instead of a silent green)."
```

---

### Task 2: Org-settings drift gate + `.github/org-access.json`

**Files:**

- Create: `.github/org-access.json`
- Create: `scripts/structure-audit/check-org-settings-drift.ts`
- Create: `scripts/structure-audit/check-org-settings-drift.test.ts`
- Modify: `package.json` (the `audit:` block, near line 165)
- Modify: `scripts/lib/preflight-gates.ts` (the `CI_ONLY_GATES` array)

**Interfaces:**

- Consumes: `runGh`, `isStrict`, `strictSkip` from Task 1.
- Produces: `diffOrgSettings(desired: OrgSettings, live: unknown): AuditResult`,
  `loadOrgAccess(repoRoot: string): OrgAccessFile`, and the `OrgSettings` /
  `OrgAccessFile` types. Task 3 imports `loadOrgAccess` + `OrgAccessFile`.

**Why:** `members_can_create_repositories: true` and
`default_repository_permission: read` are org-wide settings that revert silently.
Checking the desired values in and diffing live config makes them a gated
property.

- [ ] **Step 1: Write the desired config file**

Create `.github/org-access.json`:

```json
{
  "$comment": "Desired org-access config. `settings` is audited by check-org-settings-drift.ts; `team_reachability.exempt` by check-team-reachability.ts. See docs/infrastructure-roadmap.md.",
  "settings": {
    "members_can_create_repositories": false,
    "default_repository_permission": "none"
  },
  "team_reachability": { "exempt": [] }
}
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/structure-audit/check-org-settings-drift.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { diffOrgSettings, type OrgSettings } from "./check-org-settings-drift.ts";

const DESIRED: OrgSettings = {
  members_can_create_repositories: false,
  default_repository_permission: "none",
};

describe("diffOrgSettings", () => {
  test("passes when live matches desired", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: false,
      default_repository_permission: "none",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a reverted boolean setting", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: true,
      default_repository_permission: "none",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("members_can_create_repositories");
    expect(result.errors[0]).toContain("expected false");
    expect(result.errors[0]).toContain("got true");
  });

  test("flags a reverted string setting", () => {
    const result = diffOrgSettings(DESIRED, {
      members_can_create_repositories: false,
      default_repository_permission: "read",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("default_repository_permission");
    expect(result.errors.join("\n")).toContain("read");
  });

  test("flags a non-object live response", () => {
    const result = diffOrgSettings(DESIRED, null);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not an object");
  });

  test("flags a missing field", () => {
    const result = diffOrgSettings(DESIRED, { members_can_create_repositories: false });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("default_repository_permission");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `bun test scripts/structure-audit/check-org-settings-drift.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the gate**

Create `scripts/structure-audit/check-org-settings-drift.ts`:

```typescript
#!/usr/bin/env bun

/**
 * audit:org-settings-drift — asserts the org's live settings match the desired
 * values in `.github/org-access.json`. Manual UI settings revert silently
 * (`members_can_create_repositories`, `default_repository_permission`); this
 * makes them a gated property. The diff is pure and unit-tested; the CLI reads
 * live config via `gh` and is fail-soft locally / strict in the CI sweep.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface OrgSettings {
  members_can_create_repositories: boolean;
  default_repository_permission: string;
}

export interface OrgAccessFile {
  settings: OrgSettings;
  team_reachability: { exempt: string[] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function diffOrgSettings(desired: OrgSettings, live: unknown): AuditResult {
  if (!isRecord(live)) {
    return { ok: false, errors: ["org settings response is not an object"] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(desired) as (keyof OrgSettings)[]) {
    if (live[key] !== desired[key]) {
      errors.push(
        `${key}: expected ${JSON.stringify(desired[key])}, got ${JSON.stringify(live[key])}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadOrgAccess(repoRoot: string): OrgAccessFile {
  const raw = readFileSync(join(repoRoot, ".github/org-access.json"), "utf8");
  return JSON.parse(raw) as OrgAccessFile;
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const desired = loadOrgAccess(process.cwd()).settings;

  const res = runGh([
    "gh",
    "api",
    "orgs/nimbus-agent",
    "--jq",
    "{members_can_create_repositories, default_repository_permission}",
  ]);
  if (!res.ok) {
    const outcome = strictSkip("audit:org-settings-drift", strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  }

  const live: unknown = JSON.parse(res.stdout);
  const result = diffOrgSettings(desired, live);
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:org-settings-drift: ${err}`);
    process.exit(1);
  }
  console.log("audit:org-settings-drift: OK");
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test scripts/structure-audit/check-org-settings-drift.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Register the gate**

In `package.json`, after the `"audit:ruleset-drift"` line, add:

```json
    "audit:org-settings-drift": "bun scripts/structure-audit/check-org-settings-drift.ts",
```

In `scripts/lib/preflight-gates.ts`, add to the `CI_ONLY_GATES` array:

```typescript
  "audit:org-settings-drift", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
```

- [ ] **Step 7: Run the gate live (expect drift pre-apply)**

Run: `bun run audit:org-settings-drift`
Expected: **FAIL** naming `members_can_create_repositories` (expected false, got
true) and `default_repository_permission` (expected "none", got "read"). This red
is correct and proves the gate detects the current un-hardened state — it goes
green after Task 7 flips the settings.

- [ ] **Step 8: Typecheck + preflight-manifest test**

Run: `bunx tsc --noEmit -p scripts/tsconfig.json`
Expected: clean.

Run: `bun test scripts/lib/preflight-gates.test.ts`
Expected: PASS — the new gate is registered, drift test satisfied.

- [ ] **Step 9: Commit**

```bash
git add .github/org-access.json scripts/structure-audit/check-org-settings-drift.ts scripts/structure-audit/check-org-settings-drift.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "feat(audit): gate org-settings drift via .github/org-access.json

members_can_create_repositories and default_repository_permission are org-wide
settings that revert silently. The desired values now live in
.github/org-access.json and audit:org-settings-drift diffs them against live
config, fail-soft locally and strict in the sweep."
```

---

### Task 3: Team-reachability gate

**Files:**

- Create: `scripts/structure-audit/check-team-reachability.ts`
- Create: `scripts/structure-audit/check-team-reachability.test.ts`
- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts`

**Interfaces:**

- Consumes: `runGh`, `isStrict`, `strictSkip` from Task 1; `loadOrgAccess`,
  `OrgAccessFile` from Task 2.
- Produces: `findUnreachable(allRepos: string[], teamRepos: string[], exempt: string[]): AuditResult`.

**Why:** Six repos — the npm narrow waist plus `.github`/`linux-repo` — are
reachable through no team. The gate asserts every non-exempt repo is in some
team's grant list, so a repo added without team access is caught.

- [ ] **Step 1: Write the failing tests**

Create `scripts/structure-audit/check-team-reachability.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { findUnreachable } from "./check-team-reachability.ts";

describe("findUnreachable", () => {
  test("passes when every repo is in a team grant", () => {
    const result = findUnreachable(["a", "b"], ["a", "b", "b"], []);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a repo reachable through no team", () => {
    const result = findUnreachable(["a", "b", "c"], ["a", "b"], []);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("c");
    expect(result.errors[0]).toContain("no team");
  });

  test("an exempt teamless repo is not flagged", () => {
    const result = findUnreachable(["a", "b", "c"], ["a", "b"], ["c"]);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("empty inputs pass", () => {
    const result = findUnreachable([], [], []);
    expect(result.ok).toBe(true);
  });

  test("flags multiple teamless repos", () => {
    const result = findUnreachable(["a", "b", "c"], [], []);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test scripts/structure-audit/check-team-reachability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate**

Create `scripts/structure-audit/check-team-reachability.ts`:

```typescript
#!/usr/bin/env bun

/**
 * audit:team-reachability — asserts every org repo is reachable through at least
 * one team's repo grant. Teams were created for the periphery and never extended
 * to the publishing chain; this makes "reachable through a team" a gated
 * property. The pure diff is unit-tested; the CLI lists repos + team grants via
 * `gh` (paginated, archived repos excluded) and is fail-soft / strict.
 */

import { isStrict, runGh, strictSkip } from "./_gh-audit.ts";
import { loadOrgAccess } from "./check-org-settings-drift.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** Repos in `allRepos` that appear in no team's grant list and are not exempt. */
export function findUnreachable(
  allRepos: string[],
  teamRepos: string[],
  exempt: string[],
): AuditResult {
  const reachable = new Set(teamRepos);
  const exemptSet = new Set(exempt);
  const errors = allRepos
    .filter((r) => !reachable.has(r) && !exemptSet.has(r))
    .map((r) => `${r}: reachable through no team`);
  return { ok: errors.length === 0, errors };
}

/** Newline-separated `gh --jq` output → trimmed non-empty lines. */
function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

if (import.meta.main) {
  const strict = isStrict(process.argv.slice(2), process.env);
  const exempt = loadOrgAccess(process.cwd()).team_reachability.exempt;
  const label = "audit:team-reachability";

  const softFail = () => {
    const outcome = strictSkip(label, strict);
    if (outcome.code === 1) console.error(outcome.message);
    else console.warn(outcome.message);
    process.exit(outcome.code);
  };

  // Active (non-archived) repos. --paginate walks Link headers so the list is
  // never truncated at the 30/page default.
  const reposRes = runGh([
    "gh",
    "api",
    "--paginate",
    "orgs/nimbus-agent/repos",
    "--jq",
    ".[] | select(.archived == false) | .name",
  ]);
  if (!reposRes.ok) softFail();
  const allRepos = lines(reposRes.stdout);

  const teamsRes = runGh(["gh", "api", "--paginate", "orgs/nimbus-agent/teams", "--jq", ".[].slug"]);
  if (!teamsRes.ok) softFail();
  const teamSlugs = lines(teamsRes.stdout);

  const teamRepos: string[] = [];
  for (const slug of teamSlugs) {
    const res = runGh([
      "gh",
      "api",
      "--paginate",
      `orgs/nimbus-agent/teams/${slug}/repos`,
      "--jq",
      ".[].name",
    ]);
    if (!res.ok) softFail();
    teamRepos.push(...lines(res.stdout));
  }

  const result = findUnreachable(allRepos, teamRepos, exempt);
  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    process.exit(1);
  }
  console.log(`${label}: OK (${allRepos.length} repos reachable)`);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test scripts/structure-audit/check-team-reachability.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the gate**

In `package.json`, after the `"audit:org-settings-drift"` line, add:

```json
    "audit:team-reachability": "bun scripts/structure-audit/check-team-reachability.ts",
```

In `scripts/lib/preflight-gates.ts`, add to `CI_ONLY_GATES`:

```typescript
  "audit:team-reachability", // needs network + gh auth + org-read; runs only in org-drift-sweep.yml with --strict, never the local FAST tier
```

- [ ] **Step 6: Run the gate live (expect the 6 teamless repos pre-apply)**

Run: `bun run audit:team-reachability`
Expected: **FAIL** listing `.github`, `linux-repo`, `nimbus-client`,
`nimbus-sdk`, `nimbus-vscode`, `nimbus-web-clipper` as reachable through no team.
This red is correct — it goes green after Task 7 grants them to `maintainers`.

- [ ] **Step 7: Typecheck + preflight-manifest test**

Run: `bunx tsc --noEmit -p scripts/tsconfig.json`
Expected: clean.

Run: `bun test scripts/lib/preflight-gates.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/structure-audit/check-team-reachability.ts scripts/structure-audit/check-team-reachability.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "feat(audit): gate that every org repo is reachable through a team

Six repos (the npm narrow waist plus .github/linux-repo) reach through no team.
audit:team-reachability lists repos + team grants (paginated, archived excluded)
and fails on any non-exempt teamless repo; exemptions live in
.github/org-access.json."
```

---

### Task 4: Contributor-two advisory block

**Files:**

- Modify: `.github/rulesets/general-branch.json`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing consumed by later tasks. `ruleset-drift` must stay green — the
  block is advisory (`$`-prefixed) and ignored by the audit.

**Why:** The four solo→team switches must be recorded so onboarding contributor
two is one reviewed diff, not remembered UI clicks. Three are already enforced
solo-values; this documents the set (including the un-gated bypass switch).

- [ ] **Step 1: Add the block**

In `.github/rulesets/general-branch.json`, add a top-level `"$contributor_two"`
key (advisory; sits beside `"$comment"`). Insert it right after the `"$comment"`
line:

```json
  "$contributor_two": {
    "note": "Solo-mode switches to flip when a second maintainer gains write access — one reviewed diff. Three live in shared.pull_request below and are already drift-gated; the bypass switch is not (the CI App token cannot read bypass_actors — see the roadmap).",
    "switches": {
      "shared.pull_request.required_approving_review_count": { "solo": 0, "team": 1 },
      "shared.pull_request.require_code_owner_review": { "solo": false, "team": true },
      "shared.pull_request.require_last_push_approval": { "solo": false, "team": true },
      "bypass_actors.OrganizationAdmin.bypass_mode": { "solo": "always", "team": "pull_request" }
    }
  },
```

- [ ] **Step 2: Verify the JSON parses and ruleset-drift is unaffected**

Run: `bun -e "JSON.parse(require('fs').readFileSync('.github/rulesets/general-branch.json','utf8')); console.log('OK')"`
Expected: `OK`.

Run: `bun run audit:ruleset-drift`
Expected: `audit:ruleset-drift: OK (5 repos)` — the advisory block does not affect
the diff (which reads only `shared` + `repos`).

- [ ] **Step 3: Commit**

```bash
git add .github/rulesets/general-branch.json
git commit -m "docs(infra): record the contributor-two switch set in the ruleset config

An advisory \$contributor_two block lists the four solo->team switches and their
targets so onboarding a second maintainer is one reviewed diff. Three are already
enforced in shared.pull_request; the bypass switch is documented but not gated."
```

---

### Task 5: Wire the gates into the sweep + strict everywhere

**Files:**

- Modify: `.github/workflows/org-drift-sweep.yml`

**Interfaces:**

- Consumes: `audit:org-settings-drift`, `audit:team-reachability` (Tasks 2, 3),
  and the `--strict` support in all three gates (Tasks 1–3).
- Produces: two new sweep jobs + `--strict` on all three gate run-lines.

**Why:** The gates only become the promised drift check when the scheduled sweep
runs them against live config with a real token, loud on failure.

- [ ] **Step 1: Add `--strict` to the existing ruleset-drift job**

In `.github/workflows/org-drift-sweep.yml`, find the ruleset-drift job's run step
(`run: bun scripts/structure-audit/check-ruleset-drift.ts`) and change it to:

```yaml
        run: bun scripts/structure-audit/check-ruleset-drift.ts --strict
```

- [ ] **Step 2: Add the two new jobs**

Append these jobs to `.github/workflows/org-drift-sweep.yml` (same `jobs:` block,
after `ruleset-drift`). Both reuse the App-token mint. The org-settings job needs
`organization_administration: read` (the App has it); the reachability job also
needs **`members: read`** — see Task 7 for the grant.

```yaml
  org-settings-drift:
    name: org-settings-drift
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest
      - name: Mint App token
        id: apptoken
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.RELEASE_BOT_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
          owner: nimbus-agent
      - name: Audit org settings drift
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
        run: bun scripts/structure-audit/check-org-settings-drift.ts --strict

  team-reachability:
    name: team-reachability
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest
      - name: Mint App token
        id: apptoken
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.RELEASE_BOT_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
          owner: nimbus-agent
      - name: Audit team reachability
        env:
          GH_TOKEN: ${{ steps.apptoken.outputs.token }}
        run: bun scripts/structure-audit/check-team-reachability.ts --strict
```

- [ ] **Step 3: Verify the workflow is SHA-pinned + YAML valid**

Run: `bun run audit:action-sha-pins`
Expected: `audit:action-sha-pins: OK`. If it names `org-drift-sweep.yml`, a SHA
above is stale — resolve with `gh api repos/OWNER/REPO/git/ref/tags/TAG --jq '.object.sha'`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/org-drift-sweep.yml
git commit -m "ci(infra): add org-settings + team-reachability jobs to the sweep

Two new jobs run the P6a gates against live org config with the App token, and
all three gate jobs now pass --strict so a broken token is a red failure rather
than a silent green skip in the scheduled sweep."
```

---

### Task 6: Roadmap update

**Files:**

- Modify: `docs/infrastructure-roadmap.md`

**Interfaces:**

- Consumes: nothing.
- Produces: the delivered record. `audit:doc-refs` must still resolve.

- [ ] **Step 1: Mark P6 in the sub-programs table**

In `docs/infrastructure-roadmap.md`, change the P6 row's status/gate cell to
reflect P6a (leave the CLA + bypass-audit as the remaining P6 items):

```markdown
| P6 | Access & Contribution Model | 🔨 P6a done | Every repo reachable through a team + org settings gated (both in the sweep); contributor-two switches recorded in checked-in config. Remaining: CLA, bypass-actor audit |
```

- [ ] **Step 2: Add a P6a progress-log entry**

Add under a new `### P6a progress log` heading (after the P1 log):

```markdown
### P6a progress log

- **Delivered (2026-07-24):** the six teamless repos (`.github`, `linux-repo`,
  the four npm narrow-waist repos) are granted to `maintainers`;
  `members_can_create_repositories` → false and `default_repository_permission`
  → none; both are gated by `audit:org-settings-drift` +
  `audit:team-reachability` in `org-drift-sweep` (fail-soft locally, `--strict`
  in CI). The four contributor-two switches are recorded in the
  `$contributor_two` block of `.github/rulesets/general-branch.json`.
- **Deferred:** the CLA (own spec) and a higher-privilege **bypass-actor audit**
  (the CI App token cannot read `bypass_actors`; a future owner-`gh`-run check,
  no PAT). Private-repo ruleset protection stays **blocked-on-Team** (Free plan).
- **Dependency:** the `nimbus-release-bot` App needs `members: read` for the
  reachability job (granted at apply time).
```

- [ ] **Step 3: Verify docs gates**

Run: `bun run lint:markdown`
Expected: `Summary: 0 error(s)`.

Run: `bun run audit:doc-refs`
Expected: all refs resolve.

Run: `~/.cargo/bin/lychee --config lychee.toml docs/infrastructure-roadmap.md`
Expected: `0 Errors`.

- [ ] **Step 4: Commit**

```bash
git add docs/infrastructure-roadmap.md
git commit -m "docs(infra): record P6a delivered + its gates and deferrals"
```

---

### Task 7: Apply + live validation (org-owner)

**Files:** none (org configuration + the `nimbus-release-bot` App).

**Interfaces:**

- Consumes: the merged (or branch) gates from Tasks 2, 3, 5.
- Produces: the green sweep that *is* P6a's definition of done.

> **These are real, global org changes and require org-owner authorization.** The
> `gh api` calls are safe today (sole owner, unaffected) but must be confirmed
> before running. The App permission grant is a UI action only the owner can do.

- [ ] **Step 1: Grant the six teamless repos to `maintainers`**

```bash
for r in nimbus-client nimbus-sdk nimbus-vscode nimbus-web-clipper; do
  gh api --method PUT "orgs/nimbus-agent/teams/maintainers/repos/nimbus-agent/$r" -f permission=maintain
done
for r in .github linux-repo; do
  gh api --method PUT "orgs/nimbus-agent/teams/maintainers/repos/nimbus-agent/$r" -f permission=admin
done
```

Verify: `bun run audit:team-reachability` → `OK (N repos reachable)`.

- [ ] **Step 2: Flip the two org settings**

```bash
gh api --method PATCH orgs/nimbus-agent \
  -F members_can_create_repositories=false \
  -f default_repository_permission=none
```

Verify: `bun run audit:org-settings-drift` → `audit:org-settings-drift: OK`.

- [ ] **Step 3: Grant the App `members: read` (owner UI action)**

At `https://github.com/organizations/nimbus-agent/settings/apps/nimbus-release-bot/permissions`,
set **Organization permissions → Members → Read-only**; save; approve the
permission on the org installation
(`https://github.com/organizations/nimbus-agent/settings/installations/147619203/permissions/update`).

Verify granted:

```bash
gh api orgs/nimbus-agent/installations --jq '.installations[] | select(.app_slug=="nimbus-release-bot") | .permissions.members'
```

Expected: `read`.

- [ ] **Step 4: Prove the sweep green live**

With the P6a branch pushed and the workflow present on `main` (post-merge) or via
the branch ref:

```bash
gh workflow run org-drift-sweep.yml --ref <branch-or-main>
```

Then, once complete:

```bash
gh run list --workflow=org-drift-sweep.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run view <id> --json conclusion,jobs --jq '.conclusion, (.jobs[] | "\(.conclusion)\t\(.name)")'
```

Expected: `success`, with `org-settings-drift` and `team-reachability` both
green (they were red before Steps 1–3; green now proves the gates fire on real
regression and pass on the hardened state).

- [ ] **Step 5: Record the run id in the roadmap**

Update the P6a progress log with the proven-green run id, matching P1's
close-out. Commit:

```bash
git add docs/infrastructure-roadmap.md
git commit -m "docs(infra): P6a proven green end-to-end (run <id>)"
```

---

## Verification

Before opening the PR, run the local gate set (`test:ci` is **not** it):

- [ ] `bun run preflight:fast` — fast-tier gates (the new gates are CI-only, run separately)
- [ ] `bun test scripts/structure-audit/` — all audit tests incl. the new files
- [ ] `bun test scripts/lib/preflight-gates.test.ts` — manifest drift satisfied
- [ ] `bunx tsc --noEmit -p scripts/tsconfig.json` — scripts typecheck clean
- [ ] `bun run lint:markdown` — `0 error(s)`
- [ ] `bun run audit:doc-refs` — all refs resolve
- [ ] `bun run audit:action-sha-pins` — `OK` (workflow pins)
- [ ] `~/.cargo/bin/lychee --config lychee.toml 'docs/**/*.md' '*.md'` — whole-branch link total
- [ ] Pre-apply, `audit:org-settings-drift` and `audit:team-reachability` are **red** (they detect the current un-hardened state) — this is expected and is the gates working

**Known worktree caveats:** full `preflight` is unusable in a worktree; `bun run
lint` may report 0 files — use `bunx biome check scripts`. No `packages/` source
is touched, so `audit:coverage-floor` is N/A.

---

## Self-review coverage map

| Spec deliverable | Task |
| --- | --- |
| Team reachability (grant + gate, paginate, archived, exempt) | 3 (gate) + 7 (grant) |
| Org-settings hardening + gate + `.github/org-access.json` | 2 (gate/config) + 7 (flip) |
| Contributor-two switch set in checked-in config | 4 |
| CI-visibility: `::warning::` + `--strict` in the sweep, back-ported to ruleset-drift | 1 (plumbing) + 5 (workflow) |
| Bypass-actor audit deferred + documented | 6 (roadmap) |
| App `members: read` dependency + live validation | 7 |
| Roadmap update | 6 |
