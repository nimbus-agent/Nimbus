# GitHub Contribution Depth — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index GitHub pull-request reviews as first-class items, emit `person --reviewed--> pr`
graph edges, surface them in the `expert` and `why` agents, and capture PR size statistics — so
`nimbus negotiate` has real contribution evidence to read later.

**Architecture:** Reviews become their own `item` rows rather than PR metadata, because
`item-store.ts:130` replaces metadata wholesale and a later `PullRequestEvent` would clobber them.
The graph populator emits one edge per review item, and `"reviewed"` joins `CROSS_ITEM_RELATION_TYPES`
so `syncPrGraph`'s blanket clear cannot delete it. PR statistics ride the pull-detail response that
the existing enrichment pass already fetches and currently discards.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-11-github-contribution-depth-design.md`
**Review response:** `docs/superpowers/specs/2026-08-11-github-contribution-depth-design-review-response.md`

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Bound-param SQL only** (invariant I9). All writes go through `dbRun`/`dbExec` from `db/write.ts`
  (invariant I14) — never `db.run` directly.
- **Never commit on `main`.** All work lands on `dev/asafgolombek/github-contribution-depth`, which
  already exists and is checked out.
- **No migration in this PR.** `item.type` is free-form `TEXT NOT NULL`; the `reviewed` relation type
  has existed since V7. If you find yourself writing SQL DDL, stop — something is wrong.
- **Run `bun run preflight:fast` after every task**, before committing.
- **Coverage floor: 85% line, 80% branch, per file.** Neither `github-sync.ts` nor
  `graph-populator.ts` appears in `docs/structure-audit/coverage-baseline.json`, so both already
  clear the floor and have **no ratchet headroom** — every new branch needs a test or the gate fails.
- **`bun run typecheck:tests` before pushing.** It is advisory on Windows and gating on CI-Linux, and
  this PR adds test files. Read the "N new" line.
- **Cross-platform paths.** Use `path.join()`; never hardcode separators.
- **Line numbers are as of 2026-08-11 and drift as tasks land.** They locate code; they are not
  addresses to edit blindly. **Tasks 4–7 all modify `github-sync.ts` in sequence**, and Task 4 inserts
  roughly 70 lines (`githubReviewExternalId`, `upsertReview`, `processPullRequestReviewPayload`)
  before the regions Tasks 6 and 7 cite — so every `github-sync.ts` line number in Tasks 6 and 7 is
  stale by the time you reach them. **Locate by symbol name, then confirm the surrounding code matches
  what the task quotes before editing.** If it does not match, stop and re-read the file: the plan was
  written against a specific tree and something has moved.

## Scope note

The spec originally claimed `expert.ts:283` and `why.ts:319` were live readers of `reviewed` edges.
**They are not.** Both are absence-probes: `expert`'s `subPrReviewed` returns `{}` once edges exist,
and `why`'s pull-request lane only appends a gap note. Emitting edges without Tasks 2 and 3 would turn
`expert`'s lane from *explained-empty* into *silently empty* — a regression. Tasks 2 and 3 exist to
prevent that and are not optional.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `packages/gateway/src/graph/relationship-graph.ts` | Registers `review` as a graph-linked item type | Modify |
| `packages/gateway/src/graph/graph-populator.ts` | Emits `person --reviewed--> pr`; protects the edge from PR re-population | Modify |
| `packages/gateway/src/graph/graph-populator-reviews.test.ts` | Edge emission, survival, single-edge property | Create |
| `packages/gateway/src/agents/expert.ts` | `subPrReviewed` returns real evidence | Modify |
| `packages/gateway/src/agents/why.ts` | Pull-request lane names reviewers | Modify |
| `packages/gateway/src/connectors/github-sync.ts` | Review events → items; PR stats; enrich predicate; rate-limit fix; saturation log | Modify |
| `packages/gateway/src/connectors/github-sync.test.ts` | Review event indexing, stats capture, rate limiting | Modify |
| `packages/gateway/src/connectors/github-sync-enrich.test.ts` | Widened enrich predicate | Modify |

---

## Task 1: Emit `person --reviewed--> pr` from a `review` item

**Files:**
- Modify: `packages/gateway/src/graph/relationship-graph.ts:6-23`
- Modify: `packages/gateway/src/graph/graph-populator.ts:77-81`, `:780`
- Test: `packages/gateway/src/graph/graph-populator-reviews.test.ts` (create)

**Interfaces:**
- Consumes: `upsertGraphEntity`, `ensureGraphEntity`, `upsertGraphRelation` from
  `./relationship-graph.ts`; `IndexedItemGraphInput` from `graph-populator.ts:14`.
- Produces: a `review` item whose `metadata` carries `{ repo: string, pr_number: number }` yields
  `person(external_id = item.author_id) --reviewed--> pr(external_id = "github:<repo>#<pr_number>")`.
  Task 4 writes items in exactly that shape; Tasks 2 and 3 read exactly these edges.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/graph/graph-populator-reviews.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedPr(db: Database, externalId: string, title: string, authorId: string | null, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId,
    title,
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    authorId,
    metadata: { repo: "acme/app", number: 1 },
  });
}

function seedReview(db: Database, externalId: string, reviewerId: string, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId,
    title: "Review on acme/app#1",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    authorId: reviewerId,
    metadata: { repo: "acme/app", pr_number: 1 },
  });
}

/** Every (person external_id, pr external_id) pair joined by a `reviewed` edge. */
function reviewedPairs(db: Database): Array<{ person: string; pr: string }> {
  return db
    .query(
      `SELECT pe.external_id AS person, pre.external_id AS pr
         FROM graph_relation r
         JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
        WHERE r.type = 'reviewed'
        ORDER BY person, pr`,
    )
    .all() as Array<{ person: string; pr: string }>;
}

test("review is a graph-linked item type", () => {
  expect(isItemLinkedGraphType("review")).toBe(true);
});

test("a review item emits person -> pr reviewed", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);

  expect(reviewedPairs(db)).toEqual([
    { person: "person-reviewer", pr: "github:acme/app#1" },
  ]);
  db.close();
});

test("the reviewer is a distinct person from the PR author", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);

  const authored = db
    .query(
      `SELECT pe.external_id AS person
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
        WHERE r.type = 'authored'`,
    )
    .all() as Array<{ person: string }>;

  expect(authored).toEqual([{ person: "person-author" }]);
  expect(reviewedPairs(db)).toEqual([
    { person: "person-reviewer", pr: "github:acme/app#1" },
  ]);
  db.close();
});

// THE REGRESSION TEST. `syncPrGraph` calls `clearRelationsTouchingEntity`, which
// deletes every edge touching the PR except CROSS_ITEM_RELATION_TYPES. Without
// "reviewed" in that list, re-syncing the PR silently destroys the edge and
// nothing recreates it.
test("a reviewed edge survives the PR being re-populated", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);
  expect(reviewedPairs(db)).toHaveLength(1);

  // The PR is re-synced (title edit, state change, any later PullRequestEvent).
  seedPr(db, "acme/app#1", "Add rate limiter v2", "person-author", now + 1000);

  // PROVE THE RE-POPULATION ACTUALLY RAN. Without this the test is vacuous: if
  // `upsertIndexedItem` ever skipped graph population for an unchanged row, the
  // edge would "survive" because nothing touched it, and the assertion below
  // would stay green even with `reviewed` absent from CROSS_ITEM_RELATION_TYPES
  // — the precise defect this test exists to catch.
  const prLabel = db
    .query("SELECT label FROM graph_entity WHERE type = 'pr' AND external_id = ?")
    .get("github:acme/app#1") as { label: string };
  expect(prLabel.label).toBe("Add rate limiter v2");

  expect(reviewedPairs(db)).toEqual([
    { person: "person-reviewer", pr: "github:acme/app#1" },
  ]);
  db.close();
});

// The safety of having no edge-retirement mechanism (spec 5.F) rests on this.
test("two reviews by one person on one PR yield exactly one edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);
  seedReview(db, "acme/app#1#review-501", "person-reviewer", now + 1);

  expect(reviewedPairs(db)).toHaveLength(1);
  db.close();
});

test("a review with no author emits no edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#1#review-500",
    title: "Review on acme/app#1",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: null,
    metadata: { repo: "acme/app", pr_number: 1 },
  });

  expect(reviewedPairs(db)).toEqual([]);
  db.close();
});

test("a review whose metadata lacks repo or pr_number emits no edge", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#1#review-500",
    title: "Review",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person-reviewer",
    metadata: {},
  });

  expect(reviewedPairs(db)).toEqual([]);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-reviews.test.ts`
Expected: FAIL. The first test fails because `isItemLinkedGraphType("review")` is `false`; the rest
return empty arrays because no populator branch exists.

- [ ] **Step 3: Register `review` as a graph-linked type**

In `packages/gateway/src/graph/relationship-graph.ts`, add `"review"` to the
`ITEM_LINKED_ENTITY_TYPES` array (currently 16 entries, ending `"data_quality_test"`):

```typescript
const ITEM_LINKED_ENTITY_TYPES = [
  "pr",
  "issue",
  "ci_run",
  "deployment",
  "alert",
  "message",
  "incident",
  "error_issue",
  "git_commit",
  "dependency",
  "api_endpoint",
  "code_symbol",
  "obsidian_note",
  "data_model",
  "dashboard",
  "data_quality_test",
  "review",
] as const;
```

There is no exact-count assertion on this list (only per-type `isItemLinkedGraphType` checks in
`graph-populator-api-endpoint.test.ts`, `relationship-graph-obsidian.test.ts` and
`relationship-graph.test.ts`), so adding an entry breaks nothing.

- [ ] **Step 4: Protect the edge from PR re-population**

In `packages/gateway/src/graph/graph-populator.ts`, add `"reviewed"` to `CROSS_ITEM_RELATION_TYPES`
(line 77):

```typescript
const CROSS_ITEM_RELATION_TYPES: readonly string[] = Object.freeze([
  "resolves",
  "mentions",
  "correlates_with",
  "reviewed",
]);
```

This is load-bearing, not cosmetic: `clearRelationsTouchingEntity` (`:83`) deletes every edge touching
an entity *except* these types, and `syncPrGraph` (`:240`) calls it on every PR write.

- [ ] **Step 5: Add `syncReviewGraph`**

In `packages/gateway/src/graph/graph-populator.ts`, add this function immediately after
`syncPrGraph` (which ends at line 283). It uses `ensureGraphEntity` (`ON CONFLICT DO NOTHING`) for the
PR rather than `upsertGraphEntity` (`DO UPDATE SET label = excluded.label`), so it can never overwrite
a real PR title with a placeholder when a review is processed before its PR:

```typescript
/**
 * A `review` item is one reviewer acting on one PR, so it maps to exactly one
 * `person --reviewed--> pr` edge. Nothing is cleared here: the edge is
 * idempotent under `upsertGraphRelation`'s `ON CONFLICT (from_id, to_id, type)`,
 * and it is listed in CROSS_ITEM_RELATION_TYPES precisely so that no entity's
 * re-population retires it. The consequence — a review deleted upstream leaves
 * a stale edge — is disclosed rather than mechanised (spec 5.F).
 *
 * `ensureGraphEntity` (not `upsertGraphEntity`) for the PR side: a review can be
 * populated before its PR during a `regraph` replay, and clobbering the PR's
 * label with a synthesised one would corrupt every reader that displays it.
 */
function syncReviewGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  if (row.authorId === null || row.authorId === "") {
    return;
  }
  const repoFull = stringField(row.metadata, "repo");
  const prNumber = row.metadata["pr_number"];
  if (repoFull === undefined || repoFull === "" || typeof prNumber !== "number") {
    return;
  }

  const prItemId = `${row.service}:${repoFull}#${String(prNumber)}`;
  const prEntityId = ensureGraphEntity(db, {
    type: "pr",
    externalId: prItemId,
    label: `${repoFull}#${String(prNumber)}`,
    service: row.service,
  });

  const label = personDisplayName(db, row.authorId) ?? row.authorId;
  const personEntityId = upsertGraphEntity(db, {
    type: "person",
    externalId: row.authorId,
    label,
    service: row.service,
  });
  upsertGraphRelation(db, personEntityId, prEntityId, "reviewed", now);
}
```

`stringField`, `personDisplayName`, `ensureGraphEntity`, `upsertGraphEntity` and
`upsertGraphRelation` are all already imported or defined in this file — `ensureGraphEntity` is
imported at `:8` and currently used elsewhere, so no import changes are needed.

- [ ] **Step 6: Add the dispatch branch**

In `syncGraphFromIndexedItem` (`graph-populator.ts:766`), add a branch after the `pr` branch at
`:780-783`:

```typescript
  if (row.type === "pr") {
    syncPrGraph(db, row, now);
    return;
  }
  if (row.type === "review") {
    syncReviewGraph(db, row, now);
    return;
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/graph/graph-populator-reviews.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Red-prove the `CROSS_ITEM_RELATION_TYPES` change**

Temporarily remove `"reviewed"` from `CROSS_ITEM_RELATION_TYPES`, then run:

`bun test packages/gateway/src/graph/graph-populator-reviews.test.ts`

Expected: the test *"a reviewed edge survives the PR being re-populated"* **FAILS** (receives `[]`).
Every other test still passes. **Restore the line.** If that test passes without the entry, the test
is not exercising re-population and must be fixed before continuing — this is the single defect this
task exists to prevent.

- [ ] **Step 9: Run the surrounding suites for regressions**

Run: `bun test packages/gateway/src/graph`
Expected: PASS. Pay attention to `graph-populator-branches.test.ts:94` ("returns early for a type not
in ITEM_LINKED_ENTITY_TYPES") — if it happened to use `"review"` as its not-in-the-list example, it
now needs a different type. Check it explicitly.

- [ ] **Step 10: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/graph/relationship-graph.ts packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-reviews.test.ts
git commit -m "feat(graph): emit person --reviewed--> pr from review items"
```

---

## Task 2: `expert`'s reviewer lane returns real evidence

**Files:**
- Modify: `packages/gateway/src/agents/expert.ts:280-288`
- Test: `packages/gateway/src/agents/expert.test.ts`

**Interfaces:**
- Consumes: the `reviewed` edges Task 1 emits.
- Produces: `subPrReviewed` returns `{ stream: ExpertEvidenceStream }` with
  `Evidence.type === "pr_reviewed"` and `weight: 0.6`.

**Context:** `subPrReviewed` is currently a stub that returns `{}` whenever `reviewed` edges exist.
Task 1 makes them exist, so without this task the lane goes silently empty. `Evidence.type` in
`@nimbus-dev/sdk` already includes `"pr_reviewed"` — the slot has been unused since it was defined.
Existing weights in this file: `commit_authored` 1, `pr_authored` 0.8, `chat_post` 0.4; `pr_reviewed`
sits at **0.6** — reviewing is real expertise evidence, but weaker than authoring.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/agents/expert.test.ts`. That file creates its database inline
(`new Database(":memory:"); LocalIndex.ensureSchema(db);` — see `:207`) and seeds people with
`db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:alice", "Alice"])` (`:292`),
using `person:`-prefixed ids. Follow both conventions.

**The `person` row is not optional.** The lane's query joins `person p ON p.id = pe.external_id`, so
an `author_id` with no matching `person` row produces zero results and the test would fail for the
wrong reason.

```typescript
test("subPrReviewed surfaces a reviewer as pr_reviewed evidence", async () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const now = Date.now();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:author", "Author"]);
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Add rate limiter",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:author",
    metadata: { repo: "acme/app", number: 1 },
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#1#review-500",
    title: "Review on acme/app#1",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:reviewer",
    metadata: { repo: "acme/app", pr_number: 1 },
  });

  const result = await subPrReviewed(db, "rate limiter");

  expect(result.gap).toBeUndefined();
  expect(result.stream?.personId).toBe("person:reviewer");
  expect(result.stream?.displayName).toBe("Reviewer");
  expect(result.stream?.evidence).toHaveLength(1);
  expect(result.stream?.evidence[0]?.type).toBe("pr_reviewed");
  expect(result.stream?.evidence[0]?.itemId).toBe("github:acme/app#1");
  db.close();
});

test("subPrReviewed still reports the gap when no reviewed edges exist", async () => {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const result = await subPrReviewed(db, "anything");
  expect(result.gap?.category).toBe("missing_relation_emit");
  expect(result.stream).toBeUndefined();
  db.close();
});
```

`subPrReviewed` is currently module-private. Export it (`export async function subPrReviewed`) so the
test can call it directly — this matches how other lanes in this file are structured for testing;
verify against the file and follow whatever it already does.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/expert.test.ts -t "pr_reviewed"`
Expected: FAIL — `result.stream` is `undefined` because the lane returns `{}`.

- [ ] **Step 3: Implement the lane**

Replace `subPrReviewed` (`expert.ts:280-288`) with:

```typescript
export async function subPrReviewed(db: Database, input: string): Promise<SubAgentResult> {
  const rows = db
    .query(
      `SELECT
         p.id                           AS person_id,
         COALESCE(p.display_name, p.id) AS display_name,
         i.id                           AS item_id,
         i.title                        AS title,
         i.modified_at                  AS modified_at,
         i.service                      AS service_id
       FROM graph_relation gr
       JOIN graph_entity  pe ON pe.id = gr.from_id AND pe.type = 'person'
       JOIN person        p  ON p.id = pe.external_id
       JOIN graph_entity  pre ON pre.id = gr.to_id AND pre.type = 'pr'
       JOIN item          i  ON i.id = pre.external_id
       WHERE gr.type = 'reviewed'
         AND (i.title LIKE '%' || ? || '%' OR i.body_preview LIKE '%' || ? || '%')
       ORDER BY i.modified_at DESC
       LIMIT 50`,
    )
    .all(input, input) as Array<{
    person_id: string;
    display_name: string;
    item_id: string;
    title: string;
    modified_at: number;
    service_id: string;
  }>;

  if (rows.length === 0) {
    const gap = detectMissingRelationEmit(
      db,
      "reviewed",
      "Reviews are indexed from the GitHub events feed — sync the connector, or run `nimbus index backfill --service github` for history.",
    );
    return gap === null ? {} : { gap };
  }

  const merged = new Map<string, ExpertEvidenceStream>();
  for (const r of rows) {
    const ev: Evidence = {
      itemId: r.item_id,
      type: "pr_reviewed",
      serviceId: r.service_id,
      title: r.title.slice(0, 512),
      modifiedAt: r.modified_at,
      weight: 0.6,
    };
    const existing = merged.get(r.person_id);
    if (existing === undefined) {
      merged.set(r.person_id, {
        personId: r.person_id,
        displayName: r.display_name,
        evidence: [ev],
      });
    } else {
      existing.evidence.push(ev);
    }
  }
  const winner = [...merged.values()].sort((a, b) => b.evidence.length - a.evidence.length)[0];
  return winner === undefined ? {} : { stream: winner };
}
```

This mirrors `subChatMentions` (`:310`) exactly — same join-to-`person` shape, same merge-and-pick-
winner tail, same `LIMIT 50`. The `JOIN item i ON i.id = pre.external_id` is required, not optional:
a PR entity with no backing item row is invisible to it, which is the behaviour Task 4 relies on
(spec § 4).

**Note the remediation text change.** The old note said "Tracked as a graph-populator follow-up" — no
longer true once Task 1 lands. The gap now means "no reviews indexed yet", which is a sync problem,
not a roadmap one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/expert.test.ts`
Expected: PASS, including pre-existing tests.

**No existing test asserts the remediation string — verified.** The one test covering this lane,
`expert.test.ts:220` ("missing reviewed relation surfaces a missing_relation_emit gap note"), asserts
only `cats).toContain("missing_relation_emit")`, and it seeds its fixture with a raw
`INSERT INTO item` that bypasses the populator entirely — so it creates no graph rows, no `reviewed`
edges exist, and the gap still fires. **That test must keep passing unchanged.** If it goes red, your
lane is returning a stream where there is no evidence, which means the query is wrong.

- [ ] **Step 5: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/agents/expert.ts packages/gateway/src/agents/expert.test.ts
git commit -m "feat(agents): expert surfaces PR reviewers as pr_reviewed evidence"
```

---

## Task 3: `why`'s pull-request lane names reviewers

**Files:**
- Modify: `packages/gateway/src/agents/why.ts:295-322`
- Test: `packages/gateway/src/agents/why.test.ts`

**Interfaces:**
- Consumes: the `reviewed` edges Task 1 emits.
- Produces: the `pull_request` lane's `WhyFinding.detail` names reviewers when any exist; the
  permanent `reviewed` gap note is dropped once edges exist.

**Context:** the lane builds exactly one `WhyFinding` with `detail: "Opened by <author>"`, then
unconditionally appends a `reviewed` gap note whose comment reads "never promised — no populator emits
`reviewed`". Task 1 falsifies that comment.

- [ ] **Step 1: Write the failing test**

`why.test.ts` already has `freshDb()` (`:27`) and `seedWhyFixture(db, parts)` (`:55`), which seeds a
commit → linear issue `NIM-88` → **github PR `acme/app#412`** → blame chain. Reuse it; the review must
therefore reference `repo: "acme/app"` and `pr_number: 412` to attach to that PR.

```typescript
test("the pull_request lane names reviewers when reviewed edges exist", async () => {
  const db = freshDb();
  seedWhyFixture(db, { commit: true, issue: true, pr: true, blame: { lineNo: 12 } });
  const now = Date.now();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:reviewer", "Reviewer"]);

  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#412#review-500",
    title: "Review on acme/app#412",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:reviewer",
    metadata: { repo: "acme/app", pr_number: 412 },
  });

  const brief = await runWhy({ ref: refAt(12) }, ctxFor(db));
  const prFinding = brief.findings.find((f) => f.lane === "pull_request");

  expect(prFinding?.detail).toContain("Reviewed by");
  expect(brief.gaps.some((g) => g.detail.includes("`reviewed`"))).toBe(false);
  db.close();
});
```

This drives the whole agent through `runWhy` rather than calling the private lane, matching how the
file's other lane tests are written — check the existing `pull_request` tests and mirror whichever
entry point they use. `refAt(line)` (`:37`) builds the `<file>:<line>` ref the blame row is seeded at.

**Note the reviewer label.** `syncReviewGraph` labels the person entity with
`personDisplayName(db, authorId) ?? authorId`, so without the `person` row the detail would read
`Reviewed by person:reviewer` and the assertion above would still pass — seed the row so the test
exercises the display path the user actually sees.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "names reviewers"`
Expected: FAIL — `detail` is `"Opened by ..."` with no reviewer text, and `gap` is defined.

- [ ] **Step 3: Query reviewers and fold them into the detail**

In `why.ts`, after the `authorRow` query (`:295-303`) and before the `finding` literal (`:305`), add:

```typescript
  const reviewerRows = db
    .query(
      `SELECT DISTINCT pe.label AS label
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
        WHERE r.to_id = ? AND r.type = 'reviewed'
        ORDER BY label
        LIMIT 5`,
    )
    .all(pr.entityId) as Array<{ label: string }>;
```

Then build the detail from both parts:

```typescript
  const openedBy =
    authorRow !== null ? `Opened by ${authorRow.label}` : "PR author not resolved in the graph.";
  const detail =
    reviewerRows.length === 0
      ? openedBy
      : `${openedBy} · Reviewed by ${reviewerRows.map((r) => r.label).join(", ")}`;

  const finding: WhyFinding = {
    lane: "pull_request",
    title: `#${pr.number ?? "?"} ${pr.title}`,
    detail,
    url: pr.url,
    occurredAt: pr.modifiedAt,
    entityId: pr.entityId,
  };
```

- [ ] **Step 4: Update the gap-note comment and remediation**

Replace the comment and call at `:315-322` with:

```typescript
  // Reviewers come from `review` items indexed off the GitHub events feed. The
  // gap note now means "no reviews indexed yet", not "this is unimplemented".
  const reviewedGap = detectMissingRelationEmit(
    db,
    "reviewed",
    "Reviews are indexed from the GitHub events feed — sync the connector, or run `nimbus index backfill --service github` for history.",
  );
  return reviewedGap !== null ? { findings: [finding], gap: reviewedGap } : { findings: [finding] };
```

The `detectMissingRelationEmit` call is deliberately kept: it correctly reports "no reviews anywhere
in the index", which stays useful. It is `LIMIT 5` on the reviewer list because a `WhyFinding.detail`
is a one-line string, not a list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/why.test.ts`
Expected: PASS.

**`why.test.ts:159` is safe — verified.** It asserts
`g.category === "missing_relation_emit" && g.detail.includes("reviewed")`. That matches on `detail`,
which `detectMissingRelationEmit` generates (`gap-notes.ts:64`) and which this task does **not**
change — only the `remediation` argument changes. Its fixture seeds no review items, so the gap still
fires and the assertion still holds.

- [ ] **Step 6: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(agents): why names PR reviewers in the pull_request lane"
```

---

## Task 4: Index `PullRequestReviewEvent` as `review` items

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts:318-339` (`processEvent`), plus a new
  `upsertReview` beside `upsertPr` (`:197`)
- Test: `packages/gateway/src/connectors/github-sync.test.ts`

**Interfaces:**
- Consumes: `upsertPr` (`github-sync.ts:197`), `resolveGithubActorPersonId` (`:142`),
  `upsertIndexedItemForSync` (`index/item-store.ts:208`).
- Produces: `review` items with `metadata: { repo, pr_number, review_id, state }` — exactly the shape
  Task 1's `syncReviewGraph` reads.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/connectors/github-sync.test.ts`. Define the event once as a factory so
each test gets a fresh object — a shared literal mutated by one test would leak into the next:

```typescript
function reviewEvent(): Record<string, unknown> {
  return {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: {
      action: "created",
      review: {
        id: 500,
        state: "approved",
        body: "LGTM",
        html_url: "https://github.com/acme/app/pull/1#pullrequestreview-500",
        submitted_at: "2026-08-11T10:00:00Z",
        user: { login: "reviewer" },
      },
      pull_request: {
        number: 1,
        title: "Add rate limiter",
        body: "",
        html_url: "https://github.com/acme/app/pull/1",
        user: { login: "author" },
        state: "open",
      },
    },
  };
}

test("a PullRequestReviewEvent indexes both the review and its PR", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const now = Date.now();

  expect(processEvent(ctx, reviewEvent(), now)).toBe(true);

  const review = db
    .query("SELECT id, author_id, metadata FROM item WHERE service = 'github' AND type = 'review'")
    .get() as { id: string; author_id: string | null; metadata: string };
  expect(review.id).toBe("github:acme/app#1#review-500");
  expect(review.author_id).not.toBeNull();
  expect(JSON.parse(review.metadata)).toMatchObject({ repo: "acme/app", pr_number: 1, review_id: 500 });

  const pr = db
    .query("SELECT title FROM item WHERE id = 'github:acme/app#1'")
    .get() as { title: string };
  expect(pr.title).toBe("Add rate limiter");
  db.close();
});

test("the reviewer resolves to a different person than the PR author", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const now = Date.now();
  processEvent(ctx, reviewEvent(), now);

  const prAuthor = db.query("SELECT author_id FROM item WHERE id = 'github:acme/app#1'").get() as {
    author_id: string;
  };
  const reviewer = db
    .query("SELECT author_id FROM item WHERE id = 'github:acme/app#1#review-500'")
    .get() as { author_id: string };

  expect(reviewer.author_id).not.toBe(prAuthor.author_id);
  db.close();
});

test("a review event missing its pull_request is skipped without throwing", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: { action: "created", review: { id: 500, user: { login: "reviewer" } } },
  };

  expect(() => processEvent(ctx, ev, Date.now())).not.toThrow();
  expectServiceItemCount(db, "github", 0);
  db.close();
});

test("a review event missing its review id is skipped without throwing", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const ev = {
    type: "PullRequestReviewEvent",
    repo: { full_name: "acme/app" },
    payload: { action: "created", pull_request: { number: 1, title: "x", user: { login: "a" } } },
  };

  expect(() => processEvent(ctx, ev, Date.now())).not.toThrow();
  expectServiceItemCount(db, "github", 0);
  db.close();
});
```

`processEvent` (`github-sync.ts:318`) is module-private. Export it (`export function processEvent`)
and import it in the test. If the file already exposes a test seam for events, use that instead of
adding a second entry point.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts -t "Review"`
Expected: FAIL — `processEvent` returns `false` for `PullRequestReviewEvent` and writes nothing.

- [ ] **Step 3: Add `upsertReview`**

In `github-sync.ts`, immediately after `upsertPr` (which ends at line 244), add:

```typescript
function githubReviewExternalId(repoFull: string, prNum: number, reviewId: number): string {
  return `${repoFull}#${String(prNum)}#review-${String(reviewId)}`;
}

/**
 * A review is indexed as its own item rather than as PR metadata: the item
 * upsert replaces `metadata` wholesale (`index/item-store.ts`), so a later
 * `PullRequestEvent` for the same PR would silently erase reviewer data stored
 * there. Separate rows cannot clobber one another.
 *
 * The events feed is the authenticated user's own activity, so `author_id` here
 * is always the local user — this indexes "PRs I reviewed", never "who reviewed
 * my PRs".
 */
function upsertReview(
  ctx: SyncContext,
  repoFull: string,
  review: Record<string, unknown>,
  prNum: number,
  now: number,
): boolean {
  const reviewId = numberField(review, "id");
  if (reviewId === undefined) {
    return false;
  }
  const user = asRecord(review["user"]);
  const authorId = resolveGithubActorPersonId(ctx.db, user);
  const state = stringField(review, "state");
  const body = stringField(review, "body");
  const submitted = stringField(review, "submitted_at");
  const modified = submitted === undefined ? now : Date.parse(submitted);
  const htmlUrl = stringField(review, "html_url");

  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "review",
    externalId: githubReviewExternalId(repoFull, prNum, reviewId),
    title: `Review on ${repoFull}#${String(prNum)}`,
    body: body ?? "",
    url: htmlUrl ?? null,
    canonicalUrl: htmlUrl ?? null,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: {
      repo: repoFull,
      pr_number: prNum,
      review_id: reviewId,
      state: state ?? null,
    },
    pinned: false,
    syncedAt: now,
  });
  return true;
}
```

- [ ] **Step 4: Add the event branch**

Add this function beside `processPullRequestPayload` (`:290`):

```typescript
function processPullRequestReviewPayload(
  ctx: SyncContext,
  fullName: string,
  payload: Record<string, unknown>,
  now: number,
): boolean {
  const review = asRecord(payload["review"]);
  const pr = asRecord(payload["pull_request"]);
  if (review === undefined || pr === undefined) {
    return false;
  }
  const num = numberField(pr, "number");
  if (num === undefined) {
    return false;
  }
  // Index the PR too, so the `reviewed` edge targets a titled item rather than a
  // stub: 14 call sites inner-join `item` on `graph_entity.external_id`, and an
  // item-less entity is invisible to all of them.
  upsertPr(ctx, fullName, pr, now);
  return upsertReview(ctx, fullName, review, num, now);
}
```

Then add the dispatch in `processEvent` (`:332`):

```typescript
  if (type === "PullRequestEvent") {
    return processPullRequestPayload(ctx, fullName, payload, now);
  }
  if (type === "PullRequestReviewEvent") {
    return processPullRequestReviewPayload(ctx, fullName, payload, now);
  }
  if (type === "IssuesEvent") {
    return processIssuesPayload(ctx, fullName, payload, now);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: PASS, including pre-existing tests.

- [ ] **Step 6: Verify the end-to-end path**

Run: `bun test packages/gateway/src/graph packages/gateway/src/agents/expert.test.ts`
Expected: PASS. Task 1's populator and Task 2's reader now have a real producer.

- [ ] **Step 7: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
git commit -m "feat(connectors): index GitHub PR reviews as first-class items"
```

---

## Task 5: Capture PR size statistics

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts:70-110` (`extractPrMetadataForIndex`)
- Test: `packages/gateway/src/connectors/github-sync.test.ts`

**Interfaces:**
- Produces: PR `metadata` gains `additions`, `deletions`, `changed_files`, `commits` when the source
  payload carries them. Task 6's enrich predicate keys on their absence.

**Context:** these four fields exist on the single-PR response (`GET /repos/{owner}/{repo}/pulls/{n}`)
and **not** on the list response or event payloads — confirmed against GitHub's documentation. The
enrichment pass already fetches pull detail and discards them, so capture is free there and a no-op
on the events path.

- [ ] **Step 1: Write the failing test**

```typescript
test("PR stats are captured from a pull-detail payload", () => {
  const meta = extractPrMetadataForIndex("acme/app", {
    number: 1,
    title: "Add rate limiter",
    state: "open",
    user: { login: "author" },
    additions: 120,
    deletions: 30,
    changed_files: 7,
    commits: 3,
  });

  expect(meta["additions"]).toBe(120);
  expect(meta["deletions"]).toBe(30);
  expect(meta["changed_files"]).toBe(7);
  expect(meta["commits"]).toBe(3);
});

test("PR stats are absent, not null, when the payload omits them", () => {
  const meta = extractPrMetadataForIndex("acme/app", {
    number: 1,
    title: "Add rate limiter",
    state: "open",
    user: { login: "author" },
  });

  expect("additions" in meta).toBe(false);
  expect("deletions" in meta).toBe(false);
  expect("changed_files" in meta).toBe(false);
  expect("commits" in meta).toBe(false);
});
```

Absence rather than `null` matters: Task 6's predicate uses SQL `json_extract(...) IS NULL` to find
PRs needing enrichment, and an explicit `null` is indistinguishable from a missing key there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts -t "stats"`
Expected: FAIL — `meta["additions"]` is `undefined` in the first test.

- [ ] **Step 3: Capture the fields**

In `extractPrMetadataForIndex` (`:70`), after the `mergeable_state` block (`:91-95`) and before the
`if (merged)` block (`:96`), add:

```typescript
  for (const key of ["additions", "deletions", "changed_files", "commits"] as const) {
    const v = numberField(pr, key);
    if (v !== undefined) {
      out[key] = v;
    }
  }
```

`numberField` is already imported and used in this function (`:79`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
git commit -m "feat(connectors): capture PR additions/deletions/changed_files/commits"
```

---

## Task 6: Widen the enrichment predicate to stats-missing PRs

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts:389-459`
- Test: `packages/gateway/src/connectors/github-sync-enrich.test.ts`

**Interfaces:**
- Consumes: the metadata keys Task 5 writes.
- Produces: `selectPrEnrichCandidates` (renamed from `selectFallbackPrCandidates`) selects PRs with a
  fallback title **or** missing stats, still capped at `MAX_ENRICH_PER_TICK = 10`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/connectors/github-sync-enrich.test.ts`:

```typescript
test("a PR with a real title but no stats is selected for enrichment", () => {
  const db = createMemoryIndexDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Add rate limiter", // NOT the `PR #1` fallback
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app", number: 1 }, // no additions/deletions
  });

  const candidates = selectPrEnrichCandidates(db, 10);
  expect(candidates.map((c) => c.externalId)).toEqual(["acme/app#1"]);
  db.close();
});

test("a PR with stats already captured is not selected", () => {
  const db = createMemoryIndexDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Add rate limiter",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app", number: 1, additions: 120, deletions: 30 },
  });

  expect(selectPrEnrichCandidates(db, 10)).toEqual([]);
  db.close();
});

test("a fallback-titled PR is still selected even with stats", () => {
  const db = createMemoryIndexDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#2",
    title: "PR #2",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app", number: 2, additions: 1, deletions: 1 },
  });

  expect(selectPrEnrichCandidates(db, 10).map((c) => c.externalId)).toEqual(["acme/app#2"]);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync-enrich.test.ts`
Expected: FAIL — `selectPrEnrichCandidates` does not exist yet. Once renamed, the first test would
still fail against the old predicate, which is the point.

- [ ] **Step 3: Widen the predicate**

Replace `selectFallbackPrCandidates` (`:397`) with:

```typescript
/**
 * Candidates for a pull-detail re-fetch. Two independent reasons:
 *   1. the title is still the id-only `PR #<n>` fallback (the events feed omits
 *      `title` on `PullRequestEvent` payloads), or
 *   2. size statistics are missing — `additions`/`deletions`/`changed_files`/
 *      `commits` exist only on the single-PR response, never on events or the
 *      list endpoint.
 *
 * `json_extract` is used rather than a LIKE over the raw metadata blob so a PR
 * body mentioning "additions" cannot mask a genuinely missing field. Guarded by
 * `json_valid` because `json_extract` RAISES on malformed JSON, and one bad row
 * would otherwise kill selection for every PR.
 */
function selectPrEnrichCandidates(db: Database, limit: number): FallbackPrCandidate[] {
  const rows = db
    .query(
      `SELECT external_id, title, metadata FROM item
         WHERE service = 'github' AND type = 'pr'
           AND (
             title LIKE 'PR #%'
             OR NOT json_valid(metadata)
             OR json_extract(metadata, '$.additions') IS NULL
           )
         ORDER BY modified_at DESC LIMIT ?`,
    )
    .all(limit * 3) as { external_id: string; title: string; metadata: string }[];
  const out: FallbackPrCandidate[] = [];
  for (const r of rows) {
    const hash = r.external_id.lastIndexOf("#");
    if (hash <= 0) continue;
    const repoFull = r.external_id.slice(0, hash);
    const num = Number.parseInt(r.external_id.slice(hash + 1), 10);
    if (!Number.isFinite(num)) continue;
    out.push({ externalId: r.external_id, repoFull, num });
    if (out.length >= limit) break;
  }
  return out;
}
```

The old exact-title JS filter (`if (r.title !== \`PR #${String(num)}\`) continue;`) is **removed**:
it existed to make the SQL `LIKE` precise, but a row now qualifies on either reason, and keeping it
would silently drop every stats-missing PR with a real title — the exact case this task adds.

`NOT json_valid(metadata)` is deliberate: a row with unparseable metadata cannot be proven to have
stats, so it is re-fetched rather than skipped, and `json_extract` is never reached for it (SQLite's
`OR` short-circuits left to right).

- [ ] **Step 4: Rename the caller and update the doc comment**

Rename the call inside `enrichFallbackPrTitles` (`:431`) to `selectPrEnrichCandidates`, rename the
function itself to `enrichPrDetail`, and update its docstring (`:419-424`) to describe both reasons.
Update the call site in `syncGithubUserEvents` (`:548`) and the surrounding log message at `:553`
("PR title enrichment pass failed" → "PR detail enrichment pass failed"). Export
`selectPrEnrichCandidates` for the test.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/github-sync-enrich.test.ts`
Expected: PASS, including pre-existing enrichment tests.

- [ ] **Step 6: Log the remaining stats backlog**

Enrichment converges at 10 PRs per tick, so a large index takes many ticks to fill in statistics.
Operators need to see that catching-up is progressing rather than stalled (review response, item 6).
This is a **log line, not a metric** — nothing consumes a metric today, and adding a registration for
a transient catch-up window would be speculative.

At the end of `enrichPrDetail`, after the loop:

```typescript
  const remaining = selectPrEnrichCandidates(ctx.db, MAX_ENRICH_PER_TICK + 1).length;
  if (remaining > MAX_ENRICH_PER_TICK) {
    ctx.logger.info(
      { service: SERVICE_ID, enriched, remainingAtLeast: MAX_ENRICH_PER_TICK },
      "PR detail enrichment has more candidates queued for the next tick",
    );
  }
```

The `+ 1` and `remainingAtLeast` naming are deliberate: the selector is capped, so it can prove
"more than 10 remain" but never report an exact backlog. Claiming a precise figure it cannot compute
would be the kind of false number this project's honesty rules exist to prevent.

Add a test asserting the selector still returns at most `limit` rows when more candidates exist:

```typescript
test("selectPrEnrichCandidates never returns more than the limit", () => {
  const db = createMemoryIndexDb();
  const now = Date.now();
  for (let i = 1; i <= 15; i += 1) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: `acme/app#${String(i)}`,
      title: `PR title ${String(i)}`,
      bodyPreview: "",
      modifiedAt: now + i,
      syncedAt: now,
      metadata: { repo: "acme/app", number: i },
    });
  }

  expect(selectPrEnrichCandidates(db, 10)).toHaveLength(10);
  db.close();
});
```

- [ ] **Step 7: Red-prove the widening**

Temporarily revert the SQL `WHERE` clause to `AND title LIKE 'PR #%'` only. Run the suite.
Expected: *"a PR with a real title but no stats is selected for enrichment"* **FAILS**. Restore.

- [ ] **Step 8: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync-enrich.test.ts
git commit -m "feat(connectors): enrich PRs missing size statistics, not just titles"
```

---

## Task 7: Honour `retry-after` independently, and log a saturated tick

**Files:**
- Modify: `packages/gateway/src/connectors/github-sync.ts:366-387`, `:533-544`
- Test: `packages/gateway/src/connectors/github-sync.test.ts`

**Interfaces:**
- Produces: `throwGithubRateLimitErrorIfApplicable` raises `RateLimitError` for any 403 carrying
  `retry-after`, regardless of `x-ratelimit-remaining`.

**Context:** GitHub's documentation states a secondary rate limit returns *"either a `403` or `429`"*
and treats `retry-after` as independent of `x-ratelimit-remaining`. The current handler only honours
`retry-after` when `remaining === "0" || remaining === null` (`:373`); a 403 with `retry-after` and a
non-zero `remaining` falls through to `return` at `:379` and is not treated as rate limiting at all —
the caller sees a plain `!res.ok` and retries next tick. Task 6 widens how often the enrich path runs,
increasing exposure.

- [ ] **Step 1: Write the failing test**

```typescript
test("a 403 with retry-after is rate limiting even when remaining is non-zero", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const res = new Response("secondary rate limit", {
    status: 403,
    headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" },
  });

  expect(() => throwGithubRateLimitErrorIfApplicable(ctx, res, "events")).toThrow(RateLimitError);
  db.close();
});

test("a 403 with no retry-after and remaining left is not rate limiting", () => {
  const db = createMemoryIndexDb();
  const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);
  const res = new Response("forbidden", {
    status: 403,
    headers: { "x-ratelimit-remaining": "4999" },
  });

  expect(() => throwGithubRateLimitErrorIfApplicable(ctx, res, "events")).not.toThrow();
  db.close();
});
```

Export `throwGithubRateLimitErrorIfApplicable` for the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts -t "retry-after"`
Expected: the first test FAILS (nothing thrown); the second passes already.

- [ ] **Step 3: Fix the handler**

Replace the 403 branch (`:371-380`) with:

```typescript
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    // GitHub returns 403 OR 429 for secondary (abuse) limits, and documents
    // `retry-after` as an independent signal: a secondary limit can arrive with
    // primary quota still available. Keying only on `remaining === 0` misses
    // every one of those and retries straight into the limit.
    if (remaining === "0" || remaining === null || retryAfter !== null) {
      const retryAt = retryAfterDateFromHeader(retryAfter, 60);
      const ms = Math.max(1000, retryAt.getTime() - Date.now());
      ctx.rateLimiter.penalise("github", ms);
      throw new RateLimitError(retryAt, `GitHub ${label}: rate limited (403)`);
    }
    return;
  }
```

The `penalise("github", ...)` bucket stays hardcoded in this PR — parameterising it belongs with PR
2's `github_search` path, where a second bucket first exists.

**Note for PR 2:** `throwGithubRateLimitErrorIfApplicable` and `retryAfterDateFromHeader` are the
shared helpers the search backfill must reuse — the only change it needs is the bucket key becoming a
parameter. Do not fork a second rate-limit parser for search; GitHub's 403/429 + `retry-after`
semantics are identical on both surfaces, and two parsers would drift.

- [ ] **Step 4: Add the saturation log**

The events sync issues exactly one request per tick with `per_page=100` and no pagination, so a full
page is evidence the window may have overflowed and events may have been missed entirely. In
`syncGithubUserEvents`, after the event loop (`:544`), add:

```typescript
  // One request per tick at per_page=100 (no pagination): a full page means the
  // window may have overflowed between syncs, and anything older is unreachable
  // from the events feed. Loss is silent by construction, so record it.
  if (parsed.length >= GITHUB_EVENTS_PAGE_SIZE) {
    ctx.logger.warn(
      { service: SERVICE_ID, events: parsed.length },
      "github events page was full; older events in this window may have been missed",
    );
  }
```

Add the constant beside `MAX_ENRICH_PER_TICK` (`:395`) and use it in `eventsUrlFor` (`:112-114`) so
the page size has one definition:

```typescript
const GITHUB_EVENTS_PAGE_SIZE = 100;
```

```typescript
function eventsUrlFor(login: string): string {
  return `https://api.github.com/users/${encodeURIComponent(login)}/events?per_page=${String(GITHUB_EVENTS_PAGE_SIZE)}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/github-sync.test.ts`
Expected: PASS. Existing tests asserting the events URL string must still match — the interpolation
produces the identical `per_page=100`.

- [ ] **Step 6: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/connectors/github-sync.ts packages/gateway/src/connectors/github-sync.test.ts
git commit -m "fix(connectors): treat a 403 with retry-after as rate limiting; log saturated event pages"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: the GitHub connector page under `docs/connectors/`

**Context:** connector deliveries go in `docs/CHANGELOG.md`, not the CLAUDE.md status line.

- [ ] **Step 1: Document the three user-visible facts**

The page is `docs/connectors/github.md` (verified — do not create a new file). Add, in its own
subsection:

```markdown
### Pull-request reviews

Reviews you leave on pull requests are indexed as their own items and linked to the
pull request in the relationship graph, so `nimbus expert` and `nimbus why` can
attribute review work.

Three limits are worth knowing:

- **Reviewing a pull request indexes that pull request**, including ones you did not
  author. This is what lets a review link to a titled PR rather than a bare id.
- This indexes **pull requests you reviewed**, not **who reviewed your pull
  requests** — the GitHub events feed reports your own activity.
- Coverage begins when the connector first syncs. The events feed exposes only a
  recent window, so reviews from before then are not recoverable by syncing. A review
  deleted upstream also leaves its graph link in place.
```

- [ ] **Step 2: Add the changelog entry**

Add an entry to `docs/CHANGELOG.md` under the current unreleased heading, matching the surrounding
entries' format exactly (check the two entries above it before writing).

- [ ] **Step 3: Verify links**

Run: `bun run preflight:fast`
Then check for Windows-absolute paths, which resolve locally and 404 on CI-Linux:

```bash
grep -rn "file:///" docs/ || echo "clean"
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: GitHub review indexing, and its three stated limits"
```

---

## Final verification before pushing

- [ ] **Full test suite**

Run: `bun test packages/gateway/src/connectors packages/gateway/src/graph packages/gateway/src/agents`
Expected: PASS.

- [ ] **Test typecheck (CI-Linux-gating, Windows-advisory)**

Run: `bun run typecheck:tests`
Expected: read the "**N new**" line. It must be **0**. This PR adds test files, and a non-zero count
fails CI on Linux while staying silent on Windows.

- [ ] **Coverage floor**

Run the Linux-authoritative check per the `nimbus-coverage-floor` skill. Neither `github-sync.ts` nor
`graph-populator.ts` is in `docs/structure-audit/coverage-baseline.json`, so both currently clear 85%
line / 80% branch with **no ratchet headroom** — any new uncovered branch is a new violation. If it
fails, add tests; do not update the baseline.

- [ ] **Full preflight**

Run: `bun run preflight`
Expected: PASS. Note that preflight fail-fasts — an early lint failure hides the later audits, build
and suite, so a green run must reach the end.

- [ ] **Push and open the PR**

The PR **title** carries the conventional-commit type, because release-please parses the squash
subject; local commit messages are discarded on merge. Suggested title:

```
feat(connectors): index GitHub PR reviews and size statistics
```

Put the reasoning in the PR description — that becomes the permanent commit body. Do **not** include a
bare `Release-As:` trailer.
