# Graph-Entity Metadata Namespacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop two subsystems destroying each other's `graph_entity.metadata`, fixing a live bug where `nimbus owners` silently degrades to its legacy-row output.

**Architecture:** `graph_entity.metadata` becomes a namespaced map keyed by writer for the four co-owned entity types. A new `upsertGraphEntityNamespaced` merges with SQLite `json_patch` so a writer replaces only its own key; `graph-populator.ts` converts to it; a V54 migration wraps existing rows; a static audit rule makes the flat upsert unreachable for those types.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict with `exactOptionalPropertyTypes`, `bun:sqlite`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-19-graph-entity-metadata-namespacing-design.md`](../specs/2026-08-19-graph-entity-metadata-namespacing-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-19-graph-entity-metadata-namespacing-design-review-response.md`](../specs/2026-08-19-graph-entity-metadata-namespacing-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\graph-entity-metadata-namespacing`, branch `dev/asafgolombek/graph-entity-metadata-namespacing`. Never commit on `main`. This session is worktree-isolated — git commands must not target the shared checkout.
- **The four co-owned types are exactly:** `source_file`, `directory`, `person`, `service`. No others.
- **`EntityMetadataWriter` is a closed union:** `"ownership" | "symbols"`. Sub-project B adds `"changed_files"` later; do not add it now.
- **Never write `null` inside a namespace.** `json_patch` treats a JSON `null` as a DELETE instruction — verified: `json_patch('{"ownership":{"a":1}}','{"symbols":{"b":null}}')` → `{"ownership":{"a":1},"symbols":{}}`. Absence is represented by **omitting the key**. No `"__absent__"` sentinel.
- **`readEntityMetadata` must NOT fall back** to treating flat metadata as the `ownership` namespace. That would mask a clobber or a skipped migration — the exact failures this work exists to surface.
- **No new invariant, no new IPC method, no new HTTP route, no Tauri allowlist change, no connector change.** `ALLOWED_METHODS` stays at 105.
- **`service` and `label` clobbering are out of scope** (spec D3). Do not change their write semantics.
- **The other ~25 flat-metadata call sites stay flat** (spec D2). Only the four co-owned types convert.
- Coverage floor: every touched file ≥85% line AND ≥80% branch.
- `bun run typecheck:tests` prints "ADVISORY on win32 — not gating" and **exits 0 even with violations**. Its baseline is Linux-authoritative and gates CI. **Quote the violation count, not the exit code.**
- Run `bun run preflight:fast` before declaring any task done.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/graph/relationship-graph.ts` | **Modify.** Add `EntityMetadataWriter`, `CO_OWNED_ENTITY_TYPES`, `upsertGraphEntityNamespaced`, `readEntityMetadata`. Leave `upsertGraphEntity` untouched. |
| `packages/gateway/src/index/entity-metadata-v54-sql.ts` | **Create.** The V54 migration SQL, mirroring `premortem-v53-sql.ts`. |
| `packages/gateway/src/index/migrations/runner.ts` | **Modify.** Register the 53 → 54 step. |
| `packages/gateway/src/ownership/ownership-pass.ts` | **Modify.** Three `source_file`/`directory`/`service` writes plus the `person` write convert to the namespaced form under `writer: "ownership"`. |
| `packages/gateway/src/ownership/ownership-store.ts` | **Modify.** `parseCounts` reads through `readEntityMetadata`. |
| `packages/gateway/src/graph/graph-populator.ts` | **Modify.** Co-owned writes convert under `writer: "symbols"`. |
| `scripts/structure-audit/check-nimbus-invariants.ts` | **Modify.** New rule rejecting a flat upsert on a co-owned type. |

Task order is dependency-ordered: the API first (nothing depends on it yet), then the migration, then each writer, then the audit that locks the door behind them.

---

## Task 1: The namespaced write and read API

**Files:**

- Modify: `packages/gateway/src/graph/relationship-graph.ts` (after `upsertGraphEntity`, ~line 74)
- Test: `packages/gateway/src/graph/relationship-graph.metadata.test.ts` (new)

**Interfaces:**

- Consumes: existing `deterministicGraphEntityId`, `dbRun`.
- Produces:
  - `type EntityMetadataWriter = "ownership" | "symbols"`
  - `const CO_OWNED_ENTITY_TYPES: readonly string[]`
  - `function upsertGraphEntityNamespaced(db, row: { type, externalId, label, service?, writer, metadata }): string`
  - `function readEntityMetadata(raw: string | null, writer: EntityMetadataWriter): Record<string, unknown> | null`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/relationship-graph.metadata.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  readEntityMetadata,
  upsertGraphEntityNamespaced,
} from "./relationship-graph.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE graph_entity (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, external_id TEXT NOT NULL,
    label TEXT NOT NULL, service TEXT, metadata TEXT,
    UNIQUE(type, external_id))`);
  return db;
}

function rawMetadata(db: Database, externalId: string): string | null {
  const row = db
    .query("SELECT metadata FROM graph_entity WHERE external_id = ?")
    .get(externalId) as { metadata: string | null } | null;
  return row?.metadata ?? null;
}

describe("upsertGraphEntityNamespaced", () => {
  // THE BUG, in miniature: two writers on one entity must not destroy each other.
  test("a second writer does not wipe the first writer's namespace", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:a.ts",
      label: "a.ts",
      writer: "ownership",
      metadata: { ownerCount: 3 },
    });
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:a.ts",
      label: "a.ts",
      writer: "symbols",
      metadata: { symbolCount: 9 },
    });
    const raw = rawMetadata(db, "file:/repo:a.ts");
    expect(readEntityMetadata(raw, "ownership")).toEqual({ ownerCount: 3 });
    expect(readEntityMetadata(raw, "symbols")).toEqual({ symbolCount: 9 });
  });

  // graph-populator's converted writes rely on this exactly.
  test("an EMPTY metadata object is a no-op, not a wipe", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:b.ts",
      label: "b.ts",
      writer: "ownership",
      metadata: { ownerCount: 2 },
    });
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:b.ts",
      label: "b.ts",
      writer: "symbols",
      metadata: {},
    });
    expect(readEntityMetadata(rawMetadata(db, "file:/repo:b.ts"), "ownership")).toEqual({
      ownerCount: 2,
    });
  });

  test("a writer replaces its OWN namespace wholesale", () => {
    const db = makeDb();
    const row = {
      type: "source_file",
      externalId: "file:/repo:c.ts",
      label: "c.ts",
      writer: "ownership" as const,
    };
    upsertGraphEntityNamespaced(db, { ...row, metadata: { ownerCount: 1, stale: true } });
    upsertGraphEntityNamespaced(db, { ...row, metadata: { ownerCount: 5 } });
    expect(readEntityMetadata(rawMetadata(db, "file:/repo:c.ts"), "ownership")).toEqual({
      ownerCount: 5,
    });
  });

  // Spec § 5.1: json_patch DELETES on null. Pinned so the next writer inherits the fact.
  test("a null field inside a namespace is DELETED, not stored", () => {
    const db = makeDb();
    upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: "file:/repo:d.ts",
      label: "d.ts",
      writer: "ownership",
      metadata: { ownerCount: 4, gone: null },
    });
    const got = readEntityMetadata(rawMetadata(db, "file:/repo:d.ts"), "ownership");
    expect(got).toEqual({ ownerCount: 4 });
    expect(got !== null && "gone" in got).toBe(false);
  });
});

describe("readEntityMetadata", () => {
  test("absent namespace yields null", () => {
    expect(readEntityMetadata(JSON.stringify({ ownership: { a: 1 } }), "symbols")).toBeNull();
  });

  test("null raw yields null", () => {
    expect(readEntityMetadata(null, "ownership")).toBeNull();
  });

  test("malformed JSON yields null and does not throw", () => {
    expect(readEntityMetadata("{not json", "ownership")).toBeNull();
  });

  test("a JSON scalar or array yields null", () => {
    expect(readEntityMetadata("42", "ownership")).toBeNull();
    expect(readEntityMetadata("[1,2]", "ownership")).toBeNull();
  });

  // Spec § 5.2: NO fallback. Flat metadata must stay visible as unmigrated, so a clobber
  // or a skipped migration surfaces instead of rendering as valid ownership data.
  test("FLAT metadata is NOT resurrected as the ownership namespace", () => {
    expect(readEntityMetadata(JSON.stringify({ ownerCount: 3 }), "ownership")).toBeNull();
  });

  test("a namespace holding a non-object yields null", () => {
    expect(readEntityMetadata(JSON.stringify({ ownership: 7 }), "ownership")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/relationship-graph.metadata.test.ts`
Expected: FAIL — `upsertGraphEntityNamespaced` is not exported from `./relationship-graph.ts`.

- [ ] **Step 3: Implement the API**

Add to `packages/gateway/src/graph/relationship-graph.ts`, directly after `upsertGraphEntity`:

```ts
/**
 * Subsystems permitted to own a namespace inside `graph_entity.metadata`.
 *
 * A CLOSED union on purpose: a free-form string would let a typo silently create a fifth
 * namespace that nothing ever reads, which looks identical to data loss. Sub-project B adds
 * `"changed_files"` here when it lands, as a deliberate edit.
 */
export type EntityMetadataWriter = "ownership" | "symbols";

/**
 * Entity types written by more than one subsystem, and therefore the only types whose
 * metadata is namespaced. Resolved from the tree, not guessed: `ownership/ownership-pass.ts`
 * and `graph/graph-populator.ts` both write all four. Every other type has a single writer
 * and keeps flat metadata (design D2).
 */
export const CO_OWNED_ENTITY_TYPES: readonly string[] = [
  "source_file",
  "directory",
  "person",
  "service",
];

/**
 * Upsert an entity whose metadata is co-owned, merging the caller's namespace into whatever
 * is already there instead of replacing the column.
 *
 * `json_patch` merges at the TOP LEVEL only: the caller replaces its own key wholesale —
 * which is what a writer wants for its own data — and every sibling key is untouched.
 *
 * CAUTION, verified rather than assumed: `json_patch` treats a JSON `null` VALUE as a DELETE
 * instruction. `json_patch('{"ownership":{"a":1}}','{"symbols":{"b":null}}')` yields
 * `{"ownership":{"a":1},"symbols":{}}` — `b` is gone, not stored. Never write `null` inside a
 * namespace; omit the key instead, and record "computed and found nothing" as an explicit
 * non-null field such as a `0` or a boolean.
 */
export function upsertGraphEntityNamespaced(
  db: Database,
  row: {
    type: string;
    externalId: string;
    label: string;
    service?: string | null;
    writer: EntityMetadataWriter;
    metadata: Record<string, unknown>;
  },
): string {
  const id = deterministicGraphEntityId(row.type, row.externalId);
  const patch = JSON.stringify({ [row.writer]: row.metadata });
  dbRun(
    db,
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (type, external_id) DO UPDATE SET
       label = excluded.label,
       service = excluded.service,
       metadata = json_patch(COALESCE(graph_entity.metadata, '{}'), excluded.metadata)`,
    [id, row.type, row.externalId, row.label, row.service ?? null, patch],
  );
  return id;
}

/**
 * Read one writer's namespace out of a raw `graph_entity.metadata` value.
 *
 * Returns `null` for: a null column, unparseable JSON, a non-object root, an absent
 * namespace, or a namespace holding a non-object. `graph_entity.metadata` is written by many
 * paths, so a parse failure must degrade to "no metadata" rather than break a read.
 *
 * DELIBERATELY NO FLAT FALLBACK. Treating un-namespaced metadata as the `ownership`
 * namespace was considered and rejected: a flat write landing on a co-owned type produces
 * exactly that shape, and so does a skipped V54 — the fallback would render both as valid
 * data instead of surfacing them. See the design spec § 5.2.
 */
export function readEntityMetadata(
  raw: string | null,
  writer: EntityMetadataWriter,
): Record<string, unknown> | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const ns = (parsed as Record<string, unknown>)[writer];
  if (ns === undefined || ns === null || typeof ns !== "object" || Array.isArray(ns)) {
    return null;
  }
  return ns as Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/relationship-graph.metadata.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 4b: Add the compile-time guard on the flat function**

This narrows `upsertGraphEntity` so a **literal** co-owned type is a compile error, catching the
mistake at the keystroke rather than at CI:

```ts
export type CoOwnedEntityType = "source_file" | "directory" | "person" | "service";

/** `never` for a co-owned literal, so `upsertGraphEntity({ type: "source_file" })` fails to compile. */
type NonCoOwnedType<T extends string> = T extends CoOwnedEntityType ? never : T;
```

Then make `upsertGraphEntity` generic in its type parameter — `<T extends string>` with
`type: NonCoOwnedType<T>` — leaving every other field and the whole body unchanged.

**Do NOT write `type: Exclude<string, CoOwnedEntityType>`.** `Exclude` distributes over a union
and `string` is not a union, so it evaluates back to `string` and every co-owned type still
passes. Verified under `tsc --strict` on 2026-08-19: `const p: Exclude<string, "source_file"> =
"source_file"` **compiles clean**. That shape reads as enforcement and enforces nothing.

The generic form was verified the same way, and both halves of its behaviour matter:

```text
upsertFlat({ type: "pr" })           → compiles          (correct: not co-owned)
upsertFlat({ type: "source_file" })  → TS2322 error      (correct: co-owned)
const d: string = "source_file";
upsertFlat({ type: d })              → compiles          (DEGRADES: no literal to narrow)
```

That third line is why **Task 4's static audit is still required and is not redundant**: the
compiler protects literal call sites, the audit covers everything else. Neither alone is
sufficient, and this plan ships both.

Add two compile-assertion tests in the test file — one confirming a non-co-owned literal is
accepted, one confirming a co-owned literal is rejected — using whatever `@ts-expect-error`
convention the repo already uses for negative type tests. `@ts-expect-error` fails the build if
the error it expects stops occurring, so the guard cannot silently rot into a no-op.

- [ ] **Step 5: Confirm the existing graph suite is unaffected**

Run: `bun test packages/gateway/src/graph/`
Expected: PASS. `upsertGraphEntity` was not touched, so nothing should move.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/graph/relationship-graph.ts packages/gateway/src/graph/relationship-graph.metadata.test.ts
git commit -m "feat(graph): namespaced entity metadata write and read API"
```

---

## Task 2: The V54 migration

**Files:**

- Create: `packages/gateway/src/index/entity-metadata-v54-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (the `simpleStep(52, 53, …)` line at ~548)
- Test: `packages/gateway/src/index/entity-metadata-v54.test.ts` (new)

**Interfaces:**

- Consumes: `readEntityMetadata` (Task 1) in tests.
- Produces: `const ENTITY_METADATA_V54_SQL: string`, registered as the 53 → 54 step.

**Context:** mirror `packages/gateway/src/index/premortem-v53-sql.ts` for file shape and `simpleStep(52, 53, "premortem theme extraction tables", PREMORTEM_V53_SQL)` for registration. Read both before writing.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/entity-metadata-v54.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readEntityMetadata } from "../graph/relationship-graph.ts";
import { ENTITY_METADATA_V54_SQL } from "./entity-metadata-v54-sql.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE graph_entity (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, external_id TEXT NOT NULL,
    label TEXT NOT NULL, service TEXT, metadata TEXT,
    UNIQUE(type, external_id))`);
  return db;
}

function insert(db: Database, type: string, externalId: string, metadata: string | null): void {
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, metadata) VALUES (?, ?, ?, 'x', ?)",
    [`${type}:${externalId}`, type, externalId, metadata],
  );
}

function raw(db: Database, externalId: string): string | null {
  const row = db
    .query("SELECT metadata FROM graph_entity WHERE external_id = ?")
    .get(externalId) as { metadata: string | null } | null;
  return row?.metadata ?? null;
}

describe("V54 entity metadata namespacing migration", () => {
  test("wraps flat metadata on a co-owned type under `ownership`", () => {
    const db = makeDb();
    insert(db, "source_file", "f1", JSON.stringify({ ownerCount: 3, truncated: false }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(readEntityMetadata(raw(db, "f1"), "ownership")).toEqual({
      ownerCount: 3,
      truncated: false,
    });
  });

  test("wraps all four co-owned types", () => {
    const db = makeDb();
    for (const t of ["source_file", "directory", "person", "service"]) {
      insert(db, t, `e-${t}`, JSON.stringify({ ownerCount: 1 }));
    }
    db.run(ENTITY_METADATA_V54_SQL);
    for (const t of ["source_file", "directory", "person", "service"]) {
      expect(readEntityMetadata(raw(db, `e-${t}`), "ownership")).toEqual({ ownerCount: 1 });
    }
  });

  test("leaves NON-co-owned types flat", () => {
    const db = makeDb();
    insert(db, "pr", "pr1", JSON.stringify({ repo: "acme/web" }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "pr1")).toBe(JSON.stringify({ repo: "acme/web" }));
  });

  test("is idempotent — running twice does not double-wrap", () => {
    const db = makeDb();
    insert(db, "source_file", "f2", JSON.stringify({ ownerCount: 2 }));
    db.run(ENTITY_METADATA_V54_SQL);
    const once = raw(db, "f2");
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f2")).toBe(once);
    expect(readEntityMetadata(raw(db, "f2"), "ownership")).toEqual({ ownerCount: 2 });
  });

  // Spec § 5.3: the check is "no top-level key is a KNOWN WRITER", not merely
  // "$.ownership is absent" — otherwise a symbols-only row would be re-wrapped.
  test("does not re-wrap a row already namespaced under `symbols` only", () => {
    const db = makeDb();
    insert(db, "source_file", "f3", JSON.stringify({ symbols: { symbolCount: 4 } }));
    db.run(ENTITY_METADATA_V54_SQL);
    expect(readEntityMetadata(raw(db, "f3"), "symbols")).toEqual({ symbolCount: 4 });
    expect(readEntityMetadata(raw(db, "f3"), "ownership")).toBeNull();
  });

  test("leaves NULL metadata alone", () => {
    const db = makeDb();
    insert(db, "source_file", "f4", null);
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f4")).toBeNull();
  });

  test("leaves malformed metadata alone and does not raise", () => {
    const db = makeDb();
    insert(db, "source_file", "f5", "{not json");
    expect(() => db.run(ENTITY_METADATA_V54_SQL)).not.toThrow();
    expect(raw(db, "f5")).toBe("{not json");
  });

  test("leaves a JSON scalar or array alone", () => {
    const db = makeDb();
    insert(db, "source_file", "f6", "42");
    insert(db, "source_file", "f7", "[1,2]");
    db.run(ENTITY_METADATA_V54_SQL);
    expect(raw(db, "f6")).toBe("42");
    expect(raw(db, "f7")).toBe("[1,2]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/entity-metadata-v54.test.ts`
Expected: FAIL — cannot resolve module `./entity-metadata-v54-sql.ts`.

- [ ] **Step 3: Write the migration SQL**

Create `packages/gateway/src/index/entity-metadata-v54-sql.ts`:

```ts
/**
 * V54 — namespace `graph_entity.metadata` for the four co-owned entity types.
 *
 * `ownership/ownership-pass.ts` is the only current metadata writer on these types, so every
 * existing value belongs to it and migrates to `{"ownership": <existing>}`. Nothing is
 * discarded and no writer's history is guessed at.
 *
 * Three predicates carry weight and are easy to drop by accident:
 *
 * - `json(metadata)` rather than bare `metadata` — without it the existing object is stored
 *   as an ESCAPED STRING rather than nested JSON, and every read then returns null.
 * - `json_type(metadata) = 'object'` — excludes a valid JSON scalar or array, which
 *   `json_each` would otherwise iterate positionally and wrap into nonsense.
 * - The `NOT EXISTS` clause tests that NO top-level key is a known writer, not merely that
 *   `$.ownership` is absent. The narrower test would re-wrap a `{"symbols": …}` row. That
 *   cannot arise before this migration, but the check must not depend on that staying true.
 */
export const ENTITY_METADATA_V54_SQL = `
UPDATE graph_entity
SET metadata = json_object('ownership', json(metadata))
WHERE type IN ('source_file', 'directory', 'person', 'service')
  AND metadata IS NOT NULL
  AND json_valid(metadata)
  AND json_type(metadata) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(graph_entity.metadata)
    WHERE json_each.key IN ('ownership', 'symbols')
  );
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/entity-metadata-v54.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, import `ENTITY_METADATA_V54_SQL` alongside the other V-SQL imports, and add after the `simpleStep(52, 53, …)` entry at ~line 548:

```ts
  simpleStep(53, 54, "graph_entity metadata namespacing", ENTITY_METADATA_V54_SQL),
```

Read the surrounding `simpleStep` calls first — if the runner also maintains a `BACKFILL_LABELS` list, update it in the same commit.

**One companion constant is confirmed and must change in this commit:**
`packages/gateway/src/index/local-index.ts:265` holds `export const CURRENT_SCHEMA_VERSION = 53;`
— set it to **54**. Verified present at that line on 2026-08-19. A migration step registered
while the version constant still reads `53` is a half-landed migration: the step exists and
nothing believes the schema moved.

- [ ] **Step 6: Run the migration suite**

Run: `bun test packages/gateway/src/index/`
Expected: PASS. If a test asserts the current schema version or the migration count, update it here.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/entity-metadata-v54-sql.ts packages/gateway/src/index/entity-metadata-v54.test.ts packages/gateway/src/index/migrations/runner.ts
git commit -m "feat(index): V54 namespaces graph_entity metadata for co-owned types"
```

---

## Task 3: Convert both writers, and fix the bug

**Files:**

- Modify: `packages/gateway/src/ownership/ownership-pass.ts` (four `upsertGraphEntity` calls carrying `ownerCountsMetadata`, at ~484, ~520, ~700, plus the `person`/`service` writes)
- Modify: `packages/gateway/src/ownership/ownership-store.ts` (`parseCounts`, ~line 54)
- Modify: `packages/gateway/src/graph/graph-populator.ts` (co-owned writes, incl. `source_file` at ~497)
- Test: `packages/gateway/src/ownership/ownership-pass.metadata.test.ts` (new)

**Interfaces:**

- Consumes: `upsertGraphEntityNamespaced`, `readEntityMetadata`, `EntityMetadataWriter` (Task 1).
- Produces: nothing new — this is the behavioural fix.

**This task contains the regression test for the actual bug.** Write it first and confirm it **fails against the current code**, before converting anything. A test written after the fix proves the fix compiles, not that the bug existed.

- [ ] **Step 1: Write the failing regression test**

Create `packages/gateway/src/ownership/ownership-pass.metadata.test.ts`. Build the fixture the way the existing ownership tests do — read `ownership-pass.test.ts` first for its `git_blame_line` seeding helpers and reuse them rather than inventing a second fixture shape.

The test asserts the user-visible property:

```ts
// THE BUG. Before this task: ownership writes owner counts on a `source_file`; the code-symbol
// sync writes the SAME entity with no metadata and `metadata = excluded.metadata` NULLs them;
// `nimbus owners` then falls through to the branch meant for legacy pre-split rows. The counts
// must SURVIVE a symbol sync.
test("owner counts survive a code-symbol sync over the same file", () => {
  const db = makeOwnershipFixture();          // seeds git_blame_line for /repo/a.ts
  runOwnershipPass(db, { root: "/repo" });

  const before = findFileEntity(db, "/repo", "a.ts");
  expect(before?.counts.ownerCount).not.toBeNull();

  syncCodeSymbolGraph(db, { repoRoot: "/repo", file: "a.ts", symbols: ["foo"] });

  const after = findFileEntity(db, "/repo", "a.ts");
  expect(after?.counts.ownerCount).toBe(before?.counts.ownerCount);
  expect(after?.counts.ownersAboveFloor).toBe(before?.counts.ownersAboveFloor);
});
```

Adapt the helper names to whatever `ownership-pass.test.ts` and `graph-populator.ts` actually export — the assertions are the contract, the plumbing is local.

- [ ] **Step 2: Run it and confirm it fails FOR THE RIGHT REASON**

Run: `bun test packages/gateway/src/ownership/ownership-pass.metadata.test.ts`
Expected: FAIL, with `after.counts.ownerCount` being `null` where `before` had a number — the clobber, observed. **Record the exact output in your report.** A failure for any other reason (missing helper, bad fixture) means the test is not yet pinning the bug; fix the test before touching production code.

- [ ] **Step 3: Convert the ownership writes**

In `ownership-pass.ts`, change each co-owned `upsertGraphEntity` call to `upsertGraphEntityNamespaced` with `writer: "ownership"`, moving the existing `metadata:` value across unchanged. The `service:` and `label:` fields stay exactly as they are — spec D3 puts their clobbering out of scope.

- [ ] **Step 4: Convert the populator writes**

In `graph-populator.ts`, change co-owned `upsertGraphEntity` calls to `upsertGraphEntityNamespaced` with `writer: "symbols"`. Where the call passes no metadata today, pass `metadata: {}` — under `json_patch` that is a no-op preserving siblings, which Task 1's second test pins.

Convert only the four co-owned types. Every other `upsertGraphEntity` call in that file stays flat (spec D2).

**`ensureGraphEntity` is safe and must NOT be converted.** It is the sibling used for reference
and stub nodes, and it upserts with `ON CONFLICT (type, external_id) DO NOTHING` — verified at
`relationship-graph.ts:95-97`. It therefore writes metadata only when inserting a row that did
not exist, and can never overwrite another writer's namespace. Converting it would be churn, and
worse, would imply the flat/namespaced split tracks something other than "does this statement
overwrite metadata". Leave it, and leave its callers alone.

- [ ] **Step 5: Repoint the read**

In `ownership-store.ts`, `parseCounts` currently `JSON.parse`s the raw column and reads `m["ownerCount"]` at the root. Route it through `readEntityMetadata(raw, "ownership")` and read the fields from the returned namespace, keeping its existing `absent` fallback for `null`. Do not change what it returns for a legacy or missing row — the `ownersAboveFloor`-gated logic and its comment stay as they are.

- [ ] **Step 6: Run the regression test — it must now PASS**

Run: `bun test packages/gateway/src/ownership/ownership-pass.metadata.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full affected suites**

Run: `bun test packages/gateway/src/ownership/ packages/gateway/src/graph/ packages/gateway/src/agents/`
Expected: PASS. The agents suite covers `nimbus owners` rendering, which is the user-visible end of this fix.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ownership/ packages/gateway/src/graph/graph-populator.ts
git commit -m "fix(ownership): stop the symbol sync wiping owner counts"
```

---

## Task 4: The static audit rule

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Test: wherever that script's own tests live — locate them before writing, and follow their shape.

**Interfaces:**

- Consumes: `CO_OWNED_ENTITY_TYPES` (Task 1) — or its literal values; match how neighbouring rules in that file express their constants.
- Produces: a build-failing rule.

**Context:** this file already carries rules D20, D21 and D22 in the same shape — a named regex plus an allowed-path constant, e.g. `D22_DISPATCH_ALLOWED` / `D22_DISPATCH_RE` at ~line 708. Read those before writing; match their naming and reporting.

- [ ] **Step 1: Write the rule**

Reject any file, other than `packages/gateway/src/graph/relationship-graph.ts` itself, that calls the flat `upsertGraphEntity` with `type:` set to a co-owned type.

Write it as **what cannot pass**, not as what may: an allow-list of permitted callers is the shape that silently widens. State in a comment that the rule pins the flat function away from four types, and that a fifth co-owned type must be added here in the same commit it becomes co-owned.

**Match across lines.** The call this must catch is normally formatted as

```ts
upsertGraphEntity(db, {
  type: "source_file",
```

so a single-line regex would miss every real occurrence and pass vacuously — a guard that cannot
fire is worse than none, because it is believed. Use a multi-line match (`[\s\S]` between the
call and the `type:` literal, bounded so it cannot span into the next call), and **red-prove it
against a multi-line call site specifically**, since that is the only shape that appears in the
tree.

**State the rule's limit in its comment rather than implying completeness.** Neither layer is
total: the Step-4b compiler guard covers literal call sites and degrades on a `string`-typed
variable; this audit covers literals in any file but cannot resolve a dynamic type through a
variable either. Together they close every shape present in the tree today. A future call site
computing its type at runtime would evade both, and the comment should say so — an honest guard
records what it does not catch.

- [ ] **Step 2: Red-prove the rule**

Temporarily change one converted `graph-populator.ts` co-owned write back to `upsertGraphEntity`, run the audit, and confirm it **fails naming that file**. Restore.

Run: `bun run audit:structure` (or whatever `preflight:fast` invokes for the structure audit — check `scripts/lib/preflight-gates.ts` for the exact script name).

**Report the observed failure output.** A guard nobody has seen reject anything is a guard nobody knows works — and this branch exists because a protection looked present and was not.

- [ ] **Step 3: Confirm the audit passes on the real tree**

Run the audit again after restoring.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts
git commit -m "test(structure): reject flat upsertGraphEntity on co-owned types"
```

---

## Task 5: Documentation

**Files:**

- Modify: `docs/CHANGELOG.md`
- Modify: `docs/architecture.md` (schema reference — the V54 row)

- [ ] **Step 1: Add the changelog entry**

Prepend to `## Post-Phase-6 deliveries` in `docs/CHANGELOG.md`, dated **2026-08-19**. Match the surrounding entries' voice.

State plainly: this fixes a live bug where `nimbus owners` alternated between its real output and the fallback intended for legacy pre-split rows, depending on which pass ran last — no error, no gap note. Name the mechanism (`metadata = excluded.metadata` last-writer-wins), the four co-owned types, and the fact that `service` and `label` clobbering remain **out of scope by decision**, not oversight. Record that `json_patch` deletes on `null` and that absence is represented by omitting a key.

- [ ] **Step 2: Update the schema reference**

Add the V54 row to `docs/architecture.md`'s schema section, in the form the V51–V53 rows already use. Check what those rows record — if they name the tables touched, name `graph_entity`.

- [ ] **Step 3: Verify the doc gates**

Run: `bun run preflight:fast`, then `bun run audit:links`
Expected: PASS both.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: record V54 metadata namespacing and the owner-counts fix"
```

---

## Self-Review

**Spec coverage.** § 5.1 write API → Task 1. § 5.1's two requirements (populator converts, audit enforces) → Tasks 3 and 4. § 5.1 `json_patch` null caution → Task 1 test 4. § 5.1 omit-the-key convention → Global Constraints + Task 5. § 5.2 read API → Task 1. § 5.2 no-fallback → Task 1's "FLAT metadata is NOT resurrected" test. § 5.3 migration → Task 2, with all three load-bearing predicates given tests. § 5.4 static enforcement + red-prove → Task 4. § 6's seven test bullets → Tasks 1, 2, 3, 4. § 7 out-of-scope items → no task touches them, by construction.

**Placeholder scan.** Task 3 steps 1 and 3-5 describe edits against code the implementer must read rather than reproducing `ownership-pass.ts` and `graph-populator.ts` wholesale — the conversions are mechanical (`upsertGraphEntity` → `upsertGraphEntityNamespaced` plus a `writer:` field) and the exact surrounding lines will have shifted. The assertions in step 1 are given as real code because they are the contract. Task 4 does not supply the rule's regex because it must match the neighbouring D-rules' conventions, which the implementer reads. Task 5 describes prose that must match surrounding voice. No `TBD`/`TODO`.

**Type consistency.** `EntityMetadataWriter`, `CO_OWNED_ENTITY_TYPES`, `upsertGraphEntityNamespaced`, `readEntityMetadata`, `ENTITY_METADATA_V54_SQL` appear under exactly these names in every task referencing them. `readEntityMetadata` takes `(raw: string | null, writer)` — a raw column value, not an entity row — consistently in Tasks 1, 2 and 3.

**Two things deliberately left to the implementer to look up, flagged so they are not mistaken for gaps:** the exact structure-audit script name (Task 4 step 2 says to read `scripts/lib/preflight-gates.ts` for it), and whether `migrations/runner.ts` carries companion bookkeeping beyond the `simpleStep` line (Task 2 step 5 says to check and update in the same commit). Both are one-command lookups where guessing would be worse than reading.
