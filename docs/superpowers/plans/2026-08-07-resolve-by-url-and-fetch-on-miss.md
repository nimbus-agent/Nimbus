# Resolve-by-URL + fetch-on-miss — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gateway a resolve-by-URL read (`GET /v1/items/resolve`) backed by a derived,
indexed `resolve_key`, and a targeted fetch-on-miss write (`POST /v1/items/fetch`) bounded by a
host boundary derived from configured connector credentials.

**Architecture:** A new `resolve_key TEXT` column on `item` carries
`canonicalizeUrl(canonical_url ?? url)`, written at the single SQL chokepoint `upsertIndexedItem`
and backfilled row-wise inside migration **V52**. A pure matching-ladder module turns an incoming
URL into an exact / query-stripped / path-trimmed match. Fetch-on-miss adds an optional
`fetchOne` to `Syncable`, implemented on five connectors, gated by a host→service map derived from
Vault-stored base URLs, and appended to the egress ledger under the `sync` class.

**Tech Stack:** Bun 1.2+ / TypeScript strict, `bun:sqlite`, Biome, `bun test`.

---

## Decisions taken in this plan (read before starting)

Four are **verified corrections to the design doc**, which is authoritative on intent but wrong on
these facts. Each was checked against source, not reasoned about. The design doc is corrected in
Task 12 as part of the triple rule.

1. **The migration is V52, not V50.** `runner.ts` ends at `simpleStep(50, 51, …)`; V50 is a retired
   permanent no-op (`SCHEMA_V50_RESERVED_SQL`) and V51 is the ownership graph (#1064). A DB at V51
   never re-enters the 49→50 step.

2. **`resolve_key` is written in `upsertIndexedItem`, NOT `upsertIndexedItemForSync`.**
   `upsertIndexedItemForSync` is a depth-applying wrapper; the SQL lives in `upsertIndexedItem`,
   and **three other non-test callers write URL-bearing items straight through it**:
   - `clips/clip-ingest.ts:94` — writes `canonicalUrl: canonical` for every web clip;
   - `briefs/brief-save.ts:64` — research-brief items;
   - `glossary/glossary-project.ts:45` — glossary projections;
   plus `upsertNimbusItemIntoItemTable` → `index/local-index.ts:484` for filesystem items.

   Writing the key at `upsertIndexedItemForSync` as the design says would leave **every web clip
   unresolvable** — the browser panel's primary case, and the one item type whose whole identity is
   already a canonicalized URL. `upsertIndexedItem` is genuinely one site and strictly stronger.

3. **Self-hosted GitLab IS reachable; the secret is `gitlab.api_base`, not `gitlab.base_url`.**
   The design says "GitLab is not among them, so self-hosted GitLab is unreachable today either
   way." `connector-secrets-manifest.ts:15` lists `gitlab: ["gitlab.pat", "gitlab.api_base"]`, and
   `_lib/gitlab/events.ts:10` already exports `webOriginFromApiBase()` to turn it into a web
   origin. **Consequence for the host map: a map built by scanning for `*.base_url` silently
   misses GitLab.** The map must name each service's secret key explicitly.

4. **`canonicalizeUrl` never throws** — `url-canonical.ts:12` returns `raw` unchanged on
   unparseable input. So `unresolvable_url` cannot be inferred from its output; the route needs its
   own `new URL()` parse check *before* canonicalizing. Verified: `canonicalizeUrl("not a url")`
   returns `"not a url"`, which would otherwise be stored and matched as a legitimate key.

**Jira is IN the starter set** (the design's open question, decided here). Reason: Jira is the one
service in the set whose host boundary is *unambiguous* — it is exactly the origin of the
Vault-stored `jira.base_url`, so there is no SaaS-host guessing to do. The URL-shape variance the
design worries about is real but lives in the *deep-link* shapes (agile boards,
`/jira/software/c/projects/…?selectedIssue=`), not in the canonical one: `<base>/browse/<KEY>-<N>`
is emitted by both Cloud and Server/DC. This plan supports `/browse/<KEY>-<N>` **plus** a
`selectedIssue=<KEY>-<N>` query param and returns `unsupported_url` for every other Jira shape.
Declining explicitly is what `unsupported_url` is for; that is coverage with a stated bound, not a
pretence of completeness.

**Delivery: two stacked PRs, not one.** The user's opening argument is correct and they delegated
the call. Step 3 is a migration + row-wise backfill + a read; step 4 is a new outbound-request
surface + its security gate. Those are different risk classes, and squash-merge means one branch =
one commit on `main`, so genuinely separating them requires two branches. Both are built in this
plan; nothing is dropped or deferred.

- **PR A** = Tasks 1–6 on `dev/asafgolombek/resolve-and-fetch-on-miss`.
- **PR B** = Tasks 7–12 on `dev/asafgolombek/fetch-on-miss`, branched from PR A's head.
Task 6 and Task 12 are the two "docs + CHANGELOG" tasks that close each PR under the triple rule.

## Global Constraints

- **No `any`** — `unknown` for external data. TypeScript strict is non-negotiable.
- **No plaintext credentials** — Vault only; never in logs/IPC/config/error messages.
- **`canonicalizeUrl` (`util/url-canonical.ts`) is REUSED, NEVER MODIFIED.** `externalIdFor` hashes
  its output, so changing its rules changes clip identity. Do not add a parameter, do not add a
  rule, do not "improve" the tracking-param list.
- **Triple rule:** wiring + docs + enforcement test land in the same commit.
- **Migration atomicity:** `apply` is synchronous and the whole step runs in ONE `db.transaction`
  (`applySchemaStep`, `runner.ts:134`). "Batched" means **chunked reads to bound memory** and
  **NEVER a commit per batch**. A half-populated `resolve_key` with `user_version` already advanced
  is worse than not shipping.
- **`db.prepare()` must be `finalize()`d** in a `try/finally` — an unfinalized handle makes a later
  `db.close()` a silent no-op and pins the DB file open (#969). `backfillAuditChain`
  (`runner.ts:255`) is the precedent to copy.
- **Append-only schema:** never edit an existing migration step; add a new version.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Before pushing:** `bun run preflight:fast`, then the touched test files, then
  `bun run preflight` before opening the PR.
- Run every command from the worktree root
  `C:\gitrep\Nimbus\.claude\worktrees\resolve-fetch`.

---

## File Structure

**PR A — resolve**

| File | Responsibility |
| --- | --- |
| Create `packages/gateway/src/index/resolve-key-v52-sql.ts` | The V52 DDL constants (`ALTER TABLE` + `CREATE INDEX`). Follows the `<name>-v<N>-sql.ts` convention. |
| Modify `packages/gateway/src/index/migrations/runner.ts` | Bespoke `migrateIndexedV51ToV52` — DDL then chunked row-wise backfill, one transaction. |
| Modify `packages/gateway/src/index/item-store.ts` | Compute + write `resolve_key` inside `upsertIndexedItem`. |
| Create `packages/gateway/src/index/resolve-by-url.ts` | Pure matching ladder + response shaping. No SQL strings outside it, no HTTP. |
| Modify `packages/gateway/src/ipc/http-route-auth.ts` | `ROUTE_KEY_ITEMS_RESOLVE` + its `{kind:"clip",scope:"resolve"}` entry + union member. |
| Modify `packages/gateway/src/ipc/http-server.ts` | Mount `GET /v1/items/resolve` inline before the unauthenticated GET table. |
| Modify `packages/gateway/src/egress/egress-coverage.ts` | Extend the `http` narrowing comment: resolve appends nothing. |
| Modify `packages/cli/src/commands/prove.ts` | Same narrowing in `COVERAGE_CLASS_LABELS`. |

**PR B — fetch-on-miss**

| File | Responsibility |
| --- | --- |
| Create `packages/gateway/src/sync/fetch-host-boundary.ts` | Derived host→service map. The security gate. Own module, own tests. |
| Modify `packages/gateway/src/sync/types.ts` | Optional `fetchOne` on `Syncable` + the `FetchOneResult` union. |
| Modify `packages/gateway/src/connectors/{github,gitlab,bitbucket,jenkins,jira}-sync.ts` | Five `fetchOne` implementations reusing existing mapping functions. |
| Modify `packages/gateway/src/sync/scheduler.ts` | Per-run `sync` egress append in `runJob`; public `fetchOneByUrl`. |
| Create `packages/gateway/src/sync/targeted-fetch.ts` | Orchestrator: host gate → rate limit → egress append → `fetchOne`. |
| Modify `packages/gateway/src/ipc/http-write-routes.ts` | `ROUTE_ITEMS_FETCH` on `WRITE_ROUTE_ALLOWLIST` at the 8 KiB default cap. |
| Modify `packages/gateway/src/egress/egress-coverage.ts` | `sync: "none"` → `"per-run"`. |
| Modify `packages/gateway/src/security-invariants.test.ts` | Pin `["http","mcp","task"]` → `["http","mcp","sync","task"]`. |

---

## PR A — Resolve

### Task 1: V52 schema constants + migration step

**Files:**

- Create: `packages/gateway/src/index/resolve-key-v52-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- **Modify: `packages/gateway/src/index/local-index.ts:265` — `CURRENT_SCHEMA_VERSION` 51 → 52**
- Test: `packages/gateway/src/index/migrations/runner.test.ts`

**Interfaces:**

- Consumes: `readIndexedUserVersion(db)`, `applySchemaStep`, `recordMigration`, `dbExec`, `dbRun`,
  `dbStmtRun` — all already in `runner.ts`. `canonicalizeUrl` from `../../util/url-canonical.ts`.
- Produces: `RESOLVE_KEY_V52_SQL: readonly string[]`; an `IndexedSchemaStep` appended to
  `INDEXED_SCHEMA_STEPS` via bespoke `migrateIndexedV51ToV52(db, now)`; `CURRENT_SCHEMA_VERSION`
  becomes `52`.

**Verified facts about this file — the plan's first draft got these wrong, so use these:**

- The migration entry point is **`runIndexedSchemaMigrations(db, targetVersion, backupOptions?)`**
  (`runner.ts:635`). There is no `runIndexedMigrations`.
- It **early-returns when `readIndexedUserVersion(db) >= targetVersion`**, so the target is what
  drives the upgrade. `CURRENT_SCHEMA_VERSION` (`local-index.ts:265`, re-exported as
  `LocalIndex.SCHEMA_VERSION`) is the production target. **Bumping it to 52 is what makes V52
  actually run** — landing the step without the bump ships a dead migration.
- `runner.test.ts`'s helpers are `freshDb()` (a bare `:memory:` DB with **no** migrations run),
  `userVersion(db)`, `migrationCount(db)`, `tableNames(db)`. There is no
  `openIndexedDbAtLatest`.

- [ ] **Step 1: Write the failing test — a pre-existing row becomes resolvable**

Add to `packages/gateway/src/index/migrations/runner.test.ts`. Build the DB at **51**, insert a row
while the column genuinely does not exist yet, then migrate to 52 — no `DROP COLUMN` trickery
needed, because `runIndexedSchemaMigrations` takes the target version.

```ts
import { canonicalizeUrl } from "../../util/url-canonical.ts";

test("V52 backfills resolve_key for rows indexed before the column existed", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  // No resolve_key column at v51, so this is a genuine pre-migration row.
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
       body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('github:pr-1','github','pull_request','pr-1','PR one','','',0,
       'https://github.com/o/r/pull/1?utm_source=x',NULL,1,'{}',1,0)`,
  ).run();
  runIndexedSchemaMigrations(db, 52);
  const row = db.query("SELECT resolve_key FROM item WHERE id = 'github:pr-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe(canonicalizeUrl("https://github.com/o/r/pull/1?utm_source=x"));
  expect(userVersion(db)).toBe(52);
  db.close();
});

test("V52 leaves resolve_key NULL for a row with neither url", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview,
       body_complete, url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('nimbus:g-1','nimbus','glossary_term','g-1','Term','','',0,
       NULL,NULL,1,'{}',1,0)`,
  ).run();
  runIndexedSchemaMigrations(db, 52);
  const row = db.query("SELECT resolve_key FROM item WHERE id = 'nimbus:g-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBeNull();
  db.close();
});

test("CURRENT_SCHEMA_VERSION is 52, so V52 runs in production", () => {
  // Without this bump the step exists but never executes: runIndexedSchemaMigrations early-returns
  // once user_version >= targetVersion, and every production caller passes CURRENT_SCHEMA_VERSION.
  expect(CURRENT_SCHEMA_VERSION).toBe(52);
  const db = freshDb();
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  expect(tableNames(db)).toContain("item");
  const cols = db.query("PRAGMA table_info(item)").all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).toContain("resolve_key");
  db.close();
});
```

Import `CURRENT_SCHEMA_VERSION` from `../local-index.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts -t "V52 backfills"`
Expected: FAIL — `no such column: resolve_key`.

- [ ] **Step 3: Create the SQL constants**

```ts
// packages/gateway/src/index/resolve-key-v52-sql.ts
/**
 * V52 — `item.resolve_key`: the derived, indexed key that `GET /v1/items/resolve` matches on.
 *
 * A DERIVED column rather than an index on `canonical_url` directly, because the stored values are
 * raw provider URLs while the incoming value is whatever is in a browser's address bar. Matching
 * those needs normalisation on BOTH sides, and SQLite cannot run `canonicalizeUrl`.
 *
 * Nullable with no DEFAULT: a row with neither `url` nor `canonical_url` has no key, and NULL is
 * the honest value. SQLite indexes skip NULLs, so those rows cost nothing.
 */
export const RESOLVE_KEY_V52_SQL: readonly string[] = Object.freeze([
  `ALTER TABLE item ADD COLUMN resolve_key TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_item_resolve_key ON item(resolve_key)`,
]);
```

- [ ] **Step 4: Write the bespoke migration**

Add the import beside the other `../<name>-v<N>-sql.ts` imports in `runner.ts`:

```ts
import { RESOLVE_KEY_V52_SQL } from "../resolve-key-v52-sql.ts";
```

Add `canonicalizeUrl` to the imports:

```ts
import { canonicalizeUrl } from "../../util/url-canonical.ts";
```

Add the function beside `backfillAuditChain`:

```ts
/**
 * Chunk size for the V52 backfill. Bounds MEMORY, not transaction size: the whole step runs inside
 * one `db.transaction` (see `applySchemaStep`), so there is deliberately NO commit per chunk.
 * Committing per chunk would leave `resolve_key` half-populated with `PRAGMA user_version` already
 * advanced — an index that resolves some URLs and not others, invisible until a user asks why one
 * PR resolves and another does not.
 */
const RESOLVE_KEY_BACKFILL_CHUNK = 5_000;

function backfillResolveKey(db: Database): void {
  // NO OFFSET. The loop WRITES the very column its WHERE clause filters on, so every processed row
  // leaves the candidate set — the set is self-consuming and the next unprocessed rows are always at
  // the front. Adding an OFFSET would compound two shrinks (rows leaving the set AND the cursor
  // advancing past them) and SILENTLY SKIP roughly half the rows once the backfill exceeds one
  // chunk, committing user_version=52 over a half-populated column that never self-heals, because
  // runIndexedSchemaMigrations early-returns when user_version >= target. Termination is guaranteed
  // because each iteration removes up to CHUNK rows from the set and the loop breaks on a short read.
  const select = db.prepare(
    `SELECT id, url, canonical_url FROM item
     WHERE resolve_key IS NULL AND (url IS NOT NULL OR canonical_url IS NOT NULL)
     ORDER BY id ASC LIMIT ?`,
  );
  const update = db.prepare(`UPDATE item SET resolve_key = ? WHERE id = ?`);
  // Both statements come from db.prepare() and MUST be finalized: bun:sqlite only auto-releases the
  // db.query() cache, so an unfinalized handle makes a later db.close() a silent no-op (#969).
  try {
    for (;;) {
      const rows = select.all(RESOLVE_KEY_BACKFILL_CHUNK) as Array<{
        id: string;
        url: string | null;
        canonical_url: string | null;
      }>;
      if (rows.length === 0) {
        break;
      }
      for (const r of rows) {
        const raw = r.canonical_url ?? r.url;
        // The WHERE clause already excludes both-NULL rows; this narrows the type.
        if (raw === null) {
          continue;
        }
        dbStmtRun(update, canonicalizeUrl(raw), r.id);
      }
      if (rows.length < RESOLVE_KEY_BACKFILL_CHUNK) {
        break;
      }
    }
  } finally {
    select.finalize();
    update.finalize();
  }
}

function migrateIndexedV51ToV52(db: Database, now: number): void {
  db.transaction(() => {
    for (const sql of RESOLVE_KEY_V52_SQL) {
      dbExec(db, sql);
    }
    backfillResolveKey(db);
    dbExec(db, "PRAGMA user_version = 52");
    recordMigration(db, 52, "item.resolve_key + idx_item_resolve_key (resolve-by-URL v52)", now);
  })();
}
```

Append to `INDEXED_SCHEMA_STEPS`, after the `simpleStep(50, 51, …)` entry:

```ts
  { fromVersion: 51, toVersion: 52, apply: migrateIndexedV51ToV52 },
```

Then bump the production target in `packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 52;
```

Do NOT append to `BACKFILL_LABELS` — it intentionally stops at v37, and the comment at
`runner.ts:508` says appending per migration makes an error branch unreachable.

> **A multi-chunk test is MANDATORY, not optional.** Every correctness test that uses one row per
> case passes with *any* pagination scheme, correct or not — the bug this note exists to prevent is
> invisible below `RESOLVE_KEY_BACKFILL_CHUNK` rows. Export the constant and assert over
> `CHUNK + 3` rows that **zero** remain NULL. (An earlier draft of this plan asserted that
> `offset += rows.length` was "correct and terminating". It is not: it silently skips about half the
> rows. The claim was wrong, and single-row tests could never have caught it.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts -t "V52 backfills"`
Expected: PASS.

- [ ] **Step 6: Add the atomicity test (red-prove the transaction claim)**

```ts
test("V52 leaves user_version unadvanced when the backfill throws", () => {
  const db = freshDb();
  runIndexedSchemaMigrations(db, 51);
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, body, body_preview, body_complete,
       url, canonical_url, modified_at, metadata, synced_at, pinned)
     VALUES ('github:pr-2','github','pull_request','pr-2','PR two','','',0,
       'https://github.com/o/r/pull/2',NULL,1,'{}',1,0)`,
  ).run();
  // Poison the UPDATE the backfill must perform. The trigger is created BEFORE the migration runs,
  // and it fires on the resolve_key write that V52's backfill issues.
  db.query(
    `CREATE TRIGGER poison_resolve_key BEFORE UPDATE OF resolve_key ON item
     BEGIN SELECT RAISE(ABORT, 'boom'); END`,
  ).run();
  expect(() => runIndexedSchemaMigrations(db, 52)).toThrow();
  // The whole step is one db.transaction, so a throw mid-backfill rolls back the DDL AND the
  // version bump. A half-populated resolve_key at v52 would resolve some URLs and not others.
  expect(userVersion(db)).toBe(51);
  db.close();
});
```

> The trigger references `resolve_key`, a column that does not exist at v51. SQLite parses trigger
> bodies lazily but validates the `UPDATE OF <column>` clause at creation time against the current
> schema, so this `CREATE TRIGGER` may fail at v51. If it does, create the trigger *after* the DDL
> by splitting the assertion: run `runIndexedSchemaMigrations(db, 52)` once on an empty table
> (which succeeds trivially), then assert atomicity with a fresh DB where the poison is a
> `CHECK`-violating row instead. Do not delete the test — the atomicity property is the one the
> review-response called a live defect risk.

- [ ] **Step 7: Run both migration tests**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts`
Expected: PASS, including the file's pre-existing tests. Watch for a pre-existing test that pins the
migration count or the highest version — if one fails, it is asserting the old ceiling and must be
updated to 52, not weakened.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/resolve-key-v52-sql.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/local-index.ts \
        packages/gateway/src/index/migrations/runner.test.ts
git commit -m "V52: item.resolve_key column, index and row-wise backfill"
```

---

### Task 2: Write `resolve_key` at the `upsertIndexedItem` chokepoint

**Files:**

- Modify: `packages/gateway/src/index/item-store.ts:64-146`
- **Create** (verified absent): `packages/gateway/src/index/item-store.test.ts`
- Test: `packages/gateway/src/clips/clip-ingest.test.ts` (exists — add one test)

**There is no `item-store.test.ts` today**, so create it with this local helper rather than reaching
for a shared one that does not exist:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { upsertIndexedItem } from "./item-store.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function freshIndexedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}
```

**Interfaces:**

- Consumes: `canonicalizeUrl`.
- Produces: nothing new exported — `upsertIndexedItem` gains one derived column write. Every caller
  (all ~62 connectors via `upsertIndexedItemForSync`, plus `clip-ingest`, `brief-save`,
  `glossary-project`, `upsertNimbusItemIntoItemTable`) is covered with no signature change.

- [ ] **Step 1: Write the failing tests — sync path, clip path, and the NULL case**

```ts
test("upsertIndexedItem derives resolve_key from canonicalUrl", () => {
  const db = freshIndexedDb(); // existing helper in this file
  upsertIndexedItem(db, {
    service: "github", type: "pull_request", externalId: "pr-1", title: "t",
    bodyPreview: "b", url: "https://github.com/o/r/pull/1#discussion",
    canonicalUrl: "https://github.com/o/r/pull/1", modifiedAt: 1, syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='github:pr-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe("https://github.com/o/r/pull/1");
  db.close();
});

test("upsertIndexedItem falls back to url when canonicalUrl is absent", () => {
  const db = freshIndexedDb();
  upsertIndexedItem(db, {
    service: "jenkins", type: "build", externalId: "b-1", title: "t", bodyPreview: "b",
    url: "https://ci.example.com/job/x/12/?utm_source=mail", modifiedAt: 1, syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='jenkins:b-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe("https://ci.example.com/job/x/12");
  db.close();
});

test("upsertIndexedItem leaves resolve_key NULL when both urls are null", () => {
  const db = freshIndexedDb();
  upsertIndexedItem(db, {
    service: "nimbus", type: "research_brief", externalId: "brief-1", title: "t",
    body: "b", url: null, canonicalUrl: null, modifiedAt: 1, syncedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE id='nimbus:brief-1'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Add the clip-path regression test — the reason this task is not in `…ForSync`**

```ts
test("a web clip written through ingestClip is resolvable", () => {
  const db = freshIndexedDb();
  ingestClip(db, {
    url: "https://example.com/post?utm_source=news",
    title: "Post", body: "text", tags: [], mode: "article", capturedAt: 1,
  });
  const row = db.query("SELECT resolve_key FROM item WHERE service='nimbus'").get() as {
    resolve_key: string | null;
  };
  // Not NULL is the whole point: clip-ingest calls upsertIndexedItem DIRECTLY, bypassing
  // upsertIndexedItemForSync. Deriving the key in the wrapper would leave every clip unresolvable.
  expect(row.resolve_key).toBe("https://example.com/post");
  db.close();
});
```

Put this one in `packages/gateway/src/clips/clip-ingest.test.ts` (it needs `ingestClip`'s imports);
match that file's existing temp-DB helper.

- [ ] **Step 3: Run both to verify they fail**

Run: `bun test packages/gateway/src/index/item-store.test.ts packages/gateway/src/clips/clip-ingest.test.ts -t "resolve_key"`
Expected: FAIL — `no such column: resolve_key` (the fresh-DB helpers run migrations, so Task 1 must
be complete first) or an assertion failure on `undefined`.

- [ ] **Step 4: Implement — derive the key in `upsertIndexedItem`**

In `packages/gateway/src/index/item-store.ts`, add the import:

```ts
import { canonicalizeUrl } from "../util/url-canonical.ts";
```

Inside `upsertIndexedItem`, after the `const bodyComplete = …` line, add:

```ts
  // The DERIVED resolve key, written HERE rather than in `upsertIndexedItemForSync`, because this
  // is the actual SQL chokepoint: `clips/clip-ingest.ts`, `briefs/brief-save.ts`,
  // `glossary/glossary-project.ts` and `upsertNimbusItemIntoItemTable` all call THIS function
  // directly and never touch the sync wrapper. Deriving it in the wrapper would leave every web
  // clip unresolvable — the one item type whose identity already IS a canonicalized URL.
  //
  // `canonicalizeUrl` is reused unchanged (`externalIdFor` hashes its output, so its rules are
  // clip identity). It does not throw: unparseable input comes back verbatim, which is acceptable
  // for a stored key because the READ side parse-checks before it canonicalizes.
  const resolveSource = row.canonicalUrl ?? row.url ?? null;
  const resolveKey = resolveSource === null ? null : canonicalizeUrl(resolveSource);
```

Add `resolve_key` to the INSERT column list, the `VALUES` placeholders, the `DO UPDATE SET` clause
and the bound-parameter array:

```text
      url, canonical_url, resolve_key, modified_at, author_id, metadata, synced_at, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```text
      canonical_url = excluded.canonical_url,
      resolve_key = excluded.resolve_key,
```

```ts
      row.url ?? null,
      row.canonicalUrl ?? null,
      resolveKey,
```

> The placeholder count goes from 15 to 16. Count them — a mismatch is a runtime
> `SQLITE_RANGE` on every upsert, which the tests above catch immediately.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/index/item-store.test.ts packages/gateway/src/clips/clip-ingest.test.ts`
Expected: PASS, including the pre-existing tests in both files.

- [ ] **Step 6: Prove no other write path was missed**

Run: `bun test packages/gateway/src/index packages/gateway/src/clips packages/gateway/src/briefs packages/gateway/src/glossary`
Expected: PASS. Then confirm the caller set has not grown since this plan was written:

```bash
grep -rn "upsertIndexedItem\b" --include=*.ts packages/gateway/src | grep -v "\.test\.ts" | grep -v "^\S*:.*\*"
```

Expected callers: `briefs/brief-save.ts`, `clips/clip-ingest.ts`, `glossary/glossary-project.ts`,
and `index/item-store.ts` itself. A fifth non-comment caller means re-checking that it supplies a
URL, not that the approach is wrong.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/item-store.ts \
        packages/gateway/src/index/item-store.test.ts \
        packages/gateway/src/clips/clip-ingest.test.ts
git commit -m "derive item.resolve_key at the upsertIndexedItem chokepoint"
```

---

### Task 3: The matching ladder (pure module)

**Files:**

- Create: `packages/gateway/src/index/resolve-by-url.ts`
- Test: `packages/gateway/src/index/resolve-by-url.test.ts`

**Interfaces:**

- Consumes: `canonicalizeUrl`; a `Database` for reads only.
- Produces:

  ```ts
  export type ResolveMatchKind = "exact" | "query_stripped" | "path_trimmed";
  export type ResolveCandidate = {
    readonly id: string; readonly service: string; readonly type: string;
    readonly title: string; readonly url: string | null;
  };
  export type ResolveResponse =
    | { readonly found: true;
        readonly item: ResolveCandidate & { readonly modified_at: number };
        readonly matchKind: ResolveMatchKind }
    | { readonly found: false; readonly reason: "not_indexed" | "unresolvable_url";
        readonly service: string | null; readonly fetchable: boolean }
    | { readonly found: false; readonly reason: "ambiguous";
        readonly service: string | null; readonly fetchable: boolean;
        readonly candidates: readonly ResolveCandidate[]; readonly truncated: boolean };
  export const RESOLVE_CANDIDATE_CAP = 5;
  export const RESOLVE_MAX_TRIMMED_SEGMENTS = 3;
  export function resolveItemByUrl(
    db: Database, rawUrl: string,
    opts?: { readonly fetchable?: (host: string) => boolean },
  ): ResolveResponse;
  ```

  `opts.fetchable` is injected so PR A can pass nothing (`fetchable: false` everywhere) and PR B
  can pass the host-boundary predicate without this module importing the sync layer.

- [ ] **Step 1: Write the failing tests — one per rung, plus the cap and the reject**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolveItemByUrl } from "./resolve-by-url.ts";

function dbWith(rows: Array<{ id: string; key: string | null; type?: string }>): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT, type TEXT, title TEXT,
    url TEXT, resolve_key TEXT, modified_at INTEGER)`);
  for (const r of rows) {
    db.query(
      `INSERT INTO item (id, service, type, title, url, resolve_key, modified_at)
       VALUES (?, 'github', ?, 'T', ?, ?, 7)`,
    ).run(r.id, r.type ?? "pull_request", r.key, r.key);
  }
  return db;
}

test("rung 1 — exact key matches", () => {
  const db = dbWith([{ id: "a", key: "https://github.com/o/r/pull/1" }]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1#note");
  expect(out).toMatchObject({ found: true, matchKind: "exact" });
  db.close();
});

test("rung 2 — all query params dropped", () => {
  const db = dbWith([{ id: "a", key: "https://github.com/o/r/pull/1" }]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1?tab=files");
  expect(out).toMatchObject({ found: true, matchKind: "query_stripped" });
  db.close();
});

test("rung 3 — trailing path segments trimmed", () => {
  const db = dbWith([{ id: "a", key: "https://bitbucket.org/o/r/pull-requests/42" }]);
  const out = resolveItemByUrl(db, "https://bitbucket.org/o/r/pull-requests/42/diff");
  expect(out).toMatchObject({ found: true, matchKind: "path_trimmed" });
  db.close();
});

test("rung 3 declines rather than guessing when a trim is not unique", () => {
  const db = dbWith([
    { id: "a", key: "https://github.com/o/r/pull/1", type: "pull_request" },
    { id: "b", key: "https://github.com/o/r/pull/1", type: "issue" },
  ]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: false, reason: "ambiguous", truncated: false });
  if (out.found === false && out.reason === "ambiguous") {
    expect(out.candidates).toHaveLength(2);
  }
  db.close();
});

test("over the cap returns truncated with NO candidates", () => {
  const db = dbWith(
    Array.from({ length: 6 }, (_, i) => ({ id: `x${String(i)}`, key: "https://github.com/o/r/pull/1" })),
  );
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: false, reason: "ambiguous", truncated: true });
  if (out.found === false && out.reason === "ambiguous") {
    expect(out.candidates).toEqual([]);
  }
  db.close();
});

test("an unparseable url is unresolvable, never a stored key lookup", () => {
  const db = dbWith([{ id: "a", key: "not a url" }]);
  const out = resolveItemByUrl(db, "not a url");
  // canonicalizeUrl returns unparseable input VERBATIM, so without an explicit parse check this
  // would match the poisoned row above and report found:true.
  expect(out).toMatchObject({ found: false, reason: "unresolvable_url", service: null });
  db.close();
});

test("a well-formed url with nothing indexed is not_indexed", () => {
  const db = dbWith([]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/9");
  expect(out).toMatchObject({ found: false, reason: "not_indexed", fetchable: false });
  db.close();
});

test("an exact match wins over a trimmable one", () => {
  const db = dbWith([
    { id: "deep", key: "https://github.com/o/r/pull/1/files" },
    { id: "shallow", key: "https://github.com/o/r/pull/1" },
  ]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: true, matchKind: "exact" });
  if (out.found) {
    expect(out.item.id).toBe("deep");
  }
  db.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/index/resolve-by-url.test.ts`
Expected: FAIL — cannot resolve module `./resolve-by-url.ts`.

- [ ] **Step 3: Implement the module**

```ts
import type { Database } from "bun:sqlite";

import { canonicalizeUrl } from "../util/url-canonical.ts";

/** Candidate lists are capped: rung 3 trims path segments and can match broadly, so an uncapped
 * list would turn a mis-trimmed URL into a bulk index read over a `resolve`-scoped token. */
export const RESOLVE_CANDIDATE_CAP = 5;
/** How many trailing path segments rung 3 may trim. Bounded so `/a/b/c/d/e` cannot walk to `/a`. */
export const RESOLVE_MAX_TRIMMED_SEGMENTS = 3;

export type ResolveMatchKind = "exact" | "query_stripped" | "path_trimmed";

export type ResolveCandidate = {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
};

export type ResolveResponse =
  | {
      readonly found: true;
      readonly item: ResolveCandidate & { readonly modified_at: number };
      readonly matchKind: ResolveMatchKind;
    }
  | {
      readonly found: false;
      readonly reason: "not_indexed" | "unresolvable_url";
      readonly service: string | null;
      readonly fetchable: boolean;
    }
  | {
      readonly found: false;
      readonly reason: "ambiguous";
      readonly service: string | null;
      readonly fetchable: boolean;
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    };

type Row = {
  id: string;
  service: string;
  type: string;
  title: string;
  url: string | null;
  modified_at: number;
};

/**
 * Reads one page of matches for a key, capped at CAP+1 so "more than the cap" is distinguishable
 * from "exactly the cap" without a second COUNT query.
 */
function matchesForKey(db: Database, key: string): Row[] {
  return db
    .query(
      `SELECT id, service, type, title, url, modified_at FROM item
       WHERE resolve_key = ? ORDER BY modified_at DESC, id ASC LIMIT ?`,
    )
    .all(key, RESOLVE_CANDIDATE_CAP + 1) as Row[];
}

function toCandidate(r: Row): ResolveCandidate {
  return { id: r.id, service: r.service, type: r.type, title: r.title, url: r.url };
}

/** Metadata only, NEVER a body — resolve is a resolver; reading is `GET /v1/items/{id}`. This also
 * deliberately avoids the `metadata_only` redaction path and its two unfixed privacy defects. */
function hit(r: Row, matchKind: ResolveMatchKind): ResolveResponse {
  return {
    found: true,
    item: { ...toCandidate(r), modified_at: r.modified_at },
    matchKind,
  };
}

function ambiguous(rows: Row[], service: string | null, fetchable: boolean): ResolveResponse {
  const truncated = rows.length > RESOLVE_CANDIDATE_CAP;
  return {
    found: false,
    reason: "ambiguous",
    service,
    fetchable,
    // Over the cap the list is EMPTY, not sliced: a truncated choice menu implies the right answer
    // is among those shown when it may not be.
    candidates: truncated ? [] : rows.map(toCandidate),
    truncated,
  };
}

/** The key with every query parameter dropped (rung 2). */
function withoutQuery(u: URL): string {
  const copy = new URL(u.toString());
  copy.search = "";
  return canonicalizeUrl(copy.toString());
}

/** Progressively shorter keys, one trailing path segment removed at a time (rung 3). */
function trimmedKeys(u: URL): string[] {
  const base = new URL(u.toString());
  base.search = "";
  const segments = base.pathname.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let drop = 1; drop <= RESOLVE_MAX_TRIMMED_SEGMENTS; drop++) {
    if (segments.length - drop < 1) {
      break;
    }
    const copy = new URL(base.toString());
    copy.pathname = `/${segments.slice(0, segments.length - drop).join("/")}`;
    out.push(canonicalizeUrl(copy.toString()));
  }
  return out;
}

/**
 * Resolves a URL to an already-indexed item through a bounded ladder: exact key, then the key with
 * all query params dropped, then up to three progressively trimmed trailing path segments.
 *
 * A trimmed match must be UNIQUE or the answer is `ambiguous` — trimming can over-reach, and
 * guessing between candidates is worse than declining.
 */
export function resolveItemByUrl(
  db: Database,
  rawUrl: string,
  opts?: { readonly fetchable?: (host: string) => boolean },
): ResolveResponse {
  // Parse FIRST. `canonicalizeUrl` returns unparseable input verbatim, so canonicalizing before
  // this check would let a non-URL string match a row whose stored key is that same string.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { found: false, reason: "unresolvable_url", service: null, fetchable: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { found: false, reason: "unresolvable_url", service: null, fetchable: false };
  }
  const host = parsed.host.toLowerCase();
  const fetchable = opts?.fetchable?.(host) ?? false;

  const exact = matchesForKey(db, canonicalizeUrl(rawUrl));
  if (exact.length === 1) {
    return hit(exact[0] as Row, "exact");
  }
  if (exact.length > 1) {
    return ambiguous(exact, (exact[0] as Row).service, fetchable);
  }

  const stripped = withoutQuery(parsed);
  const queryStripped = matchesForKey(db, stripped);
  if (queryStripped.length === 1) {
    return hit(queryStripped[0] as Row, "query_stripped");
  }
  if (queryStripped.length > 1) {
    return ambiguous(queryStripped, (queryStripped[0] as Row).service, fetchable);
  }

  for (const key of trimmedKeys(parsed)) {
    const rows = matchesForKey(db, key);
    if (rows.length === 1) {
      return hit(rows[0] as Row, "path_trimmed");
    }
    if (rows.length > 1) {
      return ambiguous(rows, (rows[0] as Row).service, fetchable);
    }
  }

  return { found: false, reason: "not_indexed", service: null, fetchable };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/index/resolve-by-url.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Add a time-bounded test — the trim loop must not degrade on a long path**

A correctness test never catches quadratic behaviour; this repo has been bitten four times.

```ts
test("a pathological path resolves in bounded time", () => {
  const db = dbWith([]);
  const long = `https://example.com/${Array.from({ length: 5_000 }, () => "seg").join("/")}`;
  const t0 = performance.now();
  resolveItemByUrl(db, long);
  expect(performance.now() - t0).toBeLessThan(250);
  db.close();
});
```

- [ ] **Step 6: Run it**

Run: `bun test packages/gateway/src/index/resolve-by-url.test.ts -t "bounded time"`
Expected: PASS well under the bound — the ladder is at most 5 indexed lookups regardless of length.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/resolve-by-url.ts \
        packages/gateway/src/index/resolve-by-url.test.ts
git commit -m "resolve-by-url matching ladder with capped ambiguity"
```

---

### Task 4: `GET /v1/items/resolve` route + scope wiring

**Files:**

- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (mount beside `POST /v1/clips/related`, ~L527)
- Test: `packages/gateway/src/ipc/http-route-auth.test.ts`, `packages/gateway/test/http-api.test.ts`

**Interfaces:**

- Consumes: `resolveItemByUrl` (Task 3); `requireScopedClipToken`, `json`,
  `enforceClipScope`, `clipScopeFor`.
- Produces: `ROUTE_KEY_ITEMS_RESOLVE = "GET /v1/items/resolve"`, added to `ClipReadRouteKey`.

- [ ] **Step 1: Write the failing route-auth tests**

```ts
test("the resolve route requires the resolve scope", () => {
  expect(HTTP_ROUTE_AUTH[ROUTE_KEY_ITEMS_RESOLVE]).toEqual({ kind: "clip", scope: "resolve" });
  expect(clipScopeFor(ROUTE_KEY_ITEMS_RESOLVE)).toBe("resolve");
});

test("a legacy token is refused the resolve route with a distinguishable body", () => {
  const verdict = enforceClipScope(ROUTE_KEY_ITEMS_RESOLVE, LEGACY_SCOPES);
  expect(verdict).toEqual({
    ok: false,
    status: 403,
    body: { error: "insufficient_scope", required: "resolve", granted: ["clip", "briefs"] },
  });
});
```

The second test is the consumer contract: every browser paired today holds `LEGACY_SCOPES`
(`["clip","briefs"]`) and will hit this until it re-pairs. `403 insufficient_scope` with `required`
and `granted` is structurally distinct from `401 {error:"unauthorized"}`, so the extension can tell
"re-pair for a wider scope" from "your token is bad".

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts -t resolve`
Expected: FAIL — `ROUTE_KEY_ITEMS_RESOLVE` is not exported.

- [ ] **Step 3: Wire the table**

In `packages/gateway/src/ipc/http-route-auth.ts`, beside the other read-route constants:

```ts
export const ROUTE_KEY_ITEMS_RESOLVE = "GET /v1/items/resolve";
```

Add to `HTTP_ROUTE_AUTH`, in the "Client-token reads" block:

```ts
  // Resolve is a bearer READ under its own scope. It appends NO egress row (see the `http`
  // narrowing in egress/egress-coverage.ts) — it reads the local index and returns metadata.
  [ROUTE_KEY_ITEMS_RESOLVE]: { kind: "clip", scope: "resolve" },
```

Extend the union:

```ts
export type ClipReadRouteKey =
  | typeof ROUTE_KEY_CLIPS_RELATED
  | typeof ROUTE_KEY_BRIEF_GET
  | typeof ROUTE_KEY_AGENTS_LIST
  | typeof ROUTE_KEY_AGENT_RUN_GET
  | typeof ROUTE_KEY_ITEMS_RESOLVE;
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts`
Expected: PASS, including the pre-existing completeness test.

> The completeness test asserts the table is total over the surface. It will now also demand the
> route be reachable in `http-server.ts` — if it fails with "route in table but not mounted", that
> is Step 6's job, not a reason to weaken the table.

- [ ] **Step 5: Write the failing end-to-end route test**

In `packages/gateway/test/http-api.test.ts`, following the `POST /v1/clips/related` test's setup
(it already builds a server with `clipsVault` + a minted token):

```ts
test("GET /v1/items/resolve returns an exact match for a resolve-scoped token", async () => {
  const { baseUrl, token, db, stop } = await startServerWithClipToken(["resolve"]);
  upsertIndexedItem(db, {
    service: "github", type: "pull_request", externalId: "pr-1", title: "PR one",
    bodyPreview: "x", url: "https://github.com/o/r/pull/1",
    canonicalUrl: "https://github.com/o/r/pull/1", modifiedAt: 99, syncedAt: 99,
  });
  const res = await fetch(
    `${baseUrl}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/1?tab=files")}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    found: true, matchKind: "query_stripped",
    item: { id: "github:pr-1", service: "github", type: "pull_request", modified_at: 99 },
  });
  stop();
});

test("GET /v1/items/resolve 403s a legacy-scoped token", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["clip", "briefs"]);
  const res = await fetch(`${baseUrl}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "resolve" });
  stop();
});

test("GET /v1/items/resolve 401s an unknown token", async () => {
  const { baseUrl, stop } = await startServerWithClipToken(["resolve"]);
  const res = await fetch(`${baseUrl}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`, {
    headers: { authorization: "Bearer nope" },
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  stop();
});

test("GET /v1/items/resolve 400s a missing url param", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["resolve"]);
  const res = await fetch(`${baseUrl}/v1/items/resolve`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "missing_url" });
  stop();
});
```

If `startServerWithClipToken` does not exist with a scopes parameter, extend the file's existing
helper to take one rather than writing a second helper.

- [ ] **Step 6: Mount the route**

In `packages/gateway/src/ipc/http-server.ts`, add the import:

```ts
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import { ROUTE_KEY_ITEMS_RESOLVE } from "./http-route-auth.ts";
```

Add a handler beside the `clips/related` one (~L527):

```ts
/**
 * `GET /v1/items/resolve?url=` — bearer read under the `resolve` scope.
 *
 * Mounted INLINE in the fetch handler, BEFORE the unauthenticated GET table, for the reason
 * `GET /v1/briefs/{id}` states: that table is documented "no bearer gate", so routing scoped output
 * through it would expose it to any local process.
 *
 * Returns metadata only and appends NO egress row.
 */
async function handleItemsResolve(
  req: Request,
  url: URL,
  db: Database,
  clipsVault: NimbusVault,
): Promise<Response> {
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_ITEMS_RESOLVE);
  if (!auth.ok) {
    return auth.response;
  }
  const raw = url.searchParams.get("url");
  if (raw === null || raw.trim() === "") {
    return json({ error: "missing_url" }, 400);
  }
  return json(resolveItemByUrl(db, raw));
}
```

In the `fetch` handler, beside the existing `POST /v1/clips/related` dispatch and **before** the
unauthenticated GET table, add:

```ts
      if (
        req.method === "GET" &&
        url.pathname === "/v1/items/resolve" &&
        opts.clipsVault !== undefined
      ) {
        return await handleItemsResolve(req, url, db, opts.clipsVault);
      }
```

> Place this before any `/v1/items/*` matcher. `GET /v1/items/*` is a **public** route in the table,
> so a resolve request that fell through to it would be served unauthenticated — the exact
> "public by omission" failure the table exists to prevent. If the existing item matcher is a regex
> that would swallow `/v1/items/resolve`, the resolve check must precede it; verify by running the
> 401 test above, which fails loudly if the request is served without a bearer.

- [ ] **Step 7: Run the route tests**

Run: `bun test packages/gateway/test/http-api.test.ts -t resolve`
Expected: all four PASS. Then run the whole file to catch a swallowed-route regression:
`bun test packages/gateway/test/http-api.test.ts`

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/http-route-auth.ts \
        packages/gateway/src/ipc/http-route-auth.test.ts \
        packages/gateway/src/ipc/http-server.ts \
        packages/gateway/test/http-api.test.ts
git commit -m "GET /v1/items/resolve behind the resolve scope"
```

---

### Task 5: OpenAPI + the `http` coverage narrowing

**Files:**

- Modify: `packages/gateway/src/ipc/http-openapi.ts` (or wherever `/v1/openapi.json` is built —
  confirm with `grep -rn "openapi" packages/gateway/src/ipc/`)
- Modify: `packages/gateway/src/egress/egress-coverage.ts:55-61`
- Modify: `packages/cli/src/commands/prove.ts:46-53`
- Test: the existing OpenAPI drift test; `packages/gateway/src/egress/egress-coverage.test.ts`

**Interfaces:**

- Consumes: nothing new. Produces: no new symbols — documentation of an existing claim.

**Added to this task (gap found by Task 4's coverage run).** `resolve-by-url.ts` measures **81.82%
branch** against an 80% floor — a 1.82pp margin, so one future uncovered branch breaks CI — and the
uncovered branch is the **non-`http(s)` scheme rejection**, which is security-adjacent: it validates
caller-supplied input. Task 3's tests covered the *unparseable* URL but never a *parseable URL with a
rejected scheme*. Add this to `packages/gateway/src/index/resolve-by-url.test.ts` (the TEST file only
— `resolve-by-url.ts` itself stays untouched):

```ts
test("a parseable URL with a non-http(s) scheme is unresolvable", () => {
  // `new URL()` ACCEPTS all of these, so only the explicit protocol check rejects them. Planting a
  // row whose stored key IS the input proves the scheme gate runs BEFORE any lookup — otherwise
  // these would match and report found:true.
  const db = dbWith([{ id: "a", key: "file:///etc/passwd" }]);
  for (const raw of ["file:///etc/passwd", "javascript:alert(1)", "ftp://h/x", "data:text/plain,x"]) {
    expect(resolveItemByUrl(db, raw)).toMatchObject({
      found: false,
      reason: "unresolvable_url",
      service: null,
      fetchable: false,
    });
  }
  db.close();
});
```

- [ ] **Step 1: DECIDED — do NOT add the route to the OpenAPI document. No work here.**

An earlier draft of this plan said to "find and run the OpenAPI drift test" and to mirror "the
existing `POST /v1/clips/related` entry". **Both premises were false, verified in source:**

- The spec is a hand-maintained YAML at `packages/gateway/openapi/v1.yaml`, embedded via
  `import openapiV1Yaml from "../../openapi/v1.yaml" with { type: "file" }`
  (`ipc/embedded-assets.ts:4`). There is **no** doc↔route parity/drift test — `openapi-loader.test.ts`
  tests YAML loading and `test/integration/http/openapi-route.test.ts` asserts the route serves valid
  3.1.0 with `/v1/openapi.json` present. Nothing asserts completeness.
- There is **no `POST /v1/clips/related` entry** to mirror. The documented paths are exactly:
  `/v1/health`, `/v1/items`, `/v1/items/{id}`, `/v1/connectors`, `/v1/people`, `/v1/people/{id}`,
  `/v1/audit`, `/v1/deployments`, `/v1/openapi.json`, `/v1/metrics/dora`, `/v1/preflight/deploy`.

So the established, consistent precedent is that **every bearer-gated client-token route family is
absent** from the document — `/v1/clips`, `/v1/clips/related`, `/v1/briefs/*` and `/v1/agents/*` are
all undocumented. `v1.yaml` covers the public read surface plus the one `/v1/deployments` write
carve-out.

**Decision: follow the precedent and add nothing.** Adding resolve alone would make it the sole
documented gated route, which is actively misleading — a reader would infer the other four families
do not exist. Documenting the gated surface is a real gap, but it spans four pre-existing route
families and is its own change; fixing it by inconsistently adding a fifth is worse than leaving it.
Record this in the PR description as a stated decision, not an oversight.

- [ ] **Step 3: Extend the `http` narrowing comment**

In `packages/gateway/src/egress/egress-coverage.ts`, the `READ THE http ENTRY` paragraph currently
names `GET /v1/items`, `/v1/people`, `/v1/audit`. Add resolve explicitly:

```text
 * NOT "everything on the HTTP API". `GET /v1/items`, `GET /v1/items/resolve`, `GET /v1/people`,
 * `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append
 * NO row. `GET /v1/items/resolve` is called out by name because it is the newest of them and the
 * one most likely to be mistaken for egress: it takes a URL from an external caller and answers
 * from the LOCAL index without any outbound request. Conversely a targeted connector fetch on the
 * same port WILL append, but under `sync`, not `http` — the class tracks the kind of egress, not
 * the port it arrived on.
```

- [ ] **Step 4: Mirror it in the CLI label**

In `packages/cli/src/commands/prove.ts`:

```ts
  // NOT "the HTTP API" — the class covers agent briefs only. The other HTTP reads append nothing:
  // `GET /v1/items/resolve` in particular answers a URL lookup from the LOCAL index with no
  // outbound request, and saying so here is the whole point of a hand-written label.
  http: "agents.* briefs served over the local HTTP API",
```

- [ ] **Step 5: Run the affected suites**

Run: `bun test packages/gateway/src/egress packages/cli/src/commands/prove.test.ts`
Expected: PASS. `THIS_BINARY_COVERAGE` is unchanged in PR A — resolve appends nothing, so no class
moves. If a test fails demanding a coverage change, re-read it: the correct fix is the comment, not
the vector.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/http-openapi.ts \
        packages/gateway/src/egress/egress-coverage.ts \
        packages/cli/src/commands/prove.ts
git commit -m "document the resolve route and its no-egress narrowing"
```

---

### Task 6: PR A docs — schema reference, design correction, CHANGELOG

**Files:**

- Modify: `docs/architecture.md` (schema reference section)
- Modify: `docs/superpowers/specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (the `schema V51` → `V52` status line)

- [ ] **Step 1: Update the schema reference**

In `docs/architecture.md`, find the `item` table description (`grep -n "canonical_url" docs/architecture.md`)
and add the column plus the index:

```text
| `resolve_key` | TEXT | `canonicalizeUrl(canonical_url ?? url)`, NULL when both are null. Indexed by `idx_item_resolve_key`. Derived in `upsertIndexedItem` — the single SQL write site — and backfilled by V52. Matched by `GET /v1/items/resolve`. |
```

Bump the schema-version reference in that document to **V52**.

- [ ] **Step 2: Correct the design doc — the four verified errors**

Edit `docs/superpowers/specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md`:

1. §4 "**Migration V50**" → "**Migration V52**", and in Sequencing item 3 "V50 `resolve_key`" →
   "V52 `resolve_key`". Add after the first sentence of §4's *Storage* paragraph:

   > **Corrected 2026-08-07:** this section said V50. V50 is a retired permanent no-op and V51 is
   > the ownership graph (#1064), so the resolve migration is **V52**. Verified against
   > `index/migrations/runner.ts`, whose last step is `simpleStep(50, 51, …)`.

2. §4 *Storage*: replace "Written at exactly one site — `upsertIndexedItemForSync`, the chokepoint
   V48/V49 established — so no connector can forget it and no connector changes." with:

   > Written at exactly one site — **`upsertIndexedItem`**, the SQL writer that
   > `upsertIndexedItemForSync` delegates to — so no connector can forget it and no connector
   > changes. **Corrected 2026-08-07:** this section named `upsertIndexedItemForSync`, which is the
   > depth-applying *wrapper*, not the write site. Three other non-test callers reach the writer
   > directly — `clips/clip-ingest.ts`, `briefs/brief-save.ts`, `glossary/glossary-project.ts` —
   > plus `upsertNimbusItemIntoItemTable` for filesystem items. Deriving the key in the wrapper
   > would have left **every web clip** unresolvable, which is the browser panel's primary case and
   > the one item type whose identity already is a canonicalized URL.

3. §5 *host boundary*: replace "GitLab is not among them, so self-hosted GitLab is unreachable
   today either way." with:

   > **Corrected 2026-08-07:** GitLab *is* reachable. `connector-secrets-manifest.ts` lists
   > `gitlab: ["gitlab.pat", "gitlab.api_base"]`, and `_lib/gitlab/events.ts` already exports
   > `webOriginFromApiBase()` to derive the web origin from it. The secret is named `api_base`, not
   > `base_url`, so a host map built by scanning for `*.base_url` silently misses GitLab — the map
   > names each service's secret key explicitly instead.

4. §4 *Matching*: add after the `canonicalizeUrl` sentence:

   > **Note (2026-08-07):** `canonicalizeUrl` does not throw — unparseable input is returned
   > verbatim. So `unresolvable_url` cannot be inferred from its output; the route parses with
   > `new URL()` and rejects non-`http(s)` schemes *before* canonicalizing. Without that check a
   > non-URL string would match a row whose stored key is that same string.

5. In *Open questions*, resolve the Jira one:

   > **Resolved 2026-08-07: Jira is in the starter set,** bounded to `<base>/browse/<KEY>-<N>` and a
   > `selectedIssue=<KEY>-<N>` query param, returning `unsupported_url` for other shapes. Jira's
   > host boundary is the *least* ambiguous of the five — it is exactly the origin of the
   > Vault-stored `jira.base_url`, with no SaaS host to guess. The URL variance is real but lives in
   > the deep-link shapes, and declining those explicitly is what `unsupported_url` is for.

- [ ] **Step 3: Update `docs/CHANGELOG.md`**

Add under the current unreleased heading (match the file's existing format exactly):

```markdown
- **Resolve-by-URL** (`GET /v1/items/resolve`, `resolve` token scope). Schema **V52** adds the
  derived `item.resolve_key` (`canonicalizeUrl(canonical_url ?? url)`) plus `idx_item_resolve_key`,
  written at the single `upsertIndexedItem` SQL chokepoint and backfilled row-wise inside the
  migration. Matching is a bounded ladder — exact key, all query params dropped, then up to three
  trimmed trailing path segments — where a non-unique trim answers `ambiguous` with at most five
  candidates (over the cap: `truncated: true` and no list) rather than guessing. Returns metadata
  only, never a body, and appends no egress row.
```

- [ ] **Step 4: Bump the schema version in the two context files**

In both `CLAUDE.md` and `GEMINI.md`, change `schema V51` to `schema V52` in the Status line.

- [ ] **Step 5: Verify the docs gates**

Run: `bun run preflight:fast`
Expected: PASS. Then the link gate over the whole branch (a pre-existing broken link fails your PR):
`bun run audit:doc-refs` (confirm the exact script name with `grep -n "doc-refs\|lychee" package.json`).

- [ ] **Step 6: Full preflight and commit**

Run: `bun run preflight`
Expected: PASS. Fix anything red before committing — do not push a known-red branch.

```bash
git add docs/architecture.md docs/CHANGELOG.md CLAUDE.md GEMINI.md \
        docs/superpowers/specs/2026-08-06-http-agents-route-and-resolve-by-url-design.md \
        docs/superpowers/plans/2026-08-07-resolve-by-url-and-fetch-on-miss.md
git commit -m "docs: V52 schema reference, design corrections, changelog"
```

- [ ] **Step 7: Open PR A**

```bash
git push -u origin dev/asafgolombek/resolve-and-fetch-on-miss
```

PR title (this is the commit — release-please parses it):
`feat(gateway): resolve an indexed item by URL (V52 resolve_key)`

PR body must state the four design corrections, that resolve appends no egress row, and that every
browser paired today holds `LEGACY_SCOPES` and gets a distinguishable `403 insufficient_scope`
until it re-pairs with `nimbus clip pair --scopes resolve`.

---

## PR B — Fetch-on-miss

Branch from PR A's head:

```bash
git switch -c dev/asafgolombek/fetch-on-miss
```

### Task 7: The host boundary (the security gate)

**Files:**

- Create: `packages/gateway/src/sync/fetch-host-boundary.ts`
- Test: `packages/gateway/src/sync/fetch-host-boundary.test.ts`

**Interfaces:**

- Consumes: `readConnectorSecret` and `NimbusVault`. **Verified signature** — the plan's first draft
  named the wrong module:

  ```ts
  // packages/gateway/src/connectors/connector-vault.ts:101
  export async function readConnectorSecret<S extends ConnectorServiceId>(
    vault: NimbusVault, serviceId: S, keyName: ConnectorSecretKeyOf<S>,
  ): Promise<string | null>   // internally: vault.get(`${serviceId}.${keyName}`)
  ```

  So `keyName` is the bare key (`"pat"`, `"api_base"`, `"base_url"`), **without** the service
  prefix, and it is TYPE-CHECKED against `connector-secrets-manifest.ts`. A wrong key name is a
  compile error, not a runtime null — which is why `SERVICE_SECRETS` below is safe to write as
  literals.
- A test fake must implement **`get(fullKey)`**, not `getSecret`, and is keyed by the FULL
  `"<service>.<key>"` string.
- Produces:

  ```ts
  export type FetchableService = "github" | "gitlab" | "bitbucket" | "jenkins" | "jira";
  export const SAAS_HOSTS: Readonly<Record<string, FetchableService>>;
  export async function deriveFetchHostMap(vault: NimbusVault):
    Promise<ReadonlyMap<string, FetchableService>>;
  export function serviceForHost(
    map: ReadonlyMap<string, FetchableService>, host: string,
  ): FetchableService | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { deriveFetchHostMap, serviceForHost, SAAS_HOSTS } from "./fetch-host-boundary.ts";

/** `readConnectorSecret` calls `vault.get("<service>.<key>")` — so the fake keys on the FULL key. */
function fakeVault(secrets: Record<string, string>) {
  return {
    async get(fullKey: string): Promise<string | null> {
      return secrets[fullKey] ?? null;
    },
  } as unknown as Parameters<typeof deriveFetchHostMap>[0];
}

test("an unconfigured service is absent from the map entirely", async () => {
  const map = await deriveFetchHostMap(fakeVault({}));
  expect(serviceForHost(map, "github.com")).toBeNull();
  expect(map.size).toBe(0);
});

test("a configured SaaS service contributes its static host", async () => {
  const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
  expect(serviceForHost(map, "github.com")).toBe("github");
});

test("an arbitrary host never resolves — no first-segment guessing", async () => {
  const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
  // agents/impact.ts's HOST_TO_SERVICE would answer "github" here via hostFirstSegment.
  // That is acceptable as a hint inside a brief and unacceptable as a gate on an outbound request.
  expect(serviceForHost(map, "github.evil.example")).toBeNull();
  expect(serviceForHost(map, "notgithub.com")).toBeNull();
});

test("a self-hosted Jenkins contributes the host of its Vault base_url", async () => {
  const map = await deriveFetchHostMap(
    fakeVault({ "jenkins.base_url": "https://ci.corp.example:8443/jenkins/" }),
  );
  expect(serviceForHost(map, "ci.corp.example:8443")).toBe("jenkins");
});

test("self-hosted GitLab is reachable via api_base, not base_url", async () => {
  // The design said GitLab was unreachable. The secret is `gitlab.api_base`.
  const map = await deriveFetchHostMap(
    fakeVault({ "gitlab.pat": "t", "gitlab.api_base": "https://git.corp.example/api/v4" }),
  );
  expect(serviceForHost(map, "git.corp.example")).toBe("gitlab");
  // gitlab.com stays reachable too: api_base defaults to gitlab.com when unset.
  expect(serviceForHost(map, "gitlab.com")).toBe("gitlab");
});

test("a Jira base_url host is matched case-insensitively", async () => {
  const map = await deriveFetchHostMap(fakeVault({ "jira.base_url": "https://Corp.Atlassian.NET" }));
  expect(serviceForHost(map, "corp.atlassian.net")).toBe("jira");
});

test("a malformed base_url contributes nothing rather than throwing", async () => {
  const map = await deriveFetchHostMap(fakeVault({ "jenkins.base_url": "not a url" }));
  expect(map.size).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/sync/fetch-host-boundary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
import { readConnectorSecret } from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Which services can serve a targeted fetch. Deliberately a CLOSED union, not `string`: adding a
 * service here without landing its `fetchOne` is a compile error at the dispatch table.
 */
export type FetchableService = "github" | "gitlab" | "bitbucket" | "jenkins" | "jira";

/**
 * Static SaaS hosts. EXACT hosts only — there is no wildcard, no suffix match and no
 * first-segment fallback.
 *
 * Explicitly NOT `agents/impact.ts`'s `HOST_TO_SERVICE`, which ends in
 * `HOST_TO_SERVICE[host] ?? hostFirstSegment` and so resolves an arbitrary host to a
 * plausible-looking service name. That is the difference between a hint inside a brief and a gate
 * on an outbound request: here a miss must mean "not fetchable", never "guess".
 */
export const SAAS_HOSTS: Readonly<Record<string, FetchableService>> = Object.freeze({
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
});

/**
 * The Vault secret that proves a service is CONFIGURED, and (where applicable) the secret whose
 * value carries a self-hosted origin.
 *
 * `gitlab` uses `api_base`, NOT `base_url` — the eleven-connector `base_url` convention does not
 * cover it, and a map built by scanning for `*.base_url` would silently omit self-hosted GitLab.
 * Naming the key per service is what makes that a decision rather than an accident.
 */
const SERVICE_SECRETS: Readonly<
  Record<FetchableService, { readonly credential: string; readonly origin?: string }>
> = Object.freeze({
  github: { credential: "pat" },
  gitlab: { credential: "pat", origin: "api_base" },
  bitbucket: { credential: "app_password" },
  jenkins: { credential: "base_url", origin: "base_url" },
  jira: { credential: "api_token", origin: "base_url" },
});

/** The host of a URL, lowercased, or null when the value is not a usable http(s) origin. */
function hostOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return null;
  }
  return u.host.toLowerCase();
}

/**
 * Builds the host→service map from what is ACTUALLY configured.
 *
 * Absent credentials, a service is not in the map at all — so the boundary is derived from the
 * machine's real configuration rather than declared in a list that can drift from it. Fail-closed
 * by construction: every path that cannot prove a service is configured contributes no entry.
 */
export async function deriveFetchHostMap(
  vault: NimbusVault,
): Promise<ReadonlyMap<string, FetchableService>> {
  const map = new Map<string, FetchableService>();
  for (const [service, keys] of Object.entries(SERVICE_SECRETS) as Array<
    [FetchableService, (typeof SERVICE_SECRETS)[FetchableService]]
  >) {
    const credential = await readConnectorSecret(vault, service, keys.credential);
    if (credential === null || credential.trim() === "") {
      continue;
    }
    for (const [host, saasService] of Object.entries(SAAS_HOSTS)) {
      if (saasService === service) {
        map.set(host, service);
      }
    }
    if (keys.origin !== undefined) {
      const origin = await readConnectorSecret(vault, service, keys.origin);
      const host = origin === null ? null : hostOf(origin);
      if (host !== null) {
        map.set(host, service);
      }
    }
  }
  return map;
}

/** Exact, case-insensitive host lookup. A miss is a refusal, never a guess. */
export function serviceForHost(
  map: ReadonlyMap<string, FetchableService>,
  host: string,
): FetchableService | null {
  return map.get(host.toLowerCase()) ?? null;
}
```

> `jenkins`'s `credential` and `origin` are both `base_url` by design: Jenkins has no
> credential-only secret that proves configuration independently of its origin, and reading the
> same key twice is cheaper than a special case. Confirm `readConnectorSecret`'s exact signature
> before writing this — if it takes `(vault, service, fullKey)` with the `<service>.` prefix
> included, pass `` `${service}.${keys.credential}` `` instead.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/sync/fetch-host-boundary.test.ts`
Expected: all seven PASS.

- [ ] **Step 5: Red-prove the no-guessing property against the real `impact.ts` behaviour**

```ts
test("the boundary refuses what impact.ts's hint map would accept", async () => {
  const map = await deriveFetchHostMap(fakeVault({ "github.pat": "t" }));
  for (const host of ["github.attacker.test", "jenkins.attacker.test", "jira.attacker.test"]) {
    expect(serviceForHost(map, host)).toBeNull();
  }
});
```

Run: `bun test packages/gateway/src/sync/fetch-host-boundary.test.ts -t "impact.ts"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/sync/fetch-host-boundary.ts \
        packages/gateway/src/sync/fetch-host-boundary.test.ts
git commit -m "derived host boundary for targeted connector fetch"
```

---

### Task 8: `fetchOne` on `Syncable` + GitHub and Bitbucket

**Files:**

- Modify: `packages/gateway/src/sync/types.ts:49-54`
- Modify: `packages/gateway/src/connectors/github-sync.ts`
- Modify: `packages/gateway/src/connectors/bitbucket-sync.ts`
- Test: `packages/gateway/src/connectors/github-sync.test.ts`,
  `packages/gateway/src/connectors/bitbucket-sync.test.ts`

**Interfaces:**

- Produces, in `sync/types.ts`:

  ```ts
  export type FetchOneResult =
    | { readonly status: "indexed"; readonly itemId: string }
    | { readonly status: "not_found" }
    | { readonly status: "unsupported_url" };
  ```

  and on `Syncable`: `fetchOne?(ctx: SyncContext, url: string): Promise<FetchOneResult>;`
- Consumes: `upsertPr` (exported, `github-sync.ts:184`) and `upsertFromPullRequest`
  (module-private, `bitbucket-sync.ts:97`). Both write through `upsertIndexedItemForSync`, so
  `resolve_key` is populated by the same write and the item is resolvable the instant it lands.

- [ ] **Step 1: Add the contract to `sync/types.ts`**

```ts
/**
 * The outcome of a TARGETED single-item fetch. Distinct arms because collapsing them is how a panel
 * ends up telling a user to check credentials that are fine.
 */
export type FetchOneResult =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unsupported_url" };

export interface Syncable {
  readonly serviceId: string;
  readonly defaultIntervalMs: number;
  readonly initialSyncDepthDays: number;
  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;
  /**
   * Fetch and index ONE item by its web URL.
   *
   * OPTIONAL, and the optionality does real work: 62 connectors do not move, and a service that
   * omits it makes `POST /v1/items/fetch` answer `no_targeted_fetch` rather than pretending. An
   * implementation MUST write through `upsertIndexedItemForSync` so index depth is enforced
   * centrally and `resolve_key` is populated by the same write.
   */
  fetchOne?(ctx: SyncContext, url: string): Promise<FetchOneResult>;
}
```

- [ ] **Step 2: Write the failing GitHub test**

```ts
test("github fetchOne indexes a PR url and makes it resolvable", async () => {
  const { ctx, db } = syncTestContext(); // existing helper in this file
  const syncable = createGithubSyncable({ /* match the file's existing options shape */ });
  // Serve one PR payload from the injected fetch seam this file already uses for sync tests.
  const out = await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/42");
  expect(out).toEqual({ status: "indexed", itemId: "github:o/r#42" });
  const row = db.query("SELECT resolve_key FROM item WHERE id = 'github:o/r#42'").get() as {
    resolve_key: string | null;
  };
  expect(row.resolve_key).toBe("https://github.com/o/r/pull/42");
});

test("github fetchOne declines a non-PR github url", async () => {
  const { ctx } = syncTestContext();
  const syncable = createGithubSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://github.com/o/r/actions/runs/1")).toEqual({
    status: "unsupported_url",
  });
});

test("github fetchOne reports not_found for a 404", async () => {
  const { ctx } = syncTestContext(); // configure the seam to 404
  const syncable = createGithubSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://github.com/o/r/pull/999")).toEqual({
    status: "not_found",
  });
});
```

Read the file's existing sync tests first and mirror their fetch-injection seam exactly — do not
introduce `mock.module`, which leaks process-globally in the combined run.

- [ ] **Step 3: Run to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts -t fetchOne`
Expected: FAIL — `syncable.fetchOne` is `undefined`.

- [ ] **Step 4: Implement GitHub's `fetchOne`**

Add above the syncable factory:

```ts
/**
 * `https://github.com/<owner>/<repo>/pull/<n>` — the only shape targeted fetch supports.
 *
 * Anchored and digit-bounded: the caller-supplied URL reaches an API path, so a permissive pattern
 * here is a request-forgery surface, not a convenience.
 */
const GITHUB_PR_URL_RE = /^https?:\/\/[^/]+\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull\/(\d{1,10})$/;
```

In the object returned by `createGithubSyncable`, add:

```ts
    async fetchOne(ctx: SyncContext, url: string): Promise<FetchOneResult> {
      const m = GITHUB_PR_URL_RE.exec(url);
      if (m === null) {
        return { status: "unsupported_url" };
      }
      const [, owner, repo, num] = m as unknown as [string, string, string, string];
      const pat = await readConnectorSecret(ctx.vault, "github", "pat");
      if (pat === null) {
        return { status: "not_found" };
      }
      await ctx.rateLimiter.acquire("github");
      const res = await connectorFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`,
        { headers: buildGithubEventHeaders(pat, null) },
      );
      if (res.status === 404) {
        return { status: "not_found" };
      }
      if (!res.ok) {
        return { status: "not_found" };
      }
      const payload = (await res.json()) as Record<string, unknown>;
      // Reuse the sync path's mapper: it writes through upsertIndexedItemForSync, so depth is
      // enforced centrally and resolve_key lands with the same write.
      upsertPr(ctx, `${owner}/${repo}`, payload, Date.now());
      return { status: "indexed", itemId: `github:${owner}/${repo}#${num}` };
    },
```

> Verify `upsertPr`'s exact parameter list and the item-id format it produces before finalising the
> `itemId` string — read `github-sync.ts:184-217` and copy, do not infer. If `upsertPr` returns the
> id, use its return value instead of rebuilding it.

- [ ] **Step 5: Run the GitHub tests**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: PASS, including pre-existing tests.

- [ ] **Step 6: Repeat for Bitbucket**

Same three tests, then the implementation. Bitbucket's canonical PR URL is
`https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>`; the mapper is `upsertFromPullRequest`
(`bitbucket-sync.ts:97`) and the API call pattern is the direct `fetch` at
`bitbucket-sync.ts:280` — reuse that call's auth header builder (`basicAuthHeader`) and its
existing pagination-SSRF hardening rather than adding a second fetch path.

```ts
const BITBUCKET_PR_URL_RE =
  /^https?:\/\/[^/]+\/([\w.-]{1,100})\/([\w.-]{1,100})\/pull-requests\/(\d{1,10})$/;
```

- [ ] **Step 7: Run both connector suites**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/sync/types.ts \
        packages/gateway/src/connectors/github-sync.ts \
        packages/gateway/src/connectors/bitbucket-sync.ts \
        packages/gateway/src/connectors/github-sync.test.ts \
        packages/gateway/src/connectors/bitbucket-sync.test.ts
git commit -m "optional Syncable.fetchOne, implemented for github and bitbucket"
```

---

### Task 9: `fetchOne` on GitLab, Jenkins and Jira

**Files:**

- Modify: `packages/gateway/src/connectors/{gitlab,jenkins,jira}-sync.ts`
- Test: the three matching `*-sync.test.ts` files

**Interfaces:**

- Consumes: `FetchOneResult`; GitLab's mapper in `_lib/gitlab/events.ts` plus
  `normalisedApiBase` / `webOriginFromApiBase`; `upsertJenkinsBuildRowIfNew`
  (`jenkins-sync.ts:101`), `jenkinsJobRoot`, `jenkinsGetJson`; `jiraIndexOneIssue`
  (`jira-sync.ts:246`), `loadJiraVaultCreds`.

- [ ] **Step 1: GitLab — write the failing tests**

GitLab's merge-request URL is `<webOrigin>/<namespace/path>/-/merge_requests/<iid>`. The namespace
can nest, so the pattern must allow slashes before the `/-/` separator and nothing after the iid.

```ts
const GITLAB_MR_URL_RE = /^https?:\/\/[^/]+\/([\w./-]{1,200})\/-\/merge_requests\/(\d{1,10})$/;
```

```ts
test("gitlab fetchOne indexes a merge request on a self-hosted origin", async () => {
  const { ctx, db } = syncTestContext({ secrets: {
    "gitlab.pat": "t", "gitlab.api_base": "https://git.corp.example/api/v4",
  } });
  const syncable = createGitlabSyncable({});
  const out = await syncable.fetchOne?.(ctx, "https://git.corp.example/grp/sub/proj/-/merge_requests/7");
  expect(out).toMatchObject({ status: "indexed" });
});

test("gitlab fetchOne declines an issue url", async () => {
  const { ctx } = syncTestContext({ secrets: { "gitlab.pat": "t" } });
  const syncable = createGitlabSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://gitlab.com/g/p/-/issues/7")).toEqual({
    status: "unsupported_url",
  });
});
```

Implementation: derive the API base with `normalisedApiBase(await readConnectorSecret(ctx.vault,
"gitlab", "api_base"))`, URL-encode the namespace path for the projects endpoint
(`/projects/${encodeURIComponent(path)}/merge_requests/${iid}`), `await ctx.rateLimiter.acquire("gitlab")`,
then call the same upsert the sync path uses.

- [ ] **Step 2: Run GitLab's tests, then implement, then re-run**

Run: `bun test packages/gateway/src/connectors/gitlab-sync.test.ts -t fetchOne`
Expected: FAIL first, PASS after.

- [ ] **Step 3: Jenkins — write the failing tests**

Jenkins build URL is `<base>/job/<name>/<n>/`, with nested folders as repeated `/job/` segments.

```ts
const JENKINS_BUILD_URL_RE = /^https?:\/\/[^/]+((?:\/job\/[\w.%-]{1,100}){1,10})\/(\d{1,10})\/?$/;
```

```ts
test("jenkins fetchOne indexes a build url", async () => {
  const { ctx } = syncTestContext({ secrets: {
    "jenkins.base_url": "https://ci.corp.example", "jenkins.username": "u",
    "jenkins.api_token": "t",
  } });
  const syncable = createJenkinsSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/12/")).toMatchObject({
    status: "indexed",
  });
});

test("jenkins fetchOne declines a job url with no build number", async () => {
  const { ctx } = syncTestContext({ secrets: { "jenkins.base_url": "https://ci.corp.example" } });
  const syncable = createJenkinsSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://ci.corp.example/job/build/")).toEqual({
    status: "unsupported_url",
  });
});
```

Implementation: reuse `jenkinsGetJson` against `<buildUrl>/api/json` and pass the payload to
`upsertJenkinsBuildRowIfNew`. Note that function's name — it is a no-op for an already-indexed
build, so `fetchOne` must still return `{status:"indexed", itemId}` in that case (the item IS
indexed, which is what the caller asked about). Read it before wiring and confirm the return.

- [ ] **Step 4: Run Jenkins's tests, then implement, then re-run**

- [ ] **Step 5: Jira — write the failing tests, bounded to two shapes**

```ts
/** `<base>/browse/<KEY>-<N>` — emitted by both Cloud and Server/DC. */
const JIRA_BROWSE_URL_RE = /^https?:\/\/[^/]+\/browse\/([A-Z][A-Z0-9_]{0,50}-\d{1,10})$/;
/** A board/backlog deep link carrying `selectedIssue=<KEY>-<N>`. */
const JIRA_SELECTED_ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,50}-\d{1,10}$/;
```

```ts
test("jira fetchOne indexes a /browse/ issue url", async () => {
  const { ctx } = syncTestContext({ secrets: {
    "jira.base_url": "https://corp.atlassian.net", "jira.email": "e", "jira.api_token": "t",
  } });
  const syncable = createJiraSyncable({});
  expect(await syncable.fetchOne?.(ctx, "https://corp.atlassian.net/browse/ENG-42")).toMatchObject({
    status: "indexed",
  });
});

test("jira fetchOne indexes a board deep link via selectedIssue", async () => {
  const { ctx } = syncTestContext({ secrets: {
    "jira.base_url": "https://corp.atlassian.net", "jira.email": "e", "jira.api_token": "t",
  } });
  const syncable = createJiraSyncable({});
  const url =
    "https://corp.atlassian.net/jira/software/c/projects/ENG/boards/1?selectedIssue=ENG-42";
  expect(await syncable.fetchOne?.(ctx, url)).toMatchObject({ status: "indexed" });
});

test("jira fetchOne declines a shape it does not support, rather than guessing a key", async () => {
  const { ctx } = syncTestContext({ secrets: {
    "jira.base_url": "https://corp.atlassian.net", "jira.email": "e", "jira.api_token": "t",
  } });
  const syncable = createJiraSyncable({});
  expect(
    await syncable.fetchOne?.(ctx, "https://corp.atlassian.net/projects/ENG/issues/?filter=all"),
  ).toEqual({ status: "unsupported_url" });
});
```

Implementation: extract the key from either shape, `GET <base>/rest/api/3/issue/<KEY>` using
`loadJiraVaultCreds`, then `jiraIndexOneIssue`. Return `not_found` on 404.

- [ ] **Step 6: Run Jira's tests, then implement, then re-run**

Run: `bun test packages/gateway/src/connectors/jira-sync.test.ts -t fetchOne`

- [ ] **Step 7: Time-bound the three new regexes**

Each pattern above has a bounded quantifier on every character class precisely so it cannot
backtrack quadratically; prove it rather than asserting it.

```ts
test("the fetchOne url patterns are linear on adversarial input", () => {
  const evil = `https://x/${"a/".repeat(20_000)}`;
  for (const re of [GITLAB_MR_URL_RE, JENKINS_BUILD_URL_RE, JIRA_BROWSE_URL_RE]) {
    const t0 = performance.now();
    re.exec(evil);
    expect(performance.now() - t0).toBeLessThan(100);
  }
});
```

Export the three constants for the test, or place the test in the same file. Run it:
`bun test packages/gateway/src/connectors -t "linear on adversarial"`

- [ ] **Step 8: Run all five connector suites and commit**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts packages/gateway/src/connectors/gitlab-sync.test.ts packages/gateway/src/connectors/bitbucket-sync.test.ts packages/gateway/src/connectors/jenkins-sync.test.ts packages/gateway/src/connectors/jira-sync.test.ts`

```bash
git add packages/gateway/src/connectors/gitlab-sync.ts \
        packages/gateway/src/connectors/jenkins-sync.ts \
        packages/gateway/src/connectors/jira-sync.ts \
        packages/gateway/src/connectors/gitlab-sync.test.ts \
        packages/gateway/src/connectors/jenkins-sync.test.ts \
        packages/gateway/src/connectors/jira-sync.test.ts
git commit -m "fetchOne for gitlab, jenkins and jira"
```

---

### Task 10: The targeted-fetch orchestrator + the `sync` egress appender

**Files:**

- Create: `packages/gateway/src/sync/targeted-fetch.ts`
- Modify: `packages/gateway/src/sync/scheduler.ts:640-680` (per-run append in `runJob`)
- Modify: `packages/gateway/src/egress/egress-coverage.ts` (`sync: "none"` → `"per-run"`)
- Modify: `packages/gateway/src/security-invariants.test.ts:1481`
- Modify: `packages/cli/src/commands/prove.ts` (`sync` label)
- Test: `packages/gateway/src/sync/targeted-fetch.test.ts`

**Interfaces:**

- Consumes: `deriveFetchHostMap`, `serviceForHost` (Task 7); `FetchOneResult` (Task 8);
  `appendEgressEntry` from `packages/gateway/src/egress/` (confirm the exact export name — D22
  confines it to `egress/*`, so this module must call it, never re-implement it).
- Produces:

  ```ts
  export type TargetedFetchOutcome =
    | { readonly status: "indexed"; readonly itemId: string }
    | { readonly status: "not_found" }
    | { readonly status: "unsupported_url" }
    | { readonly status: "no_targeted_fetch"; readonly service: string }
    | { readonly status: "not_configured" }
    | { readonly status: "rate_limited" };
  export async function targetedFetch(deps: TargetedFetchDeps, url: string):
    Promise<TargetedFetchOutcome>;
  ```

- [ ] **Step 1: Write the failing orchestrator tests**

```ts
test("an unconfigured host is not_configured, and no connector is called", async () => {
  let called = false;
  const out = await targetedFetch(depsWith({ hostMap: new Map(), onFetch: () => { called = true; } }),
    "https://github.com/o/r/pull/1");
  expect(out).toEqual({ status: "not_configured" });
  expect(called).toBe(false);
});

test("a configured service with no fetchOne answers no_targeted_fetch", async () => {
  const out = await targetedFetch(
    depsWith({ hostMap: new Map([["github.com", "github"]]), syncable: { /* no fetchOne */ } }),
    "https://github.com/o/r/pull/1",
  );
  expect(out).toEqual({ status: "no_targeted_fetch", service: "github" });
});

test("an egress append failure aborts BEFORE the outbound call", async () => {
  let called = false;
  const deps = depsWith({
    hostMap: new Map([["github.com", "github"]]),
    appendEgress: () => { throw new Error("ledger down"); },
    syncable: { fetchOne: async () => { called = true; return { status: "not_found" as const }; } },
  });
  await expect(targetedFetch(deps, "https://github.com/o/r/pull/1")).rejects.toThrow();
  // Fail-closed: no row means no fetch.
  expect(called).toBe(false);
});

test("exactly one sync egress row is appended before a successful fetch", async () => {
  const rows: Array<{ destination: string; sourceType: string }> = [];
  const deps = depsWith({
    hostMap: new Map([["github.com", "github"]]),
    appendEgress: (r) => { rows.push(r); },
    syncable: { fetchOne: async () => ({ status: "indexed" as const, itemId: "github:o/r#1" }) },
  });
  expect(await targetedFetch(deps, "https://github.com/o/r/pull/1")).toEqual({
    status: "indexed", itemId: "github:o/r#1",
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ destination: "github", sourceType: "sync" });
});

test("a rate-limit rejection surfaces as rate_limited, not a failure", async () => {
  const deps = depsWith({
    hostMap: new Map([["github.com", "github"]]),
    acquire: async () => { throw new RateLimitError(new Date()); },
    syncable: { fetchOne: async () => ({ status: "indexed" as const, itemId: "x" }) },
  });
  expect(await targetedFetch(deps, "https://github.com/o/r/pull/1")).toEqual({
    status: "rate_limited",
  });
});

test("an unparseable url never reaches the host map", async () => {
  const out = await targetedFetch(depsWith({ hostMap: new Map([["github.com", "github"]]) }),
    "not a url");
  expect(out).toEqual({ status: "unsupported_url" });
});
```

Write `depsWith` as a local builder over an explicit `TargetedFetchDeps` type — dependency
injection, not `mock.module`, because this code is dispatcher-driven and `mock.module` leaks
process-globally in the combined CLI run on Linux.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/sync/targeted-fetch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

```ts
import { RateLimitError, type FetchOneResult, type SyncContext, type Syncable } from "./types.ts";
import { type FetchableService, serviceForHost } from "./fetch-host-boundary.ts";

export type TargetedFetchOutcome =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found" }
  | { readonly status: "unsupported_url" }
  | { readonly status: "no_targeted_fetch"; readonly service: string }
  | { readonly status: "not_configured" }
  | { readonly status: "rate_limited" };

export type TargetedFetchDeps = {
  readonly hostMap: ReadonlyMap<string, FetchableService>;
  readonly syncableFor: (service: FetchableService) => Syncable | undefined;
  readonly contextFor: (service: FetchableService) => SyncContext;
  /** Appends ONE `sync` egress row. Throwing aborts the fetch — fail-closed, no row no fetch. */
  readonly appendEgress: (row: { destination: string; sourceType: "sync"; method: string }) => void;
};

/**
 * Fetch and index one item named by a URL, server-side.
 *
 * The gateway re-derives `{service}` from the URL's HOST against the derived boundary and fetches
 * via THAT connector's API using its stored credential — it never dereferences the supplied URL and
 * never trusts a caller's classification.
 */
export async function targetedFetch(
  deps: TargetedFetchDeps,
  url: string,
): Promise<TargetedFetchOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: "unsupported_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { status: "unsupported_url" };
  }
  const service = serviceForHost(deps.hostMap, parsed.host);
  if (service === null) {
    // Absent credentials a service is not in the map at all, so "unknown host" and "service not
    // configured" are the same fact and get the same honest answer.
    return { status: "not_configured" };
  }
  const syncable = deps.syncableFor(service);
  if (syncable === undefined) {
    return { status: "not_configured" };
  }
  if (syncable.fetchOne === undefined) {
    return { status: "no_targeted_fetch", service };
  }
  // BEFORE the outbound call. A throw here propagates and no fetch happens.
  deps.appendEgress({ destination: service, sourceType: "sync", method: "items.fetch" });
  const ctx = deps.contextFor(service);
  // The SAME bucket the scheduler uses, so a targeted fetch can neither starve nor bypass it.
  //
  // `acquire` WAITS — it sleeps in a loop until tokens refill or a penalty window passes, and never
  // throws RateLimitError (verified: sync/rate-limiter.ts:278 / acquireUnderLock:291; it throws only
  // for a bad token count or an unknown provider). This route is synchronous with a bounded timeout,
  // so the wait must be bounded here. `acquire` is genuinely async (an awaited mutex plus sleepMs),
  // so racing it is sound — unlike a sync FFI call, which no Promise.race can ever bound.
  const acquired = await Promise.race([
    ctx.rateLimiter.acquire(service).then(() => true),
    deps.sleep(ACQUIRE_TIMEOUT_MS).then(() => false),
  ]);
  if (!acquired) {
    // The losing acquire() keeps running and will eventually take its token. That over-consumes the
    // bucket by one for a request we abandoned — deliberately the SAFE direction: it can only make
    // us more conservative against the provider, never let this path bypass or starve the scheduler.
    return { status: "rate_limited" };
  }
  const result: FetchOneResult = await syncable.fetchOne(ctx, url);
  return result;
}
```

Add to the module, and to `TargetedFetchDeps`:

```ts
/** How long a targeted fetch will wait for a rate-limit token before answering `rate_limited`. */
const ACQUIRE_TIMEOUT_MS = 5_000;
```

```ts
  /** Injected so the timeout is testable without real time. */
  readonly sleep: (ms: number) => Promise<void>;
```

`FetchableService` is a subset of `Provider` (`rate-limiter.ts:1-13` lists all five, and
`DEFAULT_QUOTAS` gives each a quota), so `acquire(service)` type-checks with no cast.

Replace the plan's earlier `RateLimitError` test with this one:

```ts
test("a rate-limit wait past the timeout answers rate_limited, not a hang", async () => {
  let fetched = false;
  const deps = depsWith({
    hostMap: new Map([["github.com", "github"]]),
    // Never resolves — models a saturated bucket.
    acquire: () => new Promise<void>(() => {}),
    sleep: async () => {},           // timeout fires immediately
    syncable: { fetchOne: async () => { fetched = true; return { status: "not_found" as const }; } },
  });
  expect(await targetedFetch(deps, "https://github.com/o/r/pull/1")).toEqual({
    status: "rate_limited",
  });
  expect(fetched).toBe(false);
});
```

Note `RateLimitError` is no longer imported by this module — drop it from the import list.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/sync/targeted-fetch.test.ts`
Expected: all six PASS.

- [ ] **Step 5: Add the scheduler's per-run appender**

`sync` rises to `per-run`, which needs BOTH appenders — the scheduler's and the targeted fetch's.
Without the scheduler one, the class would claim more than it delivers.

In `packages/gateway/src/sync/scheduler.ts` `runJob`, immediately before `connector.sync(...)`:

```ts
      // One `sync` egress row per RUN, appended before the connector makes any outbound call.
      // `per-run` is the honest granularity: a sync is a paginated run, not a call. Fail-closed —
      // a throw here aborts the run rather than syncing unrecorded.
      this.appendSyncEgress?.({
        destination: job.serviceId,
        sourceType: "sync",
        method: "sync.run",
      });
```

Inject `appendSyncEgress` through the scheduler's constructor options alongside `notify`, as an
optional closure, so existing tests construct unchanged.

- [ ] **Step 6: Write the scheduler appender test**

```ts
test("a sync run appends exactly one per-run sync egress row before syncing", async () => {
  const rows: unknown[] = [];
  const { scheduler, connector } = schedulerHarness({ appendSyncEgress: (r) => rows.push(r) });
  await scheduler.forceSync(connector.serviceId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ destination: connector.serviceId, sourceType: "sync" });
});

test("a failing egress append aborts the run", async () => {
  let synced = false;
  const { scheduler, connector } = schedulerHarness({
    appendSyncEgress: () => { throw new Error("ledger down"); },
    onSync: () => { synced = true; },
  });
  await scheduler.forceSync(connector.serviceId).catch(() => {});
  expect(synced).toBe(false);
});
```

Mirror the existing scheduler test harness in `packages/gateway/src/sync/scheduler.test.ts`.

- [ ] **Step 7: Raise the coverage class and re-pin the invariant**

In `packages/gateway/src/egress/egress-coverage.ts`:

```ts
export const THIS_BINARY_COVERAGE: CoverageVector = {
  task: "per-call",
  mcp: "per-call",
  http: "per-call",
  sync: "per-run",
  session: "none",
  model: "none",
  peer: "none",
};
```

Update that file's leading docstring: `THREE classes are non-`none`` → `FOUR`, and add a `sync`
paragraph:

```text
 * READ THE `sync` ENTRY AS `per-run`, WHICH IS WEAKER THAN `per-call` AND DELIBERATELY SO. It has
 * TWO appenders: the scheduler's sync-run boundary (`sync/scheduler.ts` `runJob`) and the targeted
 * single-item fetch (`sync/targeted-fetch.ts`, reached by `POST /v1/items/fetch`). A scheduled sync
 * is a paginated run that makes many upstream calls and appends ONE row, so the ledger proves that
 * a sync of that service happened in the window — not how many requests it made. A targeted fetch
 * appends one row for its one call. Both name the service id as `destination`.
```

In `packages/gateway/src/security-invariants.test.ts:1481`:

```ts
    expect([...claimed].sort()).toEqual(["http", "mcp", "sync", "task"]);
```

Read the comment above that line before editing — it calls widening this "a review moment, not a
test to re-bank". This is that moment, and the review is: both appenders exist and are tested in
Steps 4 and 6.

In `packages/cli/src/commands/prove.ts`, add the label:

```ts
  // `per-run`, not per-call: a scheduled sync appends ONE row for a whole paginated run. The label
  // says "runs" so a human reading `nimbus prove` does not read the count as a request count.
  sync: "connector sync runs and targeted item fetches",
```

- [ ] **Step 8: Run the coverage and invariant suites**

Run: `bun test packages/gateway/src/egress packages/gateway/src/security-invariants.test.ts packages/cli/src/commands/prove.test.ts packages/gateway/src/sync`
Expected: PASS. A failing `parseCoverage` test is expected only if it pins the old vector — check
whether it asserts the *value* (update it) or *graceful degradation across a mixed window* (must
still pass unchanged; `weakestCoverage` degrades `per-run` to `none`, which is the property that
lets this ship without a second `prove` blackout).

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/sync/targeted-fetch.ts \
        packages/gateway/src/sync/targeted-fetch.test.ts \
        packages/gateway/src/sync/scheduler.ts \
        packages/gateway/src/sync/scheduler.test.ts \
        packages/gateway/src/egress/egress-coverage.ts \
        packages/gateway/src/security-invariants.test.ts \
        packages/cli/src/commands/prove.ts
git commit -m "targeted-fetch orchestrator and the per-run sync egress appender"
```

---

### Task 11: `POST /v1/items/fetch` as an I13 write

**Files:**

- Modify: `packages/gateway/src/ipc/http-write-routes.ts`
- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (`ReadOnlyHttpServerOptions` + the write deps)
- Modify: `packages/gateway/src/platform/assemble.ts` (build the `fetchItem` closure)
- Test: `packages/gateway/src/ipc/http-write-routes.test.ts`, and a NEW
  `packages/gateway/test/integration/http/items-fetch-route.test.ts`

**Test placement + harness (corrected — an earlier draft named a path that never existed).** Route
tests live at `packages/gateway/test/integration/http/<route>-route.test.ts`, beside
`items-resolve-route.test.ts` and the four `{deployments-post,metrics-dora,openapi,preflight-deploy}`
siblings. **Reuse `startServerWithClipToken` from
`packages/gateway/src/ipc/http-api-test-server.ts`** and `makeInMemoryVault` from
`packages/gateway/test/helpers/in-memory-vault.ts` — both were extracted in Task 4 specifically so
this task does not make a fourth copy. Do NOT write a new harness; if the existing one cannot pass
the option this route needs, EXTEND it.

**Interfaces:**

- Consumes: `targetedFetch` (Task 10), `deriveFetchHostMap` (Task 7).
- Produces: `ROUTE_ITEMS_FETCH = "POST /v1/items/fetch"` on `WRITE_ROUTE_ALLOWLIST` at
  `MAX_BODY_BYTES_DEFAULT`; `ReadOnlyHttpServerOptions.fetchItem?: (url: string) =>
  Promise<TargetedFetchOutcome>`.

- [ ] **Step 1: Write the failing allowlist + scope tests**

```ts
test("the fetch route is an explicit I13 WRITE, not a reclassified read", () => {
  expect(WRITE_ROUTE_ALLOWLIST).toContain(ROUTE_ITEMS_FETCH);
  expect(ROUTE_ITEMS_FETCH).toBe("POST /v1/items/fetch");
});

test("the fetch route requires the fetch scope", () => {
  expect(HTTP_ROUTE_AUTH[ROUTE_ITEMS_FETCH]).toEqual({ kind: "clip", scope: "fetch" });
});

test("a resolve-scoped token cannot fetch", () => {
  expect(enforceClipScope(ROUTE_ITEMS_FETCH, ["resolve"])).toMatchObject({
    ok: false, status: 403, body: { error: "insufficient_scope", required: "fetch" },
  });
});

test("the fetch route uses the 8 KiB control-plane cap, not the article cap", () => {
  // A single URL is control-plane-sized; the 1 MiB article cap stays the deliberate outlier.
  expect(maxBodyBytesForRoute(ROUTE_ITEMS_FETCH)).toBe(8 * 1024);
});
```

Confirm the real name of the per-route cap accessor in `http-write-routes.ts` before writing the
last test — if the cap is an inline `switch`, assert through the dispatcher with a 9 KiB body
expecting `413 payload_too_large` instead.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/ipc/http-write-routes.test.ts -t fetch`
Expected: FAIL — `ROUTE_ITEMS_FETCH` is not exported.

- [ ] **Step 3: Wire the route constant, allowlist entry and cap**

In `http-write-routes.ts`, beside the other `ROUTE_*` constants:

```ts
/**
 * Targeted single-item fetch. An explicit I13 WRITE: it causes an OUTBOUND request to a configured
 * provider and a row in the local index. It is deliberately NOT modelled as a read that happens to
 * have side effects — that reclassification is exactly how a write slips past the allowlist.
 */
export const ROUTE_ITEMS_FETCH = "POST /v1/items/fetch";
```

Add `ROUTE_ITEMS_FETCH` to `WRITE_ROUTE_ALLOWLIST`. Leave it on `MAX_BODY_BYTES_DEFAULT` — do not
add it to the article-cap set.

Add the dispatch arm, following the `clipIngest` arm's shape: parse `{url: string}` from the body,
reject a non-string or absent `url` with `400 {error:"missing_url"}`, call the injected
`fetchItem`, and map the outcome to a status:

```ts
// `indexed` → 200; every miss → 200 with its own named status, because a miss is a legitimate
// answer to a well-formed request, not a client error. Only a malformed body is a 4xx.
```

In `http-route-auth.ts`:

```ts
  // Write. An outbound provider request under its own scope — a `resolve`-scoped token cannot
  // trigger one, which is the point of splitting the two scopes.
  [ROUTE_ITEMS_FETCH]: { kind: "clip", scope: "fetch" },
```

- [ ] **Step 4: Add the option and thread it through**

In `ReadOnlyHttpServerOptions`:

```ts
  // Targeted fetch-on-miss. Absent => POST /v1/items/fetch 404s (surface not mounted). Built at
  // assemble time because it needs the scheduler's syncables, its SyncContext and its rate-limiter
  // bucket — the HTTP layer must not reach into connectors or the Vault itself.
  readonly fetchItem?: (url: string) => Promise<TargetedFetchOutcome>;
```

Add `opts.fetchItem === undefined` to the `writeDb` gate's condition list so the writable handle
opens when only this surface is enabled.

In `packages/gateway/src/platform/assemble.ts`, where the HTTP server is started, build the closure:

```ts
    // The host map is derived from the Vault per call rather than cached: credentials can change
    // (or be revoked) while the gateway runs, and a cached boundary would keep authorising a
    // service after its credential was removed. Deriving costs a few Vault reads on a route that
    // makes a network request anyway.
    fetchItem: async (url: string) =>
      targetedFetch(
        {
          hostMap: await deriveFetchHostMap(vault),
          syncableFor: (service) => scheduler.syncableFor(service),
          contextFor: (service) => scheduler.syncContextFor(service),
          appendEgress: (row) => appendEgressEntry(db, row),
        },
        url,
      ),
```

`scheduler.syncableFor` / `syncContextFor` do not exist yet — add them as small public readers on
the scheduler beside the existing accessors, returning the registered connector and a
`SyncContext` with `depth: this.getDepthForService(service)`. That reuse is what keeps depth
enforcement and the rate-limiter bucket shared with scheduled syncs.

- [ ] **Step 5: Write the failing end-to-end route tests**

```ts
test("POST /v1/items/fetch indexes and returns the item id", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["fetch"], {
    fetchItem: async () => ({ status: "indexed", itemId: "github:o/r#1" }),
  });
  const res = await fetch(`${baseUrl}/v1/items/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/o/r/pull/1" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "indexed", itemId: "github:o/r#1" });
  stop();
});

test("POST /v1/items/fetch 403s a legacy token distinguishably from a 401", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["clip", "briefs"], {
    fetchItem: async () => ({ status: "indexed", itemId: "x" }),
  });
  const res = await fetch(`${baseUrl}/v1/items/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/o/r/pull/1" }),
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "fetch" });
  stop();
});

test("POST /v1/items/fetch 404s when the surface is not wired", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["fetch"]); // no fetchItem
  const res = await fetch(`${baseUrl}/v1/items/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://github.com/o/r/pull/1" }),
  });
  expect(res.status).toBe(404);
  stop();
});

test("POST /v1/items/fetch 400s a body with no url", async () => {
  const { baseUrl, token, stop } = await startServerWithClipToken(["fetch"], {
    fetchItem: async () => ({ status: "indexed", itemId: "x" }),
  });
  const res = await fetch(`${baseUrl}/v1/items/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  stop();
});
```

- [ ] **Step 6: Run the route tests**

Run: `bun test packages/gateway/src/ipc/http-write-routes.test.ts packages/gateway/test/http-api.test.ts`
Expected: PASS, including the route→scope completeness test and the
`WRITE_ROUTE_ALLOWLIST`-count assertion (that count changes — update it, and read the comment
beside it first).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/http-write-routes.ts \
        packages/gateway/src/ipc/http-route-auth.ts \
        packages/gateway/src/ipc/http-server.ts \
        packages/gateway/src/platform/assemble.ts \
        packages/gateway/src/sync/scheduler.ts \
        packages/gateway/src/ipc/http-write-routes.test.ts \
        packages/gateway/test/http-api.test.ts
git commit -m "POST /v1/items/fetch as an explicit I13 write under the fetch scope"
```

---

### Task 12: PR B docs — I29, OpenAPI, CHANGELOG, and the `--scopes` path

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (I29)
- Modify: `CLAUDE.md`, `GEMINI.md` (I29 summary line)
- Modify: `docs/architecture.md` (IPC/HTTP route catalogue)
- Modify: `docs/cli-reference.md` (`nimbus clip pair --scopes`)
- Modify: `docs/CHANGELOG.md`
- Modify: the OpenAPI document

- [ ] **Step 1: Extend I29 in `docs/SECURITY-INVARIANTS.md`**

Add to the I29 section, after the `mcp`/`http` coverage-class paragraph:

```markdown
A THIRD append path covers targeted connector traffic, and it raises the `sync` coverage class from
`none` to `per-run`. Two appenders share the class:

- `sync/scheduler.ts` `runJob` appends one row per scheduled sync RUN, before the connector makes
  any outbound call. `per-run` is the honest granularity — a sync is a paginated run, not a call, so
  the ledger proves a sync of that service happened in the window, not how many requests it made.
- `sync/targeted-fetch.ts` appends one row per targeted single-item fetch, reached only through
  `POST /v1/items/fetch`.

Both name the service id as `destination`, and both are fail-closed: an append failure propagates
and the outbound call never happens.

**The host boundary is part of I29's fail-closed posture, not a separate concern.** A targeted fetch
resolves `{service}` from the URL's HOST against a map DERIVED from configured connector
credentials (`sync/fetch-host-boundary.ts`): static SaaS hosts for github/gitlab/bitbucket, union
the host of each service's Vault-stored origin secret (`jenkins.base_url`, `jira.base_url`,
`gitlab.api_base`). Absent credentials a service is not in the map at all, so an unknown host and an
unconfigured service are the same fact. The map is EXACT-match with no wildcard, no suffix match and
no first-segment fallback — deliberately unlike `agents/impact.ts`'s `HOST_TO_SERVICE`, whose
`?? hostFirstSegment` fallback is acceptable as a hint inside a brief and unacceptable as a gate on
an outbound request. The gateway re-derives `{service, kind, externalId}` server-side, never trusts
a caller's classification, and fetches via that connector's API using its stored credential — never
by dereferencing the supplied URL.

Targeted fetch is NOT HITL-gated, and that is a decision with a stated basis: the owner already
authorised continuous sync of that service with those credentials, so fetching one already-in-scope
item is strictly less than what runs on a timer. It is bounded instead by the `fetch` token scope
(never granted to a legacy token), `ProviderRateLimiter.acquire(service)` on the same bucket the
scheduler uses, and the derived host boundary. HITL was rejected on the ground that an external
caller should not originate a consent prompt on the owner's machine.
```

- [ ] **Step 2: Update the I29 one-liner in both context files**

In `CLAUDE.md` and `GEMINI.md`, append to the I29 bullet: the third append path, the `sync`
`per-run` class and `sync/fetch-host-boundary.ts` as the host gate. Keep the existing wording
intact — add, do not rewrite.

- [ ] **Step 3: Add both routes to the OpenAPI document and the route catalogue**

Add `POST /v1/items/fetch` to the OpenAPI file (bearer security, `{url}` body, the six-arm outcome
union) and to `docs/architecture.md`'s HTTP route table alongside `GET /v1/items/resolve`.

- [ ] **Step 4: Document the re-pair path in `docs/cli-reference.md`**

Under `nimbus clip pair`, state the consumer-facing consequence explicitly:

```markdown
`--scopes <list>` records the scopes on the pairing window; `POST /v1/clips/pair/confirm` mints with
*the window's* scopes and ignores anything in the request body.

**Existing paired clients do not gain new scopes.** A token stored in the pre-scopes bare-string
form resolves to exactly `clip,briefs`, so a browser paired before this release gets
`403 {"error":"insufficient_scope","required":"resolve"}` from `GET /v1/items/resolve` and the same
for `fetch`. That is structurally distinct from `401 {"error":"unauthorized"}`, so a client can tell
"re-pair for a wider scope" from "this token is invalid". Two ways forward, both owner-controlled:

- `nimbus clip pair --scopes clip,briefs,resolve,fetch` — mint a fresh token.
- `nimbus clip scopes <label> --set clip,briefs,resolve` — rewrite one entry's scopes in place. The
  token value does not change, so the paired client keeps working.
```

Verify both commands exist as written before documenting them (`grep -rn "clip scopes\|--scopes"
packages/cli/src`). **If `nimbus clip scopes` was not built in #1062, do not document it** — say so
in the PR description as a gap instead. Documenting a command that does not exist is worse than
noting its absence.

- [ ] **Step 5: Update `docs/CHANGELOG.md`**

```markdown
- **Targeted fetch-on-miss** (`POST /v1/items/fetch`, `fetch` token scope, explicit `I13` write).
  `Syncable` gains an optional `fetchOne`, implemented for github, gitlab, bitbucket, jenkins and
  jira; the other 62 connectors are untouched and answer `no_targeted_fetch`. A URL is fetchable
  only when its host maps to a CONFIGURED connector — static SaaS hosts plus the host of each
  service's Vault-stored origin secret (`jenkins.base_url`, `jira.base_url`, `gitlab.api_base`) —
  with exact matching and no guessing fallback. The gateway re-derives the service server-side and
  fetches through that connector's API with its stored credential, never by dereferencing the
  supplied URL. Egress class `sync` rises from `none` to `per-run`, with appenders at the
  scheduler's sync-run boundary and at the targeted fetch (`I29`).
```

- [ ] **Step 6: Full verification before pushing**

Run, in order, and fix anything red before moving on:

```bash
bun run preflight:fast
bun run audit:invariants
bun test packages/gateway/src/sync packages/gateway/src/egress packages/gateway/src/ipc packages/gateway/src/connectors
bun run preflight
```

Then the Linux-authoritative gate, because `audit:coverage-floor` is CI-Linux-authoritative and
this PR adds several new source files:

```bash
bun run verify:docker
```

- [ ] **Step 7: Commit and open PR B**

```bash
git add docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md docs/architecture.md \
        docs/cli-reference.md docs/CHANGELOG.md
git commit -m "docs: I29 third append path, host boundary, fetch route"
git push -u origin dev/asafgolombek/fetch-on-miss
```

PR title: `feat(gateway): targeted fetch-on-miss behind a derived host boundary`

PR body must state: the base is PR A (review that first); the host boundary is the security
property and why it is derived rather than declared; that `sync` rose to `per-run` with both
appenders landed and tested; the Jira scope bound; and that no `prove` blackout occurs because
`weakestCoverage` degrades a value change gracefully.

---

## Self-review notes

**Spec coverage.** §4 → Tasks 1–5. §5 → Tasks 7–11. §2's `sync` class raise → Task 10. §6's test
table: ledger totality/attribution/fail-closed already shipped in #1063; resolve ladder → Task 3;
ambiguity cap → Task 3; migration + migration atomicity → Task 1; host boundary → Task 7; scope
completeness → Tasks 4 and 11. **Deliberately out of scope, unchanged from the design:** `D22(d)`,
the `_lib` no-re-export assertion, the agent-run lifecycle and the coverage-skew test all landed in
PR 2 (#1063); this plan does not re-do them.

**Known gaps carried forward rather than silently inherited.** The `agents.*` validators still
ignore unrecognised keys (pre-existing IPC semantics, §6). Agent cancellation still does not exist.
`metadata_only` redaction's two unfixed privacy defects are untouched — which is exactly why resolve
returns metadata only and never a body.

**Two things to confirm at execution time**, both flagged inline where they matter rather than
assumed here: `readConnectorSecret`'s exact signature (Task 7 Step 3) and
`ProviderRateLimiter.acquire`'s throw-vs-wait contract (Task 10 Step 3). Neither changes the design;
both change a few lines of code.
