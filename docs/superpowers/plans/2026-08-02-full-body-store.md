# Full-Body Store (V48) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `item.body` column holding up to 16 KiB for prose item types so keyword search, `nimbus glossary` and `nimbus decisions` stop being capped at 512 characters, while the embedding pipeline stays untouched and embedding egress stays exactly flat.

**Architecture:** `body_preview` becomes a derived 512-character prefix of a new `body` column, never written independently. FTS5 re-points at `body`. Every other reader — embeddings, federation, the relationship graph, `run-ask`, `why`/`expert`/`impact` — keeps reading `body_preview` and is not modified, so their current bounded behaviour is preserved by construction rather than by a clamp someone must remember.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, `bun:sqlite`, FTS5, Biome, `bun test`.

**Spec:** [`2026-08-02-full-body-store-design.md`](../specs/2026-08-02-full-body-store-design.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** (`db/write.ts`) — invariant **I14**, enforced statically by `scripts/structure-audit/check-nimbus-invariants.ts`. Never call `db.run(...)` directly in new code.
- **Bound parameters only**; identifiers via `escapeIdentifier` — invariant **I9**.
- **Never commit on `main`.** All work happens on `dev/asafgolombek/full-body-store` in the worktree at `.claude/worktrees/full-body-store`.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Source-scanning guards must read via `import.meta.dir`**, never `process.cwd()` — a CWD-relative read is ENOENT under the sharded CI runner and the guard silently never runs.
- **Every guard must be red-proved**: temporarily break the thing it guards, watch it fail, restore.
- `BODY_MAX_PROSE = 16384`, `BODY_MAX_DEFAULT = 512`, `BODY_PREVIEW_MAX = 512` — exact values.
- Run `bun run preflight:fast` after each task; `bun run preflight` before opening any PR.

## File Structure

**PR 1 — Substrate**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/body-caps.ts` (create) | SSoT for the two caps, per-type cap lookup, surrogate-safe clamp |
| `packages/gateway/src/index/body-caps.test.ts` (create) | Unit tests for the above |
| `packages/gateway/src/index/body-store-v48-sql.ts` (create) | The V48 SQL statement list |
| `packages/gateway/src/index/migrations/runner.ts` (modify) | Wire `simpleStep(47, 48, …)` |
| `packages/gateway/src/index/migrations/runner-v48.test.ts` (create) | Migration tests, incl. the non-regression assertion |
| `packages/gateway/src/index/local-index.ts:265` (modify) | `CURRENT_SCHEMA_VERSION` 47 → 48 |
| `packages/gateway/src/index/item-store.ts` (modify) | `body`/`bodyPreview` input union, derived preview, `body_complete` |
| `packages/gateway/src/index/item-store-body.test.ts` (create) | Store-level behaviour tests |
| `packages/gateway/src/search/hybrid-internal.ts:61` (modify) | FTS MATCH column `body_preview` → `body` |
| `packages/gateway/src/index/item-list-query.ts:37` (modify) | Explicit column list, no `body` |
| `packages/gateway/src/ipc/http-server.ts:144` (modify) | Explicit column list, **with** `body` |
| `packages/gateway/src/index/local-index.ts:453,539,698` (modify) | Explicit column lists, no `body` |
| `packages/gateway/src/connectors/reindex.ts:21-27` (modify) | `metadata_only` clears `body` + `body_complete` too |
| `packages/gateway/src/embedding/embedding-body-source.guard.test.ts` (create) | Guard: embedding path never reads `body` |
| `packages/gateway/src/federation/federation-body-source.guard.test.ts` (create) | Guard: query gate never reads `body` |
| `packages/gateway/src/db/metrics.ts` (modify) | `bodyBytes` + `ftsIndexBytes` counters |

**PR 2 — Connectors** — `slack-sync.ts`, `_lib/teams/api.ts`, `discord-sync.ts`, `linear-sync.ts`, `jira-sync.ts`, `github-sync.ts`, `bitbucket-sync.ts`, `snyk-issue-mapping.ts`, `obsidian-sync.ts`, `zoom-transcript-mapping.ts`, plus the web-clip and research-brief write paths.

**PR 3 — Backfill** — `packages/gateway/src/ipc/index-rebody-rpc.ts` (create), `packages/cli/src/commands/index-cmd.ts` (modify).

---

# PR 1 — Substrate

No connector changes. `body` is a copy of `body_preview`, so observable behaviour is identical to today and nothing can regress.

---

### Task 1: Body caps and surrogate-safe clamp

**Files:**
- Create: `packages/gateway/src/index/body-caps.ts`
- Test: `packages/gateway/src/index/body-caps.test.ts`

**Interfaces:**
- Consumes: `PROSE_HEAVY_TYPES` from `packages/gateway/src/embedding/routing.ts` (a leaf constants module with no imports — no dependency cycle).
- Produces: `BODY_MAX_PROSE: 16384`, `BODY_MAX_DEFAULT: 512`, `BODY_PREVIEW_MAX: 512`, `bodyCapForItemType(service: string, type: string): number`, `clampBody(text: string, max: number): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/body-caps.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  BODY_MAX_DEFAULT,
  BODY_MAX_PROSE,
  bodyCapForItemType,
  clampBody,
} from "./body-caps.ts";

test("prose types get the 16 KiB cap and everything else gets 512", () => {
  expect(bodyCapForItemType("slack", "message")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("notion", "page")).toBe(BODY_MAX_PROSE);
  expect(bodyCapForItemType("aws", "resource")).toBe(BODY_MAX_DEFAULT);
  expect(bodyCapForItemType("argocd", "application")).toBe(BODY_MAX_DEFAULT);
});

test("text at or under the cap is returned unchanged", () => {
  const t = "a".repeat(512);
  expect(clampBody(t, 512)).toBe(t);
  expect(clampBody("", 512)).toBe("");
});

test("text over the cap is cut to the cap", () => {
  expect(clampBody("a".repeat(600), 512)).toHaveLength(512);
});

test("a surrogate pair straddling the cap is not split", () => {
  // "😀" is one code point stored as two UTF-16 code units.
  const straddling = `${"a".repeat(511)}😀`;
  expect(straddling).toHaveLength(513);

  const clamped = clampBody(straddling, 512);

  expect(clamped).toHaveLength(511);
  // A lone surrogate is not representable in UTF-8; round-tripping proves it is absent.
  expect(Buffer.from(clamped, "utf8").toString("utf8")).toBe(clamped);
});

test("a surrogate pair wholly inside the cap is preserved", () => {
  const inside = `${"a".repeat(510)}😀`;
  expect(clampBody(inside, 512)).toBe(inside);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd .claude/worktrees/full-body-store
bun test packages/gateway/src/index/body-caps.test.ts
```

Expected: FAIL — `Cannot find module './body-caps.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/index/body-caps.ts`:

```ts
import { PROSE_HEAVY_TYPES } from "../embedding/routing.ts";

/** Cap for paragraph-shaped item types (`PROSE_HEAVY_TYPES`). */
export const BODY_MAX_PROSE = 16_384;

/** Cap for everything else — unchanged from the pre-V48 behaviour. */
export const BODY_MAX_DEFAULT = 512;

/** `item.body_preview` is always this many code units of `item.body`. */
export const BODY_PREVIEW_MAX = 512;

export function bodyCapForItemType(service: string, type: string): number {
  return PROSE_HEAVY_TYPES.has(`${service}:${type}`) ? BODY_MAX_PROSE : BODY_MAX_DEFAULT;
}

/**
 * Clamp to `max` UTF-16 code units without splitting a surrogate pair.
 *
 * A bare `slice(0, max)` can leave a lone high surrogate, which is not
 * representable in UTF-8 and corrupts the value on its way into SQLite. If the
 * last retained unit is a high surrogate its low partner is being cut, so drop
 * it too.
 */
export function clampBody(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const last = text.charCodeAt(max - 1);
  const isHighSurrogate = last >= 0xd8_00 && last <= 0xdb_ff;
  return text.slice(0, isHighSurrogate ? max - 1 : max);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/index/body-caps.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/body-caps.ts packages/gateway/src/index/body-caps.test.ts
git commit -m "feat(index): body cap SSoT with surrogate-safe clamping"
```

---

### Task 2: V48 migration

**Files:**
- Create: `packages/gateway/src/index/body-store-v48-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Modify: `packages/gateway/src/index/local-index.ts:265`
- Test: `packages/gateway/src/index/migrations/runner-v48.test.ts`

**Interfaces:**
- Produces: `BODY_STORE_V48_SQL: readonly string[]`; schema version 48; `item.body TEXT`; `item.body_complete INTEGER NOT NULL DEFAULT 0`; `item_fts` indexing `(title, body)`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v48.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("V48 adds item.body and item.body_complete", () => {
  const db = migrated();
  const cols = (
    db.query("PRAGMA table_info(item)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  expect(cols).toContain("body");
  expect(cols).toContain("body_complete");
  db.close();
});

test("V48 points item_fts at body, not body_preview", () => {
  const db = migrated();
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='item_fts'")
    .get() as { sql: string } | null;
  expect(row?.sql).toContain("body");
  expect(row?.sql).not.toContain("body_preview");
  db.close();
});

test("V48 defaults body_complete to 0 for a freshly inserted row", () => {
  const db = migrated();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','t','hello',1,1)`,
  );
  const row = db.query("SELECT body_complete FROM item WHERE id='slack:1'").get() as {
    body_complete: number;
  };
  expect(row.body_complete).toBe(0);
  db.close();
});

test("V48 preserves keyword coverage for rows indexed before the upgrade", () => {
  // The regression this guards: rebuilding item_fts against a NULL `body`
  // would drop every pre-existing row's coverage down to its title alone.
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 47);

  const haystack = `${"filler ".repeat(50)}kumquat ${"filler ".repeat(10)}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','a title',?,1,1)`,
    [haystack.slice(0, 512)],
  );

  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

  const hits = db
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'kumquat'")
    .all() as Array<{ rowid: number }>;
  expect(hits).toHaveLength(1);

  const migrate = db.query("SELECT body FROM item WHERE id='slack:1'").get() as {
    body: string | null;
  };
  expect(migrate.body).toBe(haystack.slice(0, 512));
  db.close();
});

test("V48 keeps the fts triggers in sync on insert, update and delete", () => {
  const db = migrated();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, modified_at, synced_at)
     VALUES ('slack:1','slack','message','1','t','alpha',1,1)`,
  );
  expect(
    db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'alpha'").all(),
  ).toHaveLength(1);

  db.run("UPDATE item SET body = 'bravo' WHERE id='slack:1'");
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'alpha'").all()).toHaveLength(0);
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'bravo'").all()).toHaveLength(1);

  db.run("DELETE FROM item WHERE id='slack:1'");
  expect(db.query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'bravo'").all()).toHaveLength(0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/index/migrations/runner-v48.test.ts
```

Expected: FAIL — `item` has no `body` column; `CURRENT_SCHEMA_VERSION` is still 47.

- [ ] **Step 3: Write the migration SQL**

Create `packages/gateway/src/index/body-store-v48-sql.ts`:

```ts
/**
 * V48 — `item.body` (up to 16 KiB for prose types) + `item.body_complete`,
 * with `item_fts` re-pointed from `body_preview` to `body`.
 *
 * `UPDATE item SET body = body_preview` runs BEFORE the rebuild and is
 * load-bearing: FTS5 external-content tables pull columns by name from the
 * content table, so rebuilding against a still-NULL `body` would silently
 * reduce every existing row's keyword coverage to its title alone. Seeding it
 * first makes the upgrade strictly non-regressive.
 *
 * `body_complete` deliberately stays 0 for every migrated row. It is a claim a
 * connector makes about the fetch it performed, and cannot be inferred from the
 * stored artefact — a body under 512 characters may be a Notion page that was
 * never fetched at all (`bodyPreview: ""`) or Gmail's ~200-character API
 * snippet, neither of which is complete.
 *
 * Do NOT "optimise" this to
 * `body_complete = CASE WHEN length(body_preview) < 512 THEN 1 ELSE 0 END`.
 * It has been proposed twice and rejected twice; the full reasoning is in the
 * spec under "Rejected: inferring completeness from length at migration time".
 * Length 0 would flag every title-only Notion and Confluence page as complete
 * and exclude the worst-covered connectors in the index from backfill forever.
 */
export const BODY_STORE_V48_SQL: readonly string[] = [
  "ALTER TABLE item ADD COLUMN body TEXT",
  "ALTER TABLE item ADD COLUMN body_complete INTEGER NOT NULL DEFAULT 0",
  "UPDATE item SET body = body_preview",
  "DROP TRIGGER IF EXISTS item_fts_insert",
  "DROP TRIGGER IF EXISTS item_fts_delete",
  "DROP TRIGGER IF EXISTS item_fts_update",
  "DROP TABLE IF EXISTS item_fts",
  `CREATE VIRTUAL TABLE item_fts USING fts5(
     title,
     body,
     content='item',
     content_rowid='rowid'
   )`,
  "INSERT INTO item_fts(item_fts) VALUES('rebuild')",
  `CREATE TRIGGER item_fts_insert AFTER INSERT ON item BEGIN
     INSERT INTO item_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`,
  `CREATE TRIGGER item_fts_delete AFTER DELETE ON item BEGIN
     INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
   END`,
  `CREATE TRIGGER item_fts_update AFTER UPDATE ON item BEGIN
     INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
     INSERT INTO item_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`,
];
```

- [ ] **Step 4: Wire the step and bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add the import next to the other V4x imports:

```ts
import { BODY_STORE_V48_SQL } from "../body-store-v48-sql.ts";
```

Append to `INDEXED_SCHEMA_STEPS`, immediately after the `simpleStep(46, 47, …)` entry:

```ts
  simpleStep(
    47,
    48,
    "item.body + body_complete; item_fts over body (full-body store v48)",
    BODY_STORE_V48_SQL,
  ),
```

In `packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 48;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test packages/gateway/src/index/migrations/
```

Expected: PASS — the new V48 file plus every existing `runner-v*.test.ts` still green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/body-store-v48-sql.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/migrations/runner-v48.test.ts \
        packages/gateway/src/index/local-index.ts
git commit -m "feat(index): V48 adds item.body and repoints item_fts at it"
```

---

### Task 3: Store writes the body and derives the preview

**Files:**
- Modify: `packages/gateway/src/index/item-store.ts`
- Test: `packages/gateway/src/index/item-store-body.test.ts`

**Interfaces:**
- Consumes: `bodyCapForItemType`, `clampBody`, `BODY_MAX_DEFAULT`, `BODY_PREVIEW_MAX` from Task 1; the V48 schema from Task 2.
- Produces: `upsertIndexedItem` accepting either `bodyPreview?: string` (legacy, `body_complete = 0`) or `body?: string` (declared-full, `body_complete = 1` when it fits), never both. `IndexedItemRow` gains `body: string | null` and `body_complete: number`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/item-store-body.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { BODY_MAX_PROSE } from "./body-caps.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";
import { upsertIndexedItem } from "./item-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function read(d: Database, id: string) {
  return d.query("SELECT body, body_preview, body_complete FROM item WHERE id = ?").get(id) as {
    body: string | null;
    body_preview: string | null;
    body_complete: number;
  };
}

const base = {
  service: "slack",
  type: "message",
  externalId: "1",
  title: "a title",
  modifiedAt: 1,
  syncedAt: 1,
};

test("a declared-full prose body is stored whole and marked complete", () => {
  const d = db();
  const body = "x".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body).toBe(body);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(1);
  d.close();
});

test("body_preview is always the first 512 code units of body", () => {
  const d = db();
  const body = "y".repeat(4000);
  upsertIndexedItem(d, { ...base, body });

  const row = read(d, "slack:1");
  expect(row.body_preview).toBe(row.body?.slice(0, 512));
  d.close();
});

test("a prose body over 16 KiB is clamped and marked incomplete", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "z".repeat(BODY_MAX_PROSE + 100) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(BODY_MAX_PROSE);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a non-prose type is still clamped at 512 even when declared full", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    service: "aws",
    type: "resource",
    body: "w".repeat(4000),
  });

  const row = read(d, "aws:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("the legacy bodyPreview path clamps at 512 and never claims completeness", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, bodyPreview: "v".repeat(4000) });

  const row = read(d, "slack:1");
  expect(row.body).toHaveLength(512);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_complete).toBe(0);
  d.close();
});

test("an item with no body at all falls back to its title", () => {
  const d = db();
  upsertIndexedItem(d, base);

  const row = read(d, "slack:1");
  expect(row.body).toBe("a title");
  expect(row.body_preview).toBe("a title");
  expect(row.body_complete).toBe(0);
  d.close();
});

test("a full body is keyword-searchable past the 512-character mark", () => {
  const d = db();
  upsertIndexedItem(d, {
    ...base,
    body: `${"filler ".repeat(600)}kumquat`,
  });

  const hits = d
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH 'kumquat'")
    .all() as Array<{ rowid: number }>;
  expect(hits).toHaveLength(1);
  d.close();
});

test("re-upserting a shorter body shrinks both columns", () => {
  const d = db();
  upsertIndexedItem(d, { ...base, body: "q".repeat(4000) });
  upsertIndexedItem(d, { ...base, body: "short" });

  const row = read(d, "slack:1");
  expect(row.body).toBe("short");
  expect(row.body_preview).toBe("short");
  d.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/index/item-store-body.test.ts
```

Expected: FAIL — `body` is not an accepted input key and the column is never written.

- [ ] **Step 3: Implement the store change**

In `packages/gateway/src/index/item-store.ts`, add the import:

```ts
import { BODY_MAX_DEFAULT, BODY_PREVIEW_MAX, bodyCapForItemType, clampBody } from "./body-caps.ts";
```

Extend the row type (`IndexedItemRow`, currently lines 13-27) with the two new columns:

```ts
export type IndexedItemRow = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  body: string | null;
  body_preview: string | null;
  body_complete: number;
  url: string | null;
  canonical_url: string | null;
  modified_at: number;
  author_id: string | null;
  metadata: string | null;
  synced_at: number;
  pinned: number;
};
```

Add the input union above `upsertIndexedItem`:

```ts
/**
 * A caller supplies EITHER a legacy `bodyPreview` (clamped to 512, never
 * claims completeness) OR a declared-full `body` (clamped to the type's cap).
 * Supplying both is a type error: they would be two sources of truth for one
 * column pair.
 *
 * Do NOT relax this to `{ bodyPreview?: string; body?: string }` with a runtime
 * check. The union was probed under `tsc --strict` against every real call
 * shape — plain literal, object spread, the `{ ...row, url }` re-spread in
 * `upsertNimbusItemIntoItemTable`, the `Parameters<typeof upsertIndexedItem>[1]`
 * wrapper, and a `string | undefined` value — and all compile clean, while
 * supplying both fields fails with TS2345. Relaxing it would trade a
 * compile-time guarantee for a runtime one and gain nothing.
 */
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined }
  | { body: string; bodyPreview?: undefined };
```

Change the `row` parameter of `upsertIndexedItem` so its body keys come from that union — replace the `bodyPreview?: string;` line with nothing and intersect the object type:

```ts
export function upsertIndexedItem(
  db: Database,
  row: {
    service: string;
    type: string;
    externalId: string;
    title: string;
    url?: string | null;
    canonicalUrl?: string | null;
    modifiedAt: number;
    authorId?: string | null;
    metadata?: Record<string, unknown>;
    pinned?: boolean;
    syncedAt: number;
  } & IndexedItemBodyInput,
  resolveServiceId?: ResolveServiceId,
): void {
```

Delete `clipPreview` (lines 37-39) and replace the `const preview = …` line (line 64) with:

```ts
  const declaredFull = row.body !== undefined;
  const cap = declaredFull ? bodyCapForItemType(row.service, row.type) : BODY_MAX_DEFAULT;
  const raw = row.body ?? row.bodyPreview ?? row.title;
  const body = clampBody(raw, cap);
  const preview = clampBody(body, BODY_PREVIEW_MAX);
  const bodyComplete = declaredFull && raw.length <= cap ? 1 : 0;
```

Extend the INSERT to carry the two new columns:

```ts
    `INSERT INTO item (
      id, service, type, external_id, title, body, body_preview, body_complete,
      url, canonical_url, modified_at, author_id, metadata, synced_at, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      service = excluded.service,
      type = excluded.type,
      external_id = excluded.external_id,
      title = excluded.title,
      body = excluded.body,
      body_preview = excluded.body_preview,
      body_complete = excluded.body_complete,
      url = excluded.url,
      canonical_url = excluded.canonical_url,
      modified_at = excluded.modified_at,
      author_id = excluded.author_id,
      metadata = excluded.metadata,
      synced_at = excluded.synced_at,
      pinned = excluded.pinned`,
    [
      id,
      row.service,
      row.type,
      row.externalId,
      row.title,
      body,
      preview,
      bodyComplete,
      row.url ?? null,
      row.canonicalUrl ?? null,
      row.modifiedAt,
      row.authorId ?? null,
      meta,
      row.syncedAt,
      row.pinned === true ? 1 : 0,
    ],
```

**Leave the `syncGraphFromIndexedItem` call exactly as it is** — it must keep receiving `bodyPreview: preview`. Feeding it the full body would multiply `graph_relation` rows and change what `nimbus why` and `nimbus impact` return, which this slice does not promise. Add a comment so it is not "fixed" later:

```ts
  syncGraphFromIndexedItem(
    db,
    {
      id,
      service: row.service,
      type: row.type,
      title: row.title,
      // Deliberately the 512-char preview, not `body`. Widening the graph
      // populator's input is a separate change with its own measurement.
      bodyPreview: preview,
      authorId: row.authorId ?? null,
      metadata: row.metadata ?? {},
    },
    resolveServiceId,
  );
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/index/
bun run typecheck
```

Expected: PASS. `upsertNimbusItemIntoItemTable` (line 148) already passes `bodyPreview: item.name` and still type-checks against the union.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/item-store.ts packages/gateway/src/index/item-store-body.test.ts
git commit -m "feat(index): write item.body and derive body_preview from it"
```

---

### Task 4: Repoint the FTS match and pin the read shapes

**Files:**
- Modify: `packages/gateway/src/search/hybrid-internal.ts:61`
- Modify: `packages/gateway/src/index/local-index.ts:115` — **a second, byte-identical copy of the same MATCH builder.** Found during Task 3, not at plan time. Missing it leaves 48 tests in `local-index.test.ts` red and local-index search broken at runtime. Both lines read `` return `(title : "${escaped}"* OR body_preview : "${escaped}"*)`; `` and both must become `body :`.
- Modify: `packages/gateway/src/index/item-list-query.ts:37`
- Modify: `packages/gateway/src/ipc/http-server.ts:144`
- Modify: `packages/gateway/src/index/local-index.ts:453,539,698`
- Test: `packages/gateway/src/index/item-read-shape.test.ts`

**Interfaces:**
- Consumes: the V48 schema from Task 2 and the store from Task 3.
- Produces: no new exports. `GET /v1/items/<id>` gains `body`; every list read keeps `body_preview` only.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/item-read-shape.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { ftsMatchQuery } from "../search/hybrid-internal.ts";
import { buildItemListSql } from "./item-list-query.ts";
import { CURRENT_SCHEMA_VERSION } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";
import { upsertIndexedItem } from "./item-store.ts";

function seeded(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: "b".repeat(4000),
    modifiedAt: 1,
    syncedAt: 1,
  });
  return d;
}

test("the item list read does not carry the full body", () => {
  const d = seeded();
  const { sql, vals } = buildItemListSql({ limit: 10 });
  const rows = d.query(sql).all(...vals) as Array<Record<string, unknown>>;

  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("body");
  expect(rows[0]?.["body_preview"]).toHaveLength(512);
  d.close();
});

test("a full body is findable through the hybrid fts match past 512 chars", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: `${"filler ".repeat(600)}kumquat`,
    modifiedAt: 1,
    syncedAt: 1,
  });

  // ftsMatchQuery builds a column-qualified MATCH; an unknown column throws.
  const rows = d
    .query("SELECT rowid FROM item_fts WHERE item_fts MATCH ?")
    .all(ftsMatchQuery("kumquat")) as Array<{ rowid: number }>;

  expect(rows).toHaveLength(1);
  d.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/index/item-read-shape.test.ts
```

Expected: FAIL — the list query returns `body` (it is `SELECT *`), and the MATCH throws `no such column: body_preview`.

- [ ] **Step 3: Apply the four edits**

`packages/gateway/src/search/hybrid-internal.ts:61` — the FTS column name only:

```ts
      return `(title : "${escaped}"* OR body : "${escaped}"*)`;
```

Leave lines 92 and 180 (`i.body_preview AS body_preview`) alone — those select from `item`, not from FTS, and their consumers want the preview.

`packages/gateway/src/index/item-list-query.ts:37`:

```ts
  const sql = `SELECT id, service, type, external_id, title, body_preview, url, canonical_url,
                      modified_at, author_id, metadata, synced_at, pinned
               FROM item ${where} ORDER BY modified_at DESC LIMIT ?`;
```

`packages/gateway/src/ipc/http-server.ts:144` — this one **keeps** `body`:

```ts
  const row = db
    .query(
      `SELECT id, service, type, external_id, title, body, body_preview, body_complete,
              url, canonical_url, modified_at, author_id, metadata, synced_at, pinned
       FROM item WHERE id = ? OR external_id = ? LIMIT 1`,
    )
    .get(id, id) as Record<string, unknown> | null;
```

`packages/gateway/src/index/local-index.ts` — replace `SELECT *` at line 453 and line 698, and `SELECT i.*` at line 539, with this column list (aliased `i.` for the 539 join):

```
id, service, type, external_id, title, body_preview, url, canonical_url,
modified_at, author_id, metadata, synced_at, pinned
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/index/ packages/gateway/src/search/ packages/gateway/src/ipc/http-server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/search/hybrid-internal.ts \
        packages/gateway/src/index/item-list-query.ts \
        packages/gateway/src/ipc/http-server.ts \
        packages/gateway/src/index/local-index.ts \
        packages/gateway/src/index/item-read-shape.test.ts
git commit -m "fix(search): match fts on body and pin item read shapes"
```

---

### Task 5: Data-minimization must clear the new column

**Files:**
- Modify: `packages/gateway/src/connectors/reindex.ts:21-27`
- Test: `packages/gateway/src/connectors/reindex-body.test.ts`

**Interfaces:**
- Consumes: the V48 schema and the store.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/reindex-body.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { reindexConnector } from "./reindex.ts";

test("metadata_only depth strips body, body_preview and body_complete together", async () => {
  const raw = new Database(":memory:");
  runIndexedSchemaMigrations(raw, CURRENT_SCHEMA_VERSION);
  upsertIndexedItem(raw, {
    service: "slack",
    type: "message",
    externalId: "1",
    title: "t",
    body: "secret".repeat(500),
    modifiedAt: 1,
    syncedAt: 1,
  });

  const before = raw.query("SELECT body, body_complete FROM item WHERE id='slack:1'").get() as {
    body: string | null;
    body_complete: number;
  };
  expect(before.body).not.toBeNull();
  expect(before.body_complete).toBe(1);

  await reindexConnector({
    index: { rawDb: raw, recordAudit: () => undefined } as never,
    service: "slack",
    depth: "metadata_only",
  });

  const after = raw.query(
    "SELECT body, body_preview, body_complete FROM item WHERE id='slack:1'",
  ).get() as { body: string | null; body_preview: string | null; body_complete: number };

  expect(after.body).toBeNull();
  expect(after.body_preview).toBeNull();
  expect(after.body_complete).toBe(0);
  raw.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/connectors/reindex-body.test.ts
```

Expected: FAIL — `after.body` still holds the text. This is the privacy regression the task exists to prevent; confirm you see it fail before fixing.

- [ ] **Step 3: Fix the minimization path**

In `packages/gateway/src/connectors/reindex.ts`, widen the rowid probe (line 21) so items whose text lives only in `body` are still cleaned up:

```ts
    const rowids = input.index.rawDb
      .query(
        `SELECT rowid FROM item
         WHERE service = ?
           AND ((body IS NOT NULL AND body <> '')
                OR (body_preview IS NOT NULL AND body_preview <> ''))`,
      )
      .all(input.service) as Array<{ rowid: number }>;
```

and clear all three columns (line 25) — **through `dbRun`, not `rawDb.run`**:

```ts
      dbRun(
        input.index.rawDb,
        `UPDATE item SET body = NULL, body_preview = NULL, body_complete = 0 WHERE service = ?`,
        [input.service],
      );
```

Add `import { dbRun } from "../db/write.ts";` to the file.

The existing line uses `input.index.rawDb.run(...)` directly. That is not an exemption — `DB_RUN_EXEC_ALLOW_LIST` contains exactly one file (`packages/gateway/src/db/write.ts`, asserted at `scripts/structure-audit/check-nimbus-invariants.test.ts:233`), and this call only survives because the D12 pattern matches the identifier `db`, not `rawDb`. Since this task is rewriting the statement anyway, route it through the **I14** wrapper rather than reproducing a latent violation. Do the same for the `DELETE FROM vec_items_384` call a few lines below it, which has the identical shape.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/connectors/reindex-body.test.ts packages/gateway/src/connectors/reindex.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/reindex.ts packages/gateway/src/connectors/reindex-body.test.ts
git commit -m "fix(connectors): metadata_only reindex must clear item.body too"
```

---

### Task 6: Guards that the bounded readers stay bounded

**Files:**
- Create: `packages/gateway/src/embedding/embedding-body-source.guard.test.ts`
- Create: `packages/gateway/src/federation/federation-body-source.guard.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — these read source text.
- Produces: no exports.

- [ ] **Step 1: Write the guards**

Create `packages/gateway/src/embedding/embedding-body-source.guard.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The full-body store (V48) deliberately does NOT widen what the embedder
 * sees: prose types route to OpenAI when a key is set, so reading `item.body`
 * here would ship ~32x more private text off the machine on the next embed
 * pass. That property is preserved by these files NOT changing, which is
 * exactly the kind of thing a refactor undoes silently.
 *
 * Read via import.meta.dir — a CWD-relative read is ENOENT under the sharded
 * CI runner and the guard would never run.
 */
function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

for (const file of ["pipeline.ts", "create-routing-runtime.ts", "lazy-scheduler.ts"]) {
  test(`${file} selects body_preview and never item.body`, () => {
    const src = source(file);
    expect(src).toContain("body_preview");
    // Any `body` column reference that is not `body_preview` fails the guard.
    expect(src.match(/\bi?\.?body\b(?!_preview)/g)).toBeNull();
  });
}

test("itemTextForEmbedding reads body_preview", () => {
  const src = source("chunker.ts");
  expect(src).toContain("item.body_preview");
});
```

Create `packages/gateway/src/federation/federation-body-source.guard.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * I17 sits on query-gate.ts. V48 must not widen what a federated peer receives:
 * the gate reads body_preview and slices to SNIPPET_MAX before anything leaves
 * the machine, and both halves are load-bearing.
 */
test("the federated query gate reads body_preview and still slices to SNIPPET_MAX", () => {
  const src = readFileSync(join(import.meta.dir, "query-gate.ts"), "utf8");
  expect(src).toContain("body_preview");
  expect(src).toContain("SNIPPET_MAX");
  expect(src).toContain("(r.body_preview ?? \"\").slice(0, SNIPPET_MAX)");
  expect(src.match(/\br\.body\b(?!_preview)/g)).toBeNull();
});
```

- [ ] **Step 2: Run the guards to verify they pass**

```bash
bun test packages/gateway/src/embedding/embedding-body-source.guard.test.ts \
         packages/gateway/src/federation/federation-body-source.guard.test.ts
```

Expected: PASS.

- [ ] **Step 3: Red-prove both guards**

A guard that cannot fail is not a guard. Temporarily edit `packages/gateway/src/embedding/pipeline.ts` line 194, changing `i.body_preview AS body_preview` to `i.body AS body_preview`, and `packages/gateway/src/federation/query-gate.ts` line 61 to read `r.body`. Re-run the two test files.

Expected: BOTH FAIL. Then revert both edits with `git checkout -- packages/gateway/src/embedding/pipeline.ts packages/gateway/src/federation/query-gate.ts` and re-run to confirm they pass again.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/embedding/embedding-body-source.guard.test.ts \
        packages/gateway/src/federation/federation-body-source.guard.test.ts
git commit -m "test(index): guard that embedding and federation stay on body_preview"
```

---

### Task 7: Size counters in `index.metrics`

**Files:**
- Modify: `packages/gateway/src/db/metrics.ts`
- Test: `packages/gateway/src/db/metrics-body-size.test.ts`

**Interfaces:**
- Consumes: the V48 schema.
- Produces: `IndexMetrics` gains `bodyBytes: number` and `ftsIndexBytes: number`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/db/metrics-body-size.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { collectIndexMetrics } from "./metrics.ts";

test("body and fts index bytes grow with indexed prose", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);

  const empty = collectIndexMetrics(d);
  expect(empty.bodyBytes).toBe(0);
  expect(empty.ftsIndexBytes).toBe(0);

  for (let i = 0; i < 50; i++) {
    upsertIndexedItem(d, {
      service: "slack",
      type: "message",
      externalId: String(i),
      title: `t${String(i)}`,
      body: `word${String(i)} `.repeat(400),
      modifiedAt: 1,
      syncedAt: 1,
    });
  }

  const filled = collectIndexMetrics(d);
  expect(filled.bodyBytes).toBeGreaterThan(50_000);
  expect(filled.ftsIndexBytes).toBeGreaterThan(0);
  d.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/db/metrics-body-size.test.ts
```

Expected: FAIL — `bodyBytes` is not a property of `IndexMetrics`.

- [ ] **Step 3: Implement the counters**

In `packages/gateway/src/db/metrics.ts`, add `bodyBytes: number;` and `ftsIndexBytes: number;` to the `IndexMetrics` type, and inside `collectIndexMetrics` (after the existing item counts) add:

```ts
  // NOT dbstat: bun:sqlite is not built with SQLITE_ENABLE_DBSTAT_VTAB, so
  // `dbstat` raises "no such table". The FTS5 shadow tables are ordinary
  // tables and can be summed directly, which needs no build flag.
  const bodyRow = db.query("SELECT COALESCE(SUM(length(body)), 0) AS b FROM item").get() as {
    b: number;
  } | null;
  const bodyBytes = Math.max(0, Math.floor(bodyRow?.b ?? 0));

  let ftsIndexBytes = 0;
  try {
    const ftsRow = db
      .query("SELECT COALESCE(SUM(length(block)), 0) AS b FROM item_fts_data")
      .get() as { b: number } | null;
    ftsIndexBytes = Math.max(0, Math.floor(ftsRow?.b ?? 0));
  } catch {
    /* item_fts absent on a partially-migrated database */
  }
```

Include both in the returned object.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/db/
bun run typecheck
```

Expected: PASS. Fix any `IndexMetrics` construction sites the new required fields break.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/db/metrics.ts packages/gateway/src/db/metrics-body-size.test.ts
git commit -m "feat(diag): report body and fts index size in index.metrics"
```

---

### Task 8: PR 1 gate

- [ ] **Step 1: Full preflight**

```bash
cd .claude/worktrees/full-body-store
bun run preflight 2>&1 | tee /tmp/preflight-pr1.log; echo "EXIT=$?"
```

Do not read the tail of a piped command and call it green — check the printed `EXIT=` value. Expected: `EXIT=0`.

- [ ] **Step 2: Coverage floor on Linux**

`audit:coverage-floor` is CI-Linux-authoritative; a Windows pass proves nothing.

```bash
bash scripts/coverage/reseed-docker.sh
git diff --stat scripts/coverage/baseline.json
```

Expected: coverage-floor OK, and **`baseline.json` unchanged** — a modified baseline means failing files were ratcheted in as exceptions rather than fixed.

- [ ] **Step 3: Open the PR**

Title: `feat(index): full-body store — V48 adds item.body and uncaps keyword search`

The PR description is the permanent commit body; summarise the substrate, the seed-then-rebuild ordering, the two guards, and the `reindex.ts` privacy fix.

---

# PR 2 — Connectors

Twelve one-line-ish changes. This is where recall actually improves. Each connector switches `bodyPreview:` to `body:` and passes the untruncated source text.

---

### Task 9: The three chat connectors (title-derivation footgun)

**Files:**
- Modify: `packages/gateway/src/connectors/slack-sync.ts:266-281`
- Modify: `packages/gateway/src/connectors/_lib/teams/api.ts:54-87`
- Modify: `packages/gateway/src/connectors/discord-sync.ts:183-202`
- Test: `packages/gateway/src/connectors/chat-body-full.test.ts`

**Interfaces:**
- Consumes: `upsertIndexedItem`'s `body` input from Task 3.
- Produces: `slack:message`, `teams:message`, `discord:message` rows with full bodies and `body_complete = 1`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/chat-body-full.test.ts` asserting the mapping keeps a short title while storing the whole body. Use the existing per-connector test harness in `slack-sync.test.ts` as the template for constructing a `SyncContext`; the assertion in each case is:

```ts
const row = db
  .query("SELECT title, body, body_complete FROM item WHERE id = ?")
  .get(itemId) as { title: string; body: string; body_complete: number };

expect(row.body).toHaveLength(4000);      // full message text stored
expect(row.title.length).toBeLessThanOrEqual(120); // title still short
expect(row.body_complete).toBe(1);
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/connectors/chat-body-full.test.ts
```

Expected: FAIL — `body` is 512 characters.

- [ ] **Step 3: Bind the full text to a new local in each connector**

The title deriver must keep seeing a short string. In `slack-sync.ts` around line 266:

```ts
  const full = typeof text === "string" ? text : "";
  const preview = full.slice(0, 512);
  const title = shortIndexedMessageTitleFromPreview(preview, "(no text)");
```

and change the upsert key from `bodyPreview: preview` to `body: full`.

In `_lib/teams/api.ts` around line 54:

```ts
  const full = plainTextPreviewFromHtml(content, BODY_MAX_PROSE);
  const preview = full.slice(0, 512);
```

keep `titleBase = shortIndexedMessageTitleFromPreview(preview, "(message)")`, and change the upsert key to `body: full`.

In `discord-sync.ts` around line 183 — this one derives the title inline with a whitespace-collapsing regex, which must not run over 16 KiB:

```ts
  const full = content;
  const preview = full.length > 512 ? full.slice(0, 512) : full;
  const title =
    preview.trim() === ""
      ? "(no text)"
      : preview.replaceAll(/\s+/g, " ").slice(0, 80);
```

and change the upsert key to `body: full`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/connectors/chat-body-full.test.ts \
         packages/gateway/src/connectors/slack-sync.test.ts \
         packages/gateway/src/connectors/discord-sync.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/slack-sync.ts \
        packages/gateway/src/connectors/_lib/teams/api.ts \
        packages/gateway/src/connectors/discord-sync.ts \
        packages/gateway/src/connectors/chat-body-full.test.ts
git commit -m "feat(connectors): index full chat message bodies"
```

---

### Task 10: The five issue-tracker connectors

**Files:**
- Modify: `packages/gateway/src/connectors/linear-sync.ts:175`
- Modify: `packages/gateway/src/connectors/jira-sync.ts:261`
- Modify: `packages/gateway/src/connectors/github-sync.ts:207,247`
- Modify: `packages/gateway/src/connectors/bitbucket-sync.ts:137`
- Modify: `packages/gateway/src/connectors/snyk-issue-mapping.ts:117`
- Test: `packages/gateway/src/connectors/issue-body-full.test.ts`

**Interfaces:**
- Consumes: `upsertIndexedItem`'s `body` input.
- Produces: full-bodied `linear:issue`, `jira:issue`, `github:issue`, `bitbucket:issue`, `snyk:vulnerability` rows.

All five already take their title from a separate source field, so there is no title coupling to work around — each is a direct substitution.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/issue-body-full.test.ts` with one case per connector. Build the database with `new Database(":memory:")` then `runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION)`, drive each connector's mapping function with a fixture whose description is 4,000 characters, and assert:

```ts
const row = d
  .query("SELECT title, body, body_preview, body_complete FROM item WHERE id = ?")
  .get(itemId) as {
  title: string;
  body: string;
  body_preview: string;
  body_complete: number;
};

expect(row.body).toHaveLength(4000);
expect(row.body_preview).toBe(row.body.slice(0, 512));
expect(row.body_complete).toBe(1);
// The title comes from a separate source field and must be unaffected.
expect(row.title).toBe("the fixture summary");
```

Use each connector's existing `*-sync.test.ts` for how to construct its fixture and `SyncContext`; the assertion block above is identical in all five cases.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/connectors/issue-body-full.test.ts
```

Expected: FAIL — every body is 512 characters.

- [ ] **Step 3: Substitute the keys**

- `linear-sync.ts:175` — `bodyPreview: (desc ?? "").slice(0, 512)` → `body: desc ?? ""`
- `jira-sync.ts:261` — `bodyPreview: d.bodyPrev.slice(0, 512)` → `body: d.bodyPrev`
- `github-sync.ts:207` and `:247` — `bodyPreview: (body ?? "").slice(0, 512)` → `body: body ?? ""`
- `bitbucket-sync.ts:137` — `bodyPreview: plainTextPreviewFromHtml(desc, 512)` → `body: plainTextPreviewFromHtml(desc, BODY_MAX_PROSE)`
- `snyk-issue-mapping.ts:117` — `bodyPreview: description` → `body: description`

Import `BODY_MAX_PROSE` from `../index/body-caps.ts` where it is now referenced.

**Check the surrounding lines in each file before editing.** `github-sync.ts:207` sits in the PR mapper and `:247` in the issue mapper; only `github:issue` is a prose-heavy type, but passing `body` on both is correct — the store applies `BODY_MAX_DEFAULT` to `github:pr` automatically.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/connectors/issue-body-full.test.ts \
         packages/gateway/src/connectors/linear-sync.test.ts \
         packages/gateway/src/connectors/jira-sync.test.ts \
         packages/gateway/src/connectors/github-sync.test.ts \
         packages/gateway/src/connectors/bitbucket-sync.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/linear-sync.ts \
        packages/gateway/src/connectors/jira-sync.ts \
        packages/gateway/src/connectors/github-sync.ts \
        packages/gateway/src/connectors/bitbucket-sync.ts \
        packages/gateway/src/connectors/snyk-issue-mapping.ts \
        packages/gateway/src/connectors/issue-body-full.test.ts
git commit -m "feat(connectors): index full issue and vulnerability bodies"
```

---

### Task 11: Notes, transcripts, clips and briefs

**Files:**
- Modify: `packages/gateway/src/connectors/obsidian-sync.ts:75`
- Modify: `packages/gateway/src/connectors/zoom-transcript-mapping.ts:182`
- Modify: `packages/gateway/src/clips/clip-ingest.ts:99`
- Modify: `packages/gateway/src/briefs/brief-save.ts:69`
- Test: `packages/gateway/src/connectors/document-body-full.test.ts`

**Interfaces:**
- Consumes: `upsertIndexedItem`'s `body` input.
- Produces: full-bodied `obsidian:obsidian_note`, `zoom:transcript`, `nimbus:web_clip`, `nimbus:research_brief` rows.

Note that `clip-ingest.ts:99` already reads `bodyPreview: input.body` — it hands the store the **complete** article and the store's 512-char clamp is the only thing discarding it. That is the root cause of issue #1005, and the fix here is a one-key change.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/connectors/document-body-full.test.ts` with one case per source. Each case seeds a 4,000-character document through that source's upsert and asserts:

```ts
const row = d
  .query("SELECT body, body_preview, body_complete FROM item WHERE id = ?")
  .get(itemId) as { body: string; body_preview: string; body_complete: number };

expect(row.body).toHaveLength(4000);
expect(row.body_preview).toHaveLength(512);
expect(row.body_preview).toBe(row.body.slice(0, 512));
expect(row.body_complete).toBe(1);
```

Build the in-memory database exactly as in Task 3's test (`new Database(":memory:")` then `runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION)`). For `obsidian` and `zoom` call the mapping function directly; for the clip and brief paths call `ingestClip` / the brief save entry point with a stub context, following the existing arrangement in `clips/clip-ingest.test.ts` and `briefs/brief-save.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/connectors/document-body-full.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Substitute the keys**

- `obsidian-sync.ts:75` — `bodyPreview: note.body.slice(0, 4096)` → `body: note.body`
- `zoom-transcript-mapping.ts:182` — `bodyPreview: clipTranscriptPreview(input.plainText)` → `body: input.plainText`
- `clips/clip-ingest.ts:99` — `bodyPreview: input.body` → `body: input.body`. **This closes the storage half of issue #1005**; its reporting half (`wordCount` describing text the index does not hold) stays with the web-clipper workstream, as does #1006.
- `briefs/brief-save.ts:69` — `bodyPreview: effective.summary` → `body: effective.summary`

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/connectors/document-body-full.test.ts \
         packages/gateway/src/connectors/obsidian-sync.test.ts \
         packages/gateway/src/clips/ packages/gateway/src/briefs/
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/obsidian-sync.ts \
        packages/gateway/src/connectors/zoom-transcript-mapping.ts \
        packages/gateway/src/clips/ packages/gateway/src/briefs/ \
        packages/gateway/src/connectors/document-body-full.test.ts
git commit -m "feat(connectors): index full note, transcript, clip and brief bodies"
```

---

### Task 12: Agents report truncated sources

**Files:**
- Modify: `packages/gateway/src/decisions/decision-extract.ts:119,143,247-251`
- Modify: `packages/gateway/src/glossary/glossary-extract.ts`
- Test: `packages/gateway/src/decisions/decision-truncation-report.test.ts`

**Interfaces:**
- Consumes: `item.body` and `item.body_complete`.
- Produces: both briefs carry a `truncatedSources: number` alongside their existing source count.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-truncation-report.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { loadDecisionCandidates } from "./decision-extract.ts";

test("candidate loading reports how many source bodies were truncated", () => {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);

  // Complete: a short declared-full body.
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "complete",
    title: "t1",
    body: "we decided to move billing to Postgres because the pool kept exhausting",
    modifiedAt: 2,
    syncedAt: 1,
  });

  // Incomplete: the legacy preview path never claims completeness.
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "truncated",
    title: "t2",
    bodyPreview: "we decided to shard instead; alternatives were read replicas",
    modifiedAt: 1,
    syncedAt: 1,
  });

  const loaded = loadDecisionCandidates(d, { sinceMs: 0 });

  expect(loaded.rows).toHaveLength(2);
  expect(loaded.truncatedSources).toBe(1);
  d.close();
});
```

`loadDecisionCandidates` is the function currently issuing the `SELECT` at `decision-extract.ts:119`; if its exported name differs in the tree, keep the name it has and adjust this import — do not rename it as part of this task.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-truncation-report.test.ts
```

Expected: FAIL — no such field.

- [ ] **Step 3: Switch both extractors to `body` and count incompleteness**

In `decision-extract.ts`, change the `SELECT i.id, i.service, i.type, i.title, i.body_preview, i.modified_at` (line 119) to select `i.body` and `i.body_complete`, update the row type (line 107) to match, and change the two text builders (lines 143 and 251) from `r.body_preview` to `r.body`. Accumulate `body_complete = 0` rows into a counter carried into the brief.

Apply the same substitution in `glossary-extract.ts`.

**Do not touch `glossary-store.ts`'s `item_fts` queries** — they are unqualified MATCH expressions and already read the new index correctly.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/decisions/ packages/gateway/src/glossary/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/decisions/ packages/gateway/src/glossary/
git commit -m "feat(agents): mine item.body and report truncated source counts"
```

---

### Task 13: PR 2 gate

- [ ] **Step 1: Full preflight and Linux coverage floor**

Same two commands as Task 8. Expected: `EXIT=0`, `baseline.json` unchanged.

- [ ] **Step 2: Open the PR**

Title: `feat(connectors): index full bodies for the twelve prose sources`

---

# PR 3 — Backfill

---

### Task 14: `index.rebody` IPC

**Files:**
- Create: `packages/gateway/src/ipc/index-rebody-rpc.ts`
- Create: `packages/gateway/src/ipc/index-rebody-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/index.ts` (register the handler)

**Interfaces:**
- Consumes: `LongRunningJobRegistry` from `packages/gateway/src/ipc/_lib/long-running.ts`; `dispatchByMethod` from `packages/gateway/src/ipc/_lib/dispatch-by-method.ts`.
- Produces: `index.rebody` accepting `{ service?: string; type?: string; limit?: number; dryRun?: boolean }` and returning `{ jobId: string }`, plus `index.rebodyProgress` notifications. **Not** added to the Tauri allowlist — `ALLOWED_METHODS` stays at 103.

- [ ] **Step 1: Write the failing test**

Model it on `packages/gateway/src/ipc/index-reembed-rpc.test.ts`. Assert:

```ts
test("dry run reports the remaining incomplete count per service without fetching", async () => {
  // Seed 3 slack items with body_complete = 0 and 2 with 1.
  // Call index.rebody with { dryRun: true }.
  // Expect { pending: { slack: 3 } } and zero sync invocations.
});

test("params reject a non-object and an empty service", async () => {
  // Expect rpcCode -32602 for both.
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

Follow `index-reembed-rpc.ts` structurally: an `IndexRebodyRpcError` class, a `parseRebodyParams` validator, a module-level `LongRunningJobRegistry`, and a `runRebody` that clears the per-connector watermark for the selected prose types and drives the existing sync.

The completion payload reports the remaining `body_complete = 0` count per service:

```sql
SELECT service, COUNT(*) AS pending
FROM item
WHERE body_complete = 0
GROUP BY service
```

There is deliberately **no `--only-truncated` mode.** A sync fetches by page and time window, not by item id, so the flag could suppress writes (free) while every API call still happened — a rate-limit optimisation that saves no requests. Record that in a file-header comment so it is not re-proposed, together with the cost asymmetry and the condition that would change the answer:

```ts
/**
 * `rebody` clears a watermark and lets the existing sync run. Cost is NOT
 * uniform across connectors, and callers should know which kind they have:
 *
 *   - Delta-capable (Slack, Gmail via history ids): the re-sync walks a
 *     bounded recent window.
 *   - Full-scan (Notion, Confluence, Jira): clearing the watermark re-walks
 *     EVERY page or ticket in the account. On a large workspace that is tens
 *     of thousands of requests to recover bodies for a subset of items.
 *
 * There is no `--only-truncated` today because a sync cannot be asked for
 * specific item ids: the flag would suppress writes (free) while every request
 * still happened. If a per-item fetch is ever added to the connector contract
 * — the same capability the browser client's resolve-miss path needs, see
 * docs/roadmap.md "Client surfaces" — then `rebody` SHOULD be reworked to
 * target `body_complete = 0` ids directly and skip the scan entirely. That is
 * the condition that makes the flag meaningful; until then it is theatre.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/gateway/src/ipc/
bun run typecheck
```

Expected: PASS. Confirm the Rust allowlist count assertion at `packages/ui/src-tauri/src/gateway_bridge.rs:535` is still `103`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/index-rebody-rpc.ts \
        packages/gateway/src/ipc/index-rebody-rpc.test.ts \
        packages/gateway/src/ipc/index.ts
git commit -m "feat(ipc): index.rebody re-fetches bodies for already-indexed items"
```

---

### Task 15: `nimbus index rebody` CLI

**Files:**
- Modify: `packages/cli/src/commands/index-cmd.ts`
- Modify: `packages/cli/src/commands/help.ts`
- Test: `packages/cli/src/commands/index-cmd.test.ts`

**Interfaces:**
- Consumes: `index.rebody` from Task 14.
- Produces: `nimbus index rebody [--service <id>] [--type <t>] [--limit <n>] [--dry-run]`.

- [ ] **Step 1: Write the failing test**

Extend `index-cmd.test.ts` with a case asserting `rebody --dry-run` prints the per-service pending counts and exits 0. **Use dependency injection for the dispatcher, not `mock.module`** — `mock.module` is process-global and leaks across the combined `bun test packages/cli/src` run on CI Linux.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/cli/src/commands/index-cmd.test.ts
```

Expected: FAIL — unknown subcommand.

- [ ] **Step 3: Add the subcommand**

Mirror the existing `reembed` subcommand's argument parsing, progress rendering and cancellation handling in the same file. Add the `rebody` line to `help.ts`.

`--dry-run` output must state the cost, not only the count, because the count alone understates it for full-scan connectors:

```
pending bodies: notion 4210, slack 122
note: notion has no delta sync — rebody re-walks every page in the workspace,
      not just the 4210 listed above. slack re-walks a bounded recent window.
```

Derive "has delta sync" from whether the connector's `Syncable` produces a resumable cursor, rather than hardcoding a service-name list that will drift.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/cli/src/commands/
bun run audit:readme-cli
```

Expected: PASS. `audit:readme-cli` reds if a doc names a `nimbus <cmd>` absent from `COMMAND_NAMES`, so the registry entry and the docs must land together.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/index-cmd.ts packages/cli/src/commands/help.ts \
        packages/cli/src/commands/index-cmd.test.ts
git commit -m "feat(cli): nimbus index rebody"
```

---

### Task 16: Documentation and PR 3 gate

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md` (the S1 block and the Wave 5 `glossary` / `decisions` entries)
- Modify: `docs/schema-reference.md`
- Modify: `docs/cli-reference.md`
- Modify: `.claude/commands/nimbus-db-migrations.md`
- Modify: `CLAUDE.md` and `GEMINI.md` — both say "schema V47" in the status line; they are mirrors and must be updated together
- Modify: `docs/architecture.md` — line 5 says "schema V47", and line 1331 is **already stale** at "Latest applied migration: V46 … `CURRENT_SCHEMA_VERSION = 46`" (drifted during V47). Fix both to V48 rather than only the one this slice moved.

- [ ] **Step 1: Update the docs**

`docs/CHANGELOG.md` — dated entry for the full-body store, naming V48 and the twelve connectors.

`docs/roadmap.md` — the Wave 5 `decisions` entry currently states "a 512-character item-body indexing cap limits recall to decisions stated early in a document or thread", and the S1 Delivered block repeats it. Both stop being true for migrated connectors; rewrite them to state the 16 KiB cap and the per-brief truncation count, and keep the separate 0.86 confidence ceiling (missing `migration`/`iac` evidence) untouched, since this slice does not change it.

`docs/schema-reference.md` — V48 row.

`docs/cli-reference.md` — `nimbus index rebody`.

- [ ] **Step 2: Verify the doc gates**

```bash
bun run lint:markdown
bun run audit:doc-refs
bun run lychee
```

A pre-existing broken link anywhere on the branch fails your PR, and `file:///C:/...` links must be delinked before commit.

- [ ] **Step 3: Full preflight and Linux coverage floor**

Same two commands as Task 8. Expected: `EXIT=0`, `baseline.json` unchanged.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/ .claude/commands/nimbus-db-migrations.md
git commit -m "docs: record the full-body store, V48 and nimbus index rebody"
```

Title: `feat(cli): nimbus index rebody plus the full-body store docs`
