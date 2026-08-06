# Ownership Graph — PR A (Derivation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a persisted ownership graph — `person → source_file`, `person → directory`, `person → service` — from already-indexed git blame data, with no new connectors, no LLM, and no network.

**Architecture:** A new `packages/gateway/src/ownership/` subsystem runs as a debounced, single-flight post-connector-sync pass (the `glossary` / `decisions` precedent). It aggregates `git_blame_line` into recency-weighted per-author line shares, resolves git emails to `person` rows, rolls the shares up through directories and into config-declared services, and writes graph edges via the existing `relationship-graph.ts` helpers. Schema **V51** seeds three relation types and one pass-state table.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict, `bun:sqlite`, `Bun.Glob`, Biome, `bun test`.

**Spec:** [`docs/superpowers/specs/2026-08-06-ownership-graph-design.md`](../specs/2026-08-06-ownership-graph-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-06-ownership-graph-design-review-response.md`](../specs/2026-08-06-ownership-graph-design-review-response.md)

## Global Constraints

- **Schema version is V51.** V50 is reserved for the HTTP-agents PR 3 (`resolve_key` column). Do not use V50. `CURRENT_SCHEMA_VERSION` is currently `49` in `packages/gateway/src/index/local-index.ts:265`.
- **No `any`.** Use `unknown` for external data. TypeScript strict mode.
- **All SQLite writes go through `dbRun` / `dbExec`** from `packages/gateway/src/db/write.ts` (invariant I14 / static D12). A raw `db.run(...)` fails the static audit.
- **All SQL uses bound parameters** (invariant I9). No string interpolation of values into SQL.
- **Any child-process spawn passes `extensionProcessEnv({})`** from `packages/gateway/src/extensions/spawn-env.ts` (invariant I1).
- **Do NOT edit any of these files** — a parallel session owns them: `packages/gateway/src/ipc/agents-rpc.ts`, `ipc/http-server.ts`, `ipc/http-write-routes.ts`, `ipc/http-route-auth.ts`, `packages/gateway/src/egress/*`, `packages/cli/src/commands/prove.ts`, `scripts/structure-audit/check-nimbus-invariants.ts`.
- **Do NOT edit `packages/gateway/src/security-invariants.test.ts`.** This PR adds no HTTP route and no invariant, so it needs no change there. If you believe it does, stop and report instead.
- **Do NOT add a built-in agent** and do NOT touch `AGENTS_RPC_HANDLERS`.
- **This PR adds no IPC method, no CLI command, and no Tauri allowlist entry.** Those are PR B.
- **Cross-platform:** build paths with `path.join()` / `path.relative()`, never hardcoded separators. Store root-relative paths with forward slashes (`replaceAll("\\", "/")`), matching `filesystem-v2-sync.ts`'s dependency-path handling.
- **Any test that reads a source file must resolve from `import.meta.dir`, never `process.cwd()`.**
- **Work on branch `dev/asafgolombek/ownership-graph`** in worktree `C:/gitrep/Nimbus/.claude/worktrees/ownership-graph`. Verify with `git rev-parse --abbrev-ref HEAD` before committing. Never commit on `main`.
- **Run `bun install` in the worktree before the first test run** or every suite fake-fails.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/ownership-v51-sql.ts` | The V51 SQL constants: relation-type seed + `ownership_pass_state` DDL |
| `packages/gateway/src/ownership/blame-aggregate.ts` | Pure: `git_blame_line` → recency-weighted `(email, file)` totals; glob exclusion |
| `packages/gateway/src/ownership/owner-identity.ts` | Pure: git email → person id or `git:` fallback; bot filtering |
| `packages/gateway/src/ownership/repo-remote.ts` | `git remote` → normalized `{host, ownerName}`; remote selection rules |
| `packages/gateway/src/ownership/ownership-pass.ts` | Orchestration: aggregate → identity → rollups → clear/emit → reap |
| `packages/gateway/src/ownership/ownership-refresh.ts` | Debounced single-flight wrapper |
| plus one `*.test.ts` beside each of the five | |

**Modified**

| File | Change |
| --- | --- |
| `packages/gateway/src/index/local-index.ts:265` | `CURRENT_SCHEMA_VERSION` 49 → 51 |
| `packages/gateway/src/index/migrations/runner.ts` | Import + register two `simpleStep`s (V50 no-op, V51) |
| `packages/gateway/src/config/nimbus-toml.ts` | New `[ownership]` section: type, defaults, parser, loader |
| `packages/gateway/src/platform/assemble.ts` | Construct + trigger + stop the refresher |

**Explicitly unmodified:** `packages/gateway/src/graph/*` — the pass calls its exported helpers but changes none of them.

---

## A note on V50

`CURRENT_SCHEMA_VERSION` must reach **51**, and the migration runner applies steps in sequence, so a step from 49→50 must exist or the ladder breaks. Task 1 registers a **deliberate no-op V50 step** whose SQL is a comment, reserving the slot for the HTTP-agents PR 3 without claiming it. When that PR lands it replaces the no-op's SQL; the version number and ledger row are already correct. This is the one coordination point between the two branches, and it is inert by construction.

---

## Task 1: V51 migration (with the reserved V50 slot)

**Files:**

- Create: `packages/gateway/src/index/ownership-v51-sql.ts`
- Modify: `packages/gateway/src/index/local-index.ts:265`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Test: `packages/gateway/src/index/migrations/runner-v51.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `OWNERSHIP_RELATION_TYPES_V51_SQL: string`, `OWNERSHIP_PASS_STATE_V51_SQL: string`, `SCHEMA_V50_RESERVED_SQL: string`. Schema version 51 with `graph_relation_type` rows `owns` / `contains` / `tracks_remote` and table `ownership_pass_state`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v51.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function freshMigratedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

describe("V51 ownership migration", () => {
  test("schema version reaches 51", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(51);
    const db = freshMigratedDb();
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(51);
    db.close();
  });

  test("seeds exactly the three ownership relation types", () => {
    const db = freshMigratedDb();
    const names = (
      db
        .query(
          "SELECT name FROM graph_relation_type WHERE name IN ('owns','contains','tracks_remote') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(["contains", "owns", "tracks_remote"]);
    db.close();
  });

  test("creates ownership_pass_state with its full column set", () => {
    const db = freshMigratedDb();
    const cols = (
      db.query("PRAGMA table_info(ownership_pass_state)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "last_pass_at",
      "last_duration_ms",
      "roots_total",
      "roots_covered",
      "roots_with_remote",
      "files_covered",
      "files_excluded",
      "services_bound",
      "owners_emitted",
      "entities_reaped",
    ]);
    db.close();
  });

  test("ownership_pass_state is single-row by construction", () => {
    const db = freshMigratedDb();
    db.run("INSERT INTO ownership_pass_state (id) VALUES (1)");
    expect(() => db.run("INSERT INTO ownership_pass_state (id) VALUES (2)")).toThrow();
    db.close();
  });

  test("re-running the migration on an already-migrated db is a no-op", () => {
    const db = freshMigratedDb();
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(51);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v51.test.ts`
Expected: FAIL — `CURRENT_SCHEMA_VERSION` is 49, and `ownership_pass_state` does not exist.

- [ ] **Step 3: Create the SQL constants**

Create `packages/gateway/src/index/ownership-v51-sql.ts`:

```ts
/**
 * V50 is RESERVED for the HTTP-agents PR 3 (`resolve_key`), which is being
 * built on a parallel branch. The migration ladder applies steps in sequence,
 * so the slot must exist for V51 to be reachable — but this branch must not
 * claim it. The step is therefore a deliberate no-op: it bumps
 * `user_version` and records a ledger row, nothing else. PR 3 replaces this
 * constant's body with its real DDL; the version and ledger row are already
 * correct.
 */
export const SCHEMA_V50_RESERVED_SQL = `
-- V50 reserved for the HTTP agents resolve-by-URL work; intentionally empty.
SELECT 1;
`;

/**
 * V51 — seed the ownership relation types (Spine S1, ownership graph).
 * `graph_relation.type` is FK-constrained to `graph_relation_type(name)`, so
 * these must exist before any ownership edge can be inserted. Mirrors
 * `graph-lineage-types-v40-sql.ts`.
 */
export const OWNERSHIP_RELATION_TYPES_V51_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('owns', 1),
  ('contains', 1),
  ('tracks_remote', 1);
`;

/**
 * Single-row pass state. Every counter exists to make a documented limit
 * REPORTABLE rather than implied: `roots_total = 0` is the most common cause
 * of an empty ownership graph and must be visible, not silent. The
 * `CHECK(id = 1)` shape follows `decision_pass_state`
 * (`decisions-v47-sql.ts:93`).
 */
export const OWNERSHIP_PASS_STATE_V51_SQL = `
CREATE TABLE IF NOT EXISTS ownership_pass_state (
  id                INTEGER PRIMARY KEY CHECK(id = 1),
  last_pass_at      INTEGER,
  last_duration_ms  INTEGER NOT NULL DEFAULT 0,
  roots_total       INTEGER NOT NULL DEFAULT 0,
  roots_covered     INTEGER NOT NULL DEFAULT 0,
  roots_with_remote INTEGER NOT NULL DEFAULT 0,
  files_covered     INTEGER NOT NULL DEFAULT 0,
  files_excluded    INTEGER NOT NULL DEFAULT 0,
  services_bound    INTEGER NOT NULL DEFAULT 0,
  owners_emitted    INTEGER NOT NULL DEFAULT 0,
  entities_reaped   INTEGER NOT NULL DEFAULT 0
);
`;
```

- [ ] **Step 4: Bump the schema version**

In `packages/gateway/src/index/local-index.ts`, change line 265 from `export const CURRENT_SCHEMA_VERSION = 49;` to:

```ts
export const CURRENT_SCHEMA_VERSION = 51;
```

- [ ] **Step 5: Register both steps in the runner**

In `packages/gateway/src/index/migrations/runner.ts`, add to the import block near the other `*-sql.ts` imports:

```ts
import {
  OWNERSHIP_PASS_STATE_V51_SQL,
  OWNERSHIP_RELATION_TYPES_V51_SQL,
  SCHEMA_V50_RESERVED_SQL,
} from "../ownership-v51-sql.ts";
```

Then append to the end of the `INDEXED_SCHEMA_STEPS` array, after the existing `49` entry:

```ts
  simpleStep(49, 50, "reserved for HTTP agents resolve-by-URL", SCHEMA_V50_RESERVED_SQL),
  simpleStep(50, 51, "ownership relation types + ownership_pass_state", [
    OWNERSHIP_RELATION_TYPES_V51_SQL,
    OWNERSHIP_PASS_STATE_V51_SQL,
  ]),
```

`simpleStep` accepts `readonly string[]` and `dbExec`s each in order inside one transaction — see its doc comment at `runner.ts:144`.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner-v51.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full migration suite for regressions**

Run: `bun test packages/gateway/src/index/migrations/`
Expected: PASS. A version-count or ledger assertion elsewhere may need updating to 51 — if one fails, read it and update the number; do not weaken the assertion.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/ownership-v51-sql.ts packages/gateway/src/index/migrations/runner-v51.test.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/local-index.ts
git commit -m "feat(gateway): V51 ownership relation types + pass state"
```

---

## Task 2: `[ownership]` config section

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml-ownership.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:

  ```ts
  export type NimbusOwnershipToml = {
    enabled: boolean;
    debounceMs: number;
    halfLifeDays: number;
    minShare: number;
    maxOwnersPerPath: number;
    ignoreGlobs: string[];
  };
  export const DEFAULT_NIMBUS_OWNERSHIP_TOML: NimbusOwnershipToml;
  export function parseNimbusOwnershipToml(raw: string, defaults?: NimbusOwnershipToml): NimbusOwnershipToml;
  export function loadNimbusOwnershipFromConfigDir(configDir: string): NimbusOwnershipToml;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/config/nimbus-toml-ownership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NIMBUS_OWNERSHIP_TOML,
  parseNimbusOwnershipToml,
} from "./nimbus-toml.ts";

describe("[ownership] config", () => {
  test("defaults match both existing derivation passes (enabled)", () => {
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.enabled).toBe(true);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.debounceMs).toBe(30_000);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.halfLifeDays).toBe(365);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.minShare).toBeCloseTo(0.05, 10);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.maxOwnersPerPath).toBe(10);
    expect(DEFAULT_NIMBUS_OWNERSHIP_TOML.ignoreGlobs.length).toBeGreaterThan(0);
  });

  test("an empty config yields the defaults", () => {
    expect(parseNimbusOwnershipToml("")).toEqual(DEFAULT_NIMBUS_OWNERSHIP_TOML);
  });

  // THE REGRESSION THIS FILE EXISTS FOR: `min_share` is the one FLOAT key.
  // If its branch falls through to the integer branch, 0.05 truncates to 0 and
  // the `n <= 0` guard discards it — the threshold silently disables itself
  // with no error. Same trap [decisions].min_confidence documents at
  // nimbus-toml.ts:1663-1665.
  test("min_share survives the float branch", () => {
    const cfg = parseNimbusOwnershipToml("[ownership]\nmin_share = 0.05\n");
    expect(cfg.minShare).toBeCloseTo(0.05, 10);
    expect(cfg.minShare).not.toBe(0);
  });

  test("min_share clamps to [0,1]", () => {
    expect(parseNimbusOwnershipToml("[ownership]\nmin_share = 5\n").minShare).toBe(1);
    expect(parseNimbusOwnershipToml("[ownership]\nmin_share = -1\n").minShare).toBe(0);
  });

  test("integer keys parse", () => {
    const cfg = parseNimbusOwnershipToml(
      "[ownership]\ndebounce_ms = 1000\nhalf_life_days = 90\nmax_owners_per_path = 3\n",
    );
    expect(cfg.debounceMs).toBe(1000);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.maxOwnersPerPath).toBe(3);
  });

  test("enabled = false parses", () => {
    expect(parseNimbusOwnershipToml("[ownership]\nenabled = false\n").enabled).toBe(false);
  });

  test("ignore_globs overrides the defaults, and an empty array disables filtering", () => {
    const cfg = parseNimbusOwnershipToml('[ownership]\nignore_globs = ["**/*.gen.ts"]\n');
    expect(cfg.ignoreGlobs).toEqual(["**/*.gen.ts"]);
    expect(parseNimbusOwnershipToml("[ownership]\nignore_globs = []\n").ignoreGlobs).toEqual([]);
  });

  test("malformed values fall back to defaults rather than throwing", () => {
    const cfg = parseNimbusOwnershipToml(
      "[ownership]\ndebounce_ms = nonsense\nmin_share = nonsense\n",
    );
    expect(cfg.debounceMs).toBe(DEFAULT_NIMBUS_OWNERSHIP_TOML.debounceMs);
    expect(cfg.minShare).toBe(DEFAULT_NIMBUS_OWNERSHIP_TOML.minShare);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-ownership.test.ts`
Expected: FAIL — `DEFAULT_NIMBUS_OWNERSHIP_TOML` is not exported.

- [ ] **Step 3: Implement the section**

In `packages/gateway/src/config/nimbus-toml.ts`, append after the `[decisions]` section (which ends with `loadNimbusDecisionsFromConfigDir`, around line 1706):

```ts
// ---------------------------------------------------------------------------
// [ownership] — ownership graph derivation pass (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusOwnershipToml = {
  /** Default ON, like [glossary] and [decisions]. This pass opens nothing and
   * calls no model — it reads local rows and writes local graph edges. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** Recency half-life for blame-line weighting. */
  halfLifeDays: number;
  /** Minimum share for an edge to be emitted. FLOAT — see the parser. */
  minShare: number;
  /** Cap on emitted owners per path; the true count lands on entity metadata. */
  maxOwnersPerPath: number;
  /** Root-relative globs excluded from aggregation. `[]` disables filtering. */
  ignoreGlobs: string[];
};

/**
 * Lock files and generated output are fully present in `git_blame_line`:
 * `gitBlameWindowFiles` (`connectors/blame-index-sync.ts:70`) is a bare
 * `git log --name-only` and consults NO exclude list. Left unfiltered, a
 * churning lock file is thousands of lines credited to whoever last ran the
 * installer, and would dominate its directory's rollup.
 */
const DEFAULT_OWNERSHIP_IGNORE_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/vendor/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
];

export const DEFAULT_NIMBUS_OWNERSHIP_TOML: NimbusOwnershipToml = {
  enabled: true,
  debounceMs: 30_000,
  halfLifeDays: 365,
  minShare: 0.05,
  maxOwnersPerPath: 10,
  ignoreGlobs: [...DEFAULT_OWNERSHIP_IGNORE_GLOBS],
};

function applyNimbusOwnershipKey(
  out: Partial<NimbusOwnershipToml>,
  key: string,
  valRaw: string,
): void {
  if (key === "enabled") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.enabled = b;
    return;
  }
  if (key === "ignore_globs") {
    // An explicit empty array is meaningful (disable filtering), so this must
    // NOT be guarded on length.
    out.ignoreGlobs = parseStringArray(valRaw);
    return;
  }
  // `min_share` is the one FLOAT key, so it MUST precede the integer branch:
  // that branch would truncate 0.05 to 0, and its `n <= 0` guard would then
  // discard it before the clamp ever ran — silently disabling the threshold.
  // Identical to the [decisions].min_confidence trap at lines 1663-1665.
  if (key === "min_share") {
    const f = Number(valRaw.trim());
    if (valRaw.trim() !== "" && Number.isFinite(f)) {
      out.minShare = Math.min(1, Math.max(0, f));
    }
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "half_life_days":
      out.halfLifeDays = n;
      break;
    case "max_owners_per_path":
      out.maxOwnersPerPath = n;
      break;
    default:
      break;
  }
}

export function parseNimbusOwnershipToml(
  raw: string,
  defaults: NimbusOwnershipToml = DEFAULT_NIMBUS_OWNERSHIP_TOML,
): NimbusOwnershipToml {
  const out: Partial<NimbusOwnershipToml> = {};
  forEachSectionEntry(raw, "[ownership]", (key, valRaw) =>
    applyNimbusOwnershipKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusOwnershipFromConfigDir(configDir: string): NimbusOwnershipToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_OWNERSHIP_TOML,
    parseNimbusOwnershipToml,
  );
}
```

`parseStringArray`, `parseBool`, `parseIntDec`, `forEachSectionEntry`, `loadTomlSection` and `join` are all already imported or defined in this file — add no new imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-ownership.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Red-prove the float-branch guard**

Temporarily move the `min_share` block to *after* the `parseIntDec` block. Re-run the suite.
Expected: the `min_share survives the float branch` test FAILS with `minShare` still `0.05` from defaults (the key silently ignored). **Revert the move exactly.** A guard never observed failing has proved nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-ownership.test.ts
git commit -m "feat(gateway): [ownership] config section"
```

---

## Task 3: Blame aggregation with recency weighting and glob exclusion

**Files:**

- Create: `packages/gateway/src/ownership/blame-aggregate.ts`
- Test: `packages/gateway/src/ownership/blame-aggregate.test.ts`

**Interfaces:**

- Consumes: `NimbusOwnershipToml` (Task 2) — only `halfLifeDays` and `ignoreGlobs` are read here.
- Produces:

  ```ts
  export type FileAuthorWeight = {
    readonly filePath: string;      // root-relative, forward slashes
    readonly authorEmail: string;   // normalized (lowercased, trimmed)
    readonly authorName: string | null;
    readonly weightedLines: number;
    readonly rawLines: number;
    readonly lastTouchedMs: number; // max author_time_ms across the person's lines
  };
  export type BlameAggregate = {
    readonly rows: readonly FileAuthorWeight[];
    readonly filesCovered: number;
    readonly filesExcluded: number;
  };
  export function lineWeight(authorTimeMs: number, nowMs: number, halfLifeMs: number): number;
  export function compileIgnoreGlobs(globs: readonly string[]): Bun.Glob[];
  export function matchesAnyCompiledGlob(filePath: string, compiled: readonly Bun.Glob[]): boolean;
  export function isIgnoredPath(filePath: string, globs: readonly string[]): boolean;
  export function aggregateBlameForRoot(
    db: Database,
    repoRoot: string,
    opts: { nowMs: number; halfLifeDays: number; ignoreGlobs: readonly string[] },
  ): BlameAggregate;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/blame-aggregate.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  aggregateBlameForRoot,
  compileIgnoreGlobs,
  isIgnoredPath,
  lineWeight,
  matchesAnyCompiledGlob,
} from "./blame-aggregate.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function addLine(
  d: Database,
  file: string,
  lineNo: number,
  email: string,
  name: string,
  ageDays: number,
): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ROOT, file, lineNo, `sha${String(lineNo)}`, name, email, NOW - ageDays * DAY],
  );
}

describe("lineWeight", () => {
  test("a line authored right now weighs exactly 1", () => {
    expect(lineWeight(NOW, NOW, 365 * DAY)).toBeCloseTo(1, 10);
  });

  test("a line exactly one half-life old weighs exactly 0.5", () => {
    expect(lineWeight(NOW - 365 * DAY, NOW, 365 * DAY)).toBeCloseTo(0.5, 10);
  });

  test("two half-lives weigh 0.25", () => {
    expect(lineWeight(NOW - 730 * DAY, NOW, 365 * DAY)).toBeCloseTo(0.25, 10);
  });

  test("a future timestamp is clamped to weight 1, never amplified", () => {
    expect(lineWeight(NOW + 1000 * DAY, NOW, 365 * DAY)).toBeCloseTo(1, 10);
  });
});

// These target the COMPILED pair, because that is what production runs:
// `aggregateBlameForRoot` uses `compileIgnoreGlobs` + `matchesAnyCompiledGlob`.
// `isIgnoredPath` is a thin convenience over them and is covered by the
// equivalence test alone — testing only the wrapper would leave the hot path
// unverified.
describe("glob exclusion", () => {
  test("matches lock files and nested generated trees", () => {
    const compiled = compileIgnoreGlobs([
      "**/package-lock.json",
      "**/dist/**",
      "**/*.min.js",
    ]);
    expect(matchesAnyCompiledGlob("package-lock.json", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/package-lock.json", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/dist/index.js", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("a/b/c.min.js", compiled)).toBe(true);
    expect(matchesAnyCompiledGlob("packages/app/src/index.ts", compiled)).toBe(false);
  });

  test("compiling an empty list yields a matcher that matches nothing", () => {
    expect(matchesAnyCompiledGlob("package-lock.json", compileIgnoreGlobs([]))).toBe(false);
  });

  test("a path containing glob metacharacters does not corrupt matching", () => {
    const compiled = compileIgnoreGlobs(["**/dist/**"]);
    expect(matchesAnyCompiledGlob("src/weird[1]/a{b}.ts", compiled)).toBe(false);
  });

  test("isIgnoredPath is exactly the compiled pair composed", () => {
    const globs = ["**/dist/**", "**/*.min.js", "**/package-lock.json"];
    const compiled = compileIgnoreGlobs(globs);
    for (const p of ["a/dist/b.js", "a/b.min.js", "package-lock.json", "a/b.ts", ""]) {
      expect(isIgnoredPath(p, globs)).toBe(matchesAnyCompiledGlob(p, compiled));
    }
  });
});

describe("aggregateBlameForRoot", () => {
  let d: Database;
  beforeEach(() => {
    d = db();
  });

  test("splits a file's weight between two authors by recency", () => {
    addLine(d, "src/a.ts", 1, "old@x.com", "Old", 730); // weight 0.25
    addLine(d, "src/a.ts", 2, "new@x.com", "New", 0); //   weight 1.0
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.filesCovered).toBe(1);
    const byEmail = new Map(agg.rows.map((r) => [r.authorEmail, r]));
    expect(byEmail.get("old@x.com")?.weightedLines).toBeCloseTo(0.25, 10);
    expect(byEmail.get("new@x.com")?.weightedLines).toBeCloseTo(1.0, 10);
    expect(byEmail.get("old@x.com")?.rawLines).toBe(1);
  });

  test("normalizes author email case", () => {
    addLine(d, "src/a.ts", 1, "Mixed@Case.COM", "M", 0);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.authorEmail).toBe("mixed@case.com");
  });

  test("EXCLUDES an ignored file from rows AND counts it", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    addLine(d, "package-lock.json", 1, "bot@x.com", "B", 0);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: ["**/package-lock.json"],
    });
    expect(agg.filesCovered).toBe(1);
    expect(agg.filesExcluded).toBe(1);
    expect(agg.rows.every((r) => r.filePath !== "package-lock.json")).toBe(true);
  });

  test("only reads the requested root", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES ('/repo/beta', 'src/b.ts', 1, 'sha', 'B', 'b@x.com', ?)`,
      [NOW],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows.every((r) => r.authorEmail === "a@x.com")).toBe(true);
  });

  test("lastTouchedMs is the newest of the author's lines", () => {
    addLine(d, "src/a.ts", 1, "a@x.com", "A", 100);
    addLine(d, "src/a.ts", 2, "a@x.com", "A", 5);
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.lastTouchedMs).toBe(NOW - 5 * DAY);
  });

  test("a NULL author_email is skipped rather than grouped under empty string", () => {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, 'src/a.ts', 1, 'sha', 'A', NULL, ?)`,
      [ROOT, NOW],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows).toHaveLength(0);
  });

  test("a NULL author_time_ms is treated as maximally old, not as weight 1", () => {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, 'src/a.ts', 1, 'sha', 'A', 'a@x.com', NULL)`,
      [ROOT],
    );
    const agg = aggregateBlameForRoot(d, ROOT, {
      nowMs: NOW,
      halfLifeDays: 365,
      ignoreGlobs: [],
    });
    expect(agg.rows[0]?.weightedLines).toBeCloseTo(0, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ownership/blame-aggregate.test.ts`
Expected: FAIL — module `./blame-aggregate.ts` not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/ownership/blame-aggregate.ts`:

```ts
import type { Database } from "bun:sqlite";

const MS_PER_DAY = 86_400_000;

export type FileAuthorWeight = {
  readonly filePath: string;
  readonly authorEmail: string;
  readonly authorName: string | null;
  readonly weightedLines: number;
  readonly rawLines: number;
  readonly lastTouchedMs: number;
};

export type BlameAggregate = {
  readonly rows: readonly FileAuthorWeight[];
  readonly filesCovered: number;
  readonly filesExcluded: number;
};

/**
 * Exponential recency decay. A line authored `halfLifeMs` ago counts half as
 * much as one authored now.
 *
 * A FUTURE `authorTimeMs` (clock skew, a rewritten commit date) is clamped to
 * weight 1 rather than allowed to exceed it: `0.5 ^ negative` is > 1 and would
 * let a single skewed line outweigh an entire file.
 */
export function lineWeight(authorTimeMs: number, nowMs: number, halfLifeMs: number): number {
  const ageMs = nowMs - authorTimeMs;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / halfLifeMs);
}

/**
 * `Bun.Glob` rather than a hand-rolled glob-to-regex translation: compiling a
 * user-supplied pattern into a backtracking regex is a ReDoS surface, and the
 * translation step is where that defect is usually introduced.
 *
 * Compilation is separated from matching because `aggregateBlameForRoot`
 * iterates BLAME LINES, not files. Constructing the glob set inside that loop
 * would build `lines × patterns` objects — on a 50k-line root with the 21
 * default patterns, over a million allocations for a decision that depends
 * only on the path.
 */
export function compileIgnoreGlobs(globs: readonly string[]): Bun.Glob[] {
  return globs.map((g) => new Bun.Glob(g));
}

export function matchesAnyCompiledGlob(
  filePath: string,
  compiled: readonly Bun.Glob[],
): boolean {
  for (const g of compiled) {
    if (g.match(filePath)) return true;
  }
  return false;
}

/** String convenience over the compiled pair. Compiles on every call, so it is
 * for callers holding a single path — never for a hot loop. */
export function isIgnoredPath(filePath: string, globs: readonly string[]): boolean {
  return matchesAnyCompiledGlob(filePath, compileIgnoreGlobs(globs));
}

type BlameRow = {
  file_path: string;
  author_name: string | null;
  author_email: string | null;
  author_time_ms: number | null;
};

/**
 * Aggregate one root's blame into per-`(file, author)` weighted totals.
 *
 * Filtering happens HERE, not in the blame sync, on purpose: `git_blame_line`
 * is shared with `nimbus why`'s provenance lanes, which legitimately need to
 * answer "who last touched this lock-file line". Narrowing what gets blamed
 * would silently degrade an unrelated shipped feature.
 */
export function aggregateBlameForRoot(
  db: Database,
  repoRoot: string,
  opts: { nowMs: number; halfLifeDays: number; ignoreGlobs: readonly string[] },
): BlameAggregate {
  const halfLifeMs = Math.max(1, opts.halfLifeDays) * MS_PER_DAY;
  const rows = db
    .query(
      `SELECT file_path, author_name, author_email, author_time_ms
         FROM git_blame_line
        WHERE repo_root = ?
        ORDER BY file_path ASC, line_no ASC`,
    )
    .all(repoRoot) as BlameRow[];

  const acc = new Map<string, { row: FileAuthorWeight }>();
  const coveredFiles = new Set<string>();
  const excludedFiles = new Set<string>();

  // Compiled ONCE, then memoized PER FILE. The rows are blame LINES, so a
  // 5,000-line file would otherwise be glob-matched 5,000 times against every
  // pattern for a decision that depends only on the path. Compilation alone
  // fixes the allocation cost; the memo fixes the far larger match cost.
  const compiled = compileIgnoreGlobs(opts.ignoreGlobs);
  const ignoredByPath = new Map<string, boolean>();
  const isIgnored = (path: string): boolean => {
    const memo = ignoredByPath.get(path);
    if (memo !== undefined) return memo;
    const v = matchesAnyCompiledGlob(path, compiled);
    ignoredByPath.set(path, v);
    return v;
  };

  for (const r of rows) {
    if (isIgnored(r.file_path)) {
      excludedFiles.add(r.file_path);
      continue;
    }
    const email = r.author_email?.trim().toLowerCase() ?? "";
    if (email === "") continue;
    coveredFiles.add(r.file_path);

    // A NULL author_time_ms must decay to ~0, never to weight 1: an unknown
    // date is not evidence of recency.
    const t = r.author_time_ms ?? Number.NEGATIVE_INFINITY;
    const w = Number.isFinite(t) ? lineWeight(t, opts.nowMs, halfLifeMs) : 0;
    const lastTouched = Number.isFinite(t) ? t : 0;

    const key = `${r.file_path}\u0000${email}`;
    const prev = acc.get(key);
    if (prev === undefined) {
      acc.set(key, {
        row: {
          filePath: r.file_path,
          authorEmail: email,
          authorName: r.author_name,
          weightedLines: w,
          rawLines: 1,
          lastTouchedMs: lastTouched,
        },
      });
      continue;
    }
    acc.set(key, {
      row: {
        ...prev.row,
        weightedLines: prev.row.weightedLines + w,
        rawLines: prev.row.rawLines + 1,
        lastTouchedMs: Math.max(prev.row.lastTouchedMs, lastTouched),
      },
    });
  }

  return {
    rows: [...acc.values()].map((v) => v.row),
    filesCovered: coveredFiles.size,
    filesExcluded: excludedFiles.size,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ownership/blame-aggregate.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ownership/blame-aggregate.ts packages/gateway/src/ownership/blame-aggregate.test.ts
git commit -m "feat(gateway): recency-weighted blame aggregation with glob exclusion"
```

---

## Task 4: Owner identity resolution

**Files:**

- Create: `packages/gateway/src/ownership/owner-identity.ts`
- Test: `packages/gateway/src/ownership/owner-identity.test.ts`

**Interfaces:**

- Consumes: `findPersonByCanonicalEmail`, `normalizeEmail` from `../people/person-store.ts`.
- Produces:

  ```ts
  export type ResolvedOwner = {
    readonly entityExternalId: string; // person id, or `git:<email>`
    readonly label: string;
    readonly resolved: boolean;
  };
  export function isBotAuthor(authorName: string | null, authorEmail: string): boolean;
  export function resolveOwner(db: Database, authorEmail: string, authorName: string | null): ResolvedOwner;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/owner-identity.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isBotAuthor, resolveOwner } from "./owner-identity.ts";

const NOW = 1_800_000_000_000;

describe("isBotAuthor", () => {
  test("filters a [bot]-suffixed name", () => {
    expect(isBotAuthor("dependabot[bot]", "x@y.com")).toBe(true);
    expect(isBotAuthor("renovate[bot]", "x@y.com")).toBe(true);
  });

  test("filters the bare github noreply address", () => {
    expect(isBotAuthor("GitHub", "noreply@github.com")).toBe(true);
  });

  // LOAD-BEARING: `*@users.noreply.github.com` addresses belong to REAL people
  // who enabled email privacy. Filtering them would erase real contributors.
  test("does NOT filter users.noreply.github.com — those are real people", () => {
    expect(isBotAuthor("Real Person", "1234+real@users.noreply.github.com")).toBe(false);
  });

  test("does not filter an ordinary author", () => {
    expect(isBotAuthor("Ada Lovelace", "ada@example.com")).toBe(false);
  });

  test("is case-insensitive on the bot suffix", () => {
    expect(isBotAuthor("Dependabot[BOT]", "x@y.com")).toBe(true);
  });
});

describe("resolveOwner", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });

  test("resolves to an existing person id", () => {
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person-1",
      "Ada Lovelace",
      "ada@example.com",
    ]);
    const out = resolveOwner(db, "ada@example.com", "Ada L");
    expect(out).toEqual({
      entityExternalId: "person-1",
      label: "Ada Lovelace",
      resolved: true,
    });
  });

  test("matches case-insensitively via normalizeEmail", () => {
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person-1",
      "Ada Lovelace",
      "ada@example.com",
    ]);
    expect(resolveOwner(db, "ADA@Example.COM", "Ada L").entityExternalId).toBe("person-1");
  });

  test("falls back to git:<email> when no person matches", () => {
    const out = resolveOwner(db, "stranger@example.com", "A Stranger");
    expect(out).toEqual({
      entityExternalId: "git:stranger@example.com",
      label: "A Stranger",
      resolved: false,
    });
  });

  // The fallback must never write to `person`: a decade of drive-by committers
  // and CI identities would otherwise pollute people data permanently.
  test("the fallback does NOT insert into the person table", () => {
    resolveOwner(db, "stranger@example.com", "A Stranger");
    const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("an unresolved author with no name falls back to the email as label", () => {
    expect(resolveOwner(db, "anon@example.com", null).label).toBe("anon@example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ownership/owner-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/ownership/owner-identity.ts`:

```ts
import type { Database } from "bun:sqlite";

import { findPersonByCanonicalEmail, normalizeEmail } from "../people/person-store.ts";

export type ResolvedOwner = {
  readonly entityExternalId: string;
  readonly label: string;
  readonly resolved: boolean;
};

/**
 * `*@users.noreply.github.com` is deliberately NOT matched: those addresses
 * belong to real people who enabled GitHub's email privacy. Only the BARE
 * `noreply@github.com` (used by GitHub's own web-UI commits) and explicit
 * `[bot]` name suffixes are filtered.
 */
export function isBotAuthor(authorName: string | null, authorEmail: string): boolean {
  if (authorEmail.trim().toLowerCase() === "noreply@github.com") return true;
  const name = authorName?.trim().toLowerCase() ?? "";
  return name.endsWith("[bot]");
}

/**
 * Map a git author email to a graph `person` entity external id.
 *
 * An unresolved email yields a `git:<email>` external id and is NEVER inserted
 * into the `person` table. Dropping such lines instead would understate every
 * denominator; inserting them would pollute people data with CI identities and
 * one-off contributors.
 */
export function resolveOwner(
  db: Database,
  authorEmail: string,
  authorName: string | null,
): ResolvedOwner {
  const email = normalizeEmail(authorEmail);
  const person = findPersonByCanonicalEmail(db, email);
  if (person !== null) {
    return {
      entityExternalId: person.id,
      label: person.displayName ?? person.id,
      resolved: true,
    };
  }
  const name = authorName?.trim() ?? "";
  return {
    entityExternalId: `git:${email}`,
    label: name === "" ? email : name,
    resolved: false,
  };
}
```

If `PersonRecord`'s display-name property is not `displayName`, read `people/person-store.ts` and use the real name — do not guess.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ownership/owner-identity.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ownership/owner-identity.ts packages/gateway/src/ownership/owner-identity.test.ts
git commit -m "feat(gateway): git-author identity resolution for ownership"
```

---

## Task 5: Git remote resolution

**Files:**

- Create: `packages/gateway/src/ownership/repo-remote.ts`
- Test: `packages/gateway/src/ownership/repo-remote.test.ts`

**Interfaces:**

- Consumes: `extensionProcessEnv` from `../extensions/spawn-env.ts`.
- Produces:

  ```ts
  export type RemoteRef = { readonly service: string; readonly ownerName: string };
  export type RemoteSpawn = typeof Bun.spawn;
  export function parseRemoteUrl(url: string): RemoteRef | null;
  export function selectRemoteName(names: readonly string[]): string | null;
  export function resolveRepoRemote(root: string, spawn?: RemoteSpawn): Promise<RemoteRef | null>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/repo-remote.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { parseRemoteUrl, selectRemoteName } from "./repo-remote.ts";

describe("parseRemoteUrl", () => {
  test("ssh form", () => {
    expect(parseRemoteUrl("git@github.com:nimbus-agent/Nimbus.git")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("https form with .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/nimbus-agent/Nimbus.git")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("https form without .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/nimbus-agent/Nimbus")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("gitlab and bitbucket hosts", () => {
    expect(parseRemoteUrl("git@gitlab.com:group/proj.git")?.service).toBe("gitlab");
    expect(parseRemoteUrl("https://bitbucket.org/team/repo.git")?.service).toBe("bitbucket");
  });

  test("a trailing slash is tolerated", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo/")?.ownerName).toBe("owner/repo");
  });

  test("an unrecognised host yields null", () => {
    expect(parseRemoteUrl("https://git.example.com/owner/repo.git")).toBeNull();
  });

  test("garbage yields null rather than throwing", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("https://github.com/onlyowner")).toBeNull();
  });
});

describe("selectRemoteName", () => {
  test("prefers origin whenever it exists", () => {
    expect(selectRemoteName(["upstream", "origin", "fork"])).toBe("origin");
  });

  test("uses the sole remote when origin is absent", () => {
    expect(selectRemoteName(["upstream"])).toBe("upstream");
  });

  // LOAD-BEARING: in a fork workflow `origin` is the user's fork and
  // `upstream` is canonical. Picking "the first" would bind a service to the
  // wrong repository, SILENTLY. Ambiguity must fail closed.
  test("returns null when origin is absent and two or more remotes exist", () => {
    expect(selectRemoteName(["upstream", "fork"])).toBeNull();
    expect(selectRemoteName(["a", "b", "c"])).toBeNull();
  });

  test("returns null when there are no remotes", () => {
    expect(selectRemoteName([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ownership/repo-remote.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/ownership/repo-remote.ts`:

```ts
import { extensionProcessEnv } from "../extensions/spawn-env.ts";

export type RemoteRef = { readonly service: string; readonly ownerName: string };
export type RemoteSpawn = typeof Bun.spawn;

const GIT_TIMEOUT_MS = 30_000;

const HOST_TO_SERVICE: ReadonlyMap<string, string> = new Map([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
]);

/** Mirrors `runGit` in `connectors/blame-index-sync.ts`: I1 env scoping, a
 * bounded timeout, and a catch that degrades to an empty result rather than
 * throwing (AbortError, git not on PATH, spawn failure). */
async function runGit(
  root: string,
  args: readonly string[],
  spawn: RemoteSpawn,
): Promise<{ code: number; out: string }> {
  try {
    const proc = spawn(["git", "-C", root, ...args], {
      env: extensionProcessEnv({}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { code, out };
  } catch {
    return { code: 1, out: "" };
  }
}

/** `host` + `owner/name` from an ssh or https remote URL; null if the host is
 * not one we can form a `repo` entity id for, or the path is not `owner/name`. */
export function parseRemoteUrl(url: string): RemoteRef | null {
  const raw = url.trim();
  if (raw === "") return null;

  let host: string;
  let path: string;
  const sshMatch = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }

  const service = HOST_TO_SERVICE.get(host.toLowerCase());
  if (service === undefined) return null;

  let p = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.length !== 2) return null;
  return { service, ownerName: `${parts[0] ?? ""}/${parts[1] ?? ""}` };
}

/**
 * `origin` when present; otherwise the SOLE remote if there is exactly one.
 *
 * Two-or-more without `origin` returns null on purpose. In a fork workflow
 * `origin` is the user's fork and `upstream` is canonical, so "pick the first"
 * binds a service to the wrong repository — and does it silently, which is a
 * worse failure than no binding. Same posture as `AmbiguousBindingWarning`
 * in `metrics/service-identity.ts`.
 */
export function selectRemoteName(names: readonly string[]): string | null {
  if (names.includes("origin")) return "origin";
  return names.length === 1 ? (names[0] ?? null) : null;
}

export async function resolveRepoRemote(
  root: string,
  spawn: RemoteSpawn = Bun.spawn,
): Promise<RemoteRef | null> {
  const listed = await runGit(root, ["remote"], spawn);
  if (listed.code !== 0) return null;
  const names = listed.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const chosen = selectRemoteName(names);
  if (chosen === null) return null;
  const url = await runGit(root, ["remote", "get-url", chosen], spawn);
  if (url.code !== 0) return null;
  return parseRemoteUrl(url.out.trim());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ownership/repo-remote.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Red-prove the ambiguity guard**

Change `selectRemoteName`'s last line to `return names[0] ?? null;`. Re-run.
Expected: `returns null when origin is absent and two or more remotes exist` FAILS. **Revert exactly.**

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ownership/repo-remote.ts packages/gateway/src/ownership/repo-remote.test.ts
git commit -m "feat(gateway): git remote resolution with fail-closed ambiguity"
```

---

## Task 6: The ownership pass

**Files:**

- Create: `packages/gateway/src/ownership/ownership-pass.ts`
- Test: `packages/gateway/src/ownership/ownership-pass.test.ts`

**Interfaces:**

- Consumes: `aggregateBlameForRoot` (Task 3), `resolveOwner` / `isBotAuthor` (Task 4), `resolveRepoRemote` / `RemoteSpawn` (Task 5), `NimbusOwnershipToml` (Task 2), and from `../graph/relationship-graph.ts`: `upsertGraphEntity(db, {type, externalId, label, service?, metadata?}) => string` and `upsertGraphRelation(db, fromId, toId, relationType, createdAt, weight?) => void`.
- Produces:

  ```ts
  export type OwnershipPassSummary = {
    readonly rootsTotal: number; readonly rootsCovered: number; readonly rootsWithRemote: number;
    readonly filesCovered: number; readonly filesExcluded: number;
    readonly servicesBound: number; readonly ownersEmitted: number;
    readonly entitiesReaped: number; readonly durationMs: number;
  };
  export type OwnershipPassOptions = {
    nowMs: number;
    roots: readonly string[];
    config: NimbusOwnershipToml;
    serviceRepoUrns: ReadonlyMap<string, readonly string[]>; // serviceId -> ["github:owner/name", ...]
    spawn?: RemoteSpawn;
  };
  export function directoryAncestors(filePath: string): string[];
  export function rankOwners(
    weights: ReadonlyMap<string, number>, minShare: number, maxOwners: number,
  ): { readonly emitted: { externalId: string; share: number }[]; readonly totalOwners: number; readonly totalWeight: number };
  export function runOwnershipPass(db: Database, opts: OwnershipPassOptions): Promise<OwnershipPassSummary>;
  ```

- [ ] **Step 1: Write the failing test for the two pure helpers**

Create `packages/gateway/src/ownership/ownership-pass.test.ts` with this first block:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { directoryAncestors, rankOwners, runOwnershipPass } from "./ownership-pass.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

describe("directoryAncestors", () => {
  test("lists every ancestor including the repo root, nearest first", () => {
    expect(directoryAncestors("packages/gateway/src/index.ts")).toEqual([
      "packages/gateway/src",
      "packages/gateway",
      "packages",
      "",
    ]);
  });

  test("a top-level file has only the repo root as ancestor", () => {
    expect(directoryAncestors("README.md")).toEqual([""]);
  });
});

describe("rankOwners", () => {
  test("computes share from weighted totals and sorts descending", () => {
    const out = rankOwners(new Map([["a", 3], ["b", 1]]), 0, 10);
    expect(out.totalWeight).toBeCloseTo(4, 10);
    expect(out.emitted[0]).toEqual({ externalId: "a", share: 0.75 });
    expect(out.emitted[1]).toEqual({ externalId: "b", share: 0.25 });
  });

  test("drops owners below minShare but still counts them in totalOwners", () => {
    const out = rankOwners(new Map([["a", 96], ["b", 2], ["c", 2]]), 0.05, 10);
    expect(out.emitted.map((e) => e.externalId)).toEqual(["a"]);
    expect(out.totalOwners).toBe(3);
  });

  test("caps at maxOwners while reporting the true count", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 11; i += 1) m.set(`p${String(i)}`, 10);
    const out = rankOwners(m, 0, 10);
    expect(out.emitted).toHaveLength(10);
    expect(out.totalOwners).toBe(11);
  });

  test("breaks ties by external id ascending, deterministically", () => {
    const out = rankOwners(new Map([["zzz", 5], ["aaa", 5], ["mmm", 5]]), 0, 2);
    expect(out.emitted.map((e) => e.externalId)).toEqual(["aaa", "mmm"]);
  });

  test("a zero total weight emits nothing rather than dividing by zero", () => {
    const out = rankOwners(new Map([["a", 0]]), 0, 10);
    expect(out.emitted).toEqual([]);
    expect(Number.isNaN(out.totalWeight)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ownership/ownership-pass.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pass**

Create `packages/gateway/src/ownership/ownership-pass.ts`:

```ts
import type { Database } from "bun:sqlite";

import type { NimbusOwnershipToml } from "../config/nimbus-toml.ts";
import { dbRun } from "../db/write.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { aggregateBlameForRoot } from "./blame-aggregate.ts";
import { isBotAuthor, resolveOwner } from "./owner-identity.ts";
import { type RemoteSpawn, resolveRepoRemote } from "./repo-remote.ts";

export type OwnershipPassSummary = {
  readonly rootsTotal: number;
  readonly rootsCovered: number;
  readonly rootsWithRemote: number;
  readonly filesCovered: number;
  readonly filesExcluded: number;
  readonly servicesBound: number;
  readonly ownersEmitted: number;
  readonly entitiesReaped: number;
  readonly durationMs: number;
};

export type OwnershipPassOptions = {
  readonly nowMs: number;
  readonly roots: readonly string[];
  readonly config: NimbusOwnershipToml;
  readonly serviceRepoUrns: ReadonlyMap<string, readonly string[]>;
  readonly spawn?: RemoteSpawn;
};

/** Every ancestor directory of a root-relative path, nearest first, with the
 * repo root itself represented as `""`. */
export function directoryAncestors(filePath: string): string[] {
  const parts = filePath.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    out.push(parts.slice(0, i).join("/"));
  }
  out.push("");
  return out;
}

/**
 * Weighted totals → emitted shares.
 *
 * `totalOwners` is the count BEFORE thresholding and capping, so truncation is
 * reportable rather than silent. Ties break on external id ascending, which is
 * uniform because every id is TEXT — `person.id` is `TEXT PRIMARY KEY`
 * (`index/unified-item-v3-sql.ts:3`) and the fallback is `git:<email>`.
 */
export function rankOwners(
  weights: ReadonlyMap<string, number>,
  minShare: number,
  maxOwners: number,
): {
  readonly emitted: { externalId: string; share: number }[];
  readonly totalOwners: number;
  readonly totalWeight: number;
} {
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  const totalOwners = weights.size;
  if (totalWeight <= 0) return { emitted: [], totalOwners, totalWeight: 0 };

  const ranked = [...weights.entries()]
    .map(([externalId, w]) => ({ externalId, share: w / totalWeight }))
    .filter((e) => e.share >= minShare)
    .sort((a, b) => (b.share !== a.share ? b.share - a.share : a.externalId.localeCompare(b.externalId)))
    .slice(0, Math.max(0, maxOwners));

  return { emitted: ranked, totalOwners, totalWeight };
}

function fileExternalId(root: string, path: string): string {
  return `file:${root}:${path}`;
}
function dirExternalId(root: string, path: string): string {
  return `dir:${root}:${path}`;
}

/**
 * Retire this root's ownership edges in ONE statement.
 *
 * Scoping is an EXACT EQUALITY on `graph_entity.service = 'ownership:<root>'`,
 * never a `LIKE 'file:<root>:%'` prefix — a `repoRoot` containing `%` or `_`
 * would silently widen a prefix pattern across roots. Equality on a dedicated
 * marker column carries none of that hazard while still being a single query,
 * so there is no need to materialize a candidate id set first.
 */
function clearOwnershipEdgesForRoot(db: Database, rootMarker: string): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type IN ('owns','contains')
        AND (from_id IN (SELECT id FROM graph_entity WHERE service = ?1)
          OR   to_id IN (SELECT id FROM graph_entity WHERE service = ?1))`,
    [rootMarker],
  );
}

/**
 * Delete this root's `source_file` / `directory` entities that now have NO
 * relations at all, in one statement. Returns the row count via `changes`.
 *
 * The degree-0 test spans EVERY relation type, not just this pass's: a
 * `source_file` may still carry `defined_in` edges from `syncCodeSymbolGraph`,
 * which owns them, and `graph_relation` cascades on entity deletion — so
 * reaping an entity that still has any edge would destroy another populator's
 * work. A degree-0 entity has nothing to cascade, making the delete inert
 * beyond the row itself.
 *
 * `NOT EXISTS` rather than `NOT IN`: both are correct here only because
 * `from_id`/`to_id` are `TEXT NOT NULL` (`index/graph-v7-sql.ts:19-20`) — a
 * single NULL in a `NOT IN` subquery makes the whole predicate never match,
 * silently reaping nothing. `NOT EXISTS` is immune to that and uses the
 * existing `idx_graph_relation_from` / `_to` indexes.
 */
function reapOrphansForRoot(db: Database, rootMarker: string): number {
  const res = dbRun(
    db,
    `DELETE FROM graph_entity
      WHERE service = ?1
        AND type IN ('source_file','directory')
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.from_id = graph_entity.id)
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.to_id   = graph_entity.id)`,
    [rootMarker],
  );
  return res.changes;
}

export async function runOwnershipPass(
  db: Database,
  opts: OwnershipPassOptions,
): Promise<OwnershipPassSummary> {
  const t0 = performance.now();
  const cfg = opts.config;
  let rootsCovered = 0;
  let rootsWithRemote = 0;
  let filesCovered = 0;
  let filesExcluded = 0;
  let ownersEmitted = 0;
  let entitiesReaped = 0;
  const servicesSeen = new Set<string>();

  // serviceId -> owner externalId -> weighted lines, accumulated across roots.
  const serviceWeights = new Map<string, Map<string, number>>();
  // "github:owner/name" -> serviceId
  const urnToService = new Map<string, string>();
  for (const [serviceId, urns] of opts.serviceRepoUrns) {
    for (const u of urns) urnToService.set(u, serviceId);
  }

  // Resolve every root's remote UP FRONT and in parallel. Two effects, the
  // second being the real reason: it removes the serial spawn cost across
  // roots, and — more importantly — it lifts all subprocess I/O out of the
  // per-root loop, leaving that loop as uninterrupted SQLite work. Interleaving
  // `await`ed spawns with graph writes is what would make wrapping the loop in
  // a transaction impossible later.
  const remoteByRoot = new Map<string, Awaited<ReturnType<typeof resolveRepoRemote>>>();
  await Promise.all(
    opts.roots.map(async (root) => {
      remoteByRoot.set(root, await resolveRepoRemote(root, opts.spawn));
    }),
  );

  for (const root of opts.roots) {
    const rootMarker = `ownership:${root}`;
    clearOwnershipEdgesForRoot(db, rootMarker);

    const agg = aggregateBlameForRoot(db, root, {
      nowMs: opts.nowMs,
      halfLifeDays: cfg.halfLifeDays,
      ignoreGlobs: cfg.ignoreGlobs,
    });
    filesCovered += agg.filesCovered;
    filesExcluded += agg.filesExcluded;
    if (agg.rows.length > 0) rootsCovered += 1;

    // file -> ownerExternalId -> weight ; and dir -> ownerExternalId -> weight
    const fileWeights = new Map<string, Map<string, number>>();
    const dirWeights = new Map<string, Map<string, number>>();
    const ownerLabels = new Map<string, string>();

    for (const r of agg.rows) {
      if (isBotAuthor(r.authorName, r.authorEmail)) continue;
      const owner = resolveOwner(db, r.authorEmail, r.authorName);
      ownerLabels.set(owner.entityExternalId, owner.label);

      const fw = fileWeights.get(r.filePath) ?? new Map<string, number>();
      fw.set(owner.entityExternalId, (fw.get(owner.entityExternalId) ?? 0) + r.weightedLines);
      fileWeights.set(r.filePath, fw);

      for (const dir of directoryAncestors(r.filePath)) {
        const dw = dirWeights.get(dir) ?? new Map<string, number>();
        dw.set(owner.entityExternalId, (dw.get(owner.entityExternalId) ?? 0) + r.weightedLines);
        dirWeights.set(dir, dw);
      }
    }

    const remote = remoteByRoot.get(root) ?? null;
    let boundServiceId: string | undefined;
    if (remote !== null) {
      rootsWithRemote += 1;
      const wsId = upsertGraphEntity(db, {
        type: "workspace",
        externalId: `filesystem:${root}`,
        label: root,
        service: "filesystem",
      });
      const repoId = upsertGraphEntity(db, {
        type: "repo",
        externalId: `${remote.service}:${remote.ownerName}`,
        label: remote.ownerName,
        service: remote.service,
      });
      upsertGraphRelation(db, wsId, repoId, "tracks_remote", opts.nowMs);

      boundServiceId = urnToService.get(`${remote.service}:${remote.ownerName}`);
      if (boundServiceId !== undefined) {
        const svcId = upsertGraphEntity(db, {
          type: "service",
          externalId: `service:${boundServiceId}`,
          label: boundServiceId,
          service: "nimbus",
        });
        upsertGraphRelation(db, repoId, svcId, "belongs_to", opts.nowMs);
        servicesSeen.add(boundServiceId);
      }
    }

    const emitOwners = (
      targetEntityId: string,
      weights: Map<string, number>,
    ): void => {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      for (const e of ranked.emitted) {
        const personId = upsertGraphEntity(db, {
          type: "person",
          externalId: e.externalId,
          label: ownerLabels.get(e.externalId) ?? e.externalId,
          service: "filesystem",
        });
        upsertGraphRelation(db, personId, targetEntityId, "owns", opts.nowMs, e.share);
        ownersEmitted += 1;
      }
    };

    for (const [path, weights] of fileWeights) {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      const fileId = upsertGraphEntity(db, {
        type: "source_file",
        externalId: fileExternalId(root, path),
        label: path,
        service: rootMarker,
        metadata: {
          ownerCount: ranked.totalOwners,
          truncated: ranked.emitted.length < ranked.totalOwners,
          totalWeightedLines: ranked.totalWeight,
        },
      });
      emitOwners(fileId, weights);

      const nearest = directoryAncestors(path)[0];
      if (nearest !== undefined) {
        const dirId = upsertGraphEntity(db, {
          type: "directory",
          externalId: dirExternalId(root, nearest),
          label: nearest === "" ? root : nearest,
          service: rootMarker,
        });
        upsertGraphRelation(db, dirId, fileId, "contains", opts.nowMs);
      }
    }

    for (const [dir, weights] of dirWeights) {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      const dirId = upsertGraphEntity(db, {
        type: "directory",
        externalId: dirExternalId(root, dir),
        label: dir === "" ? root : dir,
        service: rootMarker,
        metadata: {
          ownerCount: ranked.totalOwners,
          truncated: ranked.emitted.length < ranked.totalOwners,
          totalWeightedLines: ranked.totalWeight,
        },
      });
      emitOwners(dirId, weights);

      const parents = directoryAncestors(dir);
      const parent = dir === "" ? undefined : parents[0];
      if (parent !== undefined) {
        const parentId = upsertGraphEntity(db, {
          type: "directory",
          externalId: dirExternalId(root, parent),
          label: parent === "" ? root : parent,
          service: rootMarker,
        });
        upsertGraphRelation(db, parentId, dirId, "contains", opts.nowMs);
      }
    }

    if (boundServiceId !== undefined) {
      const sw = serviceWeights.get(boundServiceId) ?? new Map<string, number>();
      const rootTotals = dirWeights.get("");
      if (rootTotals !== undefined) {
        for (const [owner, w] of rootTotals) sw.set(owner, (sw.get(owner) ?? 0) + w);
      }
      serviceWeights.set(boundServiceId, sw);
      for (const [owner, label] of ownerLabels) ownerLabels.set(owner, label);
    }

    entitiesReaped += reapOrphansForRoot(db, rootMarker);
  }

  for (const [serviceId, weights] of serviceWeights) {
    const svcId = upsertGraphEntity(db, {
      type: "service",
      externalId: `service:${serviceId}`,
      label: serviceId,
      service: "nimbus",
    });
    const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
    for (const e of ranked.emitted) {
      const personId = upsertGraphEntity(db, {
        type: "person",
        externalId: e.externalId,
        label: e.externalId,
        service: "filesystem",
      });
      upsertGraphRelation(db, personId, svcId, "owns", opts.nowMs, e.share);
      ownersEmitted += 1;
    }
  }

  const summary: OwnershipPassSummary = {
    rootsTotal: opts.roots.length,
    rootsCovered,
    rootsWithRemote,
    filesCovered,
    filesExcluded,
    servicesBound: servicesSeen.size,
    ownersEmitted,
    entitiesReaped,
    durationMs: Math.round(performance.now() - t0),
  };

  dbRun(
    db,
    `INSERT INTO ownership_pass_state
       (id, last_pass_at, last_duration_ms, roots_total, roots_covered, roots_with_remote,
        files_covered, files_excluded, services_bound, owners_emitted, entities_reaped)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       last_pass_at = excluded.last_pass_at,
       last_duration_ms = excluded.last_duration_ms,
       roots_total = excluded.roots_total,
       roots_covered = excluded.roots_covered,
       roots_with_remote = excluded.roots_with_remote,
       files_covered = excluded.files_covered,
       files_excluded = excluded.files_excluded,
       services_bound = excluded.services_bound,
       owners_emitted = excluded.owners_emitted,
       entities_reaped = excluded.entities_reaped`,
    [
      opts.nowMs,
      summary.durationMs,
      summary.rootsTotal,
      summary.rootsCovered,
      summary.rootsWithRemote,
      summary.filesCovered,
      summary.filesExcluded,
      summary.servicesBound,
      summary.ownersEmitted,
      summary.entitiesReaped,
    ],
  );

  return summary;
}
```

Note the `service` column on `source_file` / `directory` entities is set to `ownership:<root>`. That marker column is what lets both the clear and the reap scope by **exact equality** — root-scoped, a single bulk statement each, and with none of the widening hazard a `LIKE 'file:<root>:%'` prefix query would carry for a `repoRoot` containing `%` or `_`. `source_file` entities created by `syncCodeSymbolGraph` carry `service: "filesystem"` and a different `external_id` namespace, so they are never in scope here — and even if one were, the degree-0 test would spare it.

- [ ] **Step 4: Run the pure-helper tests**

Run: `bun test packages/gateway/src/ownership/ownership-pass.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Append the integration tests to the same file**

```ts
function seedLine(
  d: Database, file: string, lineNo: number, email: string, name: string, ageDays: number,
): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["/repo/alpha", file, lineNo, `sha${String(lineNo)}`, name, email, NOW - ageDays * DAY],
  );
}

const noRemote: typeof Bun.spawn = (() => {
  throw new Error("git unavailable");
}) as unknown as typeof Bun.spawn;

function fakeSpawn(remotes: string, url: string): typeof Bun.spawn {
  return ((cmd: string[]) => {
    const isGetUrl = cmd.includes("get-url");
    const body = isGetUrl ? url : remotes;
    return {
      exited: Promise.resolve(0),
      stdout: new Response(body).body,
    };
  }) as unknown as typeof Bun.spawn;
}

function baseOpts(over: Partial<Parameters<typeof runOwnershipPass>[1]> = {}) {
  return {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: noRemote,
    ...over,
  };
}

describe("runOwnershipPass", () => {
  let d: Database;
  beforeEach(() => {
    d = new Database(":memory:");
    runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  });

  test("zero roots is a no-op that RECORDS roots_total = 0", async () => {
    const s = await runOwnershipPass(d, baseOpts({ roots: [] }));
    expect(s.rootsTotal).toBe(0);
    const row = d.query("SELECT roots_total FROM ownership_pass_state WHERE id = 1").get() as
      | { roots_total: number }
      | null;
    expect(row?.roots_total).toBe(0);
  });

  test("emits person -> source_file owns edges with share as weight", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 2, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 3, "b@x.com", "B", 0);
    await runOwnershipPass(d, baseOpts());
    const rows = d
      .query(
        `SELECT p.external_id AS owner, r.weight AS weight
           FROM graph_relation r
           JOIN graph_entity p ON p.id = r.from_id
           JOIN graph_entity f ON f.id = r.to_id
          WHERE r.type = 'owns' AND f.type = 'source_file'
          ORDER BY r.weight DESC`,
      )
      .all() as { owner: string; weight: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.owner).toBe("git:a@x.com");
    expect(rows[0]?.weight).toBeCloseTo(2 / 3, 6);
  });

  test("emits directory rollup and contains edges", async () => {
    seedLine(d, "packages/app/src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const dirs = (
      d.query("SELECT label FROM graph_entity WHERE type = 'directory' ORDER BY label").all() as {
        label: string;
      }[]
    ).map((r) => r.label);
    expect(dirs).toContain("packages/app/src");
    expect(dirs).toContain("packages");
    const contains = d.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'contains'").get() as {
      n: number;
    };
    expect(contains.n).toBeGreaterThan(0);
  });

  test("records ownerCount and truncated on the file entity", async () => {
    for (let i = 0; i < 12; i += 1) {
      seedLine(d, "src/a.ts", i + 1, `p${String(i)}@x.com`, `P${String(i)}`, 0);
    }
    await runOwnershipPass(d, baseOpts({ config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [], minShare: 0 } }));
    const row = d
      .query("SELECT metadata FROM graph_entity WHERE type = 'source_file' LIMIT 1")
      .get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as { ownerCount: number; truncated: boolean };
    expect(meta.ownerCount).toBe(12);
    expect(meta.truncated).toBe(true);
  });

  test("is idempotent — running twice yields the same edge count", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const first = d.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number };
    await runOwnershipPass(d, baseOpts());
    const second = d.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number };
    expect(second.n).toBe(first.n);
  });

  test("binds a service when the remote matches a configured URN", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/api.git"),
        serviceRepoUrns: new Map([["checkout", ["github:acme/api"]]]),
      }),
    );
    const svc = d.query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'service'").get() as {
      n: number;
    };
    expect(svc.n).toBe(1);
    const belongs = d.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'").get() as {
      n: number;
    };
    expect(belongs.n).toBe(1);
  });

  test("no remote still emits file ownership, just no service rollup", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    const s = await runOwnershipPass(d, baseOpts());
    expect(s.rootsWithRemote).toBe(0);
    expect(s.servicesBound).toBe(0);
    expect(s.ownersEmitted).toBeGreaterThan(0);
  });

  test("bots are excluded from ownership", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "src/a.ts", 2, "bot@x.com", "dependabot[bot]", 0);
    await runOwnershipPass(d, baseOpts());
    const owners = (
      d
        .query(
          `SELECT DISTINCT p.external_id AS owner FROM graph_relation r
             JOIN graph_entity p ON p.id = r.from_id WHERE r.type = 'owns'`,
        )
        .all() as { owner: string }[]
    ).map((r) => r.owner);
    expect(owners).not.toContain("git:bot@x.com");
  });

  test("retires edges for a file whose blame is removed, and reaps its entity", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    d.run("DELETE FROM git_blame_line WHERE file_path = 'src/a.ts'");
    const s = await runOwnershipPass(d, baseOpts());
    const files = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'source_file'")
      .get() as { n: number };
    expect(files.n).toBe(0);
    expect(s.entitiesReaped).toBeGreaterThan(0);
  });

  // THE LOAD-BEARING REAPING TEST. A `source_file` that still carries a
  // `defined_in` edge from `syncCodeSymbolGraph` must SURVIVE, edge intact.
  test("does not reap an entity that still has a foreign edge", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    await runOwnershipPass(d, baseOpts());
    const fileRow = d
      .query("SELECT id FROM graph_entity WHERE type = 'source_file' LIMIT 1")
      .get() as { id: string };
    const symId = d.query("SELECT id FROM graph_entity LIMIT 1").get() as { id: string };
    d.run(
      "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES (?, ?, 'defined_in', 1, ?)",
      [symId.id, fileRow.id, NOW],
    );
    d.run("DELETE FROM git_blame_line WHERE file_path = 'src/a.ts'");
    await runOwnershipPass(d, baseOpts());
    const survived = d.query("SELECT COUNT(*) AS n FROM graph_entity WHERE id = ?").get(fileRow.id) as {
      n: number;
    };
    expect(survived.n).toBe(1);
    const edge = d
      .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'defined_in'")
      .get() as { n: number };
    expect(edge.n).toBe(1);
  });

  test("a second root with glob metacharacters in its path is untouched by the first root's reap", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES ('/repo/we_ird%path', 'src/b.ts', 1, 'sha', 'B', 'b@x.com', ?)`,
      [NOW],
    );
    await runOwnershipPass(d, baseOpts({ roots: [ROOT, "/repo/we_ird%path"] }));
    d.run("DELETE FROM git_blame_line WHERE repo_root = ?", [ROOT]);
    await runOwnershipPass(d, baseOpts({ roots: [ROOT] }));
    const other = d
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE service = 'ownership:/repo/we_ird%path'")
      .get() as { n: number };
    expect(other.n).toBeGreaterThan(0);
  });

  test("ignored paths are excluded and counted", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 0);
    seedLine(d, "package-lock.json", 1, "b@x.com", "B", 0);
    const s = await runOwnershipPass(
      d,
      baseOpts({
        config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: ["**/package-lock.json"] },
      }),
    );
    expect(s.filesExcluded).toBe(1);
    const labels = (
      d.query("SELECT label FROM graph_entity WHERE type = 'source_file'").all() as {
        label: string;
      }[]
    ).map((r) => r.label);
    expect(labels).not.toContain("package-lock.json");
  });
});
```

- [ ] **Step 6: Run the full file**

Run: `bun test packages/gateway/src/ownership/ownership-pass.test.ts`
Expected: PASS, 19 tests. If the `fakeSpawn` stub's shape does not satisfy `resolveRepoRemote`, read `repo-remote.ts` and adjust the stub — do not weaken the assertion.

- [ ] **Step 7: Red-prove the reaping-safety guard**

In `reapOrphansForRoot`, narrow both `NOT EXISTS` subqueries to this pass's own edge types by appending `AND r.type IN ('owns','contains')` to each. Re-run.
Expected: `does not reap an entity that still has a foreign edge` FAILS — the `defined_in` edge is destroyed by the cascade. **Revert exactly.**

Then do it a second way: change `NOT EXISTS (SELECT 1 ...)` to `id NOT IN (SELECT from_id FROM graph_relation)` and insert a row with a NULL `from_id`. This one you cannot actually execute — the column is `TEXT NOT NULL`, and that constraint is the only reason the `NOT IN` form would have been safe. Record that as the reason the code uses `NOT EXISTS`, and move on.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ownership/ownership-pass.ts packages/gateway/src/ownership/ownership-pass.test.ts
git commit -m "feat(gateway): ownership derivation pass with rollups and orphan reaping"
```

---

## Task 7: Debounced refresher

**Files:**

- Create: `packages/gateway/src/ownership/ownership-refresh.ts`
- Test: `packages/gateway/src/ownership/ownership-refresh.test.ts`

**Interfaces:**

- Consumes: `OwnershipPassSummary` (Task 6).
- Produces:

  ```ts
  export type OwnershipRefresherDeps = {
    debounceMs: number;
    runPass: () => Promise<OwnershipPassSummary>;
    onError?: (err: unknown) => void;
  };
  export type OwnershipRefresher = {
    trigger: () => void;
    run: () => Promise<OwnershipPassSummary>;
    stop: () => void;
  };
  export function createOwnershipRefresher(deps: OwnershipRefresherDeps): OwnershipRefresher;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/ownership-refresh.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { OwnershipPassSummary } from "./ownership-pass.ts";
import { createOwnershipRefresher } from "./ownership-refresh.ts";

const SUMMARY: OwnershipPassSummary = {
  rootsTotal: 0, rootsCovered: 0, rootsWithRemote: 0, filesCovered: 0,
  filesExcluded: 0, servicesBound: 0, ownersEmitted: 0, entitiesReaped: 0, durationMs: 0,
};

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createOwnershipRefresher", () => {
  test("coalesces a burst of triggers into one pass", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 20,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.trigger();
    r.trigger();
    r.trigger();
    await tick(60);
    expect(calls).toBe(1);
    r.stop();
  });

  test("a trigger during a running pass schedules exactly one follow-up", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        await tick(30);
        return SUMMARY;
      },
    });
    r.trigger();
    await tick(15);
    r.trigger();
    r.trigger();
    await tick(120);
    expect(calls).toBe(2);
    r.stop();
  });

  test("run() bypasses the debounce and returns the summary", async () => {
    const r = createOwnershipRefresher({ debounceMs: 10_000, runPass: async () => SUMMARY });
    expect(await r.run()).toEqual(SUMMARY);
    r.stop();
  });

  test("a throwing pass reaches onError and does not wedge the refresher", async () => {
    let errs = 0;
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return SUMMARY;
      },
      onError: () => {
        errs += 1;
      },
    });
    r.trigger();
    await tick(40);
    r.trigger();
    await tick(40);
    expect(errs).toBe(1);
    expect(calls).toBe(2);
    r.stop();
  });

  test("stop() prevents a pending debounced pass from firing", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 30,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.trigger();
    r.stop();
    await tick(80);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ownership/ownership-refresh.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/ownership/ownership-refresh.ts`:

```ts
import type { OwnershipPassSummary } from "./ownership-pass.ts";

export type OwnershipRefresherDeps = {
  readonly debounceMs: number;
  /** Injected rather than imported so this module is testable without a Database. */
  readonly runPass: () => Promise<OwnershipPassSummary>;
  readonly onError?: (err: unknown) => void;
};

export type OwnershipRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /** Runs immediately, bypassing the debounce, sharing the single-flight guard. */
  run: () => Promise<OwnershipPassSummary>;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the ownership pass. Mirrors
 * `decisions/decision-refresh.ts`: a burst of connector syncs must coalesce
 * into ONE pass, and a trigger arriving mid-pass sets a DIRTY flag rather than
 * queueing — exactly one follow-up runs however many syncs landed meanwhile,
 * so a slow pass cannot accumulate a backlog. Dropping the trigger outright
 * would lose whichever sync overlapped the pass until some later sync fired.
 *
 * LIMIT — `stop()` clears the debounce timer only; a pass already in flight
 * runs to completion. Unlike the decisions pass there is no model call
 * underneath, so the unbounded-hang failure mode that pass documents does not
 * apply here: every await is SQLite or a timeout-bounded `git` spawn.
 */
export function createOwnershipRefresher(deps: OwnershipRefresherDeps): OwnershipRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;

  function fire(): void {
    timer = undefined;
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    deps
      .runPass()
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
        if (dirty) {
          dirty = false;
          fire();
        }
      });
  }

  return {
    trigger(): void {
      if (stopped) return;
      if (running) {
        dirty = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },
    async run(): Promise<OwnershipPassSummary> {
      running = true;
      try {
        return await deps.runPass();
      } finally {
        running = false;
      }
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/ownership/ownership-refresh.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ownership/ownership-refresh.ts packages/gateway/src/ownership/ownership-refresh.test.ts
git commit -m "feat(gateway): debounced single-flight ownership refresher"
```

---

## Task 8: Wire the refresher into assemble

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts`

**Interfaces:**

- Consumes: `createOwnershipRefresher` (Task 7), `runOwnershipPass` (Task 6), `loadNimbusOwnershipFromConfigDir` (Task 2), and the existing `loadNimbusFilesystemRootsFromConfigDir` + `loadNimbusServiceConfigsFromConfigDir`.
- Produces: an `ownershipRefresher: OwnershipRefresher | undefined` on the same return object that already carries `glossaryRefresher` and `decisionsRefresher`.

- [ ] **Step 1: Read the three wiring sites before editing**

Read `packages/gateway/src/platform/assemble.ts` around lines **425–440** (the return type), **490–535** (the `decisionsRefresher` construction and the post-sync trigger block), **570–580** (the return statement), and **1955–1975** (destructuring + `sidecarStops`). Quote what is actually there before writing. Do not rely on the line numbers above being exact — the file changes often.

- [ ] **Step 2: Add the import**

Alongside the existing `../config/...` and feature imports:

```ts
import { loadNimbusOwnershipFromConfigDir } from "../config/nimbus-toml.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import {
  createOwnershipRefresher,
  type OwnershipRefresher,
} from "../ownership/ownership-refresh.ts";
```

If `loadNimbusOwnershipFromConfigDir` is already reachable through an existing `../config/nimbus-toml.ts` import in that file, extend that import rather than adding a duplicate.

- [ ] **Step 3: Construct the refresher**

Immediately after the `decisionsRefresher` construction block, add:

```ts
  // Ownership graph (S1 Local Brain). Construction-gated on `[ownership].enabled`,
  // matching decisionsRefresher — a disabled pass leaves this `undefined` rather
  // than idling. Roots and service configs are re-read per pass so a config edit
  // applies without a gateway restart.
  const ownershipCfg = loadNimbusOwnershipFromConfigDir(paths.configDir);
  const ownershipRefresher = ownershipCfg.enabled
    ? createOwnershipRefresher({
        debounceMs: ownershipCfg.debounceMs,
        runPass: () => {
          const roots = loadNimbusFilesystemRootsFromConfigDir(paths.configDir)
            .filter((r) => r.gitAware)
            .map((r) => r.path);
          const serviceRepoUrns = new Map<string, readonly string[]>();
          for (const [serviceId, svc] of loadNimbusServiceConfigsFromConfigDir(paths.configDir)) {
            serviceRepoUrns.set(
              serviceId,
              svc.repos.map((u) => `${u.provider}:${u.providerId}`),
            );
          }
          return runOwnershipPass(db, {
            nowMs: Date.now(),
            roots,
            config: ownershipCfg,
            serviceRepoUrns,
          });
        },
        onError: (err) => {
          syncLogger.warn({ err }, "ownership derivation pass failed");
        },
      })
    : undefined;
```

Verify `ParsedDoraRepoUrn`'s field names against `metrics/dora-config.ts` before using `u.provider` / `u.providerId` — if they differ, use the real ones.

- [ ] **Step 4: Trigger it post-sync**

In the same block that already calls `glossaryRefresher.trigger()` and `decisionsRefresher?.trigger()`, add:

```ts
      ownershipRefresher?.trigger();
```

- [ ] **Step 5: Return it and stop it**

Add `ownershipRefresher` to the returned object literal and to the declared return type (as `OwnershipRefresher | undefined`), alongside `decisionsRefresher`. Then at the `sidecarStops` site:

```ts
  if (ownershipRefresher !== undefined) {
    sidecarStops.push(() => ownershipRefresher.stop());
  }
```

- [ ] **Step 6: Typecheck and run the platform tests**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun test packages/gateway/src/platform/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(gateway): wire the ownership pass into the post-sync seam"
```

---

## Task 8b: Status-surface drift (schema V49 → V51)

**Files:**

- Modify: `CLAUDE.md`
- Modify: `GEMINI.md`
- Modify: `docs/architecture.md`

**Why this task exists.** `scripts/structure-audit/check-status-drift.ts` is a **preflight gate**. `auditStatusDrift` reads `CURRENT_SCHEMA_VERSION` from `local-index.ts` as canonical, then scans `CLAUDE.md`, `GEMINI.md` and `docs/architecture.md` for `/\bschema\s+V(\d+)/gi` and errors on every mismatch. All three currently say **V49**, so Task 1's bump makes this gate fail. Without this task the failure surfaces only at Task 9, after all implementation.

It also cross-checks that `CURRENT_SCHEMA_VERSION` equals the highest `…-v<N>-sql.ts` filename. `ownership-v51-sql.ts` gives 51, matching. The reserved V50 has no file of its own and needs none — the check takes the maximum, not a contiguous run.

**Interfaces:** none — documentation only.

- [ ] **Step 1: Run the audit to see it fail**

Run: `bun run scripts/structure-audit/check-status-drift.ts`
Expected: FAIL, with three `"schema V49" is stale — canonical schema is V51` errors, one per surface.

- [ ] **Step 2: Update the two mirrored status lines**

In **both** `CLAUDE.md` and `GEMINI.md` (they are mirrors — CLAUDE.md's own header says to update both when changing roadmap rows), change `schema V49` to `schema V51` in the `**Status:**` paragraph. Leave the `V49 (connector-depth enforcement + Gmail/Outlook bodies, #1047)` clause alone — that sentence is about a past release and remains true.

Add the ownership graph to the S1 sentence in the same paragraph, after the research-briefs clause:

```text
; the ownership graph (schema V51) derives service/code ownership from the already-indexed git-blame data
```

- [ ] **Step 3: Update architecture.md**

Two edits:

1. Line ~5: `schema V49` → `schema V51`.
2. The migration-runner paragraph (~line 1379): change `**Latest applied migration: V49**` to `**Latest applied migration: V51**` and prepend a clause describing V51 ahead of the existing V49 clause:

```text
V51 added the ownership relation types (`owns` / `contains` / `tracks_remote`) + `ownership_pass_state` — the ownership graph derived from git blame — S1 "Local Brain"; V50 is reserved for the HTTP agents resolve-by-URL work and is a deliberate no-op step;
```

Also update the trailing `` `CURRENT_SCHEMA_VERSION = 49` `` in that same paragraph to `51`. That one is not caught by the audit's regex, which makes it exactly the kind of stale prose that survives a gate and misleads the next reader.

- [ ] **Step 4: Run the audit to verify it passes**

Run: `bun run scripts/structure-audit/check-status-drift.ts`
Expected: PASS, no output.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md GEMINI.md docs/architecture.md
git commit -m "docs: status surfaces to schema V51"
```

---

## Task 9: Full verification and PR

**Files:** none created; this task verifies and ships.

- [ ] **Step 1: Run the whole ownership suite**

Run: `bun test packages/gateway/src/ownership/`
Expected: PASS, 58 tests across five files.

- [ ] **Step 2: Confirm the forbidden files are untouched**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected: the list contains NONE of `ipc/agents-rpc.ts`, `ipc/http-server.ts`, `ipc/http-write-routes.ts`, `ipc/http-route-auth.ts`, `egress/`, `cli/src/commands/prove.ts`, `scripts/structure-audit/check-nimbus-invariants.ts`, `security-invariants.test.ts`, or anything under `packages/gateway/src/graph/`. If any appears, STOP and report — the two workstreams have collided.

- [ ] **Step 3: Run the full preflight, REDIRECTED to a file**

Never pipe this into `tee` or `tail` — the pipe's exit status masks a failing run and has reported false success in this repo.

```bash
bun run preflight > /tmp/ownership-preflight.txt 2>&1; echo "EXIT=$?"
grep -nE "FAIL|✗|error|Error:" /tmp/ownership-preflight.txt | head -50
```

Expected: `EXIT=0`. Investigate every hit before proceeding; an early failure fail-fasts the run and leaves later gates unrun, so a short log is not evidence of success.

- [ ] **Step 4: Check coverage-floor violations against your own diff**

If `audit:coverage-floor` reports violations, run `git diff --name-only origin/main...HEAD` and confirm each violating file is actually yours. On Windows this audit reports false violations in files you never touched (`socket-listeners.ts`, `platform/linux.ts`) — it is CI-Linux-authoritative. Fix a real violation with tests, never with an exclusion.

- [ ] **Step 5: Verify tests pass from a second working directory**

```bash
cd C:/Users/asafg/AppData/Local/Temp && bun test C:/gitrep/Nimbus/.claude/worktrees/ownership-graph/packages/gateway/src/ownership/
```

Expected: PASS. This catches any CWD-relative path assumption that would be dead in CI.

- [ ] **Step 6: Prove the branch merges cleanly**

```bash
git fetch origin main
git merge-tree --write-tree origin/main HEAD
```

Expected: no conflict markers. A conflicting PR runs NO `pull_request` workflows and reads deceptively green.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin dev/asafgolombek/ownership-graph
```

PR title (release-please parses this line):

```text
feat(gateway): ownership graph derived from already-indexed blame data
```

The PR description MUST state, prominently:

- Schema is **V51**. V50 is registered as a deliberate **no-op step** reserving the slot for the HTTP-agents PR 3; that PR replaces the constant's body, and the version and ledger row are already correct.
- This PR does **not** modify `security-invariants.test.ts`, any `ipc/http-*` file, `agents-rpc.ts`, `egress/*`, or `packages/gateway/src/graph/*`.
- Read surface (`ownership.*` IPC + `nimbus owners` CLI + Tauri allowlist) is **PR B**, deliberately deferred.

---

## Self-Review

**Spec coverage.** §4 V51 → Task 1. §5.2 entities + §5.3 edges → Task 6. §5.4 migration → Task 1. §5.5 scoring → Tasks 3 and 6. §5.5.1 path exclusion → Tasks 2 and 3. §5.6 identity → Task 4. §5.7 remote + fallback + no-caching → Task 5. §6 modules, flow, orphan reaping, config → Tasks 2–8. §7 failure posture → Task 6's degradation tests. §8 security → Global Constraints + Task 9 Step 2. §10 testing → each task's test block.

**Deliberately deferred to PR B, per §9:** `ownership.*` IPC, `nimbus owners` CLI, Tauri allowlist.

**Known follow-up not covered here, per §11:** `agents.ownership` brief; rewiring `expert.ts`'s `subBlame` lane; CODEOWNERS/reviewer/changed-file ingestion.

**Type consistency check.** `FileAuthorWeight` / `BlameAggregate` (Task 3) are consumed unchanged in Task 6. `ResolvedOwner.entityExternalId` (Task 4) is the key threaded through `rankOwners` and into `upsertGraphEntity`. `RemoteRef.{service, ownerName}` (Task 5) is used to build both the `repo` external id and the URN lookup key in Task 6. `OwnershipPassSummary` (Task 6) is the return type of `runPass` in Task 7 and the test fixture there. `NimbusOwnershipToml` field names (`halfLifeDays`, `minShare`, `maxOwnersPerPath`, `ignoreGlobs`) are identical in Tasks 2, 3, 6 and 8.

**Two things the implementer must verify rather than trust**, both flagged inline: `PersonRecord`'s display-name property in Task 4 Step 3, and `ParsedDoraRepoUrn`'s field names in Task 8 Step 3. Both are read-and-confirm, not guess.
