# Why-Lens Step 1a — Graph-Populator Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `resolves`, `mentions` and `correlates_with` graph edges real — they are declared in the schema but written by no populator — so the `nimbus why` agent (step 1b) can traverse them instead of returning permanently-empty lanes.

**Architecture:** All work is inside `packages/gateway/src/graph/graph-populator.ts` and its callers. Edges are emitted from `syncGraphFromIndexedItem`, the single function `index/item-store.ts` calls on every item upsert. Three of the new edges are *cross-item* (their two endpoints come from different items' syncs), which today's blanket relation-clear would silently delete — so the clear is scoped first, in Task 1, before any cross-item edge is emitted. `incident` and `deployment` have no graph entities at all today, so they are created before they can be correlated. A backfill re-runs the populator over already-indexed items, since edges otherwise appear only when an item next re-syncs.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`, Biome.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **All SQL writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `db/write.ts` (invariant `I14`, static check `D12`). Never call `db.run` directly in production code.
- **Bound parameters only** (invariant `I9`). No string interpolation of values into SQL. Placeholder *counts* may be built from array length; values always bind.
- **No new migration.** Every table and relation type used here already exists (V7 / V12 / V27). `graph_relation.type` is FK-constrained to `graph_relation_type(name)` — all five types used here are already rows in that table.
- **No circular imports.** `index/item-store.ts` imports `graph/graph-populator.ts`; the reverse is forbidden.
- **Cross-platform paths** — `path.join()`, never hardcoded separators.
- **Test isolation** — real SQLite (`new Database(":memory:")` + `LocalIndex.ensureSchema(db)`), no DB-layer mocks.
- **Per-file coverage floor ≥80% line and branch.** The floor is Docker-Linux-authoritative; verify there, not on native Windows.
- Run `bun run preflight:fast` after every task; `bun run preflight` before the first push.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/gateway/src/index/item-key.ts` | `itemPrimaryKey` as a dependency-free leaf, so the populator can build item keys without importing `item-store` | **Create** (Task 3) |
| `packages/gateway/src/index/item-store.ts` | Item upsert; re-exports `itemPrimaryKey`; passes `bodyPreview` to the populator | Modify (Tasks 2, 3) |
| `packages/gateway/src/graph/graph-populator.ts` | All entity + relation emission | Modify (Tasks 1–6) |
| `packages/gateway/src/graph/graph-refs.ts` | Pure reference extraction from text (issue refs, ticket keys, PR/commit refs) — no DB, no I/O | **Create** (Task 3) |
| `packages/gateway/src/graph/graph-refs.test.ts` | Unit tests for the pure extractors | **Create** (Task 3) |
| `packages/gateway/src/graph/graph-populator-clear.test.ts` | Proves cross-item edges survive a far-entity re-sync | **Create** (Task 1) |
| `packages/gateway/src/graph/graph-populator-resolves.test.ts` | `resolves` emission | **Create** (Task 3) |
| `packages/gateway/src/graph/graph-populator-mentions.test.ts` | `mentions` emission | **Create** (Task 4) |
| `packages/gateway/src/graph/graph-populator-incidents.test.ts` | `incident` / `deployment` entities + `correlates_with` | **Create** (Tasks 5, 6) |
| `packages/gateway/src/graph/regraph.ts` | Re-run the populator over every indexed item | **Create** (Task 7) |
| `packages/gateway/src/graph/regraph.test.ts` | Backfill tests | **Create** (Task 7) |

Reference extraction lives in its own file because it is pure, heavily branched, and the part most worth testing exhaustively — keeping it out of the DB-touching populator lets it be tested without a database.

---

### Task 1: Scope the relation clear so cross-item edges survive

Every sync function opens with `clearRelationsTouchingEntity`, which deletes **every** relation touching the entity in either direction. That is safe today only because every existing edge is emitted by the sync of one of its own endpoints. The moment a message emits `mentions → pr`, the next PR re-sync deletes it.

This task must land first — every later task depends on it.

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts:37-39`
- Test: `packages/gateway/src/graph/graph-populator-clear.test.ts` (create)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `CROSS_ITEM_RELATION_TYPES` — module-private, `readonly string[]` frozen to `["resolves", "mentions", "correlates_with"]`.
  - `clearRelationsTouchingEntity(db: Database, entityId: string): void` — unchanged signature, new behavior.

**The two directional clear helpers are deliberately NOT introduced here.** `clearOutgoingRelationsOfType` first has a caller in Task 3, `clearIncomingRelationsOfType` in Task 6, and `biome.json` sets `noUnusedVariables: "error"` — which fires on unused module-private functions. Introducing them early makes this task fail `lint` / `preflight:fast` / the pre-commit hook, so each is defined in the task that first calls it. Their contracts are stated here so the design reads as a whole:

| Helper | Introduced in | Contract |
| --- | --- | --- |
| `clearOutgoingRelationsOfType(db, fromId, relationType)` | Task 3 | Deletes `from_id = fromId AND type = relationType`. The *source* of a cross-item edge is authoritative for it. |
| `clearIncomingRelationsOfType(db, toId, relationType)` | Task 6 | Deletes `to_id = toId AND type = relationType`. The mirror, for when the *target* decides whether the edge still belongs. |

The two are disjoint in effect — one keys `from_id`, the other `to_id` — so each side stays authoritative for its own slice of a cross-item relation without racing the other.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/graph-populator-clear.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { upsertGraphRelation } from "./relationship-graph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function relationCount(db: Database, type: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = ?").get(type) as {
    n: number;
  };
  return row.n;
}

test("a cross-item `mentions` edge survives a re-sync of the entity it points at", () => {
  const db = freshDb();
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "patch",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: "shipping acme/app#1 now",
    bodyPreview: "shipping acme/app#1 now",
    modifiedAt: now,
    syncedAt: now,
    metadata: { channel: "C1" },
  });

  const pr = db
    .query("SELECT id FROM graph_entity WHERE type = 'pr' LIMIT 1")
    .get() as { id: string };
  const msg = db
    .query("SELECT id FROM graph_entity WHERE type = 'message' LIMIT 1")
    .get() as { id: string };

  // Stand in for what Task 4 will emit from the message side.
  upsertGraphRelation(db, msg.id, pr.id, "mentions", now);
  expect(relationCount(db, "mentions")).toBe(1);

  // Re-sync the PR. Its own edges are rebuilt; the message's edge must not be collateral.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login (v2)",
    bodyPreview: "patch",
    modifiedAt: now + 1,
    syncedAt: now + 1,
    metadata: { repo: "acme/app" },
  });

  expect(relationCount(db, "mentions")).toBe(1);
});

test("a re-sync still rebuilds the entity's own edges rather than duplicating them", () => {
  const db = freshDb();
  const now = Date.now();

  for (const [i, title] of ["Fix login", "Fix login (v2)"].entries()) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title,
      bodyPreview: "patch",
      modifiedAt: now + i,
      syncedAt: now + i,
      metadata: { repo: "acme/app" },
    });
  }

  expect(relationCount(db, "targets")).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-clear.test.ts`

Expected: FAIL. The first test fails with `expect(1).toBe(1)` on the *second* assertion receiving `0` — the PR re-sync deleted the message's `mentions` edge. The second test passes already (it documents behavior that must not regress).

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/graph/graph-populator.ts`, replace the existing `clearRelationsTouchingEntity` (currently lines 37-39) with:

```ts
/**
 * Relation types whose two endpoints come from *different* items' syncs.
 * The blanket clear below must not touch them: the entity being cleared is
 * only one endpoint, and the other side is authoritative for the edge.
 * Each emitting sync function clears its own outgoing edges of these types
 * via `clearOutgoingRelationsOfType` immediately before re-emitting them.
 */
const CROSS_ITEM_RELATION_TYPES: readonly string[] = Object.freeze([
  "resolves",
  "mentions",
  "correlates_with",
]);

function clearRelationsTouchingEntity(db: Database, entityId: string): void {
  const placeholders = CROSS_ITEM_RELATION_TYPES.map(() => "?").join(", ");
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE (from_id = ? OR to_id = ?)
        AND type NOT IN (${placeholders})`,
    [entityId, entityId, ...CROSS_ITEM_RELATION_TYPES],
  );
}
```

Note the placeholder string is built from array *length* only — every value still binds, so `I9` holds.

Nothing else is added in this task — see the note above on why the two directional clear helpers land with their first callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/graph-populator-clear.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Verify nothing else regressed**

Run: `bun test packages/gateway/src/graph/ packages/gateway/src/agents/impact.test.ts`

Expected: PASS. The existing graph and impact suites must be green **unchanged** — this task alters shared behavior, so their passing is the honesty gate.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-clear.test.ts
git commit -m "fix(graph): scope the relation clear so cross-item edges survive re-sync"
```

---

### Task 2: Carry the item body into the populator

Reference extraction needs the PR and message body. `IndexedItemGraphInput` carries only `{id, service, type, title, authorId, metadata}`.

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts:12-19`
- Modify: `packages/gateway/src/index/item-store.ts:104-111`
- Test: `packages/gateway/src/graph/graph-populator-clear.test.ts` (extend)

**Interfaces:**

- Consumes: Task 1's scoped clear.
- Produces: `IndexedItemGraphInput` gains `bodyPreview: string | null`. Every later task reads `row.bodyPreview`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/graph/graph-populator-clear.test.ts`:

```ts
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

test("the populator receives the item body", () => {
  const db = freshDb();
  const now = Date.now();

  // Compiles only once IndexedItemGraphInput carries bodyPreview.
  syncGraphFromIndexedItem(db, {
    id: "github:acme/app#7",
    service: "github",
    type: "pr",
    title: "Fix login",
    bodyPreview: "closes #4",
    authorId: null,
    metadata: { repo: "acme/app" },
  });

  const pr = db.query("SELECT id FROM graph_entity WHERE type = 'pr' LIMIT 1").get() as
    | { id: string }
    | null;
  expect(pr).not.toBeNull();
  void now;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-clear.test.ts`

Expected: FAIL at typecheck — `Object literal may only specify known properties, and 'bodyPreview' does not exist in type 'IndexedItemGraphInput'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/graph/graph-populator.ts`, extend the type:

```ts
export type IndexedItemGraphInput = {
  id: string;
  service: string;
  type: string;
  title: string;
  bodyPreview: string | null;
  authorId: string | null;
  metadata: Record<string, unknown>;
};
```

In `packages/gateway/src/index/item-store.ts`, at the `syncGraphFromIndexedItem` call (currently line 104), add the field. `preview` is already computed above the `dbRun`:

```ts
  syncGraphFromIndexedItem(db, {
    id,
    service: row.service,
    type: row.type,
    title: row.title,
    bodyPreview: preview,
    authorId: row.authorId ?? null,
    metadata: row.metadata ?? {},
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/ && bunx tsc --noEmit -p packages/gateway/tsconfig.json`

Expected: PASS, and a clean typecheck. `bun test` does not typecheck — run both. Any other construction site of `IndexedItemGraphInput` (tests included) will fail the typecheck until it supplies `bodyPreview`; fix each by adding `bodyPreview: null`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/index/item-store.ts packages/gateway/src/graph/graph-populator-clear.test.ts
git commit -m "feat(graph): carry the item body into the populator"
```

---

### Task 3: Emit `resolves` — PR body to issue

**Files:**

- Create: `packages/gateway/src/index/item-key.ts`
- Create: `packages/gateway/src/graph/graph-refs.ts`
- Create: `packages/gateway/src/graph/graph-refs.test.ts`
- Create: `packages/gateway/src/graph/graph-populator-resolves.test.ts`
- Modify: `packages/gateway/src/index/item-store.ts:26-31`
- Modify: `packages/gateway/src/graph/graph-populator.ts` (`syncPrGraph`)

**Interfaces:**

- Consumes: Task 1's `clearOutgoingRelationsOfType`; Task 2's `row.bodyPreview`.
- Produces:
  - `itemPrimaryKey(service: string, externalId: string): string` — moved to `index/item-key.ts`, re-exported from `item-store.ts` so existing importers are untouched.
  - `extractIssueRefs(text: string): { numeric: number[]; ticketKeys: string[] }` from `graph/graph-refs.ts`.

`itemPrimaryKey` must move because `item-store.ts` imports `graph-populator.ts`; importing it back would be a circular dependency, which the project forbids. A dependency-free leaf module is the fix — not a second copy.

- [ ] **Step 1: Write the failing test for the pure extractor**

Create `packages/gateway/src/graph/graph-refs.test.ts`:

```ts
import { expect, test } from "bun:test";

import { extractIssueRefs } from "./graph-refs.ts";

test("extracts GitHub-style numeric issue references", () => {
  expect(extractIssueRefs("closes #4 and fixes #17")).toEqual({
    numeric: [4, 17],
    ticketKeys: [],
  });
});

test("extracts ticket keys", () => {
  expect(extractIssueRefs("part of NIM-88, follows ABC-7")).toEqual({
    numeric: [],
    ticketKeys: ["NIM-88", "ABC-7"],
  });
});

test("deduplicates and preserves first-seen order", () => {
  expect(extractIssueRefs("#4 #4 NIM-1 NIM-1 #9")).toEqual({
    numeric: [4, 9],
    ticketKeys: ["NIM-1"],
  });
});

test("ignores lowercase and over-long keys that are not ticket keys", () => {
  expect(extractIssueRefs("abc-1 and VERYLONGPROJECT-2")).toEqual({
    numeric: [],
    ticketKeys: [],
  });
});

test("ignores a bare hash with no digits", () => {
  expect(extractIssueRefs("# heading and #")).toEqual({ numeric: [], ticketKeys: [] });
});

test("handles empty input", () => {
  expect(extractIssueRefs("")).toEqual({ numeric: [], ticketKeys: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-refs.test.ts`

Expected: FAIL — `Cannot find module './graph-refs.ts'`.

- [ ] **Step 3: Write the extractor**

Create `packages/gateway/src/graph/graph-refs.ts`:

```ts
/**
 * Pure reference extraction from indexed text. No DB, no I/O — every
 * function here is a total function of its input string, which is what
 * makes the branch-heavy parsing cheap to test exhaustively.
 */

const NUMERIC_REF_RE = /#(\d+)/g;
// Ticket keys: 2-10 uppercase alphanumerics, a hyphen, then digits.
// The bounded length is what keeps SHOUTING-1 style prose out.
const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;

export type IssueRefs = {
  numeric: number[];
  ticketKeys: string[];
};

export function extractIssueRefs(text: string): IssueRefs {
  const numeric: number[] = [];
  const seenNumeric = new Set<number>();
  for (const m of text.matchAll(NUMERIC_REF_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || seenNumeric.has(n)) continue;
    seenNumeric.add(n);
    numeric.push(n);
  }

  const ticketKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const m of text.matchAll(TICKET_KEY_RE)) {
    const key = m[0];
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    ticketKeys.push(key);
  }

  return { numeric, ticketKeys };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/graph-refs.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Extract `itemPrimaryKey` to a leaf module**

Create `packages/gateway/src/index/item-key.ts`:

```ts
/**
 * The `<service>:<externalId>` primary key shared by the item table and the
 * graph populator. Lives in its own dependency-free module because
 * `item-store.ts` imports the populator — importing the key helper back out
 * of `item-store` would close a cycle.
 */
export function itemPrimaryKey(service: string, externalId: string): string {
  const prefix = `${service}:`;
  if (externalId.startsWith(prefix)) {
    return externalId;
  }
  return `${service}:${externalId}`;
}
```

In `packages/gateway/src/index/item-store.ts`, delete the local `itemPrimaryKey` definition (currently lines 26-31) and replace it with a re-export near the top of the file, so every existing importer keeps working:

```ts
export { itemPrimaryKey } from "./item-key.ts";
```

Add the matching value import for internal use:

```ts
import { itemPrimaryKey } from "./item-key.ts";
```

- [ ] **Step 6: Verify the extraction is behavior-neutral**

Run: `bun test packages/gateway/src/index/ && bunx tsc --noEmit -p packages/gateway/tsconfig.json`

Expected: PASS and a clean typecheck. No test should change — this is a pure move.

- [ ] **Step 7: Write the failing test for `resolves` emission**

Create `packages/gateway/src/graph/graph-populator-resolves.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedIssue(db: Database, externalId: string, title: string, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId,
    title,
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { repo: "acme/app" },
  });
}

function resolvesTargets(db: Database): string[] {
  const rows = db
    .query(
      `SELECT e.external_id AS ext
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = 'resolves'
        ORDER BY ext`,
    )
    .all() as Array<{ ext: string }>;
  return rows.map((r) => r.ext);
}

test("a PR body referencing #4 emits resolves to that repo's issue 4", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #4",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["github:acme/app#4"]);
});

test("a numeric ref with no matching issue emits no edge", () => {
  const db = freshDb();
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #999",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual([]);
});

test("a ticket key matches an issue indexed by another service", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["linear:NIM-88"]);
});

test("removing the reference from the PR body removes the edge on re-sync", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);

  for (const [i, body] of ["closes #4", "no longer references anything"].entries()) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix login",
      bodyPreview: body,
      modifiedAt: now + i,
      syncedAt: now + i,
      metadata: { repo: "acme/app" },
    });
  }

  expect(resolvesTargets(db)).toEqual([]);
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-resolves.test.ts`

Expected: FAIL — the first test gets `[]` instead of `["github:acme/app#4"]`; nothing emits `resolves` yet.

- [ ] **Step 9: Emit `resolves` from `syncPrGraph`**

In `packages/gateway/src/graph/graph-populator.ts`, add the import:

```ts
import { itemPrimaryKey } from "../index/item-key.ts";
import { type IssueRefs, extractIssueRefs } from "./graph-refs.ts";
```

Add the first directional clear helper (declared in Task 1, introduced here because this is its first caller):

```ts
/**
 * Clear one entity's outgoing edges of a single cross-item relation type.
 * Call this from the *emitting* side before re-emitting, so a reference
 * removed from a PR body or message body disappears from the graph.
 * `clearRelationsTouchingEntity` deliberately skips these types (Task 1),
 * so this is the only thing that retires them.
 */
function clearOutgoingRelationsOfType(db: Database, fromId: string, relationType: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? AND type = ?", [fromId, relationType]);
}
```

Add this helper above `syncPrGraph`:

```ts
/**
 * Resolve a PR/message reference to an existing `issue` graph entity.
 * Numeric refs are scoped to the referring item's own repo and service —
 * `#4` means a different issue in a different repo. Ticket keys are
 * service-agnostic, since the tracker is usually not the forge.
 */
function findIssueEntityIds(
  db: Database,
  service: string,
  repoFull: string | undefined,
  refs: IssueRefs,
): string[] {
  const ids: string[] = [];

  if (repoFull !== undefined) {
    for (const n of refs.numeric) {
      const ext = itemPrimaryKey(service, `${repoFull}#${n}`);
      const row = db
        .query("SELECT id FROM graph_entity WHERE type = 'issue' AND external_id = ? LIMIT 1")
        .get(ext) as { id?: string } | null;
      if (row?.id !== undefined) ids.push(row.id);
    }
  }

  for (const key of refs.ticketKeys) {
    const row = db
      .query(
        `SELECT id FROM graph_entity
          WHERE type = 'issue' AND (external_id = ? OR external_id LIKE '%:' || ?)
          ORDER BY id ASC LIMIT 1`,
      )
      .get(key, key) as { id?: string } | null;
    if (row?.id !== undefined) ids.push(row.id);
  }

  return Array.from(new Set(ids));
}
```

Then at the end of `syncPrGraph`, after the `merged_as` block, append:

```ts
  clearOutgoingRelationsOfType(db, prEntityId, "resolves");
  const refs = extractIssueRefs(`${row.title}\n${row.bodyPreview ?? ""}`);
  for (const issueId of findIssueEntityIds(db, row.service, repoFull, refs)) {
    upsertGraphRelation(db, prEntityId, issueId, "resolves", now);
  }
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/`

Expected: PASS. All four `resolves` tests green, and every pre-existing graph test still green.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/index/item-key.ts packages/gateway/src/index/item-store.ts packages/gateway/src/graph/graph-refs.ts packages/gateway/src/graph/graph-refs.test.ts packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-resolves.test.ts
git commit -m "feat(graph): emit resolves edges from PR bodies to issues"
```

---

### Task 4: Emit `mentions` — message body to PR, issue, or commit

**Files:**

- Modify: `packages/gateway/src/graph/graph-refs.ts`
- Modify: `packages/gateway/src/graph/graph-refs.test.ts`
- Modify: `packages/gateway/src/graph/graph-populator.ts` (`syncMessageGraph`)
- Create: `packages/gateway/src/graph/graph-populator-mentions.test.ts`

**Interfaces:**

- Consumes: Task 3's `extractIssueRefs`, `itemPrimaryKey`, `clearOutgoingRelationsOfType`.
- Produces: `extractCommitShas(text: string): string[]` from `graph/graph-refs.ts`.

- [ ] **Step 1: Write the failing test for SHA extraction**

Append to `packages/gateway/src/graph/graph-refs.test.ts`:

```ts
import { extractCommitShas } from "./graph-refs.ts";

test("extracts 7-to-40 character hex SHAs", () => {
  expect(extractCommitShas("see a1b2c3d and 0123456789abcdef0123456789abcdef01234567")).toEqual([
    "a1b2c3d",
    "0123456789abcdef0123456789abcdef01234567",
  ]);
});

test("ignores short hex runs and decimal numbers", () => {
  expect(extractCommitShas("abc123 and 1234567")).toEqual(["1234567"]);
});

test("deduplicates SHAs", () => {
  expect(extractCommitShas("a1b2c3d a1b2c3d")).toEqual(["a1b2c3d"]);
});
```

Note the second case: `1234567` is seven hex characters and is indistinguishable from a short SHA by shape alone. **It is deliberately kept.**

A reviewer proposed skipping all-decimal 7-character candidates to avoid false-positive lookups. The arithmetic argues against it: a hex character is decimal with probability 10/16, so an all-decimal 7-character SHA prefix occurs at rate (10/16)⁷ ≈ **3.7%**. That filter would silently drop roughly one in twenty-seven real short-SHA mentions.

What it buys is one avoided lookup per false positive. That lookup is `external_id LIKE '%:' || ?`, which cannot use an index — but it is bounded by the `UNIQUE(type, external_id)` prefix on `type = 'commit'`, so it scans commit entities only, and a message body yields few candidates.

The trade is a few milliseconds against a 3.7% silent miss rate. This entire phase exists because three lanes were silently empty; accepting a new silent-miss rate to save microseconds is the wrong direction. Keep the false positives — they resolve to nothing and emit nothing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-refs.test.ts`

Expected: FAIL — `extractCommitShas is not a function`.

- [ ] **Step 3: Add the extractor**

Append to `packages/gateway/src/graph/graph-refs.ts`:

```ts
const COMMIT_SHA_RE = /\b([0-9a-f]{7,40})\b/g;

export function extractCommitShas(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(COMMIT_SHA_RE)) {
    const sha = m[1];
    if (sha === undefined || seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/graph-refs.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing test for `mentions` emission**

Create `packages/gateway/src/graph/graph-populator-mentions.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function mentionTargets(db: Database): string[] {
  const rows = db
    .query(
      `SELECT e.type || ':' || e.external_id AS ref
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = 'mentions'
        ORDER BY ref`,
    )
    .all() as Array<{ ref: string }>;
  return rows.map((r) => r.ref);
}

function seedMessage(db: Database, body: string, at: number): void {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: body,
    bodyPreview: body,
    modifiedAt: at,
    syncedAt: at,
    metadata: { channel: "C1" },
  });
}

test("a message naming a ticket key mentions that issue", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);

  expect(mentionTargets(db)).toEqual(["issue:linear:NIM-88"]);
});

test("a message naming a commit SHA mentions that commit", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: "a1b2c3d4e5f6",
    title: "Fix retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha: "a1b2c3d4e5f6", repoRoot: "/repo" },
  });

  seedMessage(db, "this broke in a1b2c3d4e5f6", now);

  expect(mentionTargets(db)).toEqual(["commit:github:a1b2c3d4e5f6"]);
});

test("a message referencing nothing indexed emits no edges", () => {
  const db = freshDb();
  const now = Date.now();
  seedMessage(db, "lunch?", now);
  expect(mentionTargets(db)).toEqual([]);
});

test("editing a message to drop the reference drops the edge", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);
  seedMessage(db, "never mind", now + 1);

  expect(mentionTargets(db)).toEqual([]);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-mentions.test.ts`

Expected: FAIL — first test gets `[]`; nothing emits `mentions`.

- [ ] **Step 7: Emit `mentions` from `syncMessageGraph`**

In `packages/gateway/src/graph/graph-populator.ts`, add to the import from `./graph-refs.ts`:

```ts
import { type IssueRefs, extractCommitShas, extractIssueRefs } from "./graph-refs.ts";
```

Add this helper above `syncMessageGraph`:

```ts
/**
 * Resolve commit SHAs to `commit` entities by their `<service>:<sha>` external id.
 *
 * The extracted string is treated as a PREFIX of the stored SHA, anchored to the
 * start of the SHA portion. This is load-bearing: commits are indexed with full
 * 40-character SHAs, but people cite them in chat as 7-character short SHAs — the
 * exact case `COMMIT_SHA_RE`'s `{7,40}` bound exists to catch. An exact-suffix
 * match (`LIKE '%:' || ?`) matches only full-length SHAs and silently emits
 * nothing for every realistic short-SHA mention.
 *
 * When a short prefix is ambiguous across services the tie-break is arbitrary,
 * the same limitation `findIssueEntityIds` carries for duplicate ticket keys.
 */
function findCommitEntityIds(db: Database, shas: readonly string[]): string[] {
  const ids: string[] = [];
  for (const sha of shas) {
    const row = db
      .query(
        `SELECT id FROM graph_entity
          WHERE type = 'commit'
            AND substr(external_id, instr(external_id, ':') + 1) LIKE ? || '%'
          ORDER BY id ASC LIMIT 1`,
      )
      .get(sha) as { id?: string } | null;
    if (row?.id !== undefined) ids.push(row.id);
  }
  return ids;
}
```

At the end of `syncMessageGraph`, after the channel block, append:

```ts
  clearOutgoingRelationsOfType(db, msgEntityId, "mentions");
  const text = `${row.title}\n${row.bodyPreview ?? ""}`;
  const mentioned = new Set<string>([
    ...findIssueEntityIds(db, row.service, undefined, extractIssueRefs(text)),
    ...findCommitEntityIds(db, extractCommitShas(text)),
  ]);
  for (const targetId of mentioned) {
    upsertGraphRelation(db, msgEntityId, targetId, "mentions", now);
  }
```

`findIssueEntityIds` is passed `undefined` for the repo: a `#4` in Slack has no repo context, so only ticket keys resolve. That is deliberate — a repo-less numeric ref would otherwise match an arbitrary repo's issue 4.

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/`

Expected: PASS — all four `mentions` tests, plus every earlier graph test.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/graph/graph-refs.ts packages/gateway/src/graph/graph-refs.test.ts packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-mentions.test.ts
git commit -m "feat(graph): emit mentions edges from messages to issues and commits"
```

---

### Task 5: Create `incident` and `deployment` graph entities

Both types are indexed as items by real connectors and both are in `ITEM_LINKED_ENTITY_TYPES`, but `syncGraphFromIndexedItem` has no branch for either — so no entity is ever created. Nothing can be correlated until they exist.

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Create: `packages/gateway/src/graph/graph-populator-incidents.test.ts`

**Interfaces:**

- Consumes: Task 2's `row.bodyPreview` (unused here, but the type is shared).
- Produces: `incident` and `deployment` graph entity types, each with `external_id = row.id`, `service = row.service`, and `metadata` carrying `occurredAt` (epoch ms) plus the item's `service` field. Task 6 correlates on `occurredAt`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/graph-populator-incidents.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function entityTypes(db: Database): string[] {
  const rows = db
    .query("SELECT DISTINCT type FROM graph_entity ORDER BY type")
    .all() as Array<{ type: string }>;
  return rows.map((r) => r.type);
}

test("an indexed incident becomes an incident graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("incident");
  const row = db
    .query("SELECT external_id, service FROM graph_entity WHERE type = 'incident'")
    .get() as { external_id: string; service: string };
  expect(row.external_id).toBe("pagerduty:PD-1");
  expect(row.service).toBe("pagerduty");
});

test("an indexed deployment becomes a deployment graph entity", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { service: "checkout" },
  });

  expect(entityTypes(db)).toContain("deployment");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-incidents.test.ts`

Expected: FAIL — `entityTypes(db)` is `[]`; no branch handles either type.

- [ ] **Step 3: Write the sync functions**

In `packages/gateway/src/graph/graph-populator.ts`, add above `syncGraphFromIndexedItem`:

```ts
/**
 * Incidents and deployments are timeline anchors: the graph needs them as
 * entities so a change can be correlated with what it responded to or
 * caused. `occurredAt` is the item's `modified_at`, which every connector
 * sets to the event time.
 */
function syncTimelineEventGraph(
  db: Database,
  row: IndexedItemGraphInput,
  entityType: "incident" | "deployment",
  occurredAt: number,
  now: number,
): void {
  const affectedService = stringField(row.metadata, "service");
  const entityId = upsertGraphEntity(db, {
    type: entityType,
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { occurredAt, affectedService: affectedService ?? null },
  });
  clearRelationsTouchingEntity(db, entityId);
  void now;
}
```

`syncGraphFromIndexedItem` does not currently receive the item's `modified_at`. Rather than widen the input a second time, read it back — the row was written immediately before the populator call, so it is always present:

```ts
function occurredAtForItem(db: Database, itemId: string): number {
  const row = db.query("SELECT modified_at FROM item WHERE id = ?").get(itemId) as
    | { modified_at: number }
    | null;
  return row?.modified_at ?? Date.now();
}
```

Then add the dispatch branches inside `syncGraphFromIndexedItem`, before the closing brace:

```ts
  if (row.type === "incident") {
    syncTimelineEventGraph(db, row, "incident", occurredAtForItem(db, row.id), now);
    return;
  }
  if (row.type === "deployment") {
    syncTimelineEventGraph(db, row, "deployment", occurredAtForItem(db, row.id), now);
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/graph-populator-incidents.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-incidents.test.ts
git commit -m "feat(graph): create incident and deployment graph entities"
```

---

### Task 6: Emit `correlates_with` — deployment to incident

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Modify: `packages/gateway/src/graph/graph-populator-incidents.test.ts`

**Interfaces:**

- Consumes: Task 5's `incident` / `deployment` entities and their `occurredAt` metadata; Task 1's `clearOutgoingRelationsOfType`.
- Produces: `correlates_with` edges, always directed **deployment → incident**, emitted from whichever side syncs. Window: the incident occurred within `CORRELATION_WINDOW_MS` (2 hours) **after** the deployment, and both name the same `affectedService`.

The direction is fixed regardless of which item triggers the sync, so the `why` agent's driver lane has one traversal to write.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/graph/graph-populator-incidents.test.ts`:

```ts
const HOUR = 60 * 60 * 1000;

function correlations(db: Database): Array<{ from: string; to: string }> {
  return db
    .query(
      `SELECT f.type || ':' || f.external_id AS "from",
              t.type || ':' || t.external_id AS "to"
         FROM graph_relation r
         JOIN graph_entity f ON f.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id
        WHERE r.type = 'correlates_with'
        ORDER BY "from", "to"`,
    )
    .all() as Array<{ from: string; to: string }>;
}

function seedDeploy(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "deployment",
    externalId: "deploy-9",
    title: "Deploy checkout v2",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

function seedIncident(db: Database, at: number, service: string): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { service },
  });
}

test("an incident shortly after a deploy of the same service correlates", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("correlation is emitted regardless of which side syncs last", () => {
  const db = freshDb();
  const t = Date.now();
  seedIncident(db, t + HOUR, "checkout");
  seedDeploy(db, t, "checkout");

  expect(correlations(db)).toEqual([
    { from: "deployment:github:deploy-9", to: "incident:pagerduty:PD-1" },
  ]);
});

test("an incident outside the window does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("an incident before the deploy does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t - HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});

test("a different service does not correlate", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident to a different service retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident is re-classified against a different service.
  seedIncident(db, t + HOUR, "search");

  expect(correlations(db)).toEqual([]);
});

test("re-syncing an incident out of the window retires the stale correlation", () => {
  const db = freshDb();
  const t = Date.now();
  seedDeploy(db, t, "checkout");
  seedIncident(db, t + HOUR, "checkout");
  expect(correlations(db)).toHaveLength(1);

  // The incident's true start time turns out to be much later.
  seedIncident(db, t + 5 * HOUR, "checkout");

  expect(correlations(db)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-incidents.test.ts`

Expected: FAIL — the first two tests get `[]`, and the two retirement tests fail on their second assertion with a surviving stale edge.

- [ ] **Step 3: Implement the correlation**

In `packages/gateway/src/graph/graph-populator.ts`, add the second directional clear helper (declared in Task 1, introduced here because this is its first caller):

```ts
/**
 * The mirror of `clearOutgoingRelationsOfType`, for a cross-item edge whose
 * *target* decides whether the edge still belongs: an incident that moves in
 * time or changes service must drop the correlations pointing at it, and only
 * the incident's own sync knows that.
 */
function clearIncomingRelationsOfType(db: Database, toId: string, relationType: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE to_id = ? AND type = ?", [toId, relationType]);
}
```

Then add above `syncTimelineEventGraph`:

```ts
/** An incident this long after a deploy of the same service is treated as related. */
const CORRELATION_WINDOW_MS = 2 * 60 * 60 * 1000;

type TimelineRow = { id: string; occurred_at: number };

function timelineCounterparts(
  db: Database,
  counterpartType: "incident" | "deployment",
  affectedService: string,
  windowFrom: number,
  windowTo: number,
): TimelineRow[] {
  return db
    .query(
      `SELECT id,
              CAST(json_extract(metadata, '$.occurredAt') AS INTEGER) AS occurred_at
         FROM graph_entity
        WHERE type = ?
          AND json_extract(metadata, '$.affectedService') = ?
          AND CAST(json_extract(metadata, '$.occurredAt') AS INTEGER) BETWEEN ? AND ?
        ORDER BY occurred_at ASC
        LIMIT 20`,
    )
    .all(counterpartType, affectedService, windowFrom, windowTo) as TimelineRow[];
}
```

Then replace the `void now;` line at the end of `syncTimelineEventGraph` with:

```ts
  if (affectedService === undefined) return;

  if (entityType === "deployment") {
    clearOutgoingRelationsOfType(db, entityId, "correlates_with");
    for (const inc of timelineCounterparts(
      db,
      "incident",
      affectedService,
      occurredAt,
      occurredAt + CORRELATION_WINDOW_MS,
    )) {
      upsertGraphRelation(db, entityId, inc.id, "correlates_with", now);
    }
    return;
  }

  // An incident syncing after its deploy must still create the edge, and the
  // edge is always directed deployment -> incident.
  //
  // The incoming clear is load-bearing: `clearRelationsTouchingEntity` skips
  // `correlates_with` (Task 1), so an incident that moved in time or changed
  // service would otherwise keep every correlation it ever had. Only the
  // incident's own sync knows its current window and service, so only it can
  // retire those edges.
  clearIncomingRelationsOfType(db, entityId, "correlates_with");
  for (const dep of timelineCounterparts(
    db,
    "deployment",
    affectedService,
    occurredAt - CORRELATION_WINDOW_MS,
    occurredAt,
  )) {
    upsertGraphRelation(db, dep.id, entityId, "correlates_with", now);
  }
```

`clearRelationsTouchingEntity` already leaves `correlates_with` alone (Task 1), which is what lets the incident-side emission survive a later deployment re-sync.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/`

Expected: PASS — all five correlation tests plus every earlier graph test.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-incidents.test.ts
git commit -m "feat(graph): correlate deployments with the incidents that follow them"
```

---

### Task 7: Backfill already-indexed items

New edges appear only when an item next re-syncs. Historical PRs, messages and incidents may never re-sync, so without a backfill the graph stays sparse exactly where the history lives.

**Files:**

- Create: `packages/gateway/src/graph/regraph.ts`
- Create: `packages/gateway/src/graph/regraph.test.ts`

**Interfaces:**

- Consumes: `syncGraphFromIndexedItem` (Tasks 3–6).
- Produces: `regraphAllItems(db: Database, opts?: { batchSize?: number }): { scanned: number; graphed: number }`. Step 1b's CLI wiring consumes this; exposing it over IPC is deliberately deferred to 1b so this task stays gateway-internal and independently mergeable.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/regraph.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { regraphAllItems } from "./regraph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Insert an item directly, bypassing the populator, to simulate pre-existing data. */
function insertRawItem(
  db: Database,
  o: { service: string; type: string; externalId: string; title: string; body: string; at: number },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `${o.service}:${o.externalId}`,
      o.service,
      o.type,
      o.externalId,
      o.title,
      o.body,
      o.at,
      o.at,
      JSON.stringify({ repo: "acme/app" }),
    ],
  );
}

test("backfill graphs items that were indexed before the populator knew how", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  expect(
    (db.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number }).n,
  ).toBe(0);

  const result = regraphAllItems(db);

  expect(result.scanned).toBe(2);
  expect(result.graphed).toBe(2);
  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test("backfill skips item types the graph does not participate in", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "gdrive",
    type: "file",
    externalId: "f1",
    title: "Notes",
    body: "",
    at: now,
  });

  const result = regraphAllItems(db);
  expect(result.scanned).toBe(1);
  expect(result.graphed).toBe(0);
});

test("backfill is idempotent", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  regraphAllItems(db);
  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/regraph.test.ts`

Expected: FAIL — `Cannot find module './regraph.ts'`.

- [ ] **Step 3: Write the backfill**

Create `packages/gateway/src/graph/regraph.ts`:

```ts
import type { Database } from "bun:sqlite";

import { syncGraphFromIndexedItem } from "./graph-populator.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

export type RegraphResult = {
  scanned: number;
  graphed: number;
};

type ItemRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  author_id: string | null;
  metadata: string | null;
};

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Item types graphed in dependency order. An entity that is only ever a
 * reference *target* must already exist when the item referencing it is
 * processed, or the edge is silently skipped: `findIssueEntityIds` and
 * `findCommitEntityIds` resolve against `graph_entity`, not `item`.
 *
 * `deployment` / `incident` correlate symmetrically (either side emits the
 * edge), so their relative order is free — they are listed only to keep the
 * whole dependency story in one place.
 */
const REGRAPH_TYPE_ORDER: readonly string[] = Object.freeze([
  "issue",
  "git_commit",
  "deployment",
  "incident",
  "pr",
  "message",
]);

function graphOneRow(db: Database, r: ItemRow): boolean {
  if (!isItemLinkedGraphType(r.type)) return false;
  syncGraphFromIndexedItem(db, {
    id: r.id,
    service: r.service,
    type: r.type,
    title: r.title,
    bodyPreview: r.body_preview,
    authorId: r.author_id,
    metadata: parseMetadata(r.metadata),
  });
  return true;
}

/**
 * Page through one slice of the item table by keyset (`id > lastId`) rather
 * than OFFSET. OFFSET makes SQLite re-walk every skipped row on each page,
 * which turns a large backfill quadratic.
 */
function regraphSlice(
  db: Database,
  where: string,
  params: readonly unknown[],
  batchSize: number,
  counters: { scanned: number; graphed: number },
): void {
  let lastId = "";
  for (;;) {
    const rows = db
      .query(
        `SELECT id, service, type, title, body_preview, author_id, metadata
           FROM item
          WHERE ${where} AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(...params, lastId, batchSize) as ItemRow[];
    if (rows.length === 0) return;

    for (const r of rows) {
      counters.scanned += 1;
      if (graphOneRow(db, r)) counters.graphed += 1;
    }

    const last = rows.at(-1);
    if (last === undefined) return;
    lastId = last.id;
  }
}

/**
 * Re-run the graph populator over every indexed item.
 *
 * Needed because a populator change only reaches existing rows when they next
 * re-sync — and historical items may never re-sync.
 *
 * Processed in `REGRAPH_TYPE_ORDER` so reference targets are graphed before
 * the items that reference them; every edge this plan emits therefore settles
 * in a single pass. Idempotent regardless — each sync function clears and
 * rebuilds the edges it owns — so re-running is always safe.
 */
export function regraphAllItems(db: Database, opts?: { batchSize?: number }): RegraphResult {
  const batchSize = opts?.batchSize ?? 500;
  const counters = { scanned: 0, graphed: 0 };

  for (const type of REGRAPH_TYPE_ORDER) {
    regraphSlice(db, "type = ?", [type], batchSize, counters);
  }

  // Everything else: graph-participating types with no ordering constraint,
  // plus non-participating types, which are counted as scanned but skipped.
  const placeholders = REGRAPH_TYPE_ORDER.map(() => "?").join(", ");
  regraphSlice(db, `type NOT IN (${placeholders})`, REGRAPH_TYPE_ORDER, batchSize, counters);

  return counters;
}
```

The `where` fragment is a module-private literal built only from `REGRAPH_TYPE_ORDER.length`; every value still binds, so `I9` holds.

**Why not `ORDER BY CASE type ... END`:** it expresses the same intent in one query, but no index can serve the computed sort key, so SQLite materialises and sorts the entire item table — and with `OFFSET` paging it redoes that sort for every page. Slicing by type keeps each query on `idx_item_type` and the keyset cursor keeps each page O(batch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/regraph.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Prove a single pass settles forward references**

Append to `packages/gateway/src/graph/regraph.test.ts`:

```ts
test("one pass settles a forward reference that sorts the wrong way by id", () => {
  const db = freshDb();
  const now = Date.now();

  // `github:acme/app#1` (the PR) sorts BEFORE `github:acme/app#4` (the issue),
  // so an id-ordered backfill processes the PR while the issue entity does not
  // yet exist and emits nothing. Type ordering is what makes one pass enough.
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });

  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});
```

Numeric refs resolve within one service (Task 3), so both items must share `service: "github"` for `#4` to bind — which is also the realistic case.

Run: `bun test packages/gateway/src/graph/regraph.test.ts`

Expected: PASS, 4 tests. If this one fails, `REGRAPH_TYPE_ORDER` is not being honoured — and note the Step 1 backfill test exercises the same ordering hazard, so it fails too.

- [ ] **Step 6: Run the full gateway graph + agent suites**

Run: `bun test packages/gateway/src/graph/ packages/gateway/src/agents/ packages/gateway/src/index/`

Expected: PASS. `impact.ts`'s suite must be green **unchanged**.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/graph/regraph.ts packages/gateway/src/graph/regraph.test.ts
git commit -m "feat(graph): backfill the graph over already-indexed items"
```

---

## Final verification

- [ ] **Run the full pre-flight**

Run: `bun run preflight`

Expected: all gates green. `test:ci` alone is **not** the gate set.

- [ ] **Verify the coverage floor on Linux**

Run: `docker run --rm -v "$PWD":/w -w /w oven/bun:latest bash -c "bun install --frozen-lockfile && bun run audit:coverage-floor"`

Expected: no file below 80% line or branch. `audit:coverage-floor` is CI-Linux-authoritative — a native-Windows run produces false results. Every file created here is small and directly tested; if `graph-populator.ts` dips below the floor because of the new branches, add cases to the per-edge test files rather than excluding the file.

- [ ] **Confirm no invariant drift**

Run: `bun run audit:structure`

Expected: PASS. This task adds no new invariant and no new `connectors.dispatch` call site, so `D12` (all writes via `dbRun`) is the only static check with new surface — every write added here goes through `dbRun`.

---

## Review dispositions

From `2026-07-23-why-lens-1a-populator-edges-feedback.md`.

| # | Item | Disposition |
| --- | --- | --- |
| 1 | Stale incoming `correlates_with` on incident re-sync | **Fixed** — real bug. `clearIncomingRelationsOfType` added in Task 1, called from the incident branch in Task 6, with two retirement regression tests. |
| 2 | Backfill ordering | **Fixed, different mechanism** — and it was a bug, not an optimization. |
| 3 | Filter all-decimal 7-char SHAs | **Rejected**, with the arithmetic recorded in Task 4 Step 1. |
| 4 | Expression index on JSON fields | **Deferred**, premise corrected below. |
| 5 | *(found during execution, Task 4 review)* `findCommitEntityIds` could not match short SHAs | **Fixed** — see below. |

**On #5 — the plan reproduced the very bug this phase exists to fix.** Task 4's review flagged the commit lookup as Critical, and a probe confirmed it: with a commit indexed at `github:a1b2c3d4e5f6…ab` (40 chars) and a message citing `a1b2c3d` (7 chars), `external_id LIKE '%:' || ?` returns `null` — it is an exact-*suffix* match, so it only ever matches full-length SHAs. `COMMIT_SHA_RE`'s `{7,40}` bound exists precisely to catch short SHAs, and the (10/16)⁷ rationale for keeping all-decimal candidates is about short SHAs — so the lookup silently discarded the dominant real-world case. The relation would have been "declared, populated, and still empty," one level below the failure this phase was written to close.

Fixed by anchoring the extracted string as a prefix of the SHA portion: `substr(external_id, instr(external_id, ':') + 1) LIKE ? || '%'`. Verified to match a 7-character prefix, still match a full 40-character SHA, and reject a non-matching prefix. `findIssueEntityIds` is unaffected — a ticket key like `NIM-88` *is* the whole suffix, so exact-suffix matching is correct there.

**On #2 — it was a latent test failure, not a speed-up.** The reviewer framed it as avoiding a second pass. Checking the actual sort order shows worse: `github:acme/app#1` (the PR) sorts *before* `github:acme/app#4` (the issue), so under id-only ordering the Task 7 Step 1 test would have processed the PR against a non-existent issue entity and asserted `1` against `0`. The plan shipped a failing test. Type-ordered slicing fixes it, and a dedicated test now pins the ordering hazard.

The suggested `ORDER BY CASE type ... END` was not adopted: no index can serve a computed sort key, so SQLite materialises and sorts the whole item table, and `OFFSET` paging repeats that sort per page. Slicing by type keeps each query on `idx_item_type`, and a keyset cursor (`id > ?`) keeps each page O(batch) instead of O(offset).

**On #4 — the premise is wrong, the deferral is right.** The concern was that `json_extract` in `timelineCounterparts` forces full-table scans. It does not: the query leads with `type = ?`, and `EXPLAIN QUERY PLAN` confirms SQLite serves that from the `UNIQUE(type, external_id)` autoindex —

```text
SEARCH graph_entity USING INDEX sqlite_autoindex_graph_entity_2 (type=?)
```

So the `json_extract` predicates filter within deployments (or incidents) only, already bounded and further capped by `LIMIT 20`. No index is warranted now. If a very large history ever makes it measurable, the fix belongs in a migration alongside a benchmark that demonstrates the problem — not speculatively here.

---

## What step 1b consumes from this plan

Step 1b's six lanes traverse, in the direction shown:

| Lane | Traversal now real |
| --- | --- |
| `subAuthorship` | `git_blame_line` → `commit` entity (existing) |
| `subPullRequest` | `commit` ← `merged_as` ← `pr` (existing; reverse) |
| `subTicket` | `pr` → `resolves` → `issue` (**Task 3**) |
| `subDiscussion` | `message` → `mentions` → `pr` / `issue` / `commit` (**Task 4**; reverse from the PR) |
| `subDriver` | `deployment` → `correlates_with` → `incident` (**Tasks 5, 6**) |
| `subDownstream` | `depends_on` / `defined_in` / `in_repo` (existing) |

`regraphAllItems` (Task 7) is what step 1b's `nimbus index regraph` CLI command wraps.
