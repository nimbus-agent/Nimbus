# PR Changed-File Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index which files each PR touched, across GitHub / GitLab / Bitbucket, behind a coverage record that keeps "we did not check" distinguishable from "we checked and it does not match".

**Architecture:** Two V55 tables keyed on `item.id` with `ON DELETE CASCADE`. A per-forge fetch runs inside the existing sync tick as a sibling of `enrichPrDetail`, bounded per tick and writing one transaction per PR. A store module owns all reads, including the canonical fail-closed negation query that W6-B will call. No predicate language ships here.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict with `exactOptionalPropertyTypes`, `bun:sqlite`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-19-pr-changed-file-indexing-design.md`](../specs/2026-08-19-pr-changed-file-indexing-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-19-pr-changed-file-indexing-design-review-response.md`](../specs/2026-08-19-pr-changed-file-indexing-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\pr-changed-file-indexing`, branch `dev/asafgolombek/pr-changed-file-indexing`. Never commit on `main`. This session is worktree-isolated — git commands must not target the shared checkout.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `db/write.ts` (invariant I14, static rule D12). Identifiers via `escapeIdentifier` (I9). Never string-interpolate a value into SQL.
- **The two write helpers bind parameters DIFFERENTLY** — verified against real call sites, and easy to get backwards: `dbRun(db, sql, [a, b, c])` takes an **array**; `dbStmtRun(stmt, a, b, c)` takes them **spread** (`embedding/pipeline.ts:157`, `index/migrations/runner.ts:272`). Passing an array to `dbStmtRun` binds one argument instead of several.
- **Path matching uses `GLOB`, never `LIKE`.** Verified against `bun:sqlite`: `'Tests/a.ts' LIKE 'tests/%'` → `1` (case-insensitive) and `'src/myXfile.ts' LIKE 'src/my_file.ts'` → `1` (`_` is a wildcard). Both are `0` under `GLOB`. Always a bound parameter.
- **One row per touched path.** A rename emits TWO rows (old and new path). A deletion emits ONE row. Membership decides every predicate; `status` is descriptive only.
- **Fail-closed:** a PR with no `pr_files_state` row, or with `truncated = 1`, is EXCLUDED from negation results and counted in a gap. Never included with a caveat.
- **`bun:sqlite` `prepare()` must be `finalize()`d** — an unfinalized statement makes `close()` a silent no-op.
- **No new IPC method, no new CLI command, no Tauri allowlist change.** `ALLOWED_METHODS` stays at **105** (asserted in `packages/ui/src-tauri/src/gateway_bridge.rs:594`).
- **No new invariant and no new egress class.** The fetch runs inside the scheduled sync run, already covered per-run by `egress/sync-egress.ts`.
- Coverage floor: every touched file ≥85% line AND ≥80% branch.
- `bun run typecheck:tests` prints "ADVISORY on win32 — not gating" and **exits 0 even with violations**. **Quote the violation count, not the exit code.**
- Run `bun run preflight:fast` before declaring any task done.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/pr-changed-file-v55-sql.ts` | V55 DDL only (two tables + two indexes) |
| `packages/gateway/src/prfiles/pr-changed-file-store.ts` | All reads/writes of both tables, including the canonical negation query |
| `packages/gateway/src/prfiles/pr-file-mapping.ts` | Pure forge-payload → `ChangedFileRow[]` mappers (no I/O) |
| `packages/gateway/src/prfiles/pr-file-fetch.ts` | Shared bounded-tick fetch loop + candidate selector |
| `packages/gateway/test/fixtures/pr-files/` | Recorded forge payloads |

---

## Task 1: V55 schema

**Files:**
- Create: `packages/gateway/src/index/pr-changed-file-v55-sql.ts`
- Create: `packages/gateway/src/index/pr-changed-file-v55.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + `INDEXED_SCHEMA_STEPS`)
- Modify: `packages/gateway/src/index/local-index.ts:265` (`CURRENT_SCHEMA_VERSION`)

**Interfaces:**
- Produces: `PR_CHANGED_FILE_V55_SQL: string` — the DDL, imported by the runner.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/pr-changed-file-v55.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "./pr-changed-file-v55-sql.ts";

/** Minimal parent tables so the foreign keys have something to reference. */
function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL,
    type TEXT NOT NULL, external_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  db.exec(`INSERT INTO item VALUES ('github:o/r#1','github','pr','o/r#1')`);
  db.exec(`INSERT INTO graph_entity VALUES ('ent-1','source_file')`);
  return db;
}

describe("V55 pr changed-file schema", () => {
  test("stores a row and reads it back", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, local_file_id)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified','ent-1')`);
    const row = db.query("SELECT path, local_file_id FROM pr_changed_file").get() as {
      path: string;
      local_file_id: string | null;
    };
    expect(row.path).toBe("src/a.ts");
    expect(row.local_file_id).toBe("ent-1");
    db.close();
  });

  // The cascade is the whole pruning story. If foreign_keys were off, or the
  // REFERENCES clause were missing, this passes silently as a no-op delete —
  // so assert the ROWS ARE GONE, not merely that the delete ran.
  test("deleting the PR item cascades BOTH tables", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified')`);
    db.exec(`INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count)
             VALUES ('github:o/r#1', 1, 1, 1)`);
    db.exec("DELETE FROM item WHERE id = 'github:o/r#1'");
    const files = db.query("SELECT COUNT(*) AS c FROM pr_changed_file").get() as { c: number };
    const state = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(files.c).toBe(0);
    expect(state.c).toBe(0);
    db.close();
  });

  // `reapOrphansForRoot` really deletes degree-0 source_file entities, so this
  // path is live, not theoretical. SET NULL returns the row to the same state
  // it has for a repo that was never cloned.
  test("deleting the graph entity nulls local_file_id and KEEPS the row", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, local_file_id)
             VALUES ('github:o/r#1','o/r','src/a.ts','modified','ent-1')`);
    db.exec("DELETE FROM graph_entity WHERE id = 'ent-1'");
    const row = db.query("SELECT path, local_file_id FROM pr_changed_file").get() as {
      path: string;
      local_file_id: string | null;
    } | null;
    expect(row?.path).toBe("src/a.ts");
    expect(row?.local_file_id).toBeNull();
    db.close();
  });

  test("re-applying the DDL is idempotent", () => {
    const db = makeDb();
    db.exec(PR_CHANGED_FILE_V55_SQL);
    db.exec(PR_CHANGED_FILE_V55_SQL);
    const t = db
      .query(
        `SELECT COUNT(*) AS c FROM sqlite_master
          WHERE type='table' AND name IN ('pr_changed_file','pr_files_state')`,
      )
      .get() as { c: number };
    expect(t.c).toBe(2);
    db.close();
  });

  test("(item_id, path) is unique — a rename's two rows do not collide", () => {
    const db = makeDb();
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
             VALUES ('github:o/r#1','o/r','src/a.ts','renamed','tests/a.ts')`);
    db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
             VALUES ('github:o/r#1','o/r','tests/a.ts','renamed','src/a.ts')`);
    const c = db.query("SELECT COUNT(*) AS c FROM pr_changed_file").get() as { c: number };
    expect(c.c).toBe(2);
    expect(() =>
      db.exec(`INSERT INTO pr_changed_file (item_id, repo_full, path, status)
               VALUES ('github:o/r#1','o/r','src/a.ts','modified')`),
    ).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/index/pr-changed-file-v55.test.ts`
Expected: FAIL — cannot resolve `./pr-changed-file-v55-sql.ts`.

- [ ] **Step 3: Write the DDL**

Create `packages/gateway/src/index/pr-changed-file-v55-sql.ts`:

```ts
/**
 * V55 — PR changed-file paths plus their coverage record.
 *
 * Keyed on `item.id` (already `itemPrimaryKey(service, externalId)`) rather than on
 * `(service, pr_external_id)`: the pair is redundant, and the cascade gives pruning for free.
 * Same shape as `deployment-v28-sql.ts` and `embedding-v6-sql.ts`, and the cascade actually
 * fires — `index/local-index.ts` runs `PRAGMA foreign_keys = ON`.
 *
 * ONE ROW PER TOUCHED PATH. A rename writes two rows (old and new), a deletion writes one, so a
 * single index on `path` answers "did this PR touch X" with no special cases. `counterpart_path`
 * records a rename's other half for display; nothing correctness-bearing reads it.
 *
 * `pr_files_state` is the coverage record. Its cascade matters in the opposite direction from
 * storage hygiene: a coverage row outliving its PR would claim "we know this PR's files" after the
 * file rows were cascaded away — asserting verification the index no longer holds.
 */
export const PR_CHANGED_FILE_V55_SQL = `
CREATE TABLE IF NOT EXISTS pr_changed_file (
  item_id          TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  repo_full        TEXT NOT NULL,
  path             TEXT NOT NULL,
  status           TEXT NOT NULL,
  counterpart_path TEXT,
  local_file_id    TEXT REFERENCES graph_entity(id) ON DELETE SET NULL,
  PRIMARY KEY (item_id, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_pr_changed_file_path ON pr_changed_file(path);
CREATE INDEX IF NOT EXISTS idx_pr_changed_file_local ON pr_changed_file(local_file_id);

CREATE TABLE IF NOT EXISTS pr_files_state (
  item_id        TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  fetched_at_ms  INTEGER NOT NULL,
  api_file_count INTEGER NOT NULL,
  stored_count   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/gateway/src/index/pr-changed-file-v55.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import beside the other V5x imports (near line 24):

```ts
import { PR_CHANGED_FILE_V55_SQL } from "../pr-changed-file-v55-sql.ts";
```

and append to `INDEXED_SCHEMA_STEPS`, directly after the V54 line (currently line 550):

```ts
  simpleStep(54, 55, "PR changed-file paths + coverage", PR_CHANGED_FILE_V55_SQL),
```

- [ ] **Step 6: Bump the schema version**

In `packages/gateway/src/index/local-index.ts:265`, change `54` to `55`:

```ts
export const CURRENT_SCHEMA_VERSION = 55;
```

A step registered while the constant still reads `54` is a half-landed migration — the step exists and nothing believes the schema moved.

- [ ] **Step 7: Run the migration suite**

Run: `bun test packages/gateway/src/index`
Expected: PASS. If a test asserts the latest version number, update it to 55.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/
git commit -F - <<'EOF'
feat(index): V55 adds PR changed-file paths and their coverage record

Two tables keyed on item.id with ON DELETE CASCADE, matching
deployment-v28. One row per touched path, so a rename writes two rows
and a single path index answers every touch predicate.

local_file_id is ON DELETE SET NULL because reapOrphansForRoot really
deletes the degree-0 source_file entities it points at.
EOF
```

---

## Task 2: The store module

**Files:**
- Create: `packages/gateway/src/prfiles/pr-changed-file-store.ts`
- Create: `packages/gateway/src/prfiles/pr-changed-file-store.test.ts`

**Interfaces:**
- Consumes: `PR_CHANGED_FILE_V55_SQL` (Task 1).
- Produces:
  - `type ChangedFileRow = { readonly path: string; readonly status: ChangedFileStatus; readonly counterpartPath: string | null }`
  - `type ChangedFileStatus = "added" | "modified" | "removed" | "renamed"`
  - `recordPrChangedFiles(db, args: { itemId: string; repoFull: string; files: readonly ChangedFileRow[]; apiFileCount: number; truncated: boolean; nowMs: number }): void`
  - `selectPrsNotTouching(db, args: { pathGlob: string; limit: number }): NegationResult`
  - `type NegationResult = { readonly itemIds: readonly string[]; readonly excludedNoCoverage: number; readonly excludedTruncated: number }`
  - `collectPrFileCoverage(db): { readonly covered: number; readonly totalPrs: number; readonly truncated: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/prfiles/pr-changed-file-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import {
  collectPrFileCoverage,
  recordPrChangedFiles,
  selectPrsNotTouching,
} from "./pr-changed-file-store.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL,
    type TEXT NOT NULL, external_id TEXT NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  return db;
}

function addPr(db: Database, id: string): void {
  db.exec(`INSERT INTO item VALUES ('${id}','github','pr','${id}')`);
}

describe("pr-changed-file-store", () => {
  test("records files and a coverage row in one call", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1000,
    });
    const s = db.query("SELECT stored_count, truncated FROM pr_files_state").get() as {
      stored_count: number;
      truncated: number;
    };
    expect(s.stored_count).toBe(1);
    expect(s.truncated).toBe(0);
    db.close();
  });

  test("a re-fetch REPLACES the previous file set rather than merging", () => {
    const db = makeDb();
    addPr(db, "p1");
    const base = { itemId: "p1", repoFull: "o/r", apiFileCount: 1, truncated: false, nowMs: 1 };
    recordPrChangedFiles(db, {
      ...base,
      files: [{ path: "old.ts", status: "modified", counterpartPath: null }],
    });
    recordPrChangedFiles(db, {
      ...base,
      files: [{ path: "new.ts", status: "modified", counterpartPath: null }],
    });
    const paths = (
      db.query("SELECT path FROM pr_changed_file ORDER BY path").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["new.ts"]);
    db.close();
  });

  // FAIL-CLOSED. p2 has no coverage row at all. It must NOT be returned as
  // "does not touch tests/", because we never checked.
  test("a PR with no coverage row is EXCLUDED, not returned", () => {
    const db = makeDb();
    addPr(db, "p1");
    addPr(db, "p2");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    const r = selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 });
    expect(r.itemIds).toEqual(["p1"]);
    expect(r.excludedNoCoverage).toBe(1);
    db.close();
  });

  test("a TRUNCATED PR is excluded on the same footing as an unfetched one", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 4000,
      truncated: true,
      nowMs: 1,
    });
    const r = selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 });
    expect(r.itemIds).toEqual([]);
    expect(r.excludedTruncated).toBe(1);
    db.close();
  });

  test("a PR that DELETED a file still counts as touching it", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "tests/gone.ts", status: "removed", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual([]);
    db.close();
  });

  test("a rename out of tests/ still counts as touching tests/", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [
        { path: "src/a.ts", status: "renamed", counterpartPath: "tests/a.ts" },
        { path: "tests/a.ts", status: "renamed", counterpartPath: "src/a.ts" },
      ],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual([]);
    db.close();
  });

  // GLOB, not LIKE. Under LIKE both of these would match and the PR would be
  // wrongly excluded from a `tests/` question.
  test("matching is case-sensitive — Tests/ does not answer a tests/ question", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "Tests/a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrsNotTouching(db, { pathGlob: "tests/*", limit: 50 }).itemIds).toEqual(["p1"]);
    db.close();
  });

  test("an underscore in the pattern is literal, not a wildcard", () => {
    const db = makeDb();
    addPr(db, "p1");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "src/myXfile.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    // Under LIKE, `my_file.ts` would match `myXfile.ts` and wrongly exclude p1.
    expect(selectPrsNotTouching(db, { pathGlob: "src/my_file.ts", limit: 50 }).itemIds).toEqual([
      "p1",
    ]);
    db.close();
  });

  test("coverage counts covered, total and truncated", () => {
    const db = makeDb();
    addPr(db, "p1");
    addPr(db, "p2");
    addPr(db, "p3");
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [{ path: "a.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    recordPrChangedFiles(db, {
      itemId: "p2",
      repoFull: "o/r",
      files: [{ path: "b.ts", status: "modified", counterpartPath: null }],
      apiFileCount: 9000,
      truncated: true,
      nowMs: 1,
    });
    expect(collectPrFileCoverage(db)).toEqual({ covered: 2, totalPrs: 3, truncated: 1 });
    db.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/prfiles/pr-changed-file-store.test.ts`
Expected: FAIL — cannot resolve `./pr-changed-file-store.ts`.

- [ ] **Step 3: Write the store**

Create `packages/gateway/src/prfiles/pr-changed-file-store.ts`:

```ts
import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../db/write.ts";

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed";

export type ChangedFileRow = {
  readonly path: string;
  readonly status: ChangedFileStatus;
  /** A rename's other half, for display. No predicate reads this. */
  readonly counterpartPath: string | null;
};

export type NegationResult = {
  readonly itemIds: readonly string[];
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * Replace a PR's entire changed-file set and stamp its coverage row, in ONE transaction.
 *
 * The transaction boundary is correctness, not speed: the coverage row asserts "we know this PR's
 * files", so it must land with the rows it describes. A crash between them would leave a PR marked
 * covered with a partial list — a confident wrong answer, which is the exact failure the coverage
 * table exists to prevent.
 *
 * DELETE-then-insert rather than upsert: a re-fetch is a fresh truth. A file dropped from a PR
 * between fetches must disappear, and merging would leave it behind forever.
 */
export function recordPrChangedFiles(
  db: Database,
  args: {
    readonly itemId: string;
    readonly repoFull: string;
    readonly files: readonly ChangedFileRow[];
    readonly apiFileCount: number;
    readonly truncated: boolean;
    readonly nowMs: number;
  },
): void {
  // `db.transaction(fn)` RETURNS a function; the trailing `()` runs it. Omitting that call is a
  // silent no-op — nothing is written and nothing throws. House style is to invoke it inline
  // (`connectors/obsidian-sync.ts:243-256`).
  db.transaction(() => {
    dbRun(db, "DELETE FROM pr_changed_file WHERE item_id = ?", [args.itemId]);
    const stmt = db.prepare(
      `INSERT INTO pr_changed_file (item_id, repo_full, path, status, counterpart_path)
       VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      for (const f of args.files) {
        // NOTE the calling convention difference, verified against real call sites:
        // `dbStmtRun` takes its params SPREAD (`dbStmtRun(stmt, a, b, c)` — see
        // `embedding/pipeline.ts:157`), while `dbRun` below takes them as an ARRAY.
        // Passing an array here binds ONE argument, not five, and fails at runtime.
        dbStmtRun(stmt, args.itemId, args.repoFull, f.path, f.status, f.counterpartPath);
      }
    } finally {
      // An unfinalized prepare() makes close() a silent no-op on this database.
      stmt.finalize();
    }
    dbRun(
      db,
      `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count, truncated)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (item_id) DO UPDATE SET
         fetched_at_ms = excluded.fetched_at_ms,
         api_file_count = excluded.api_file_count,
         stored_count = excluded.stored_count,
         truncated = excluded.truncated`,
      [args.itemId, args.nowMs, args.apiFileCount, args.files.length, args.truncated ? 1 : 0],
    );
  })();
}

/**
 * The canonical fail-closed negation query. W6-B calls this rather than rebuilding it.
 *
 * The INNER JOIN to `pr_files_state` is the mechanism, not an optimisation: a PR with no coverage
 * row cannot appear in the result at all. A LEFT JOIN here — or reading `pr_changed_file` alone —
 * silently returns every unfetched PR as a confident "does not touch X".
 *
 * GLOB, never LIKE: LIKE is case-insensitive for ASCII and treats `_` as a wildcard, both verified
 * against this repo's bun:sqlite. Paths are case-sensitive on Linux and macOS, and `_` is common in
 * real filenames, so LIKE would answer a `tests/` question with `Tests/` data and turn any pattern
 * containing an underscore into a wildcard.
 */
export function selectPrsNotTouching(
  db: Database,
  args: { readonly pathGlob: string; readonly limit: number },
): NegationResult {
  const rows = db
    .query(
      `SELECT i.id AS id
         FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr'
          AND s.truncated = 0
          AND NOT EXISTS (
                SELECT 1 FROM pr_changed_file f
                 WHERE f.item_id = i.id AND f.path GLOB ?1
              )
        ORDER BY i.id
        LIMIT ?2`,
    )
    .all(args.pathGlob, args.limit) as Array<{ id: string }>;

  const noCov = db
    .query(
      `SELECT COUNT(*) AS c FROM item i
        LEFT JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.item_id IS NULL`,
    )
    .get() as { c: number } | null;

  const trunc = db
    .query(
      `SELECT COUNT(*) AS c FROM item i
         JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.type = 'pr' AND s.truncated = 1`,
    )
    .get() as { c: number } | null;

  return {
    itemIds: rows.map((r) => r.id),
    excludedNoCoverage: noCov?.c ?? 0,
    excludedTruncated: trunc?.c ?? 0,
  };
}

/** Coverage summary for `diag.snapshot`. `covered` includes truncated PRs — they were fetched. */
export function collectPrFileCoverage(db: Database): {
  readonly covered: number;
  readonly totalPrs: number;
  readonly truncated: number;
} {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM pr_files_state) AS covered,
         (SELECT COUNT(*) FROM item WHERE type = 'pr') AS total_prs,
         (SELECT COUNT(*) FROM pr_files_state WHERE truncated = 1) AS truncated`,
    )
    .get() as { covered: number; total_prs: number; truncated: number } | null;
  return {
    covered: row?.covered ?? 0,
    totalPrs: row?.total_prs ?? 0,
    truncated: row?.truncated ?? 0,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/gateway/src/prfiles/pr-changed-file-store.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Red-prove the fail-closed join**

This is the one guard the whole spec rests on, so prove it rejects rather than trusting green.

Temporarily change `JOIN pr_files_state s` to `LEFT JOIN pr_files_state s` in `selectPrsNotTouching`, then run:

`bun test packages/gateway/src/prfiles/pr-changed-file-store.test.ts`

Expected: the test "a PR with no coverage row is EXCLUDED, not returned" FAILS with `["p1","p2"]` received instead of `["p1"]`. **Restore the inner JOIN and re-run to green.** Record the observed failure output in your report — a guard nobody has seen reject anything is a guard nobody knows works.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/prfiles/
git commit -F - <<'EOF'
feat(prfiles): changed-file store with the fail-closed negation query

recordPrChangedFiles writes a PR's file set and its coverage row in one
transaction - the coverage row asserts we know this PR's files, so it
must not survive a crash that lost them.

selectPrsNotTouching inner-joins the coverage table, so an unfetched PR
cannot be returned as "does not touch X". Uses GLOB: LIKE is
case-insensitive and treats _ as a wildcard, both wrong for paths.
EOF
```

---

## Task 3: GitHub fetch path

**Files:**
- Create: `packages/gateway/test/fixtures/pr-files/github-pull-files.json`
- Create: `packages/gateway/src/prfiles/pr-file-mapping.ts`
- Create: `packages/gateway/src/prfiles/pr-file-mapping.test.ts`

**Interfaces:**
- Consumes: `ChangedFileRow`, `ChangedFileStatus` (Task 2).
- Produces: `mapGithubPrFiles(payload: unknown): ChangedFileRow[]`

- [ ] **Step 1: Record the fixture**

The spec states GitHub's response shape from prior knowledge. Replace knowledge with a recorded payload before writing the mapper.

Create `packages/gateway/test/fixtures/pr-files/github-pull-files.json` holding a representative `GET /repos/{owner}/{repo}/pulls/{n}/files` response. It MUST include one entry of each of: `added`, `modified`, `removed`, and `renamed` (the renamed entry carrying `previous_filename`), plus one entry whose `filename` contains an underscore.

```json
[
  { "filename": "src/added.ts", "status": "added" },
  { "filename": "src/my_file.ts", "status": "modified" },
  { "filename": "tests/gone.ts", "status": "removed" },
  { "filename": "src/moved.ts", "status": "renamed", "previous_filename": "tests/moved.ts" },
  { "filename": "src/copied.ts", "status": "copied" },
  { "filename": "src/changed.ts", "status": "changed" }
]
```

If the live API disagrees with this shape when you check it, **use the live shape and say so in your report** — the fixture is the contract, this block is a starting point.

- [ ] **Step 2: Write the failing test**

Create `packages/gateway/src/prfiles/pr-file-mapping.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapGithubPrFiles } from "./pr-file-mapping.ts";

// Fixtures are read and parsed, NOT imported with an import attribute. This repo uses zero
// `with { type: "json" }` imports; the established pattern is readFileSync + JSON.parse
// (`connectors/openapi-indexer-parsing.test.ts:8-12`). Do not "modernise" this.
const FIX = join(import.meta.dir, "../../test/fixtures/pr-files");
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIX, name), "utf8")) as unknown;

const fixture = loadFixture("github-pull-files.json");

describe("mapGithubPrFiles", () => {
  test("a rename produces TWO rows, one per touched path", () => {
    const rows = mapGithubPrFiles(fixture);
    const renamed = rows.filter((r) => r.status === "renamed").map((r) => r.path);
    expect(renamed.sort()).toEqual(["src/moved.ts", "tests/moved.ts"]);
  });

  test("both halves of a rename point at each other", () => {
    const rows = mapGithubPrFiles(fixture);
    const to = rows.find((r) => r.path === "src/moved.ts");
    const from = rows.find((r) => r.path === "tests/moved.ts");
    expect(to?.counterpartPath).toBe("tests/moved.ts");
    expect(from?.counterpartPath).toBe("src/moved.ts");
  });

  test("a deletion produces exactly one row", () => {
    const rows = mapGithubPrFiles(fixture);
    expect(rows.filter((r) => r.path === "tests/gone.ts")).toHaveLength(1);
  });

  test("copied and changed normalise to modified", () => {
    const rows = mapGithubPrFiles(fixture);
    expect(rows.find((r) => r.path === "src/copied.ts")?.status).toBe("modified");
    expect(rows.find((r) => r.path === "src/changed.ts")?.status).toBe("modified");
  });

  test("a non-array payload yields no rows rather than throwing", () => {
    expect(mapGithubPrFiles({ message: "Not Found" })).toEqual([]);
    expect(mapGithubPrFiles(null)).toEqual([]);
  });

  test("an entry missing filename is skipped, not defaulted", () => {
    expect(mapGithubPrFiles([{ status: "added" }, { filename: "ok.ts", status: "added" }])).toEqual(
      [{ path: "ok.ts", status: "added", counterpartPath: null }],
    );
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `bun test packages/gateway/src/prfiles/pr-file-mapping.test.ts`
Expected: FAIL — cannot resolve `./pr-file-mapping.ts`.

- [ ] **Step 4: Write the mapper**

Create `packages/gateway/src/prfiles/pr-file-mapping.ts`:

```ts
import { asRecord, stringField } from "../connectors/unknown-record.ts";

import type { ChangedFileRow, ChangedFileStatus } from "./pr-changed-file-store.ts";

/**
 * GitHub reports six statuses; we keep four. `copied` and `changed` are both content edits with no
 * distinct meaning for a touch predicate, so they normalise to `modified` rather than widening the
 * union with values nothing branches on.
 */
function normaliseGithubStatus(raw: string): ChangedFileStatus {
  switch (raw) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * Map a `pulls/{n}/files` payload to one row per TOUCHED path.
 *
 * A rename yields TWO rows. GitHub reports it as a single entry on the new `filename` with a
 * `previous_filename`, but a PR that renames `tests/a.ts` to `src/a.ts` HAS touched `tests/a.ts` —
 * so a "does not touch tests/" query must not match it. Emitting both paths makes that fall out of
 * a plain membership test instead of requiring every caller to remember a second column.
 *
 * Returns `[]` for any payload that is not an array: an error body (`{"message":"Not Found"}`) must
 * produce no rows rather than throwing into the sync tick.
 */
export function mapGithubPrFiles(payload: unknown): ChangedFileRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of payload) {
    const rec = asRecord(entry);
    if (rec === undefined) {
      continue;
    }
    const path = stringField(rec, "filename");
    if (path === undefined || path === "") {
      continue;
    }
    const status = normaliseGithubStatus(stringField(rec, "status") ?? "modified");
    const previous = stringField(rec, "previous_filename");
    if (status === "renamed" && previous !== undefined && previous !== "") {
      out.push({ path, status: "renamed", counterpartPath: previous });
      out.push({ path: previous, status: "renamed", counterpartPath: path });
      continue;
    }
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}
```

If `stringField` does not exist with this signature in `connectors/unknown-record.ts`, read that
file and use whatever it does export — do not invent a helper.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test packages/gateway/src/prfiles/pr-file-mapping.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/prfiles/ packages/gateway/test/fixtures/pr-files/
git commit -F - <<'EOF'
feat(prfiles): map GitHub pull-request files to touched paths

One row per touched path, from a recorded fixture rather than from the
API docs. A rename emits two rows: a PR that moved tests/a.ts to
src/a.ts has touched tests/a.ts, so a "does not touch tests/" query
must not match it.
EOF
```

---

## Task 4: GitLab and Bitbucket mappers

**Files:**
- Create: `packages/gateway/test/fixtures/pr-files/gitlab-mr-diffs.json`
- Create: `packages/gateway/test/fixtures/pr-files/bitbucket-pr-diffstat.json`
- Modify: `packages/gateway/src/prfiles/pr-file-mapping.ts`
- Modify: `packages/gateway/src/prfiles/pr-file-mapping.test.ts`

**Interfaces:**
- Produces: `mapGitlabMrFiles(payload: unknown): ChangedFileRow[]`, `mapBitbucketPrFiles(payload: unknown): ChangedFileRow[]`

- [ ] **Step 1: Record both fixtures**

GitLab MR diffs — each entry carries `old_path`, `new_path` and three booleans:

```json
[
  { "old_path": "src/a.ts", "new_path": "src/a.ts", "new_file": false, "renamed_file": false, "deleted_file": false },
  { "old_path": "src/b.ts", "new_path": "src/b.ts", "new_file": true,  "renamed_file": false, "deleted_file": false },
  { "old_path": "tests/c.ts", "new_path": "tests/c.ts", "new_file": false, "renamed_file": false, "deleted_file": true },
  { "old_path": "tests/d.ts", "new_path": "src/d.ts", "new_file": false, "renamed_file": true, "deleted_file": false }
]
```

Bitbucket diffstat — a paginated envelope whose `values` carry `old` / `new` objects:

```json
{
  "values": [
    { "status": "modified", "old": { "path": "src/a.ts" }, "new": { "path": "src/a.ts" } },
    { "status": "added",    "old": null,                    "new": { "path": "src/b.ts" } },
    { "status": "removed",  "old": { "path": "tests/c.ts" }, "new": null },
    { "status": "renamed",  "old": { "path": "tests/d.ts" }, "new": { "path": "src/d.ts" } }
  ],
  "next": null
}
```

As in Task 3: if the live API disagrees, use the live shape and say so in your report.

- [ ] **Step 2: Write the failing tests**

Append to `packages/gateway/src/prfiles/pr-file-mapping.test.ts`:

```ts
// Reuse the `loadFixture` helper already defined at the top of this file by Task 3 — do not add a
// second loader, and do not switch to an import attribute (this repo uses none).
import { mapBitbucketPrFiles, mapGitlabMrFiles } from "./pr-file-mapping.ts";

const gitlabFixture = loadFixture("gitlab-mr-diffs.json");
const bitbucketFixture = loadFixture("bitbucket-pr-diffstat.json");

describe("mapGitlabMrFiles", () => {
  test("a rename produces TWO rows", () => {
    const rows = mapGitlabMrFiles(gitlabFixture);
    expect(
      rows
        .filter((r) => r.status === "renamed")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["src/d.ts", "tests/d.ts"]);
  });

  test("the boolean flags map onto added / removed / modified", () => {
    const rows = mapGitlabMrFiles(gitlabFixture);
    expect(rows.find((r) => r.path === "src/b.ts")?.status).toBe("added");
    expect(rows.find((r) => r.path === "tests/c.ts")?.status).toBe("removed");
    expect(rows.find((r) => r.path === "src/a.ts")?.status).toBe("modified");
  });

  test("a non-array payload yields no rows", () => {
    expect(mapGitlabMrFiles({ error: "nope" })).toEqual([]);
  });
});

describe("mapBitbucketPrFiles", () => {
  test("reads the paginated values envelope", () => {
    expect(mapBitbucketPrFiles(bitbucketFixture).length).toBeGreaterThan(0);
  });

  test("a rename produces TWO rows", () => {
    const rows = mapBitbucketPrFiles(bitbucketFixture);
    expect(
      rows
        .filter((r) => r.status === "renamed")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["src/d.ts", "tests/d.ts"]);
  });

  test("a null old/new side is skipped rather than yielding an empty path", () => {
    const rows = mapBitbucketPrFiles(bitbucketFixture);
    expect(rows.some((r) => r.path === "")).toBe(false);
    expect(rows.find((r) => r.path === "src/b.ts")?.status).toBe("added");
    expect(rows.find((r) => r.path === "tests/c.ts")?.status).toBe("removed");
  });

  test("a payload with no values array yields no rows", () => {
    expect(mapBitbucketPrFiles({})).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and confirm they fail**

Run: `bun test packages/gateway/src/prfiles/pr-file-mapping.test.ts`
Expected: FAIL — `mapGitlabMrFiles` and `mapBitbucketPrFiles` are not exported.

- [ ] **Step 4: Write both mappers**

Append to `packages/gateway/src/prfiles/pr-file-mapping.ts`:

```ts
/** Emit one row per touched path, collapsing a rename's two paths into two rows. */
function pushPair(out: ChangedFileRow[], oldPath: string, newPath: string): void {
  out.push({ path: newPath, status: "renamed", counterpartPath: oldPath });
  out.push({ path: oldPath, status: "renamed", counterpartPath: newPath });
}

/**
 * GitLab reports a change as `old_path`/`new_path` plus three booleans rather than a status
 * string. A rename is the only case where the two paths differ meaningfully, and it emits two
 * rows for the same reason GitHub's does.
 */
export function mapGitlabMrFiles(payload: unknown): ChangedFileRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of payload) {
    const rec = asRecord(entry);
    if (rec === undefined) {
      continue;
    }
    const oldPath = stringField(rec, "old_path") ?? "";
    const newPath = stringField(rec, "new_path") ?? "";
    if (rec["renamed_file"] === true && oldPath !== "" && newPath !== "" && oldPath !== newPath) {
      pushPair(out, oldPath, newPath);
      continue;
    }
    const path = newPath !== "" ? newPath : oldPath;
    if (path === "") {
      continue;
    }
    const status: ChangedFileStatus =
      rec["new_file"] === true ? "added" : rec["deleted_file"] === true ? "removed" : "modified";
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}

function bitbucketSidePath(side: unknown): string {
  const rec = asRecord(side);
  return rec === undefined ? "" : (stringField(rec, "path") ?? "");
}

/**
 * Bitbucket wraps diffstat entries in a paginated `values` envelope and reports each side as an
 * object that is `null` for an add (no `old`) or a delete (no `new`). Reading `.path` off the null
 * side is how an empty-path row would get written, so each side is resolved independently and an
 * empty result is skipped.
 */
export function mapBitbucketPrFiles(payload: unknown): ChangedFileRow[] {
  const rec = asRecord(payload);
  const values = rec?.["values"];
  if (!Array.isArray(values)) {
    return [];
  }
  const out: ChangedFileRow[] = [];
  for (const entry of values) {
    const e = asRecord(entry);
    if (e === undefined) {
      continue;
    }
    const oldPath = bitbucketSidePath(e["old"]);
    const newPath = bitbucketSidePath(e["new"]);
    const raw = stringField(e, "status") ?? "modified";
    if (raw === "renamed" && oldPath !== "" && newPath !== "" && oldPath !== newPath) {
      pushPair(out, oldPath, newPath);
      continue;
    }
    const path = newPath !== "" ? newPath : oldPath;
    if (path === "") {
      continue;
    }
    const status: ChangedFileStatus =
      raw === "added" ? "added" : raw === "removed" ? "removed" : "modified";
    out.push({ path, status, counterpartPath: null });
  }
  return out;
}
```

- [ ] **Step 5: Run and confirm they pass**

Run: `bun test packages/gateway/src/prfiles/pr-file-mapping.test.ts`
Expected: PASS, **13 tests** — 6 from Task 3, plus 3 GitLab and 4 Bitbucket here. If your count
differs, you added or dropped a test; reconcile rather than adjusting the number.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/prfiles/ packages/gateway/test/fixtures/pr-files/
git commit -F - <<'EOF'
feat(prfiles): map GitLab and Bitbucket changed files

Same one-row-per-touched-path contract as GitHub, from recorded
fixtures. GitLab signals a change with three booleans rather than a
status string; Bitbucket nulls the old side on an add and the new side
on a delete, so each side is resolved independently.
EOF
```

---

## Task 5: Candidate selector and file cap (pure helpers)

**Files:**
- Create: `packages/gateway/src/prfiles/pr-file-fetch.ts`
- Create: `packages/gateway/src/prfiles/pr-file-fetch.test.ts`

**Interfaces:**
- Consumes: `recordPrChangedFiles`, `ChangedFileRow` (Task 2); the mappers (Tasks 3–4).
- Produces:
  - `MAX_PRS_PER_TICK = 10`, `MAX_FILES_PER_PR = 300`, `PR_FILES_PAGE_SIZE = 100`
  - `selectPrFileCandidates(db, service: string, limit: number): PrFileCandidate[]` where `PrFileCandidate = { readonly itemId: string; readonly repoFull: string; readonly externalId: string }`
  - `applyFileCap(files: readonly ChangedFileRow[]): { readonly kept: ChangedFileRow[]; readonly truncated: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/prfiles/pr-file-fetch.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import type { ChangedFileRow } from "./pr-changed-file-store.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";
import { applyFileCap, MAX_FILES_PER_PR, selectPrFileCandidates } from "./pr-file-fetch.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL, type TEXT NOT NULL,
    external_id TEXT NOT NULL, modified_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE graph_entity (id TEXT PRIMARY KEY, type TEXT NOT NULL)`);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  return db;
}

function addPr(db: Database, id: string, extId: string, modified: number): void {
  db.exec(
    `INSERT INTO item VALUES ('${id}','github','pr','${extId}', ${String(modified)})`,
  );
}

const row = (path: string): ChangedFileRow => ({ path, status: "modified", counterpartPath: null });

describe("selectPrFileCandidates", () => {
  test("returns PRs with no coverage row, newest first", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    addPr(db, "p2", "o/r#2", 300);
    addPr(db, "p3", "o/r#3", 200);
    const got = selectPrFileCandidates(db, "github", 10).map((c) => c.itemId);
    expect(got).toEqual(["p2", "p3", "p1"]);
    db.close();
  });

  test("a PR that already has coverage is not re-queued", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    recordPrChangedFiles(db, {
      itemId: "p1",
      repoFull: "o/r",
      files: [row("a.ts")],
      apiFileCount: 1,
      truncated: false,
      nowMs: 1,
    });
    expect(selectPrFileCandidates(db, "github", 10)).toEqual([]);
    db.close();
  });

  test("respects the limit", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    addPr(db, "p2", "o/r#2", 200);
    expect(selectPrFileCandidates(db, "github", 1)).toHaveLength(1);
    db.close();
  });

  test("does not return items of another service or another type", () => {
    const db = makeDb();
    db.exec(`INSERT INTO item VALUES ('g1','gitlab','pr','a/b!1', 100)`);
    db.exec(`INSERT INTO item VALUES ('i1','github','issue','o/r#9', 100)`);
    expect(selectPrFileCandidates(db, "github", 10)).toEqual([]);
    db.close();
  });

  test("derives repoFull from the external id", () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#42", 100);
    expect(selectPrFileCandidates(db, "github", 10)[0]?.repoFull).toBe("o/r");
    db.close();
  });
});

describe("applyFileCap", () => {
  test("under the cap keeps everything and is not truncated", () => {
    const r = applyFileCap([row("a.ts"), row("b.ts")]);
    expect(r.kept).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  test("exactly at the cap is NOT truncated", () => {
    const files = Array.from({ length: MAX_FILES_PER_PR }, (_, i) => row(`f${String(i)}.ts`));
    const r = applyFileCap(files);
    expect(r.kept).toHaveLength(MAX_FILES_PER_PR);
    expect(r.truncated).toBe(false);
  });

  test("over the cap truncates and flags it", () => {
    const files = Array.from({ length: MAX_FILES_PER_PR + 1 }, (_, i) => row(`f${String(i)}.ts`));
    const r = applyFileCap(files);
    expect(r.kept).toHaveLength(MAX_FILES_PER_PR);
    expect(r.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/prfiles/pr-file-fetch.test.ts`
Expected: FAIL — cannot resolve `./pr-file-fetch.ts`.

- [ ] **Step 3: Write the selector and the cap**

Create `packages/gateway/src/prfiles/pr-file-fetch.ts`:

```ts
import type { Database } from "bun:sqlite";

import type { ChangedFileRow } from "./pr-changed-file-store.ts";

/** Matches `MAX_ENRICH_PER_TICK` in `connectors/github-sync.ts`, which drains the same way. */
export const MAX_PRS_PER_TICK = 10;

/**
 * Largest page each forge allows, so the cap is reached in the fewest requests. GitHub's files
 * endpoint defaults to 30, so the default would cost 3.3x the calls for any PR over 30 files.
 */
export const PR_FILES_PAGE_SIZE = 100;

/**
 * At `PR_FILES_PAGE_SIZE = 100` this is three requests for the largest PR we will store. A PR
 * beyond it is stored AND flagged `truncated`, which excludes it from negation entirely — holding
 * 300 of 4000 paths cannot verify "does not touch X".
 */
export const MAX_FILES_PER_PR = 300;

export type PrFileCandidate = {
  readonly itemId: string;
  readonly repoFull: string;
  readonly externalId: string;
};

/**
 * PRs of this service with no coverage row yet, newest first.
 *
 * `modified_at DESC` is what makes one selector serve both forward coverage and the bounded
 * backfill: recent PRs are covered first and the backlog shrinks every tick, so there is no
 * separate backfill mode to build or explain. `NOT EXISTS` rather than `NOT IN` — `NOT IN` with a
 * NULL anywhere in the subquery silently matches nothing.
 */
export function selectPrFileCandidates(
  db: Database,
  service: string,
  limit: number,
): PrFileCandidate[] {
  const rows = db
    .query(
      `SELECT i.id AS id, i.external_id AS external_id
         FROM item i
        WHERE i.type = 'pr'
          AND i.service = ?1
          AND NOT EXISTS (SELECT 1 FROM pr_files_state s WHERE s.item_id = i.id)
        ORDER BY i.modified_at DESC
        LIMIT ?2`,
    )
    .all(service, limit) as Array<{ id: string; external_id: string }>;
  const out: PrFileCandidate[] = [];
  for (const r of rows) {
    // Every forge keys a PR as `<repoFull><sep><num>`: `#` on GitHub and Bitbucket, `!` for
    // GitLab MRs. Split on the LAST separator — a repo path may itself contain neither, but
    // splitting on the first would break a group path like `grp/sub/proj!7`.
    const cut = Math.max(r.external_id.lastIndexOf("#"), r.external_id.lastIndexOf("!"));
    if (cut <= 0) {
      continue;
    }
    out.push({
      itemId: r.id,
      repoFull: r.external_id.slice(0, cut),
      externalId: r.external_id,
    });
  }
  return out;
}

/**
 * Apply `MAX_FILES_PER_PR`. Exactly-at-cap is NOT truncated: we hold every path, so a negation
 * over it is fully verified. Only a set we could not store completely is unverifiable.
 */
export function applyFileCap(files: readonly ChangedFileRow[]): {
  readonly kept: ChangedFileRow[];
  readonly truncated: boolean;
} {
  if (files.length <= MAX_FILES_PER_PR) {
    return { kept: [...files], truncated: false };
  }
  return { kept: files.slice(0, MAX_FILES_PER_PR), truncated: true };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/gateway/src/prfiles/pr-file-fetch.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole module and preflight**

Run: `bun test packages/gateway/src/prfiles packages/gateway/src/index`
Then: `bun run preflight:fast`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/prfiles/
git commit -F - <<'EOF'
feat(prfiles): bounded per-tick candidate selector and file cap

One modified_at DESC selector serves forward coverage and the bounded
backfill together, so there is no separate backfill mode. Splitting the
external id on the LAST separator keeps GitLab group paths intact.

Exactly-at-cap is not truncated: we hold every path, so a negation over
it is fully verified. Only an incomplete set is unverifiable.
EOF
```

---

## Task 6: The shared fetch driver, and GitHub wiring

**Files:**
- Modify: `packages/gateway/src/prfiles/pr-file-fetch.ts`
- Modify: `packages/gateway/src/prfiles/pr-file-fetch.test.ts`
- Modify: `packages/gateway/src/connectors/github-sync.ts`
- Modify: `packages/gateway/src/connectors/github-sync.test.ts`

**Interfaces:**
- Consumes: `selectPrFileCandidates`, `applyFileCap`, `MAX_PRS_PER_TICK`, `PR_FILES_PAGE_SIZE`, `MAX_FILES_PER_PR` (Task 5); `recordPrChangedFiles` (Task 2); `mapGithubPrFiles` (Task 3).
- Produces:
  - `MAX_PAGES_PER_PR = 3`
  - `type FetchPage = (candidate: PrFileCandidate, page: number) => Promise<{ readonly rows: readonly ChangedFileRow[]; readonly hasMore: boolean } | null>`
  - `runPrFilePass(ctx: SyncContext, args: { service: string; fetchPage: FetchPage; nowMs: number }): Promise<number>`

**Why a driver plus a per-forge closure:** the loop holds every behaviour that matters —
per-candidate isolation, page accumulation, the cap, the coverage write — and none of it is
forge-specific. Splitting it this way lets the loop be tested exhaustively with a fake `fetchPage`
and **no HTTP mocking at all**, while each forge task reduces to one function that builds a URL and
maps a payload.

- [ ] **Step 1: Write the failing driver test**

Append to `packages/gateway/src/prfiles/pr-file-fetch.test.ts`:

```ts
import type { SyncContext } from "../sync/types.ts";
import { MAX_PAGES_PER_PR, runPrFilePass } from "./pr-file-fetch.ts";

/** Only the two fields the driver touches; cast keeps the fake honest about that. */
function fakeCtx(db: Database, acquired: string[]): SyncContext {
  return {
    db,
    logger: { warn: () => undefined, info: () => undefined } as unknown as SyncContext["logger"],
    rateLimiter: {
      acquire: async (s: string) => {
        acquired.push(s);
      },
    } as unknown as SyncContext["rateLimiter"],
  } as unknown as SyncContext;
}

describe("runPrFilePass", () => {
  test("writes files and a coverage row for each candidate", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => ({ rows: [row("src/a.ts")], hasMore: false }),
    });
    expect(n).toBe(1);
    const s = db.query("SELECT stored_count FROM pr_files_state").get() as { stored_count: number };
    expect(s.stored_count).toBe(1);
    db.close();
  });

  // Per-candidate isolation. p1 throwing must not cost p2 its coverage row, and
  // must not roll back anything already written this tick.
  test("one candidate failing does not stop or roll back the others", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 200);
    addPr(db, "p2", "o/r#2", 100);
    const n = await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (c) => {
        if (c.itemId === "p1") throw new Error("boom");
        return { rows: [row("src/b.ts")], hasMore: false };
      },
    });
    expect(n).toBe(1);
    const ids = (
      db.query("SELECT item_id FROM pr_files_state").all() as Array<{ item_id: string }>
    ).map((r) => r.item_id);
    expect(ids).toEqual(["p2"]);
    db.close();
  });

  // A failed candidate must NOT get a coverage row: an empty row would assert
  // "we checked this PR and it touched nothing" - a confident wrong negative.
  test("a failed candidate is left uncovered, not recorded as empty", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => {
        throw new Error("boom");
      },
    });
    const c = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(c.c).toBe(0);
    db.close();
  });

  test("a null page result leaves the PR uncovered too", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async () => null,
    });
    const c = db.query("SELECT COUNT(*) AS c FROM pr_files_state").get() as { c: number };
    expect(c.c).toBe(0);
    db.close();
  });

  test("accumulates rows across pages until hasMore is false", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (_c, page) => ({
        rows: [row(`p${String(page)}.ts`)],
        hasMore: page < 2,
      }),
    });
    const paths = (
      db.query("SELECT path FROM pr_changed_file ORDER BY path").all() as Array<{ path: string }>
    ).map((r) => r.path);
    expect(paths).toEqual(["p1.ts", "p2.ts"]);
    db.close();
  });

  test("stops at MAX_PAGES_PER_PR and marks the PR truncated", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    await runPrFilePass(fakeCtx(db, []), {
      service: "github",
      nowMs: 5,
      fetchPage: async (_c, page) => ({ rows: [row(`p${String(page)}.ts`)], hasMore: true }),
    });
    const s = db.query("SELECT stored_count, truncated FROM pr_files_state").get() as {
      stored_count: number;
      truncated: number;
    };
    expect(s.stored_count).toBe(MAX_PAGES_PER_PR);
    expect(s.truncated).toBe(1);
    db.close();
  });

  test("acquires the rate limiter once per request", async () => {
    const db = makeDb();
    addPr(db, "p1", "o/r#1", 100);
    const acquired: string[] = [];
    await runPrFilePass(fakeCtx(db, acquired), {
      service: "github",
      nowMs: 5,
      fetchPage: async (_c, page) => ({ rows: [row("a.ts")], hasMore: page < 2 }),
    });
    expect(acquired).toEqual(["github", "github"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/prfiles/pr-file-fetch.test.ts`
Expected: FAIL — `runPrFilePass` and `MAX_PAGES_PER_PR` are not exported.

- [ ] **Step 3: Write the driver**

Append to `packages/gateway/src/prfiles/pr-file-fetch.ts`:

```ts
import type { SyncContext } from "../sync/types.ts";
import { recordPrChangedFiles } from "./pr-changed-file-store.ts";

/** `MAX_FILES_PER_PR / PR_FILES_PAGE_SIZE` — three requests reach the largest set we store. */
export const MAX_PAGES_PER_PR = 3;

/**
 * Fetch ONE page for a candidate. Returns `null` when the page could not be read at all — the
 * driver treats that as a failure for this PR, not as "no files".
 */
export type FetchPage = (
  candidate: PrFileCandidate,
  page: number,
) => Promise<{ readonly rows: readonly ChangedFileRow[]; readonly hasMore: boolean } | null>;

/**
 * Drain up to `MAX_PRS_PER_TICK` candidates for one service. Returns how many were recorded.
 *
 * Each candidate is fetched and written INDEPENDENTLY, and this loop deliberately holds no
 * transaction of its own: `recordPrChangedFiles` scopes one per PR, so a candidate that throws
 * mid-tick cannot roll back the PRs already written. A rate-limit error still propagates, because
 * continuing to hammer a limited API is worse than ending the tick early.
 *
 * A failed candidate is left with NO coverage row rather than an empty one. An empty coverage row
 * would assert "we checked this PR and it touched nothing" — a confident wrong negative, which is
 * exactly what the coverage table exists to prevent. Leaving it uncovered means the selector
 * re-queues it next tick.
 *
 * Pages are mapped and concatenated as they arrive rather than being buffered as raw JSON, so a
 * large PR never holds more than one page of payload in memory.
 */
export async function runPrFilePass(
  ctx: SyncContext,
  args: {
    readonly service: string;
    readonly fetchPage: FetchPage;
    readonly nowMs: number;
  },
): Promise<number> {
  const candidates = selectPrFileCandidates(ctx.db, args.service, MAX_PRS_PER_TICK);
  let recorded = 0;
  for (const c of candidates) {
    const collected: ChangedFileRow[] = [];
    let pagesExhausted = false;
    let failed = false;
    try {
      for (let page = 1; page <= MAX_PAGES_PER_PR; page++) {
        await ctx.rateLimiter.acquire(args.service);
        const res = await args.fetchPage(c, page);
        if (res === null) {
          failed = true;
          break;
        }
        collected.push(...res.rows);
        if (!res.hasMore) {
          pagesExhausted = true;
          break;
        }
      }
    } catch (err) {
      // A rate-limit error ends the whole tick; anything else costs only this PR.
      // `RateLimitError` is the class the connectors already throw — import it from
      // wherever `connectors/github-sync.ts` imports it. Do NOT add an `isRateLimitError`
      // helper; the instanceof check is the established shape here.
      if (err instanceof RateLimitError) {
        throw err;
      }
      ctx.logger.warn(
        { service: args.service, itemId: c.itemId, err: String(err) },
        "PR changed-file fetch failed for one PR (non-fatal, will retry next tick)",
      );
      failed = true;
    }
    if (failed) {
      continue;
    }
    const { kept, truncated } = applyFileCap(collected);
    recordPrChangedFiles(ctx.db, {
      itemId: c.itemId,
      repoFull: c.repoFull,
      files: kept,
      apiFileCount: collected.length,
      // Truncated when the cap trimmed rows OR when we ran out of page budget with
      // more pages still on offer — both mean we do not hold the full path set.
      truncated: truncated || !pagesExhausted,
      nowMs: args.nowMs,
    });
    recorded += 1;
  }
  return recorded;
}
```

**Import placement:** the three `import` lines above belong at the TOP of `pr-file-fetch.ts`
alongside Task 5's existing imports, not in the middle of the file where this block is appended.
`RateLimitError`'s import path is whatever `packages/gateway/src/connectors/github-sync.ts` uses —
read it rather than guessing.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test packages/gateway/src/prfiles/pr-file-fetch.test.ts`
Expected: PASS, 15 tests (8 from Task 5 + 7 here).

- [ ] **Step 5: Wire GitHub in**

In `packages/gateway/src/connectors/github-sync.ts`, add the URL builder beside `pullDetailUrl`:

```ts
export function pullFilesUrl(repoFull: string, num: number, page: number): string {
  return `https://api.github.com/repos/${repoFull}/pulls/${String(num)}/files?per_page=${String(
    PR_FILES_PAGE_SIZE,
  )}&page=${String(page)}`;
}
```

and a best-effort pass mirroring `runPrDetailEnrichmentBestEffort` exactly — same try/catch, same
rethrow of `RateLimitError`, same warn:

```ts
async function runPrFilePassBestEffort(ctx: SyncContext, pat: string, now: number): Promise<void> {
  try {
    await runPrFilePass(ctx, {
      service: SERVICE_ID,
      nowMs: now,
      fetchPage: async (c, page) => {
        const num = Number(c.externalId.slice(c.externalId.lastIndexOf("#") + 1));
        if (!Number.isFinite(num)) return null;
        const res = await fetch(pullFilesUrl(c.repoFull, num, page), {
          headers: buildGithubEventHeaders(pat, null),
        });
        if (res.status === 401) throw new UnauthenticatedError("GitHub pull files: 401");
        throwGithubRateLimitErrorIfApplicable(ctx, res, "pull files");
        if (!res.ok) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await res.text()) as unknown;
        } catch {
          return null;
        }
        const rows = mapGithubPrFiles(parsed);
        // A full page means there may be another; a short page is the last one.
        return { rows, hasMore: Array.isArray(parsed) && parsed.length === PR_FILES_PAGE_SIZE };
      },
    });
  } catch (err) {
    if (err instanceof RateLimitError) throw err; // honor backoff
    ctx.logger.warn(
      { service: SERVICE_ID, err: String(err) },
      "PR changed-file pass failed (non-fatal)",
    );
  }
}
```

Call it immediately after **both** existing `runPrDetailEnrichmentBestEffort` call sites
(currently lines 801 and 843). Both matter: line 843 is the 304 path, and `enrichPrDetail`'s own
docstring records that before it ran on the unchanged path too, the backlog drained at roughly
zero on a low-activity account. Wiring only the changed path would reproduce that bug.

- [ ] **Step 6: Add a GitHub wiring test**

Add to `packages/gateway/src/connectors/github-sync.test.ts`, matching its existing fetch-stub
style:

```ts
test("pullFilesUrl requests the largest page and a page number", () => {
  const u = pullFilesUrl("o/r", 7, 2);
  expect(u).toContain("/repos/o/r/pulls/7/files");
  expect(u).toContain("per_page=100");
  expect(u).toContain("page=2");
});
```

- [ ] **Step 7: Run both suites and preflight**

Run: `bun test packages/gateway/src/prfiles packages/gateway/src/connectors/github-sync.test.ts`
Then: `bun run preflight:fast`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/prfiles/ packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
git commit -F - <<'EOF'
feat(prfiles): fetch driver and GitHub wiring

The driver holds every behaviour that is not forge-specific, so each
forge reduces to one fetchPage closure and the loop is tested with no
HTTP mocking.

Per-candidate isolation is the point: the loop holds no transaction of
its own, so one PR failing cannot roll back the PRs already written. A
failed PR gets NO coverage row - an empty one would assert we checked
it and found nothing, a confident wrong negative.

Wired into both enrichment call sites, including the 304 path: the
existing enrichment records that skipping it drained the backlog at
roughly zero on a quiet account.
EOF
```

---

## Task 7: GitLab and Bitbucket wiring

**Files:**
- Modify: `packages/gateway/src/connectors/gitlab-sync.ts`
- Modify: `packages/gateway/src/connectors/bitbucket-sync.ts`
- Modify: their respective `.test.ts` files

**Interfaces:**
- Consumes: `runPrFilePass`, `PR_FILES_PAGE_SIZE` (Task 6); `mapGitlabMrFiles`, `mapBitbucketPrFiles` (Task 4).

- [ ] **Step 1: Read both sync entry points first**

Read `createGitlabSyncable`'s `sync` (`gitlab-sync.ts:189`) and `createBitbucketSyncable`'s
(`bitbucket-sync.ts:361`). Note how each obtains its credential and how each already builds an
authenticated request — reuse those, do not add a second auth path.

- [ ] **Step 2: Wire GitLab**

Add a `runPrFilePass` call at the end of GitLab's `sync`, wrapped in the same best-effort
try/catch shape as Task 6's, with:

- URL: the MR diffs endpoint for `c.repoFull` and the iid parsed from `c.externalId` after its
  LAST `!`, with the forge's page-size parameter set to `PR_FILES_PAGE_SIZE`.
- Mapping: `mapGitlabMrFiles(parsed)`.
- `hasMore`: `Array.isArray(parsed) && parsed.length === PR_FILES_PAGE_SIZE`.
- `service: "gitlab"` — must match the `item.service` value GitLab rows carry, or the selector
  returns nothing and the pass is silently inert. Verify against a real row before trusting it.

- [ ] **Step 3: Wire Bitbucket**

Same shape, with:

- URL: the PR `diffstat` endpoint, with Bitbucket's own page-size parameter.
- Mapping: `mapBitbucketPrFiles(parsed)` — **called once per page**, and the driver concatenates
  the returned rows. Do not accumulate raw envelopes and map once at the end; per-page mapping
  keeps at most one page of payload in memory and is what the driver's contract expects.
- `hasMore`: Bitbucket paginates with a `next` URL in the envelope, so
  `typeof asRecord(parsed)?.["next"] === "string"` is the signal — not a length comparison.
- `service: "bitbucket"` — same verification as GitLab.

- [ ] **Step 4: Add one wiring test per forge**

For each, assert the URL builder produces the documented path and carries the page-size parameter,
mirroring Task 6 Step 6. Do not re-test the mappers or the driver — they are covered.

- [ ] **Step 5: Run the suites and preflight**

Run: `bun test packages/gateway/src/connectors packages/gateway/src/prfiles`
Then: `bun run preflight:fast`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/
git commit -F - <<'EOF'
feat(prfiles): wire the changed-file pass into GitLab and Bitbucket

Each forge supplies only a fetchPage closure; the driver owns the loop.
Bitbucket signals another page with a next URL rather than a full-page
length, so its hasMore reads that field instead of comparing counts.
EOF
```

---

## Task 8: Coverage on `diag.snapshot`

**Files:**
- Modify: `packages/gateway/src/db/metrics.ts` (the `IndexMetrics` type and `collectIndexMetrics`)
- Modify: `packages/gateway/src/db/metrics.test.ts` (or create it if absent)
- Modify: `packages/cli/src/commands/status.ts`
- Modify: `packages/cli/src/commands/status.test.ts`

**Interfaces:**
- Consumes: `collectPrFileCoverage` (Task 2).
- Produces: `IndexMetrics.prFileCoverage: { covered: number; totalPrs: number; truncated: number }`

- [ ] **Step 1: Write the failing gateway test**

Add to `packages/gateway/src/db/metrics.test.ts`:

```ts
test("index metrics report PR changed-file coverage", () => {
  const db = makeMetricsDb(); // the file's existing helper
  db.exec(PR_CHANGED_FILE_V55_SQL);
  db.exec(`INSERT INTO item (id, service, type, external_id, modified_at, title, synced_at)
           VALUES ('p1','github','pr','o/r#1',1,'PR #1',1)`);
  db.exec(`INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count)
           VALUES ('p1',1,2,2)`);
  const m = collectIndexMetrics(db);
  expect(m.prFileCoverage).toEqual({ covered: 1, totalPrs: 1, truncated: 0 });
  db.close();
});
```

Read the existing test file first and match its database-construction helper rather than inventing
one; the `item` insert above must list whatever columns that schema actually requires.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/db/metrics.test.ts`
Expected: FAIL — `prFileCoverage` is not a property of `IndexMetrics`.

- [ ] **Step 3: Extend the metrics type and collector**

In `packages/gateway/src/db/metrics.ts`, add to the `IndexMetrics` type:

```ts
  /** PR changed-file indexing progress. `covered` includes truncated PRs — they were fetched. */
  prFileCoverage: { covered: number; totalPrs: number; truncated: number };
```

and inside `collectIndexMetrics`, before the return, add:

```ts
  const prFileCoverage = collectPrFileCoverage(db);
```

then include `prFileCoverage` in the returned object. Import it at the top:

```ts
import { collectPrFileCoverage } from "../prfiles/pr-changed-file-store.ts";
```

- [ ] **Step 4: Run the gateway test and confirm it passes**

Run: `bun test packages/gateway/src/db/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI test**

Add to `packages/cli/src/commands/status.test.ts`, matching the file's existing snapshot-stub style:

```ts
test("prints PR file coverage when present", async () => {
  const lines = await runStatusWithSnapshot({
    index: { totalItems: 5, prFileCoverage: { covered: 412, totalPrs: 1203, truncated: 18 } },
  });
  expect(lines.join("\n")).toContain("PR file coverage: 412 / 1203 (18 truncated)");
});

test("omits the line entirely when there are no PRs", async () => {
  const lines = await runStatusWithSnapshot({
    index: { totalItems: 5, prFileCoverage: { covered: 0, totalPrs: 0, truncated: 0 } },
  });
  expect(lines.join("\n")).not.toContain("PR file coverage");
});
```

Read the existing test file and reuse its actual helper name and shape — `runStatusWithSnapshot`
is illustrative. Do not add a new harness if one exists.

- [ ] **Step 6: Print the line**

In `packages/cli/src/commands/status.ts`, extend `IndexMetricsBrief` with
`prFileCoverage?: unknown` and add a printer beside `printEmbeddingBackfill`, which is the
established precedent for a progress line:

```ts
function printPrFileCoverage(raw: unknown): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const c = raw as { covered?: unknown; totalPrs?: unknown; truncated?: unknown };
  if (typeof c.covered !== "number" || typeof c.totalPrs !== "number") {
    return;
  }
  // No PRs indexed at all: the line would read "0 / 0" and imply a problem where there is none.
  if (c.totalPrs === 0) {
    return;
  }
  const trunc = typeof c.truncated === "number" ? c.truncated : 0;
  const suffix = trunc > 0 ? ` (${String(trunc)} truncated)` : "";
  console.log(`PR file coverage: ${String(c.covered)} / ${String(c.totalPrs)}${suffix}`);
}
```

and call it from the same place `printVerboseIndexMetrics` reads `snap.index`.

- [ ] **Step 7: Run both suites**

Run: `bun test packages/cli/src/commands/status.test.ts packages/gateway/src/db/metrics.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/db/ packages/cli/src/commands/
git commit -F - <<'EOF'
feat(status): report PR changed-file coverage

Extends the existing diag.snapshot index payload rather than adding an
IPC method, so ALLOWED_METHODS stays at 105. Sits beside the embedding
backfill line, the established precedent for progress reporting.

The line is omitted entirely when no PRs are indexed - "0 / 0" would
imply a problem where there is none.
EOF
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/architecture.md` (the "Latest applied migration" bullet)
- Modify: `docs/schema-reference.md` (V55 entry + the canonical migration blockquote)
- Modify: `.claude/commands/nimbus-db-migrations.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (the `schema V54` → `V55` mention on the Status line)

- [ ] **Step 1: Verify each drift site before editing**

Run: `grep -rn "V54" CLAUDE.md GEMINI.md docs/architecture.md docs/schema-reference.md .claude/commands/nimbus-db-migrations.md`

Edit only lines that claim V54 is the LATEST schema. Lines describing what V54 *did* are history and
stay. `CLAUDE.md` and `GEMINI.md` are byte-identical mirrors on that line — update both.

- [ ] **Step 2: Write the CHANGELOG entry**

Add a dated entry stating: what shipped (V55, two tables, three forge mappers, the bounded tick,
the coverage line), the honesty boundary (**no predicate language — that is W6-B**), and the two
exclusions a reader must know about (no coverage row, and `truncated`). Say plainly that coverage
grows over ticks rather than being complete on first sync.

- [ ] **Step 3: Add the V55 schema-reference entry**

Follow the V51–V54 entries' form. `graph_entity` gains no column; two new tables. State the
`item.id` keying and both cascades.

- [ ] **Step 4: Run the doc gates**

Run: `bun run audit:status-drift && bun run audit:links && bun run audit:doc-refs`
Expected: all pass.

- [ ] **Step 5: Full preflight**

Run: `bun run preflight:fast`
Then: `bun run typecheck:tests` — **quote the violation count** ("N known errors baselined, 0 new"),
not the exit code; it exits 0 on win32 regardless.
Expected: preflight PASSED, 0 new typecheck-tests violations.

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md .claude/commands/
git commit -F - <<'EOF'
docs: record V55 PR changed-file indexing

States the scope boundary plainly: this ships the data and the
fail-closed primitive, not a predicate language. Records both exclusion
rules - no coverage row, and truncated - since a reader who knows only
the first would misread a truncated PR as covered.
EOF
```

---

## Self-Review

**Spec coverage.** § 4.1 → Task 1. § 4.2 → Task 1. § 4.3 `local_file_id` column and its
`SET NULL` → Task 1 (schema); its *population* is deferred, see below. § 4.4 canonical negation →
Task 2. § 5 fetch path → **Task 6 (the driver and GitHub) and Task 7 (GitLab, Bitbucket)**;
Tasks 3–5 supply the pure pieces it calls. § 5.1 caps and page size → Task 5 (values) and Task 6
(page budget). § 5.3 batched writes in one transaction → Task 2. § 6 egress (no change) → nothing
to build. § 7 observability → Task 8. § 9 testing → each task's tests, with the fail-closed
red-prove pinned in Task 2 Step 5. § 10.1 fixture verification → Tasks 3–4 Step 1.

**Corrected after review — the first draft of this line was false and hid a whole missing task.**
It claimed "§ 5 fetch path → Tasks 3–5". Tasks 3 and 4 are pure mappers and Task 5 is a pure
selector plus a cap: **not one of them performs I/O or calls `recordPrChangedFiles`.** The plan as
first written would have produced a schema, a store, mappers and a selector that nothing ever
invoked — every task green, every test passing, and the feature completely inert. Tasks 6 and 7
now carry the fetch loop and the per-forge wiring. The lesson is that a coverage line naming tasks
by *topic* proves nothing; it has to name the task that makes the code RUN.

**One deliberate deferral, recorded rather than silently dropped.** The spec's § 4.3 says the
ownership pass populates `local_file_id`. This plan creates the column, its foreign key and its
`SET NULL` behaviour, but does NOT wire the ownership pass to fill it. Nothing in B reads the
column — negation uses `path` alone — so populating it would add a writer to `ownership-pass.ts`
serving no consumer in this sub-project, which is the YAGNI the spec's own D2-style reasoning
argues against. It becomes a task when a consumer exists. **Task 9's CHANGELOG must say the column
ships unpopulated**, so nobody reads a `NULL` as "no local file".

**Placeholder scan.** No "TBD"/"appropriate"/"as needed". Five steps say "read the existing file
first and match what it exports" (Task 3 Step 4, Task 6 Step 3, Task 7 Step 1, Task 8 Steps 1
and 5) — each names a specific file and a specific reason, and they exist because inventing a
helper that already exists is the likelier failure than not finding one. Task 7's steps describe
each wiring by its inputs, mapper, `hasMore` signal and service id rather than repeating Task 6's
closure verbatim; that is deliberate, since the shape is established one task earlier and copying
it would invite editing the wrong copy.

**Type consistency.** `ChangedFileRow` / `ChangedFileStatus` are defined in Task 2 and consumed
unchanged in Tasks 3, 4, 5. `recordPrChangedFiles` takes `counterpartPath` (camelCase) mapping to
`counterpart_path` (snake_case) in SQL — consistent across every usage. `MAX_FILES_PER_PR` is
defined once in Task 5 and imported by its test. `collectPrFileCoverage` returns
`{ covered, totalPrs, truncated }` in Task 2 and is consumed with exactly those names in Task 8.
`PrFileCandidate` is defined in Task 5 and is the parameter type of `FetchPage` in Task 6.
`runPrFilePass` is defined in Task 6 and called by Task 7's two wirings with the same argument
object shape.

**A note on the two "truncated" sources.** Task 5's `applyFileCap` reports truncation from the row
count; Task 6's driver ALSO sets `truncated` when it exhausts `MAX_PAGES_PER_PR` with more pages
still on offer. Both mean the same thing — we do not hold the full path set — and the driver ORs
them. A reviewer seeing only one of the two could reasonably think the other case was missed; it is
not.
