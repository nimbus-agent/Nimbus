# S3 MCP Capture Sink — PR 2 (proposals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP client can call `propose_decision`, `propose_term` and `propose_link`. A proposal is stored but asserted NOWHERE (no item, no native row, no embedding) until the owner runs `nimbus captures accept <id>`. Accepting writes the real `decision_record` / `glossary_term` / `graph_relation` row with `'agent'` provenance and an anchored "agent-authored" disclosure. The owner can also reject a proposal, and revoke an accepted one, which removes exactly what it wrote.

**Architecture:** PR 1 (`main` at 486aa798) shipped the `capture` table (V67), the I28 gate (`mcp-sink/capture-gate.ts`, notes only) and `nimbus captures list|show|revoke`. This PR:
- **V68:** rebuilds `decision_record` (an FK parent) and `glossary_term` to admit `'agent'` and add a `capture_id` ownership column, and seeds five `captured_*` relation types.
- **`capture-native.ts`:** adds the accept-time writers and their revoke inverses.
- **The gate:** widens to all four kinds and gains `acceptCapture` / `rejectCapture`.
- **Existing passes:** makes every pass that could clobber an `'agent'` row leave it alone.
- **Surfaces:** adds the three MCP tools and the CLI verbs.

**Tech Stack:** Bun 1.3, TypeScript strict, `bun:sqlite`, `bun:test`, zod (CLI MCP schemas), `@modelcontextprotocol/sdk` 1.32 (CLI only).

**Spec:** `docs/superpowers/specs/2026-10-11-mcp-capture-sink-design.md`. Read §1, §4.2–§4.4, §5.1 (step 8), §5.2–§5.4, §6, §7, §10, §11 and §12. The spec's version numbers predate PR 1. The **Spec corrections** table below is authoritative wherever the two disagree.

## Spec corrections (rulings made at planning, checked against the code)

| Spec says | Ruling | Why | Cost if wrong |
|---|---|---|---|
| V67 rebuilds | **V68**; file `index/capture-native-v68-sql.ts` | `main` used V66 for #1648, and PR 1's `capture` table took V67 | none |
| D32(c) = the `'agent'` literal | **D32(d)**, which confines the agent-row WRITER functions instead of a SQL literal | PR 1 shipped three clauses (a/b/c). A literal scan cannot tell `SET definition_source = 'agent'` from a guard like `NOT IN ('manual','agent')`, and the guards must live in the stores | A hand-written SQL `'agent'` write outside the writers evades the text scan. Capability confinement is the real defense (the D27(b) bound) |
| accept audits `hitl_status='approved'` | **`not_required`** with `outcome: "accepted"` | I4: `approved` is admitted only where a consent gate decided (`APPROVED_ROW_IS_EARNED`). The owner's own CLI command is not a gate, as with revoke | One string and a test |
| reject audits `rejected` | **kept: `rejected`** | The exec-gate convention: an owner denial records `rejected` | none |
| reject runs "steps 1–3" (capability) | **reject needs NO capability**; accept does | §8.2 says reject must still work under a policy lock so the owner can drain the queue; it outranks §5.2's shorthand | A locked-off sink still lets the owner reject (intended) |
| the V68 step runs `PRAGMA foreign_key_check` and throws on any row | **a COUNT check**: restored evidence rows must equal the held rows whose decision still exists. Orphans that pre-date V68 are dropped, not fatal | A pre-existing orphan would fail `foreign_key_check` on every boot and brick the gateway | A pre-existing orphan evidence row (which pointed at nothing) is dropped |
| `nimbus why` gets the disclosure | **dropped** | `agents/why.ts` never reads `decision_record` | none |
| disclosure says "accepted by the owner on <date>" | **no date** | `decision_record` has no accept-time column; the anchor excludes the date anyway; `nimbus captures show` prints `decidedAt` | Less detail in the brief |
| an accepted term is a normal glossary row | **it is never PROJECTED** (no `nimbus:glossary_term` item); the reconcile pass skips projection for it; and accepting over an llm/snippet row that WAS projected UNPROJECTS that item in the same transaction (Task 6) | `nimbus:glossary_term` is in `PROSE_HEAVY_TYPES` (`embedding/routing.ts`), so projecting agent text would send it to a remote embedder when an OpenAI key is set, breaking success criterion 5. The capture item (`nimbus:capture`, local-only) is what search finds. Without the unproject, the superseded llm definition would stay searchable forever, because reconcile now skips the row | An accepted term is found in search via its capture item, not a glossary item |
| (not in spec) | **the graph populator must not delete `captured_*` edges** | `graph-populator.ts`'s `clearRelationsTouchingEntity` deletes every edge on an entity whose type is outside `CROSS_ITEM_RELATION_TYPES`, on each re-sync | none |
| (not in spec) | **`decisions --rebuild` and `glossary --rebuild` keep `'agent'` rows** | `clearDecisions` / `clearGlossary` delete everything, and no pass can re-derive an owner-accepted row | A rebuild is no longer a full reset for agent rows (revoke is how they go) |
| (not in spec) | **every glossary pass leaves `'agent'` rows alone**: reconcile demotion, `markConsolidated`/`markVetoed`, the mined `display_term` overwrite | the reconcile sweep would demote an accepted term with few mentions within 12 h | none |
| (not in spec) | **`upsertManualTerm` taking over an `'agent'` row clears `capture_id`** | manual wins (spec §5.2); without clearing ownership, revoking the capture later would delete the owner's manual term | none |
| `list` defaults to `--state proposed` | **kept as shipped: no default filter** | PR 1 shipped `list` showing every state; a proposed-only default would hide live notes | none |
| (PR 1 follow-ups) | **`--limit` on `captures list`; an "agent-authored" tag on `nimbus query` capture cards** | promised in #1653's description; both files are edited here anyway | ~20 lines |

**Considered and NOT taken** (from the 2026-10-13 plan review, `…-pr2-review.md`):

- **An advisory "this term is vetoed" note in the `propose_term` response.** Rejected, not deferred. It would tell an external MCP client what the owner has vetoed or authored, which is index state the sink never discloses to a submitter. The submit response stays a function of the payload alone. The owner sees `ERR_CAPTURE_SUPERSEDED` at accept time, which is where the decision is made.
- **Multi-id / `--all` accept and reject.** Deferred to a follow-up, with no PR 3 dependency. Single-id verbs keep one audit row per explicit owner act. A batch form needs its own answer to partial failure (one superseded term in ten), and that is a design question, not a flag.

## Global Constraints

- Work in worktree `C:\gitrep\Nimbus\.claude\worktrees\s3-mcp-capture-sink`, branch **`dev/asaf/s3-mcp-capture-sink-pr2`** (cut from `origin/main` at 486aa798). Verify with `git rev-parse --abbrev-ref HEAD` before EVERY commit. Never `git stash`. Commit-message files go under `.superpowers/sdd/…`, never shared `%TEMP%`.
- The spec and this plan never land on `main`. Strip `docs/superpowers/` before opening the PR (Task 15).
- **Write hook:** `.claude/settings.local.json` runs `biome check --write` after every Write/Edit of a `.ts` file, and it has turned `\u` regex escapes into literal invisible characters. After editing a file that contains a `\u` escape, run the code-point scan (Task 15, Step 1) on it.
- No `any`. External data enters as `unknown`.
- Every SQLite write goes through `dbRun`/`dbExec`/`dbStmtRun` (`db/write.ts`, I14/D12). Reads may use `db.query(...).get/all`.
- Build fixtures through the real writers (`upsertIndexedItem`; `upsertCandidate`+`markExtracted` for decisions; `upsertCandidate`+`markConsolidated` for glossary; the migration runner). Only migration tests seed the pre-migration shape with raw SQL, as `runner-v46.test.ts` does.
- Test DBs come from `openMigratedMemoryDb()` (`index/migrated-db-template.ts`, foreign keys ON), or `new Database(":memory:")` + `runIndexedSchemaMigrations(db, N)` when a test must stop at version N.
- New files must clear **≥85% line AND ≥80% branch** per file. Write the branch tests up front. CI Linux is authoritative.
- Payload caps (spec §4.2), verbatim:
  - **Decision:**
    - `statement`: single-line control characters stripped, truncated at 500, refused when empty.
    - `rationale`: multi-line, truncated at 4,096.
    - `alternatives`: at most 10, each truncated at 500.
    - `decidedAt`: an integer number of ms with |v| ≤ 8.64e15, else refuse. It defaults to the submit time.
    - `evidence`: at most 10 item ids.
  - **Term:**
    - `term`: at most 100 characters, refused beyond. Refused when empty, or when `normalizeTerm` yields `""`.
    - `definition`: multi-line, truncated at 2,048, refused when empty.
    - `synonyms`: at most 10, each at most 100 characters, refused beyond.
  - **Link:**
    - `fromItemId` and `toItemId`: required and different.
    - `relation`: one of `relates_to|fixes|caused_by|supersedes|documents`.
    - `note`: truncated at 500.
  - The rebuilt payload is refused above 64 KiB (`PAYLOAD_MAX_BYTES`, unchanged).
- New error codes, verbatim: `ERR_CAPTURE_SUPERSEDED`, `ERR_CAPTURE_LINK_UNRESOLVED`.
- Relation types, verbatim: `captured_relates_to`, `captured_fixes`, `captured_caused_by`, `captured_supersedes`, `captured_documents`.
- Disclosure anchor, verbatim: `captured via MCP, accepted by the owner`.
- Audit: `capture.accept` → `not_required`, `outcome: "accepted"`; `capture.reject` → `rejected`, `outcome: "rejected"`. Owner-method refusals are not audited (the PR 1 revoke posture).
- IPC: `captures.accept` and `captures.reject` join the existing namespace. Outer routing is by namespace prefix (`tryDispatchCaptureRpc`, `ipc/server/dispatchers.ts:1481`), so no routing edit is needed. LAN-forbidden by namespace; not on the Tauri allowlist; no HTTP route.
- PR title: `feat(mcp): capture sink proposals — decisions, terms and links over MCP (S3, I28)`. No `!`.
- After every task: `bun run typecheck` and `bun run lint`. Before the PR: `bun run preflight:fast`, then `bun test packages/gateway packages/cli scripts`.

## Review Focus

1. **An endpoint item re-syncs after its link was accepted.** The populator's per-entity clear must leave the `captured_*` edge. Pinned in Task 5.
2. **`nimbus decisions --rebuild` / `nimbus glossary --rebuild` after accepting agent rows.** Both keep the `'agent'` rows and their evidence. Pinned in Tasks 3 and 4.
3. **An accepted term with no mentions anywhere in the index.** The reconcile sweep neither demotes nor projects it. Pinned in Task 4.
4. **Two owner terminals accept the same capture at once.** Exactly one native row and one audit row; the loser gets `ERR_CAPTURE_STATE`. Pinned in Task 7.
5. **A proposal's evidence item is deleted between submit and accept.** Accept refuses `ERR_CAPTURE_UNKNOWN_ITEM`; the capture stays `proposed`. Pinned in Task 7.
6. **V68 on a populated database with `foreign_keys` ON.** Every `decision_evidence` row survives. Pinned in Task 1.

---

## File Structure

Gateway (`packages/gateway/src/`):

| File | Change |
|---|---|
| `index/capture-native-v68-sql.ts` | **new**: V68 SQL (two rebuilds + relation-type seed) |
| `index/migrations/runner.ts` | hand-written `migrateIndexedV67ToV68` step |
| `index/local-index.ts` | `CURRENT_SCHEMA_VERSION = 68` |
| `decisions/decision-types.ts` | `ExtractionSource` gains `"agent"` |
| `decisions/decision-store.ts` | `insertAgentDecision`, `deleteAgentDecision`, `agentDecisionOwned`, `deleteEvidenceCitingItem`; `clearDecisions` keeps agent rows |
| `glossary/glossary-types.ts`, `agents/_lib/glossary-types.ts` | `DefinitionSource` gains `"agent"` |
| `glossary/glossary-store.ts` | `upsertAgentTerm`, `deleteAgentTerm`, `termOwnership`; guards on existing writers; `clearGlossary` keeps agent rows |
| `glossary/glossary-reconcile.ts` | agent rows: stats refresh only |
| `graph/relationship-graph.ts` | `CAPTURED_RELATION_TYPES`, `resolveItemGraphEntityId`, `deleteGraphRelation`, `graphRelationExists` |
| `graph/graph-populator.ts` | `CROSS_ITEM_RELATION_TYPES` gains the five types |
| `mcp-sink/capture-types.ts` | payload types, `LINK_RELATIONS`, codes, `SUBMITTABLE_KINDS` = all four |
| `mcp-sink/capture-validate.ts` | `validateCapturePayload` for all four kinds |
| `mcp-sink/capture-native.ts` | **new**: accept precondition, native writers, revoke inverse, native status |
| `mcp-sink/capture-store.ts` | `markAccepted`, `markRejected`, `countAcceptedWithNativeRef` |
| `mcp-sink/capture-gate.ts` | proposals in submit (+ step 8); `acceptCapture`, `rejectCapture`; revoke from `accepted`; `nativeStatus` |
| `ipc/capture-rpc.ts` | `captures.accept`, `captures.reject` |
| `agents/_lib/brief-disclosures.ts` | `decisionsAgentDisclosure`; glossary `'agent'` branch |
| `agents/_lib/render.ts` | per-decision source line; ` — agent-authored` list label |
| `agents/_lib/brief-contract.ts` | a `decisions` arm |
| `security-invariants.test.ts` | the PR 1 submit-order test follows the new validator (Task 7); I28 rows for accept/reject/revoke (Task 10) |
| `platform/assemble.ts` | the boot `pruneRejected` uses `REJECTED_RETENTION_MS` (Task 8) |
| `scripts/structure-audit/check-nimbus-invariants.ts` (+ test) | D32(d) |

CLI (`packages/cli/src/`): `mcp/capture-tools.ts` (three tools), `commands/captures.ts` + `captures-format.ts` (accept/reject verbs, `--limit`, native status), `commands/query.ts` (agent-authored tag).

E2E: `packages/gateway/test/e2e/mcp-capture.e2e.test.ts` (extended).

---

### Task 1: V68 — `'agent'` provenance, `capture_id`, `captured_*` relation types

**Files:**
- Create: `packages/gateway/src/index/capture-native-v68-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`: import beside `CAPTURE_V67_SQL` (:14); add `migrateIndexedV67ToV68` beside `migrateIndexedV51ToV52` (~:348); append `{ fromVersion: 67, toVersion: 68, apply: migrateIndexedV67ToV68 }` after the `simpleStep(66, 67, …)` line (~:596).
- Modify: `packages/gateway/src/index/local-index.ts:282` → `CURRENT_SCHEMA_VERSION = 68`
- Modify: `packages/gateway/src/index/migrations/runner.test.ts:785-788` (67 → 68, both the title and the `toBe`)
- Create: `packages/gateway/src/index/migrations/runner-v68.test.ts`
- Modify (the status-drift gate scans these for `schema V<N>`): `CLAUDE.md:8` and `GEMINI.md:8` (two `V67` occurrences each, in "schema V67" and in the capture-sink prose — change only the `schema V67` phrase in the I-count sentence, and leave the historical "schema **V67**" capture sentence intact unless `audit:status-drift` flags it); `docs/architecture.md:5` ("schema V67" → "schema V68") and `:2769` (prepend a V68 entry to "Latest applied migration"); `docs/schema-reference.md:5` (same), plus a V68 block after the V67 block (~:1049), and the `decision_record` / `glossary_term` DDL blocks gain the widened CHECK and `capture_id`.

**Interfaces:**
- Produces: `CAPTURE_NATIVE_V68_REBUILD_DECISIONS_SQL`, `CAPTURE_NATIVE_V68_FINISH_SQL` (`readonly string[]`), plus these columns and types:
  - `decision_record.capture_id TEXT`, and `extraction_source ∈ {'llm','snippet','agent'}`;
  - `glossary_term.capture_id TEXT`, and `definition_source ∈ {'llm','snippet','manual','agent'}`;
  - five `graph_relation_type` rows.

- [ ] **Step 1: Write the failing test.** Create `runner-v68.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "./runner.ts";

/** Seed the V67 shape directly: a migration test must write what the OLD schema allowed. */
function seedV67(db: Database): void {
  db.run(
    `INSERT INTO decision_record (id, source_item_id, status, statement, extraction_source, cue_tier, cue_text, confidence, decided_at, updated_at)
     VALUES ('d1', 'slack:m1', 'extracted', 'Use WAL', 'llm', 'heading', 'Decision:', 0.9, 10, 11),
            ('d2', 'slack:m2', 'pending', NULL, NULL, 'weak', 'we will', 0, 20, 21)`,
  );
  db.run(
    `INSERT INTO decision_evidence (decision_id, kind, entity_id, item_id, evidence_key, label, url, occurred_at)
     VALUES ('d1', 'source', NULL, 'slack:m1', 'item:slack:m1', 'thread', NULL, 10),
            ('d1', 'pr', 'e-pr-1', NULL, 'entity:e-pr-1', '#1', 'https://x/1', 12)`,
  );
  db.run(
    `INSERT INTO glossary_term (term_key, display_term, status, definition, definition_source, doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES ('wal', 'WAL', 'consolidated', 'write-ahead log', 'manual', 3, 1, 2, 3)`,
  );
}

function evidence(db: Database): unknown[] {
  return db
    .query("SELECT * FROM decision_evidence ORDER BY decision_id, evidence_key")
    .all();
}

describe("V68 — capture provenance", () => {
  for (const fk of ["OFF", "ON"] as const) {
    test(`preserves every decision and evidence row with foreign_keys ${fk}`, () => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, 67);
      seedV67(db);
      const before = evidence(db);
      const decisionsBefore = db.query("SELECT * FROM decision_record ORDER BY id").all();
      db.run(`PRAGMA foreign_keys = ${fk}`);
      runIndexedSchemaMigrations(db, 68);
      expect(evidence(db)).toEqual(before);
      const after = db
        .query("SELECT * FROM decision_record ORDER BY id")
        .all() as Array<Record<string, unknown>>;
      // Every pre-existing column is byte-identical; the only addition is capture_id = NULL.
      expect(after.map(({ capture_id, ...rest }) => rest)).toEqual(decisionsBefore);
      expect(after.every((r) => r["capture_id"] === null)).toBe(true);
      db.close();
    });
  }

  test("an evidence row orphaned BEFORE V68 is dropped, not fatal", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    db.run(
      `INSERT INTO decision_evidence (decision_id, kind, entity_id, item_id, evidence_key, label)
       VALUES ('gone', 'source', NULL, 'x:1', 'item:x:1', 'orphan')`,
    );
    runIndexedSchemaMigrations(db, 68);
    const n = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(n.n).toBe(2);
    db.close();
  });

  test("the evidence cascade still works after the rebuild", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    runIndexedSchemaMigrations(db, 68);
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM decision_record WHERE id = 'd1'");
    expect(evidence(db)).toEqual([]);
    db.close();
  });

  test("glossary rows survive byte-identically; capture_id is NULL", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 67);
    seedV67(db);
    const before = db.query("SELECT * FROM glossary_term").all();
    runIndexedSchemaMigrations(db, 68);
    const after = db.query("SELECT * FROM glossary_term").all() as Array<
      Record<string, unknown>
    >;
    expect(after.map(({ capture_id, ...rest }) => rest)).toEqual(before);
    expect(after[0]?.["capture_id"]).toBeNull();
    db.close();
  });

  test("'agent' is admitted by both CHECKs; an unknown source still refuses", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    db.run(
      `INSERT INTO decision_record (id, source_item_id, status, extraction_source, cue_tier, cue_text, decided_at, updated_at, capture_id)
       VALUES ('a', 'nimbus:cap_1', 'extracted', 'agent', 'explicit', 'agent capture', 1, 1, 'cap_1')`,
    );
    db.run(
      `INSERT INTO glossary_term (term_key, display_term, status, definition, definition_source, first_seen_at, last_seen_at, updated_at, capture_id)
       VALUES ('k', 'K', 'consolidated', 'd', 'agent', 1, 1, 1, 'cap_2')`,
    );
    expect(() =>
      db.run(
        `INSERT INTO decision_record (id, source_item_id, status, extraction_source, cue_tier, cue_text, decided_at, updated_at)
         VALUES ('b', 's', 'extracted', 'robot', 'explicit', 'c', 1, 1)`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO glossary_term (term_key, display_term, status, definition_source, first_seen_at, last_seen_at, updated_at)
         VALUES ('z', 'Z', 'pending', 'robot', 1, 1, 1)`,
      ),
    ).toThrow();
    db.close();
  });

  test("recreates every index dropped with the rebuilt tables", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    const names = (tbl: string): string[] =>
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%'")
          .all(tbl) as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort();
    expect(names("decision_record")).toEqual([
      "idx_decision_decided_at",
      "idx_decision_pending_priority",
      "idx_decision_source_item",
      "idx_decision_status_confidence",
      "idx_decision_verified",
    ]);
    expect(names("glossary_term")).toEqual([
      "idx_glossary_term_display",
      "idx_glossary_term_pending_attempt",
      "idx_glossary_term_status_score",
      "idx_glossary_term_verified",
    ]);
    db.close();
  });

  test("seeds the five captured_* relation types and leaves no hold table", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 68);
    const rows = db
      .query("SELECT name, directed FROM graph_relation_type WHERE name LIKE 'captured_%' ORDER BY name")
      .all();
    expect(rows).toEqual([
      { name: "captured_caused_by", directed: 1 },
      { name: "captured_documents", directed: 1 },
      { name: "captured_fixes", directed: 1 },
      { name: "captured_relates_to", directed: 1 },
      { name: "captured_supersedes", directed: 1 },
    ]);
    const hold = db
      .query("SELECT name FROM sqlite_master WHERE name LIKE '%_v68%'")
      .all();
    expect(hold).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run it, and see it fail.** `bun test packages/gateway/src/index/migrations/runner-v68.test.ts`. Expected: FAIL, because version 68 is never reached (`user_version` stays 67, and the `capture_id` column does not exist).

- [ ] **Step 3: Write the SQL.** Create `index/capture-native-v68-sql.ts`. Before writing the column lists, open `index/decisions-v47-sql.ts` and `index/glossary-manual-v46-sql.ts` and confirm them against the live DDL. Every column must be named on both sides of each copy, as in V46.

```ts
/**
 * V68 — capture-sink provenance (spec 2026-10-11 § 4.4, invariant I28, PR 2).
 *
 * `decision_record.extraction_source` and `glossary_term.definition_source` admit `'agent'`, and
 * both tables gain a nullable `capture_id`: the capture that currently OWNS the row, so revoke can
 * tell "my row" from one a later capture, a pass or a manual term took over. `NULL` on every
 * pass-written row. SQLite cannot widen a CHECK in place, so both tables are REBUILT (the V46
 * precedent), with every column named on both sides of the copy.
 *
 * `decision_record` is an FK PARENT (`decision_evidence … ON DELETE CASCADE`), unlike V46's table.
 * With `foreign_keys = ON`, `DROP TABLE decision_record` performs an implicit DELETE that cascades
 * the evidence away, and `PRAGMA foreign_keys` is a no-op inside the step's transaction, so it
 * cannot be switched off here. The evidence is therefore held aside and restored: a no-op restore
 * when the cascade did not fire (production migrates before `ensureSchema` turns FKs on), a full one
 * when it did. Evidence whose decision no longer exists (pre-existing orphans) is not restored.
 * The runner step counts the restore before the hold table is dropped (spec deviation: a count,
 * not `foreign_key_check`, so a pre-existing orphan cannot brick every boot).
 */
const DECISION_COLS = `id, source_item_id, status, statement, rationale, alternatives,
  extraction_source, cue_tier, cue_text, priority, confidence, decided_at, has_adr,
  stats_verified_at, attempts, last_attempt_at, updated_at`;

const EVIDENCE_COLS =
  "decision_id, kind, entity_id, item_id, evidence_key, label, url, occurred_at";

export const V68_EVIDENCE_HOLD = "decision_evidence_v68_hold";

/** Part 1: hold the evidence, rebuild decision_record, restore. The runner counts, then runs part 2. */
export const CAPTURE_NATIVE_V68_REBUILD_DECISIONS_SQL: readonly string[] = [
  `CREATE TABLE ${V68_EVIDENCE_HOLD} AS SELECT ${EVIDENCE_COLS} FROM decision_evidence`,
  `CREATE TABLE IF NOT EXISTS decision_record_v68 (
     id                TEXT PRIMARY KEY,
     source_item_id    TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
     statement         TEXT,
     rationale         TEXT,
     alternatives      TEXT NOT NULL DEFAULT '[]',
     extraction_source TEXT CHECK(extraction_source IN ('llm','snippet','agent')),
     cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
     cue_text          TEXT NOT NULL,
     priority          REAL NOT NULL DEFAULT 0,
     confidence        REAL NOT NULL DEFAULT 0,
     decided_at        INTEGER NOT NULL,
     has_adr           INTEGER NOT NULL DEFAULT 0,
     stats_verified_at INTEGER NOT NULL DEFAULT 0,
     attempts          INTEGER NOT NULL DEFAULT 0,
     last_attempt_at   INTEGER NOT NULL DEFAULT 0,
     updated_at        INTEGER NOT NULL,
     capture_id        TEXT
   )`,
  `INSERT INTO decision_record_v68 (${DECISION_COLS}) SELECT ${DECISION_COLS} FROM decision_record`,
  "DROP TABLE decision_record",
  "ALTER TABLE decision_record_v68 RENAME TO decision_record",
  "CREATE INDEX IF NOT EXISTS idx_decision_status_confidence ON decision_record(status, confidence DESC)",
  "CREATE INDEX IF NOT EXISTS idx_decision_pending_priority ON decision_record(status, priority DESC, last_attempt_at)",
  "CREATE INDEX IF NOT EXISTS idx_decision_decided_at ON decision_record(status, decided_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_decision_verified ON decision_record(status, stats_verified_at)",
  "CREATE INDEX IF NOT EXISTS idx_decision_source_item ON decision_record(source_item_id)",
  "DELETE FROM decision_evidence",
  `INSERT INTO decision_evidence (${EVIDENCE_COLS})
     SELECT ${EVIDENCE_COLS} FROM ${V68_EVIDENCE_HOLD}
      WHERE decision_id IN (SELECT id FROM decision_record)`,
];

/** Rows the restore MUST have produced (counted before the hold table is dropped). */
export const V68_EXPECTED_EVIDENCE_SQL = `SELECT COUNT(*) AS n FROM ${V68_EVIDENCE_HOLD}
  WHERE decision_id IN (SELECT id FROM decision_record)`;

const GLOSSARY_COLS = `term_key, display_term, status, definition, definition_source, doc_freq,
  service_spread, score, form, first_seen_at, last_seen_at, top_sources,
  synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
  last_attempt_at, updated_at`;

/** Part 2: drop the hold, rebuild glossary_term (no FK in either direction), seed relation types. */
export const CAPTURE_NATIVE_V68_FINISH_SQL: readonly string[] = [
  `DROP TABLE ${V68_EVIDENCE_HOLD}`,
  `CREATE TABLE IF NOT EXISTS glossary_term_v68 (
     term_key          TEXT PRIMARY KEY,
     display_term      TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
     definition        TEXT,
     definition_source TEXT CHECK(definition_source IN ('llm','snippet','manual','agent')),
     doc_freq          INTEGER NOT NULL DEFAULT 0,
     service_spread    INTEGER NOT NULL DEFAULT 0,
     score             REAL    NOT NULL DEFAULT 0,
     form              TEXT    NOT NULL DEFAULT 'phrase',
     first_seen_at     INTEGER NOT NULL,
     last_seen_at      INTEGER NOT NULL,
     top_sources       TEXT NOT NULL DEFAULT '[]',
     synonyms          TEXT NOT NULL DEFAULT '[]',
     near_misses       TEXT NOT NULL DEFAULT '[]',
     consolidated_at   INTEGER,
     stats_verified_at INTEGER NOT NULL DEFAULT 0,
     attempts          INTEGER NOT NULL DEFAULT 0,
     last_attempt_at   INTEGER NOT NULL DEFAULT 0,
     updated_at        INTEGER NOT NULL,
     capture_id        TEXT
   )`,
  `INSERT INTO glossary_term_v68 (${GLOSSARY_COLS}) SELECT ${GLOSSARY_COLS} FROM glossary_term`,
  "DROP TABLE glossary_term",
  "ALTER TABLE glossary_term_v68 RENAME TO glossary_term",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score ON glossary_term(status, score DESC)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt ON glossary_term(status, last_attempt_at)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_display ON glossary_term(display_term)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_verified ON glossary_term(status, stats_verified_at)",
  // Prefixed so they can never coincide with a populator-written edge (spec § 4.4).
  `INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
     ('captured_relates_to', 1),
     ('captured_fixes', 1),
     ('captured_caused_by', 1),
     ('captured_supersedes', 1),
     ('captured_documents', 1)`,
];
```

- [ ] **Step 4: Write the runner step.** In `runner.ts`, next to `migrateIndexedV51ToV52`:

```ts
/**
 * V67→V68 is hand-written rather than a `simpleStep`: between the decision_record rebuild and the
 * hold table's drop it must COUNT the restored evidence, and a SQL list cannot throw on a count.
 */
function migrateIndexedV67ToV68(db: Database, now: number): void {
  db.transaction(() => {
    for (const sql of CAPTURE_NATIVE_V68_REBUILD_DECISIONS_SQL) dbExec(db, sql);
    const expected = (db.query(V68_EXPECTED_EVIDENCE_SQL).get() as { n: number }).n;
    const restored = (
      db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number }
    ).n;
    if (restored !== expected) {
      throw new Error(
        `V68: decision_evidence restore produced ${String(restored)} rows, expected ${String(expected)}`,
      );
    }
    for (const sql of CAPTURE_NATIVE_V68_FINISH_SQL) dbExec(db, sql);
    dbExec(db, "PRAGMA user_version = 68");
    recordMigration(
      db,
      68,
      "capture provenance: 'agent' sources + capture_id; captured_* relation types (v68)",
      now,
    );
  })();
}
```

Import `CAPTURE_NATIVE_V68_REBUILD_DECISIONS_SQL`, `CAPTURE_NATIVE_V68_FINISH_SQL` and `V68_EXPECTED_EVIDENCE_SQL` in sorted position. Append `{ fromVersion: 67, toVersion: 68, apply: migrateIndexedV67ToV68 },` after the V67 entry. Bump `CURRENT_SCHEMA_VERSION` to 68, and update `runner.test.ts:785-788`.

- [ ] **Step 5: Run the tests.** `bun test packages/gateway/src/index/migrations/` must PASS, including the drift guard against `maxRegisteredIndexedSchemaVersion()`. Then run `bun test packages/gateway/src/decisions packages/gateway/src/glossary packages/gateway/src/graph` to confirm that every existing reader still works on the rebuilt tables.

- [ ] **Step 6: Red-prove the FK case.** Temporarily delete the `DELETE FROM decision_evidence` and restore `INSERT` lines. The `foreign_keys ON` test must then fail: either the count check throws, or rows are missing. Restore the lines.

- [ ] **Step 7: Update the docs that pin the version.**
  - **"schema V67" → "schema V68":** `CLAUDE.md`, `GEMINI.md` and `docs/architecture.md:5`.
  - **"Latest applied migration":** prepend a V68 entry in `docs/architecture.md` (~:2769) and `docs/schema-reference.md:5`: `**V68** (\`capture-native-v68-sql.ts\` adds no table — \`decision_record\` and \`glossary_term\` are REBUILT to admit \`'agent'\` provenance and gain a nullable \`capture_id\`, the evidence held aside and restored because \`decision_record\` is an FK parent; seeds five \`captured_*\` relation types.)`.
  - **`docs/schema-reference.md` DDL:** the `decision_record` and `glossary_term` blocks gain the widened CHECK and `capture_id TEXT`. Add a `-- V68 --` comment block after the V67 block, pointing at the authoritative file.
  - **Check:** run `bun run audit:status-drift`; it must pass.

- [ ] **Step 8: Commit.**

```bash
git add packages/gateway/src/index docs/architecture.md docs/schema-reference.md CLAUDE.md GEMINI.md
git commit -F .superpowers/sdd/<plan-workspace>/commit-msg-task-1.txt
```
Message: `feat(index): V68 — 'agent' provenance + capture_id on decisions and glossary; captured_* relation types`.

---

### Task 2: Capture types and payload validation for decision, term and link

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-types.ts`
- Modify: `packages/gateway/src/mcp-sink/capture-validate.ts`
- Modify: `packages/gateway/src/mcp-sink/capture-validate.test.ts`
- Modify: `packages/gateway/src/graph/relationship-graph.ts` (only `CAPTURED_RELATION_TYPES` here; the rest is Task 5)

**Interfaces:**
- Produces, in `capture-types.ts`:

```ts
export const LINK_RELATIONS = ["relates_to", "fixes", "caused_by", "supersedes", "documents"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
export interface DecisionPayload {
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly decidedAt: number;
  readonly evidence: readonly string[];
}
export interface TermPayload {
  readonly term: string;
  readonly termKey: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
}
export interface LinkPayload {
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly relation: LinkRelation;
  readonly note: string | null;
}
export type ValidatedCapture =
  | { readonly kind: "note"; readonly payload: NotePayload }
  | { readonly kind: "decision"; readonly payload: DecisionPayload }
  | { readonly kind: "term"; readonly payload: TermPayload }
  | { readonly kind: "link"; readonly payload: LinkPayload };
```
  - `CaptureErrorCode` gains `"ERR_CAPTURE_SUPERSEDED" | "ERR_CAPTURE_LINK_UNRESOLVED"`.
  - `capture-validate.ts`: `validateCapturePayload(kind: CaptureKind, raw: unknown, nowMs: number): ValidatedCapture`, and `referencedItemIds(v: ValidatedCapture): readonly string[]`.
  - `relationship-graph.ts`: `export const CAPTURED_RELATION_TYPES: Readonly<Record<LinkRelation, string>>`. To avoid an import cycle, type it as `Readonly<Record<"relates_to" | "fixes" | "caused_by" | "supersedes" | "documents", string>>` with the literal union written out. Task 2's test asserts the two sets are equal.

- [ ] **Step 1: Write the failing tests.** Append to `capture-validate.test.ts`:

```ts
import { CAPTURED_RELATION_TYPES } from "../graph/relationship-graph.ts";
import { LINK_RELATIONS } from "./capture-types.ts";
import { referencedItemIds, validateCapturePayload } from "./capture-validate.ts";

const NOW = 1_700_000_000_000;

describe("validateCapturePayload — decision", () => {
  test("rebuilds from named fields only, truncates prose, defaults decidedAt to now", () => {
    const v = validateCapturePayload(
      "decision",
      {
        statement: `  ${"s".repeat(600)}\u001b[31m `,
        rationale: "why\nbecause",
        alternatives: ["a", "b".repeat(700)],
        evidence: ["github:pr:1"],
        junk: "dropped",
      },
      NOW,
    );
    expect(v.kind).toBe("decision");
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.statement.length).toBe(500);
    expect(v.payload.statement).not.toContain("\u001b");
    expect(v.payload.rationale).toBe("why\nbecause");
    expect(v.payload.alternatives[1]?.length).toBe(500);
    expect(v.payload.decidedAt).toBe(NOW);
    expect(Object.keys(v.payload).sort()).toEqual(
      ["alternatives", "decidedAt", "evidence", "rationale", "statement"],
    );
  });
  test.each([
    ["empty statement", { statement: "   " }],
    ["non-integer decidedAt", { statement: "s", decidedAt: 1.5 }],
    ["decidedAt outside Date range", { statement: "s", decidedAt: 9e15 }],
    ["11 alternatives", { statement: "s", alternatives: Array.from({ length: 11 }, (_, i) => `a${String(i)}`) }],
    ["11 evidence ids", { statement: "s", evidence: Array.from({ length: 11 }, (_, i) => `x:${String(i)}`) }],
    ["a non-string rationale", { statement: "s", rationale: 3 }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("decision", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
  test("an explicit decidedAt is kept; a null rationale stays null", () => {
    const v = validateCapturePayload("decision", { statement: "s", decidedAt: 123 }, NOW);
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.decidedAt).toBe(123);
    expect(v.payload.rationale).toBeNull();
  });
});

describe("validateCapturePayload — term", () => {
  test("derives termKey with normalizeTerm and truncates the definition", () => {
    const v = validateCapturePayload(
      "term",
      { term: " Write-Ahead Logs ", definition: "d".repeat(3000), synonyms: ["WAL"] },
      NOW,
    );
    if (v.kind !== "term") throw new Error("kind");
    expect(v.payload.term).toBe("Write-Ahead Logs");
    expect(v.payload.termKey).toBe("write-ahead log");
    expect(v.payload.definition.length).toBe(2048);
    expect(v.payload.synonyms).toEqual(["WAL"]);
  });
  test.each([
    ["a 101-char term", { term: "t".repeat(101), definition: "d" }],
    ["an empty definition", { term: "t", definition: "  " }],
    ["a term that normalizes to nothing", { term: "...", definition: "d" }],
    ["a 101-char synonym", { term: "t", definition: "d", synonyms: ["s".repeat(101)] }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("term", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
});

describe("validateCapturePayload — link", () => {
  test("keeps the enum relation and truncates the note", () => {
    const v = validateCapturePayload(
      "link",
      { fromItemId: "a:1", toItemId: "b:2", relation: "fixes", note: "n".repeat(900) },
      NOW,
    );
    if (v.kind !== "link") throw new Error("kind");
    expect(v.payload.relation).toBe("fixes");
    expect(v.payload.note?.length).toBe(500);
    expect(referencedItemIds(v)).toEqual(["a:1", "b:2"]);
  });
  test.each([
    ["the same endpoint twice", { fromItemId: "a:1", toItemId: "a:1", relation: "fixes" }],
    ["an unknown relation", { fromItemId: "a:1", toItemId: "b:2", relation: "owns" }],
    ["a missing endpoint", { fromItemId: "a:1", relation: "fixes" }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("link", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
});

test("every link relation has a captured_ relation type, and nothing else does", () => {
  expect(Object.keys(CAPTURED_RELATION_TYPES).sort()).toEqual([...LINK_RELATIONS].sort());
  for (const [r, t] of Object.entries(CAPTURED_RELATION_TYPES)) expect(t).toBe(`captured_${r}`);
});

test("note still validates through the dispatcher; referencedItemIds reads each kind", () => {
  const n = validateCapturePayload("note", { body: "b", relatesTo: ["x:1"] }, NOW);
  expect(referencedItemIds(n)).toEqual(["x:1"]);
  const d = validateCapturePayload("decision", { statement: "s", evidence: ["y:2"] }, NOW);
  expect(referencedItemIds(d)).toEqual(["y:2"]);
  const t = validateCapturePayload("term", { term: "t", definition: "d" }, NOW);
  expect(referencedItemIds(t)).toEqual([]);
});
```

Before writing these, confirm `normalizeTerm("Write-Ahead Logs")`'s real output in `glossary/term-normalize.ts`. Depluralising the last word should give `"write-ahead log"`; adjust the expectation to what the function actually returns, and say so in the report.

- [ ] **Step 2: Run them, and see them fail.** `bun test packages/gateway/src/mcp-sink/capture-validate.test.ts`. Expected: FAIL, because `validateCapturePayload` is not exported.

- [ ] **Step 3: Implement.** In `capture-types.ts`, add the types and codes from **Interfaces**. Do NOT widen `SUBMITTABLE_KINDS` yet. Task 7 widens it in the same commit that makes the gate able to handle proposals; widening it earlier would let a proposal be validated as a note.

In `relationship-graph.ts`, near `upsertGraphRelation`:

```ts
/**
 * Graph relation types an ACCEPTED capture link writes (spec § 4.4, seeded by V68). Prefixed so they
 * can never coincide with a populator-written edge; the populator's per-entity clear exempts them
 * (`CROSS_ITEM_RELATION_TYPES`), so only the capture gate's revoke removes one.
 */
export const CAPTURED_RELATION_TYPES: Readonly<
  Record<"relates_to" | "fixes" | "caused_by" | "supersedes" | "documents", string>
> = Object.freeze({
  relates_to: "captured_relates_to",
  fixes: "captured_fixes",
  caused_by: "captured_caused_by",
  supersedes: "captured_supersedes",
  documents: "captured_documents",
});
```

In `capture-validate.ts`, add the following below `validateNotePayload`. Keep `validateNotePayload` exported, since PR 1's tests use it.

```ts
export const DECISION_STATEMENT_MAX = 500;
export const DECISION_RATIONALE_MAX = 4_096;
export const DECISION_ALT_MAX = 500;
export const TERM_MAX = 100;
export const TERM_DEFINITION_MAX = 2_048;
export const SYNONYM_MAX_LEN = 100;
export const LINK_NOTE_MAX = 500;
const DATE_MS_MAX = 8.64e15;

function line(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof raw !== "string") invalid(`${field} must be a string`);
  const t = raw.replace(CONTROL_RE, "").trim();
  if (t === "") {
    if (required) invalid(`${field} must not be empty`);
    return null;
  }
  return clampBody(t, max);
}

function prose(raw: unknown, field: string, max: number, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) invalid(`${field} is required`);
    return null;
  }
  if (typeof raw !== "string") invalid(`${field} must be a string`);
  const t = raw.replace(BODY_CONTROL_RE, "").trim();
  if (t === "") {
    if (required) invalid(`${field} must not be empty`);
    return null;
  }
  return clampBody(t, max);
}

/** A list of prose entries: count refuses, each entry TRUNCATES (alternatives are prose). */
function proseList(raw: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${field} must be an array of strings`);
  if (raw.length > maxCount) invalid(`${field} allows at most ${String(maxCount)} entries`);
  const out: string[] = [];
  for (const v of raw) {
    const t = line(v, field, maxLen, true);
    if (t !== null && !out.includes(t)) out.push(t);
  }
  return out;
}

function capped<T>(payload: T): T {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_MAX_BYTES) {
    invalid(`payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
  }
  return payload;
}

function validateDecisionPayload(raw: unknown, nowMs: number): DecisionPayload {
  const o = asObject(raw);
  const decidedRaw = o["decidedAt"];
  let decidedAt = nowMs;
  if (decidedRaw !== undefined) {
    if (
      typeof decidedRaw !== "number" ||
      !Number.isInteger(decidedRaw) ||
      Math.abs(decidedRaw) > DATE_MS_MAX
    ) {
      invalid("decidedAt must be an integer millisecond timestamp");
    }
    decidedAt = decidedRaw;
  }
  return capped<DecisionPayload>({
    statement: line(o["statement"], "statement", DECISION_STATEMENT_MAX, true) ?? "",
    rationale: prose(o["rationale"], "rationale", DECISION_RATIONALE_MAX, false),
    alternatives: proseList(o["alternatives"], "alternatives", REF_MAX_COUNT, DECISION_ALT_MAX),
    decidedAt,
    evidence: stringList(o["evidence"], "evidence", REF_MAX_COUNT, 512),
  });
}

function validateTermPayload(raw: unknown): TermPayload {
  const o = asObject(raw);
  const termRaw = o["term"];
  if (typeof termRaw !== "string") invalid("term must be a string");
  const term = termRaw.replace(CONTROL_RE, "").trim();
  if (term === "") invalid("term must not be empty");
  // A term is a KEY: beyond the cap it refuses rather than truncating into a different key.
  if (term.length > TERM_MAX) invalid(`term must be at most ${String(TERM_MAX)} characters`);
  const termKey = normalizeTerm(term);
  if (termKey === "") invalid("term has no word characters");
  return capped<TermPayload>({
    term,
    termKey,
    definition: prose(o["definition"], "definition", TERM_DEFINITION_MAX, true) ?? "",
    synonyms: stringList(o["synonyms"], "synonyms", REF_MAX_COUNT, SYNONYM_MAX_LEN),
  });
}

function validateLinkPayload(raw: unknown): LinkPayload {
  const o = asObject(raw);
  const from = line(o["fromItemId"], "fromItemId", 512, true) ?? "";
  const to = line(o["toItemId"], "toItemId", 512, true) ?? "";
  if (from === to) invalid("fromItemId and toItemId must differ");
  const rel = o["relation"];
  if (typeof rel !== "string" || !(LINK_RELATIONS as readonly string[]).includes(rel)) {
    invalid(`relation must be one of ${LINK_RELATIONS.join(", ")}`);
  }
  return capped<LinkPayload>({
    fromItemId: from,
    toItemId: to,
    relation: rel as LinkRelation,
    note: line(o["note"], "note", LINK_NOTE_MAX, false),
  });
}

/** Whitelist-rebuild a payload of any kind (spec § 4.2). Prose truncates; structure refuses. */
export function validateCapturePayload(
  kind: CaptureKind,
  raw: unknown,
  nowMs: number,
): ValidatedCapture {
  switch (kind) {
    case "note":
      return { kind, payload: validateNotePayload(raw) };
    case "decision":
      return { kind, payload: validateDecisionPayload(raw, nowMs) };
    case "term":
      return { kind, payload: validateTermPayload(raw) };
    case "link":
      return { kind, payload: validateLinkPayload(raw) };
  }
}

/** Item ids a payload names, checked for existence at submit AND again at accept. */
export function referencedItemIds(v: ValidatedCapture): readonly string[] {
  switch (v.kind) {
    case "note":
      return v.payload.relatesTo;
    case "decision":
      return v.payload.evidence;
    case "term":
      return [];
    case "link":
      return [v.payload.fromItemId, v.payload.toItemId];
  }
}
```

Two rules for this step:
- Import `normalizeTerm` from `../glossary/term-normalize.ts`, and the new types from `./capture-types.ts`, each in sorted position.
- `stringList`, `CONTROL_RE` and `BODY_CONTROL_RE` already exist. Do not duplicate them. These regexes contain `\u` escapes, so scan the file afterwards (see Global Constraints).

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/mcp-sink/` must PASS. PR 1's note tests are unchanged.

- [ ] **Step 5: Commit.** Message: `feat(mcp): validate decision, term and link capture payloads`.

---

### Task 3: Decision store — the agent-row writer, its inverse, and a rebuild that keeps agent rows

**Files:**
- Modify: `packages/gateway/src/decisions/decision-types.ts:4` → `export type ExtractionSource = "llm" | "snippet" | "agent";`
- Modify: `packages/gateway/src/decisions/decision-store.ts`
- Modify: `packages/gateway/src/decisions/decision-store.test.ts`
- Modify: `packages/gateway/src/decisions/decision-extract.test.ts` (one rebuild test)

**Interfaces:**
- Produces (in `decision-store.ts`):

```ts
export interface AgentDecisionInsert {
  readonly id: string;              // `capture:<captureId>` — never collides with a mined (hashed) id
  readonly captureId: string;
  readonly sourceItemId: string;    // the accepted capture's nimbus:capture item
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly decidedAt: number;
  readonly evidence: readonly DecisionEvidence[];
  readonly nowMs: number;
}
export function insertAgentDecision(db: Database, d: AgentDecisionInsert): void;
export function agentDecisionOwned(db: Database, id: string, captureId: string): boolean;
export function deleteAgentDecision(db: Database, id: string, captureId: string): boolean;
export function deleteEvidenceCitingItem(db: Database, itemId: string): number;
```

- [ ] **Step 1: Write the failing tests.** In `decision-store.test.ts`, reuse the file's own migrated DB setup and imports, and add:

```ts
describe("agent decisions (capture sink)", () => {
  const base = {
    id: "capture:cap_1",
    captureId: "cap_1",
    sourceItemId: "nimbus:cap_1",
    statement: "Adopt WAL",
    rationale: "fewer writer stalls",
    alternatives: ["rollback journal"],
    decidedAt: 5_000,
    evidence: [
      { kind: "source" as const, entityId: null, itemId: "slack:m1", label: "thread", url: null, occurredAt: null },
    ],
    nowMs: 6_000,
  };

  test("insertAgentDecision writes an extracted 'agent' row, confidence 1, with its evidence", () => {
    insertAgentDecision(db, base);
    const [r] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
    expect(r?.extractionSource).toBe("agent");
    expect(r?.status).toBe("extracted");
    expect(r?.confidence).toBe(1);
    expect(r?.alternatives).toEqual(["rollback journal"]);
    expect(r?.evidence.map((e) => e.itemId)).toEqual(["slack:m1"]);
    const owner = db.query("SELECT capture_id FROM decision_record WHERE id = ?").get(base.id);
    expect(owner).toEqual({ capture_id: "cap_1" });
  });

  test("deleteAgentDecision removes only a row this capture owns, with its evidence", () => {
    insertAgentDecision(db, base);
    expect(agentDecisionOwned(db, base.id, "cap_other")).toBe(false);
    expect(deleteAgentDecision(db, base.id, "cap_other")).toBe(false);
    expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(1);
    expect(agentDecisionOwned(db, base.id, "cap_1")).toBe(true);
    expect(deleteAgentDecision(db, base.id, "cap_1")).toBe(true);
    expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(0);
    const ev = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(ev.n).toBe(0);
  });

  test("deleteAgentDecision never deletes a mined row, even one sharing the id shape", () => {
    upsertCandidate(db, { id: "m1", sourceItemId: "slack:x", cueTier: "heading", cueText: "Decision:", priority: 1, decidedAt: 1, nowMs: 1 });
    markExtracted(db, "m1", { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" }, 2);
    expect(deleteAgentDecision(db, "m1", "cap_1")).toBe(false);
    expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(1);
  });

  test("deleteEvidenceCitingItem removes every evidence row naming the item, and only those", () => {
    insertAgentDecision(db, base);
    insertAgentDecision(db, {
      ...base,
      id: "capture:cap_2",
      captureId: "cap_2",
      evidence: [
        { kind: "source", entityId: null, itemId: "slack:m1", label: "a", url: null, occurredAt: null },
        { kind: "source", entityId: null, itemId: "slack:m2", label: "b", url: null, occurredAt: null },
      ],
    });
    expect(deleteEvidenceCitingItem(db, "slack:m1")).toBe(2);
    const left = db.query("SELECT item_id FROM decision_evidence").all();
    expect(left).toEqual([{ item_id: "slack:m2" }]);
  });

  test("clearDecisions (--rebuild) keeps 'agent' rows and their evidence, clears the rest", () => {
    insertAgentDecision(db, base);
    upsertCandidate(db, { id: "m1", sourceItemId: "slack:x", cueTier: "heading", cueText: "Decision:", priority: 1, decidedAt: 1, nowMs: 1 });
    clearDecisions(db);
    const ids = db.query("SELECT id FROM decision_record").all();
    expect(ids).toEqual([{ id: base.id }]);
    const ev = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
    expect(ev.n).toBe(1);
  });
});
```

Match `upsertCandidate` / `markExtracted` to their real signatures (`decision-store.ts:145` and `:200`); the literals above follow the research report. In `decision-extract.test.ts`, add one test that calls `rebuildDecisions(db, <that file's pass options>)` after `insertAgentDecision`, and asserts the agent row survives the full rebuild-and-pass.

- [ ] **Step 2: Run them, and see them fail.** `bun test packages/gateway/src/decisions/`. Expected: FAIL, because the functions do not exist.

- [ ] **Step 3: Implement.** In `decision-store.ts`:

```ts
/**
 * The ONLY writer of an `extraction_source = 'agent'` row (static D32(d): callable only from
 * `mcp-sink/capture-native.ts`). An owner-ACCEPTED capture, so it lands `extracted` at confidence
 * 1.0; `cue_tier`/`cue_text` are NOT NULL in the schema and carry a fixed, honest marker. The id
 * `capture:<captureId>` cannot collide with a mined (hashed) id, so a plain INSERT is right: a
 * collision would be a bug and must throw (rolling the accept back), not overwrite.
 */
export function insertAgentDecision(db: Database, d: AgentDecisionInsert): void {
  db.transaction(() => {
    dbRun(
      db,
      `INSERT INTO decision_record
         (id, source_item_id, status, statement, rationale, alternatives, extraction_source,
          cue_tier, cue_text, priority, confidence, decided_at, has_adr, stats_verified_at,
          attempts, last_attempt_at, updated_at, capture_id)
       VALUES (?, ?, 'extracted', ?, ?, ?, 'agent', 'explicit', 'agent capture', 0, 1, ?, 0, ?, 0, 0, ?, ?)`,
      [
        d.id,
        d.sourceItemId,
        d.statement,
        d.rationale,
        JSON.stringify(d.alternatives),
        d.decidedAt,
        d.nowMs,
        d.nowMs,
        d.captureId,
      ],
    );
    replaceEvidence(db, d.id, d.evidence);
  })();
}

export function agentDecisionOwned(db: Database, id: string, captureId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM decision_record WHERE id = ? AND capture_id = ? AND extraction_source = 'agent'",
      )
      .get(id, captureId) !== null
  );
}

/** Revoke's inverse: deletes the row ONLY while this capture still owns it (spec § 5.3). */
export function deleteAgentDecision(db: Database, id: string, captureId: string): boolean {
  let deleted = false;
  db.transaction(() => {
    if (!agentDecisionOwned(db, id, captureId)) return;
    // Explicit, not left to the cascade: the cascade needs `foreign_keys = ON` on THIS connection.
    dbRun(db, "DELETE FROM decision_evidence WHERE decision_id = ?", [id]);
    deleted =
      dbRun(db, "DELETE FROM decision_record WHERE id = ? AND capture_id = ?", [id, captureId])
        .changes === 1;
  })();
  return deleted;
}

/** A revoked capture's item is gone: no evidence row may keep pointing at it (spec § 5.3). */
export function deleteEvidenceCitingItem(db: Database, itemId: string): number {
  return dbRun(db, "DELETE FROM decision_evidence WHERE item_id = ?", [itemId]).changes;
}
```

Before writing the `alternatives` column, check how `markExtracted` serialises it. If it is not `JSON.stringify`, match it. Change `clearDecisions` as follows, updating its doc comment to say that agent rows survive and revoke is how they leave. The whole body is shown: the `decision_pass_state` delete STAYS, because a rebuild must reset the watermark or no historical item is re-scanned:

```ts
  db.transaction(() => {
    dbRun(
      db,
      `DELETE FROM decision_evidence
        WHERE decision_id NOT IN (SELECT id FROM decision_record WHERE extraction_source = 'agent')`,
      [],
    );
    dbRun(db, "DELETE FROM decision_record WHERE extraction_source IS NOT 'agent'", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
  })();
```

Extend the `clearDecisions` test to also assert that `decision_pass_state` is empty afterwards.

Then grep for every other `DELETE FROM decision_record` and `UPDATE decision_record` in non-test code. Confirm that each one either cannot reach an `'agent'` row (it filters on `status='pending'`, on `extraction_source='snippet'`, or on an id the pass itself produced), or add the same `extraction_source IS NOT 'agent'` guard. List what you found in the report.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/decisions packages/gateway/src/agents/decisions` must PASS.

- [ ] **Step 5: Commit.** Message: `feat(decisions): agent-row writer and inverse; --rebuild keeps owner-accepted rows`.

---

### Task 4: Glossary store and passes — accept-time writer, and every pass leaves `'agent'` rows alone

**Files:**
- Modify: `packages/gateway/src/glossary/glossary-types.ts:18` → `"llm" | "snippet" | "manual" | "agent"`
- Modify: `packages/gateway/src/agents/_lib/glossary-types.ts:23` → the same union (it is a hand-kept duplicate)
- Modify: `packages/gateway/src/glossary/glossary-store.ts`
- Modify: `packages/gateway/src/glossary/glossary-reconcile.ts:44`
- Modify tests: `glossary/glossary-store.test.ts`, `glossary/glossary-reconcile.test.ts`, `glossary/glossary-extract.test.ts` (rebuild), `glossary/glossary-manual.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AgentTermUpsert {
  readonly termKey: string;
  readonly displayTerm: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
  readonly captureId: string;
  readonly stats: TermStats;
  readonly score: number;
  readonly nowMs: number;
}
/** false when a vetoed or manual row holds the key (nothing written). */
export function upsertAgentTerm(db: Database, p: AgentTermUpsert): boolean;
export function deleteAgentTerm(db: Database, termKey: string, captureId: string): boolean;
export function termOwnership(
  db: Database,
  termKey: string,
): { status: GlossaryStatus; definitionSource: DefinitionSource | null; captureId: string | null } | null;
```

- [ ] **Step 1: Write the failing tests.** Use each test file's existing fixtures: `seedCandidate`, `consolidate` via `markConsolidated`, `applyManualTerms`. Pin these behaviours:

```ts
describe("agent terms (capture sink)", () => {
  const agent = (captureId: string, definition = "agent def"): AgentTermUpsert => ({
    termKey: "wal",
    displayTerm: "WAL",
    definition,
    synonyms: ["write-ahead log"],
    captureId,
    stats: computeTermStats(db, "wal"),
    score: 0,
    nowMs: 10,
  });

  test("upsertAgentTerm inserts a consolidated 'agent' row owned by the capture", () => {
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(termOwnership(db, "wal")).toEqual({ status: "consolidated", definitionSource: "agent", captureId: "cap_1" });
    expect(getTerm(db, "wal")?.definition).toBe("agent def");
  });

  test("takes over an llm/snippet row, and an earlier agent row (ownership moves)", () => {
    seedCandidate("wal", 1);
    consolidate("wal", 5, []); // markConsolidated → an llm or snippet row
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(true);
    expect(upsertAgentTerm(db, agent("cap_2", "newer"))).toBe(true);
    expect(termOwnership(db, "wal")?.captureId).toBe("cap_2");
    expect(getTerm(db, "wal")?.definition).toBe("newer");
  });

  test("never takes over a vetoed or a manual row", () => {
    seedCandidate("wal", 1);
    markVetoed(db, "wal", 3);
    expect(upsertAgentTerm(db, agent("cap_1"))).toBe(false);
    expect(termOwnership(db, "wal")?.status).toBe("vetoed");
  });

  test("deleteAgentTerm deletes only while the capture owns the row", () => {
    upsertAgentTerm(db, agent("cap_1"));
    upsertAgentTerm(db, agent("cap_2"));
    expect(deleteAgentTerm(db, "wal", "cap_1")).toBe(false);
    expect(deleteAgentTerm(db, "wal", "cap_2")).toBe(true);
    expect(getTerm(db, "wal")).toBeNull();
  });

  test("a mined sighting refreshes stats but keeps the agent display_term and definition", () => {
    upsertAgentTerm(db, agent("cap_1"));
    seedCandidate("wal", 9); // upsertCandidate on the same key
    const t = getTerm(db, "wal");
    expect(t?.displayTerm).toBe("WAL");
    expect(t?.definitionSource).toBe("agent");
    expect(t?.definition).toBe("agent def");
  });

  test("markConsolidated / markVetoed / demoteTerm leave an agent row untouched", () => {
    upsertAgentTerm(db, agent("cap_1"));
    markConsolidated(db, { termKey: "wal", definition: "llm", definitionSource: "llm", synonyms: [], nearMisses: [], nowMs: 20 });
    markVetoed(db, "wal", 21);
    demoteTerm(db, "wal", 22);
    expect(termOwnership(db, "wal")).toEqual({ status: "consolidated", definitionSource: "agent", captureId: "cap_1" });
  });

  test("clearGlossary (--rebuild) keeps agent rows", () => {
    upsertAgentTerm(db, agent("cap_1"));
    seedCandidate("other", 1);
    clearGlossary(db);
    expect(listAllKeys(db)).toEqual(["wal"]);
  });
});
```

Add these in the other test files:
- **`glossary-manual.test.ts`:** a config term on the same key takes over the agent row. Afterwards `definitionSource === "manual"` and `termOwnership(...).captureId === null`, and `deleteAgentTerm(db, key, "cap_1")` returns `false`, so revoking the capture later cannot delete the owner's manual term.
- **`glossary-reconcile.test.ts`** (Review Focus 3): an agent row with zero mentions, made stale by setting the pass clock past the cooldown, survives `reconcilePass`. It stays `consolidated` with `definition_source = 'agent'`. Also assert that no `nimbus:glossary_term` item exists for it: `SELECT COUNT(*) FROM item WHERE service = 'nimbus' AND type = 'glossary_term'` must be 0.
- **`glossary-extract.test.ts`** (Review Focus 2): `rebuildGlossary` keeps the agent row.

- [ ] **Step 2: Run them, and see them fail.** `bun test packages/gateway/src/glossary`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  1. Widen both `DefinitionSource` unions.
  2. Add to `glossary-store.ts`:

```ts
/**
 * The ONLY writer of a `definition_source = 'agent'` row (static D32(d): callable only from
 * `mcp-sink/capture-native.ts`). Takes over an llm/snippet/agent row (the newer accepted definition
 * wins and OWNERSHIP moves, spec § 5.2); never a vetoed or manual one, the owner's own veto or
 * config wins. The accept precondition refuses those first; this `WHERE` is the second door.
 * Never projected: `nimbus:glossary_term` embeds remotely when a key is set, and agent text must
 * not (spec criterion 5) — the capture item is what search finds.
 */
export function upsertAgentTerm(db: Database, p: AgentTermUpsert): boolean {
  const seen = p.stats.docFreq > 0;
  return (
    dbRun(
      db,
      `INSERT INTO glossary_term (
         term_key, display_term, status, definition, definition_source, doc_freq, service_spread,
         score, form, first_seen_at, last_seen_at, top_sources, synonyms, near_misses,
         consolidated_at, stats_verified_at, updated_at, capture_id
       ) VALUES (?, ?, 'consolidated', ?, 'agent', ?, ?, ?, 'phrase', ?, ?, ?, ?, '[]', ?, ?, ?, ?)
       ON CONFLICT(term_key) DO UPDATE SET
         display_term = excluded.display_term, status = 'consolidated',
         definition = excluded.definition, definition_source = 'agent',
         doc_freq = excluded.doc_freq, service_spread = excluded.service_spread,
         score = excluded.score, first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at, top_sources = excluded.top_sources,
         synonyms = excluded.synonyms, consolidated_at = excluded.consolidated_at,
         stats_verified_at = excluded.stats_verified_at, updated_at = excluded.updated_at,
         capture_id = excluded.capture_id
       WHERE glossary_term.status <> 'vetoed' AND glossary_term.definition_source IS NOT 'manual'`,
      [
        p.termKey,
        p.displayTerm,
        p.definition,
        p.stats.docFreq,
        p.stats.serviceSpread,
        p.score,
        seen ? p.stats.firstSeenAt : p.nowMs,
        seen ? p.stats.lastSeenAt : p.nowMs,
        JSON.stringify(p.stats.topSources),
        JSON.stringify(p.synonyms),
        p.nowMs,
        p.nowMs,
        p.nowMs,
        p.captureId,
      ],
    ).changes === 1
  );
}

export function deleteAgentTerm(db: Database, termKey: string, captureId: string): boolean {
  return (
    dbRun(
      db,
      "DELETE FROM glossary_term WHERE term_key = ? AND capture_id = ? AND definition_source = 'agent'",
      [termKey, captureId],
    ).changes === 1
  );
}

export function termOwnership(
  db: Database,
  termKey: string,
): { status: GlossaryStatus; definitionSource: DefinitionSource | null; captureId: string | null } | null {
  const r = db
    .query("SELECT status, definition_source, capture_id FROM glossary_term WHERE term_key = ?")
    .get(termKey) as { status: string; definition_source: string | null; capture_id: string | null } | null;
  if (r === null) return null;
  return {
    status: r.status as GlossaryStatus,
    definitionSource: r.definition_source as DefinitionSource | null,
    captureId: r.capture_id,
  };
}
```

  Check how `upsertCandidate` serialises `top_sources` and `synonyms`, and match it.

  3. **Guards on existing writers:**
     - `upsertCandidate`'s `display_term` CASE becomes `WHEN definition_source IN ('manual','agent')`.
     - `markConsolidated`, `markVetoed` and `demoteTerm` each gain `AND definition_source IS NOT 'agent'` in their `WHERE`.
     - `upsertManualTerm`'s `ON CONFLICT … SET` gains `capture_id = NULL`. Its doc comment gains: "Taking over an agent row clears its ownership, so revoking that capture later cannot delete the owner's manual term."
     - `clearGlossary`'s first statement becomes `DELETE FROM glossary_term WHERE definition_source IS NOT 'agent'`. Its second statement, `DELETE FROM glossary_pass_state`, STAYS, so a rebuild still resets the watermark. Update its doc comment, and extend the `clearGlossary` test to assert `glossary_pass_state` is empty afterwards.
  4. **`glossary-reconcile.ts`:** right after `computeTermStats`, add:

```ts
    if (term.definitionSource === "agent") {
      // An owner-ACCEPTED agent term: its evidence floor does not apply (the owner vouched for it,
      // as for a manual term), and it is never projected — projection would embed agent text
      // remotely (spec criterion 5). Only the stats are refreshed.
      applyStats(
        db,
        term.termKey,
        stats,
        scoreTerm({ docFreq: stats.docFreq, serviceSpread: stats.serviceSpread, form: term.form }),
        opts.nowMs,
      );
      continue;
    }
```

  5. **Audit the remaining writers.** Grep `glossary/` and `agents/` for every `definitionSource === "manual"` and `definition_source = 'manual'`:
     - `glossary-manual.ts:117`;
     - `store.ts`, `countByStatus` and `listConsolidated`'s `ORDER BY`;
     - `render.ts:439`;
     - `packages/cli/src/commands/glossary.ts:283,355`.

     For each, decide whether `'agent'` needs the same treatment, and record the decision in the report. Expected outcomes:
     - **Sort order:** `listConsolidated` keeps manual first and leaves agent rows ranked by score.
     - **Counts:** `countByStatus.manual` keeps counting manual only.
     - **Unchanged here:** the render label is Task 9. The CLI `!== "manual"` filter is reported only, not changed.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/glossary packages/gateway/src/agents` must PASS.

- [ ] **Step 5: Commit.** Message: `feat(glossary): agent-term writer and inverse; every pass leaves accepted agent terms alone`.

---

### Task 5: Graph — endpoint resolution, exact edge delete, and `captured_*` edges survive re-sync

**Files:**
- Modify: `packages/gateway/src/graph/relationship-graph.ts`
- Modify: `packages/gateway/src/graph/graph-populator.ts:165-170`
- Modify tests: `graph/relationship-graph.test.ts`, `graph/graph-populator.test.ts`

**Interfaces:**
- Consumes: `CAPTURED_RELATION_TYPES` (Task 2).
- Produces:

```ts
/** The graph entity an indexed item is linked to, or undefined when the populator never graphed it. */
export function resolveItemGraphEntityId(db: Database, itemId: string): string | undefined;
export function graphRelationExists(db: Database, fromId: string, toId: string, type: string): boolean;
export function deleteGraphRelation(db: Database, fromId: string, toId: string, type: string): boolean;
```

- [ ] **Step 1: Write the failing tests.**
  - **`relationship-graph.test.ts`:**
    - `resolveItemGraphEntityId` returns the entity for an item the populator graphed. Build that item through the file's existing fixture path: `upsertIndexedItem` followed by `syncGraphFromIndexedItem` for a `pr` item.
    - It returns `undefined` for a `nimbus:capture` item and for an unknown id.
    - `deleteGraphRelation` deletes exactly one `(from, to, type)` edge, leaves a second edge with the same endpoints and a different type, and returns `false` on a second call.
  - **`graph-populator.test.ts`** (Review Focus 1):

```ts
test("a captured_* edge survives a re-sync of either endpoint; a populator-owned edge does not", () => {
  // Two graphed items (reuse this file's PR/issue fixtures), A and B, with entity ids eA, eB.
  // 1. upsertGraphRelation(db, eA, eB, "captured_fixes", 1)
  // 2. POSITIVE CONTROL: also write an edge the populator owns per-entity on eA (a type NOT in
  //    CROSS_ITEM_RELATION_TYPES that this fixture's sync writes, e.g. the PR's 'authored' edge),
  //    then re-sync A with syncGraphFromIndexedItem and confirm the per-entity clear really ran
  //    (the control edge is re-derived or cleared exactly as the populator decides — assert the
  //    observable effect the fixture produces, so this test fails if the clear never runs).
  // 3. Re-sync A and B; assert graphRelationExists(db, eA, eB, "captured_fixes") is still true.
});
```

  Write that test concretely, using the fixture this file already has. The positive control is mandatory: without it, "the edge survived" passes even when the re-sync never cleared anything.

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL. The functions are missing, and the captured edge is deleted by the re-sync.

- [ ] **Step 3: Implement.**

```ts
export function resolveItemGraphEntityId(db: Database, itemId: string): string | undefined {
  const placeholders = ITEM_LINKED_ENTITY_TYPES.map(() => "?").join(", ");
  const r = db
    .query(
      `SELECT id FROM graph_entity WHERE external_id = ? AND type IN (${placeholders}) ORDER BY type LIMIT 1`,
    )
    .get(itemId, ...ITEM_LINKED_ENTITY_TYPES) as { id: string } | null;
  return r?.id;
}

export function graphRelationExists(db: Database, fromId: string, toId: string, type: string): boolean {
  return (
    db
      .query("SELECT 1 FROM graph_relation WHERE from_id = ? AND to_id = ? AND type = ?")
      .get(fromId, toId, type) !== null
  );
}

/** Exact delete by the UNIQUE (from_id, to_id, type) key — revoke's inverse of a captured link. */
export function deleteGraphRelation(db: Database, fromId: string, toId: string, type: string): boolean {
  return (
    dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? AND to_id = ? AND type = ?", [
      fromId,
      toId,
      type,
    ]).changes === 1
  );
}
```

In `graph-populator.ts`, change the array as follows, and extend the comment above it (lines ~150–163) with one sentence: "`captured_*` edges are written and deleted only by the capture gate (I28), so the populator must never clear them."

```ts
const CROSS_ITEM_RELATION_TYPES: readonly string[] = Object.freeze([
  "resolves",
  "mentions",
  "correlates_with",
  "reviewed",
  ...Object.values(CAPTURED_RELATION_TYPES),
]);
```

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/graph` must PASS.

- [ ] **Step 5: Commit.** Message: `feat(graph): resolve item entities, exact edge delete; captured_* edges survive re-sync`.

---

### Task 6: `capture-native.ts` — accept precondition, native writers, revoke inverse, native status

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-native.ts`
- Create: `packages/gateway/src/mcp-sink/capture-native.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `ValidatedCapture`, `CAPTURED_RELATION_TYPES`.
  - Task 3: `insertAgentDecision`, `deleteAgentDecision`, `agentDecisionOwned`.
  - Task 4: `upsertAgentTerm`, `deleteAgentTerm`, `termOwnership`, and the existing `computeTermStats`.
  - The existing `unprojectTerm(db, termKey)` (`glossary/glossary-project.ts:76`), which is what the reconcile demotion uses.
  - Task 5: `resolveItemGraphEntityId`, `graphRelationExists`, `deleteGraphRelation`, and the existing `upsertGraphRelation`.
  - The existing `scoreTerm` (`glossary/term-scoring.ts`).
- Produces:

```ts
export type NativeStatus = "owned" | "superseded" | "absent";
export interface LinkEndpoints { readonly fromEntityId: string; readonly toEntityId: string }
/** Throws ERR_CAPTURE_LINK_UNRESOLVED; used at SUBMIT (spec § 4.2) and again at accept. */
export function resolveLinkEndpoints(db: Database, fromItemId: string, toItemId: string): LinkEndpoints;
/** Spec § 5.2 step 5. Throws ERR_CAPTURE_SUPERSEDED / ERR_CAPTURE_LINK_UNRESOLVED. */
export function assertAcceptable(db: Database, v: ValidatedCapture): LinkEndpoints | undefined;
/** The accept-time `nimbus:capture` item text for a proposal (spec § 4.3). */
export function renderAcceptedItem(v: ValidatedCapture): { title: string; body: string };
/** Writes the native row; returns native_ref. Call ONLY inside the accept transaction. */
export function writeCaptureNative(
  db: Database,
  p: { captureId: string; itemId: string; v: ValidatedCapture; link: LinkEndpoints | undefined; nowMs: number },
): string;
/** Revoke's inverse — deletes only what this capture still owns. */
export function revokeCaptureNative(
  db: Database,
  row: { id: string; kind: CaptureKind; nativeRef: string },
  linkNamedByAnotherAccepted: boolean,
): void;
export function captureNativeStatus(db: Database, row: { id: string; kind: CaptureKind; nativeRef: string }): NativeStatus;
```

- [ ] **Step 1: Write the failing tests.** In `capture-native.test.ts`, use `openMigratedMemoryDb()`. Build graphed items with the fixture Task 5 used: `upsertIndexedItem` for a `pr`, then `syncGraphFromIndexedItem`. Cover:
  - **decision:**
    - `writeCaptureNative` returns `capture:cap_1`.
    - `listDecisions` shows the row with `extractionSource: "agent"`, and evidence labels come from each item's title.
    - `nativeStatus` is `owned`.
    - `revokeCaptureNative` removes the row, and `nativeStatus` is then `absent`.
  - **term:**
    - `assertAcceptable` throws `ERR_CAPTURE_SUPERSEDED` over a vetoed row and over a manual row (build the manual row with `applyManualTerms`).
    - It passes over an llm row.
    - `writeCaptureNative` returns the `termKey`.
    - **Takeover unprojects.** Build an llm row through the real pass path (`upsertCandidate` + `markConsolidated` + `projectTerm`), and assert a `nimbus:glossary_term` item exists for it (`SELECT COUNT(*) FROM item WHERE service = 'nimbus' AND type = 'glossary_term'` is 1). This is the positive control. After `writeCaptureNative` for the same key, the count is 0. A refused write (vetoed row) leaves any projection alone.
    - A second capture's `writeCaptureNative` makes the first's `nativeStatus` `superseded`.
    - `revokeCaptureNative` of the first leaves the row, and `revokeCaptureNative` of the second deletes it.
    - `writeCaptureNative` throws `ERR_CAPTURE_SUPERSEDED` when a vetoed row appears between the check and the write: veto it after `assertAcceptable`, then call `writeCaptureNative`.
  - **link:**
    - `resolveLinkEndpoints` throws `ERR_CAPTURE_LINK_UNRESOLVED` for a `nimbus:capture` item and for an ungraphed id. The message names the offending id.
    - `writeCaptureNative` returns `<eFrom>|<eTo>|captured_fixes` and the edge exists.
    - `revokeCaptureNative(…, true)` keeps the edge; `revokeCaptureNative(…, false)` deletes it.
  - **note:**
    - `writeCaptureNative` throws, since a note has no native row.
    - `revokeCaptureNative` is a no-op.
  - **`renderAcceptedItem`:**
    - decision: title = statement; body has `Decision:` and `Rationale:` lines, and an `Alternatives:` line only when there are alternatives.
    - term: body `Term: <term> — <definition>`, and a `Synonyms:` line only when there are synonyms.
    - link: `Link: <from> —<relation>→ <to>`, and a `Note:` line only when there is a note.

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement.**

```ts
import type { Database } from "bun:sqlite";

import {
  agentDecisionOwned,
  deleteAgentDecision,
  insertAgentDecision,
} from "../decisions/decision-store.ts";
import type { DecisionEvidence } from "../decisions/decision-types.ts";
import {
  computeTermStats,
  deleteAgentTerm,
  termOwnership,
  upsertAgentTerm,
} from "../glossary/glossary-store.ts";
import { unprojectTerm } from "../glossary/glossary-project.ts";
import { scoreTerm } from "../glossary/term-scoring.ts";
import {
  CAPTURED_RELATION_TYPES,
  deleteGraphRelation,
  graphRelationExists,
  resolveItemGraphEntityId,
  upsertGraphRelation,
} from "../graph/relationship-graph.ts";
import { clampBody } from "../index/body-caps.ts";
import { CaptureError, type CaptureKind, type ValidatedCapture } from "./capture-types.ts";

/**
 * Invariant I28's accept side: the ONLY caller of the agent-row writers (static D32(d)), itself
 * called only by `capture-gate.ts`. Every write here runs inside the gate's accept transaction, and
 * every inverse deletes only what the capture still OWNS (`capture_id`, spec § 5.3).
 */
export type NativeStatus = "owned" | "superseded" | "absent";

export interface LinkEndpoints {
  readonly fromEntityId: string;
  readonly toEntityId: string;
}

const ITEM_TITLE_MAX = 200;

export function resolveLinkEndpoints(
  db: Database,
  fromItemId: string,
  toItemId: string,
): LinkEndpoints {
  const fromEntityId = resolveItemGraphEntityId(db, fromItemId);
  if (fromEntityId === undefined) {
    throw new CaptureError(
      "ERR_CAPTURE_LINK_UNRESOLVED",
      `${fromItemId} is not in the relationship graph, so it cannot be linked`,
    );
  }
  const toEntityId = resolveItemGraphEntityId(db, toItemId);
  if (toEntityId === undefined) {
    throw new CaptureError(
      "ERR_CAPTURE_LINK_UNRESOLVED",
      `${toItemId} is not in the relationship graph, so it cannot be linked`,
    );
  }
  return { fromEntityId, toEntityId };
}

export function assertAcceptable(db: Database, v: ValidatedCapture): LinkEndpoints | undefined {
  if (v.kind === "term") {
    const o = termOwnership(db, v.payload.termKey);
    if (o?.status === "vetoed") {
      throw new CaptureError(
        "ERR_CAPTURE_SUPERSEDED",
        `the glossary term "${v.payload.termKey}" is vetoed; the owner's veto wins`,
      );
    }
    if (o?.definitionSource === "manual") {
      throw new CaptureError(
        "ERR_CAPTURE_SUPERSEDED",
        `the glossary term "${v.payload.termKey}" is authored in nimbus.toml; the owner's entry wins`,
      );
    }
    return undefined;
  }
  if (v.kind === "link") return resolveLinkEndpoints(db, v.payload.fromItemId, v.payload.toItemId);
  return undefined;
}

export function renderAcceptedItem(v: ValidatedCapture): { title: string; body: string } {
  switch (v.kind) {
    case "note":
      return { title: v.payload.title, body: v.payload.body };
    case "decision": {
      const p = v.payload;
      const lines = [`Decision: ${p.statement}`, `Rationale: ${p.rationale ?? "(none given)"}`];
      if (p.alternatives.length > 0) lines.push(`Alternatives: ${p.alternatives.join(" · ")}`);
      return { title: clampBody(p.statement, ITEM_TITLE_MAX), body: lines.join("\n") };
    }
    case "term": {
      const p = v.payload;
      const lines = [`Term: ${p.term} — ${p.definition}`];
      if (p.synonyms.length > 0) lines.push(`Synonyms: ${p.synonyms.join(", ")}`);
      return { title: p.term, body: lines.join("\n") };
    }
    case "link": {
      const p = v.payload;
      const head = `Link: ${p.fromItemId} —${p.relation}→ ${p.toItemId}`;
      return {
        title: clampBody(head, ITEM_TITLE_MAX),
        body: p.note === null ? head : `${head}\nNote: ${p.note}`,
      };
    }
  }
}

function itemTitle(db: Database, itemId: string): string {
  const r = db.query("SELECT title FROM item WHERE id = ?").get(itemId) as {
    title: string | null;
  } | null;
  return r?.title ?? itemId;
}

export function writeCaptureNative(
  db: Database,
  p: {
    captureId: string;
    itemId: string;
    v: ValidatedCapture;
    link: LinkEndpoints | undefined;
    nowMs: number;
  },
): string {
  const { v } = p;
  switch (v.kind) {
    case "note":
      throw new Error("a note has no native row; it is live from submit");
    case "decision": {
      const id = `capture:${p.captureId}`;
      const evidence: DecisionEvidence[] = v.payload.evidence.map((itemId) => ({
        kind: "source",
        entityId: null,
        itemId,
        label: itemTitle(db, itemId),
        url: null,
        occurredAt: null,
      }));
      insertAgentDecision(db, {
        id,
        captureId: p.captureId,
        sourceItemId: p.itemId,
        statement: v.payload.statement,
        rationale: v.payload.rationale,
        alternatives: v.payload.alternatives,
        decidedAt: v.payload.decidedAt,
        evidence,
        nowMs: p.nowMs,
      });
      return id;
    }
    case "term": {
      const stats = computeTermStats(db, v.payload.termKey);
      const score = scoreTerm({
        docFreq: stats.docFreq,
        serviceSpread: stats.serviceSpread,
        form: "phrase",
      });
      const wrote = upsertAgentTerm(db, {
        termKey: v.payload.termKey,
        displayTerm: v.payload.term,
        definition: v.payload.definition,
        synonyms: v.payload.synonyms,
        captureId: p.captureId,
        stats,
        score,
        nowMs: p.nowMs,
      });
      if (!wrote) {
        throw new CaptureError(
          "ERR_CAPTURE_SUPERSEDED",
          `the glossary term "${v.payload.termKey}" is vetoed or authored; the owner's entry wins`,
        );
      }
      // The row may have been a projected llm/snippet term. Reconcile now skips agent rows, so
      // nothing else would ever remove that `nimbus:glossary_term` item, and it would keep serving
      // the superseded definition in search. Same transaction as the takeover.
      unprojectTerm(db, v.payload.termKey);
      return v.payload.termKey;
    }
    case "link": {
      if (p.link === undefined) throw new Error("link endpoints were not resolved");
      const type = CAPTURED_RELATION_TYPES[v.payload.relation];
      upsertGraphRelation(db, p.link.fromEntityId, p.link.toEntityId, type, p.nowMs);
      return `${p.link.fromEntityId}|${p.link.toEntityId}|${type}`;
    }
  }
}

function parseLinkRef(nativeRef: string): [string, string, string] | undefined {
  const parts = nativeRef.split("|");
  return parts.length === 3 ? [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""] : undefined;
}

export function revokeCaptureNative(
  db: Database,
  row: { id: string; kind: CaptureKind; nativeRef: string },
  linkNamedByAnotherAccepted: boolean,
): void {
  switch (row.kind) {
    case "note":
      return;
    case "decision":
      deleteAgentDecision(db, row.nativeRef, row.id);
      return;
    case "term":
      deleteAgentTerm(db, row.nativeRef, row.id);
      return;
    case "link": {
      // Two captures can name one (from, to, type) triple, and the graph stores ONE edge.
      if (linkNamedByAnotherAccepted) return;
      const ref = parseLinkRef(row.nativeRef);
      if (ref !== undefined) deleteGraphRelation(db, ...ref);
      return;
    }
  }
}

export function captureNativeStatus(
  db: Database,
  row: { id: string; kind: CaptureKind; nativeRef: string },
): NativeStatus {
  switch (row.kind) {
    case "note":
      return "absent";
    case "decision":
      return agentDecisionOwned(db, row.nativeRef, row.id) ? "owned" : "absent";
    case "term": {
      const o = termOwnership(db, row.nativeRef);
      if (o === null) return "absent";
      return o.captureId === row.id && o.definitionSource === "agent" ? "owned" : "superseded";
    }
    case "link": {
      const ref = parseLinkRef(row.nativeRef);
      return ref !== undefined && graphRelationExists(db, ...ref) ? "owned" : "absent";
    }
  }
}
```

Confirm `scoreTerm`'s argument shape against `glossary/term-scoring.ts` (the research report quotes `{ docFreq, serviceSpread, form }`).

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/mcp-sink/capture-native.test.ts` must PASS, at ≥85% line and ≥80% branch coverage for the new file.

- [ ] **Step 5: Commit.** Message: `feat(mcp): capture-native — accept-time writers and their revoke inverses`.

---

### Task 7: The gate's submit path accepts proposals (steps 5, 6 and 8)

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-types.ts` (`SUBMITTABLE_KINDS` = all four)
- Modify: `packages/gateway/src/mcp-sink/capture-gate.ts` (`submitCapture`, `titleOf`)
- Modify: `packages/gateway/src/mcp-sink/capture-gate.test.ts`, `capture-capability.test.ts` (kinds)
- Modify: `packages/gateway/src/security-invariants.test.ts` (the PR 1 I28 submit-order test, ~:2617)

**Interfaces:**
- Consumes: `validateCapturePayload` and `referencedItemIds` (Task 2), and `resolveLinkEndpoints` (Task 6).
- Produces:
  - `submitCapture` returns `{ id, state: "live" }` for a note and `{ id, state: "proposed" }` otherwise.
  - The `capture.submit` audit `outcome` is `"captured"` for a note and `"proposed"` for a proposal.

- [ ] **Step 1: Write the failing tests** in `capture-gate.test.ts`, reusing its harness:

```ts
describe("submit — proposals", () => {
  test("a decision is stored proposed: no item, no embedding, audited not_required/proposed", () => {
    const r = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "Adopt WAL" } });
    expect(r.state).toBe("proposed");
    expect(deps.store.get(r.id)?.itemId).toBeNull();
    const items = db.query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus' AND type = 'capture'").get() as { n: number };
    expect(items.n).toBe(0);
    expect(embedded).toEqual([]);
    const last = auditRows().at(-1);
    expect(last?.hitl_status).toBe("not_required");
    expect(JSON.parse(last?.action_json ?? "{}")).toMatchObject({ kind: "decision", outcome: "proposed" });
  });

  test("step 8: the pending cap refuses a proposal (audited) but never a note", () => {
    cap = onConfig({ maxPending: 1 });
    submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "log" } });
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "term", payload: { term: "MVCC", definition: "x" } }))).toBe("ERR_CAPTURE_QUEUE_FULL");
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({ outcome: "ERR_CAPTURE_QUEUE_FULL" });
    expect(submitCapture(deps, MCP, { kind: "note", payload: { body: "still fine" } }).state).toBe("live");
  });

  test("step 6: a link refuses an unknown item, then an ungraphed one, then a capture item", () => {
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "link", payload: { fromItemId: "x:1", toItemId: "y:2", relation: "fixes" } }))).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    // An indexed item the populator never graphed (a plain filesystem file):
    upsertIndexedItem(db, { service: "filesystem", type: "file", externalId: "a", title: "a", modifiedAt: 1, syncedAt: 1 });
    upsertIndexedItem(db, { service: "filesystem", type: "file", externalId: "b", title: "b", modifiedAt: 1, syncedAt: 1 });
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "link", payload: { fromItemId: "filesystem:a", toItemId: "filesystem:b", relation: "fixes" } }))).toBe("ERR_CAPTURE_LINK_UNRESOLVED");
    const note = submitCapture(deps, MCP, { kind: "note", payload: { body: "n" } });
    const [pr] = graphedItems(1);
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "link", payload: { fromItemId: `nimbus:${note.id}`, toItemId: pr, relation: "relates_to" } }))).toBe("ERR_CAPTURE_LINK_UNRESOLVED");
  });

  test("a link between two graphed items is accepted as a proposal", () => {
    const [a, b] = graphedItems(2);
    expect(submitCapture(deps, MCP, { kind: "link", payload: { fromItemId: a, toItemId: b, relation: "fixes" } }).state).toBe("proposed");
  });

  test("captureStatus counts proposals as pending; kinds now lists all four", () => {
    submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    const s = captureStatus(deps);
    expect(s.pending).toBe(1);
    expect([...s.kinds].sort()).toEqual(["decision", "link", "note", "term"]);
  });
});
```

Add a `graphedItems(n)` helper to the test file that builds `n` graphed `pr` items with the Task 5 fixture and returns their item ids. Check `upsertIndexedItem`'s required fields against `index/item-store.ts`, because the literals above are the minimum the research found.

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL with `ERR_CAPTURE_KIND_NOT_ALLOWED`, because `SUBMITTABLE_KINDS` is note-only.

- [ ] **Step 3: Implement.**
  1. **`SUBMITTABLE_KINDS`:** widen it to all four kinds, with the comment `all four since PR 2`. Update any `capture-capability.test.ts` expectation that pinned `["note"]`.
  2. **`submitCapture` step 5:** replace it with the following, and keep the other steps exactly as they are:

```ts
  // 5. Whitelist rebuild, per kind.
  let v: ValidatedCapture;
  try {
    v = validateCapturePayload(kindRaw, params["payload"], now);
  } catch (e) {
    if (e instanceof CaptureError)
      refuseAudited(deps, caller, kindRaw, clientLabel, e.code, e.message);
    throw e;
  }
  // 6. Referenced items exist (a capture item only while live/accepted); a link's endpoints must
  //    also be graph-linkable NOW, so a proposal that can never be accepted is not queued.
  const missing = missingItem(deps, referencedItemIds(v));
  if (missing !== undefined) {
    refuseAudited(deps, caller, kindRaw, clientLabel, "ERR_CAPTURE_UNKNOWN_ITEM", `no indexed item ${missing}`);
  }
  if (v.kind === "link") {
    try {
      resolveLinkEndpoints(deps.db, v.payload.fromItemId, v.payload.toItemId);
    } catch (e) {
      if (e instanceof CaptureError)
        refuseAudited(deps, caller, kindRaw, clientLabel, e.code, e.message);
      throw e;
    }
  }
  // 7. (unchanged) Durable hourly cap.
  // 8. Pending cap — proposals only; a note is never pending.
  const proposal = v.kind !== "note";
  if (proposal && deps.store.countByState("proposed") >= cap.config.maxPending) {
    refuseAudited(
      deps,
      caller,
      kindRaw,
      clientLabel,
      "ERR_CAPTURE_QUEUE_FULL",
      `the review queue is full (${String(cap.config.maxPending)} proposals await the owner)`,
    );
  }
```

  3. **Write path:** `state = proposal ? "proposed" : "live"`, and `itemId = proposal ? null : itemPrimaryKey(…)`. Only a note calls `upsertIndexedItem`, using `v.payload` and narrowing via `if (v.kind === "note")`. The audit `outcome` is `proposal ? "proposed" : "captured"`. Only a note calls `deps.scheduleEmbedding`.
  4. **Comment:** update `submitCapture`'s doc comment from "notes only" to cover all four kinds. A proposal gets no item, no native row and no embedding until accept (spec § 4.3).
  5. **`titleOf`** (`capture-gate.ts:136`): add the link preview, clamped like every other title (the two ids can be 512 characters each):

```ts
function titleOf(row: CaptureRow): string {
  if (row.payloadJson === null) return "(revoked)";
  const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  if (row.kind === "link") {
    const rel = typeof p["relation"] === "string" ? p["relation"] : "link";
    const from = typeof p["fromItemId"] === "string" ? p["fromItemId"] : "";
    const to = typeof p["toItemId"] === "string" ? p["toItemId"] : "";
    return `${rel}: ${from} → ${to}`.slice(0, 120);
  }
  const t = p["title"] ?? p["statement"] ?? p["term"];
  return typeof t === "string" ? t.slice(0, 120) : "";
}
```

  Add a test: a link whose two ids are 300 characters each lists with a title of exactly 120 characters.

  6. **The PR 1 submit-order test** (`security-invariants.test.ts`, `I28 — MCP content enters only through the capture gate…`). Its `order` array names `"validateNotePayload(params"`, which step 5 above removes, so the test goes red. Change the array to:

```ts
    const order = [
      "deps.capability()",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      "deps.limiter.tryAcquire(",
      "cap.kinds.includes(",
      "validateCapturePayload(kindRaw",
      "missingItem(",
      "resolveLinkEndpoints(",
      "deps.store.countCreatedSince(",
      'deps.store.countByState("proposed")',
      "deps.db.transaction(",
    ];
```

  Rename the test to match: `… → validate → items → link endpoints → durable cap → pending cap, in that order`. Red-prove the new entries by swapping steps 7 and 8, seeing the test fail, then restoring.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/mcp-sink packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/security-invariants.test.ts` must PASS, and every PR 1 test must stay green.

- [ ] **Step 5: Commit.** Message: `feat(mcp): submit accepts decision, term and link proposals (pending cap, link resolvability)`.

---

### Task 8: `acceptCapture` and `rejectCapture`, and their IPC methods

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-store.ts` (+ test)
- Modify: `packages/gateway/src/mcp-sink/capture-gate.ts` (+ test)
- Modify: `packages/gateway/src/ipc/capture-rpc.ts` (+ test)
- Modify: `packages/gateway/src/platform/assemble.ts:3443` (use `REJECTED_RETENTION_MS`)

**Interfaces:**
- Produces:

```ts
// capture-store.ts (module scope)
export const REJECTED_RETENTION_MS: number; // 90 days
// CaptureStore
markAccepted(id: string, itemId: string, nativeRef: string, nowMs: number): boolean; // WHERE state='proposed'
markRejected(id: string, nowMs: number): boolean;                                   // WHERE state='proposed'
countAcceptedWithNativeRef(nativeRef: string, excludingId: string): number;
// gate
export function acceptCapture(deps: CaptureGateDeps, caller: CaptureCaller, idRaw: unknown):
  { id: string; state: "accepted"; nativeRef: string };
export function rejectCapture(deps: CaptureGateDeps, caller: CaptureCaller, idRaw: unknown):
  { id: string; state: "rejected" };
```
- IPC: `captures.accept` `{id}` → `{id, state, nativeRef}`; `captures.reject` `{id}` → `{id, state}`.

- [ ] **Step 1: Write the failing tests.** In `capture-store.test.ts`, add guarded transitions: each returns `false` from the wrong state, and `countAcceptedWithNativeRef` excludes the given id. In `capture-gate.test.ts`:

```ts
describe("accept", () => {
  test("decision: native row + capture item + embedding + one not_required audit row, in one transaction", () => {
    const [ev] = graphedItems(1);
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "Adopt WAL", evidence: [ev] } });
    const r = acceptCapture(deps, OWNER, id);
    expect(r).toEqual({ id, state: "accepted", nativeRef: `capture:${id}` });
    const row = deps.store.get(id);
    expect(row?.itemId).toBe(`nimbus:${id}`);
    expect(embedded).toEqual([`nimbus:${id}`]);
    const d = db.query("SELECT extraction_source, capture_id FROM decision_record WHERE id = ?").get(`capture:${id}`);
    expect(d).toEqual({ extraction_source: "agent", capture_id: id });
    const accepts = auditRows().filter((a) => a.action_type === "capture.accept");
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.hitl_status).toBe("not_required");
    expect(JSON.parse(accepts[0]?.action_json ?? "{}")).toMatchObject({ captureId: id, outcome: "accepted" });
  });

  test("Review Focus 4: a second accept refuses ERR_CAPTURE_STATE and writes nothing more", () => {
    const { id } = submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "log" } });
    acceptCapture(deps, OWNER, id);
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(auditRows().filter((a) => a.action_type === "capture.accept")).toHaveLength(1);
  });

  test("a lost race inside the transaction rolls the native write back", () => {
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    const store = deps.store;
    deps = { ...deps, store: Object.assign(Object.create(Object.getPrototypeOf(store) as object) as CaptureStore, store, { markAccepted: () => false }) };
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus'").get()).toEqual({ n: 0 });
  });

  test("Review Focus 5: an evidence item deleted since submit refuses; the capture stays proposed", () => {
    const [ev] = graphedItems(1);
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s", evidence: [ev] } });
    deleteItemByPrimaryKey(db, String(ev));
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    expect(deps.store.get(id)?.state).toBe("proposed");
  });

  test("term over a vetoed row refuses ERR_CAPTURE_SUPERSEDED and stays proposed", () => {
    /* seed + veto "wal" through upsertCandidate/markVetoed, submit term WAL, accept → SUPERSEDED */
  });

  test("link whose endpoint left the graph refuses ERR_CAPTURE_LINK_UNRESOLVED and stays proposed", () => {
    /* submit a link between two graphed items, delete one entity's graph row (deleteGraphEntitiesForItemKeys), accept → LINK_UNRESOLVED */
  });

  test("an mcp client cannot accept; a disabled sink freezes accept but not reject", () => {
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(codeOf(() => acceptCapture(deps, MCP, id))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    cap = resolveCaptureCapability({ ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: false } }, OPEN);
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_DISABLED");
    expect(rejectCapture(deps, OWNER, id).state).toBe("rejected");
  });

  test("a live note cannot be accepted", () => {
    const { id } = submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } });
    expect(codeOf(() => acceptCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
  });

  test("an audit append failure rolls the whole accept back", () => {
    /* use the same audit-failure technique PR 1's submit test uses in this file */
  });
});

describe("reject", () => {
  test("proposed → rejected with decided_at, one 'rejected' audit row, nothing native", () => {
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    clock += 5;
    expect(rejectCapture(deps, OWNER, id)).toEqual({ id, state: "rejected" });
    expect(deps.store.get(id)?.decidedAt).toBe(clock);
    const rej = auditRows().filter((a) => a.action_type === "capture.reject");
    expect(rej.map((a) => a.hitl_status)).toEqual(["rejected"]);
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
  });
  test("reject prunes rejected rows decided more than 90 days ago", () => {
    /* reject one at clock T, advance clock past T + 90d, reject another → the first is gone */
  });
  test("rejecting a non-proposed capture refuses ERR_CAPTURE_STATE; mcp refuses FORBIDDEN", () => {
    /* … */
  });
});
```

Write the `/* … */` bodies out in full. Each comment says exactly what to seed and what to assert. For the audit-failure test, copy PR 1's technique from this same file. For the lost-race test, if the `Object.create` trick does not type-check cleanly, subclass `CaptureStore` in the test and override `markAccepted`. In `capture-rpc.test.ts`, add one dispatch test each for `captures.accept` and `captures.reject`, mirroring the existing `captures.revoke` test, including the mapping of `CaptureError` to `-32001`.

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL, because the functions are not exported.

- [ ] **Step 3: Implement.** In `capture-store.ts` (still the only file naming the table):

```ts
  markAccepted(id: string, itemId: string, nativeRef: string, nowMs: number): boolean {
    return (
      dbRun(
        this.db,
        `UPDATE capture SET state = 'accepted', item_id = ?, native_ref = ?, decided_at = ?
         WHERE id = ? AND state = 'proposed'`,
        [itemId, nativeRef, nowMs, id],
      ).changes === 1
    );
  }

  markRejected(id: string, nowMs: number): boolean {
    return (
      dbRun(
        this.db,
        "UPDATE capture SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'proposed'",
        [nowMs, id],
      ).changes === 1
    );
  }

  countAcceptedWithNativeRef(nativeRef: string, excludingId: string): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM capture WHERE state = 'accepted' AND native_ref = ? AND id <> ?")
      .get(nativeRef, excludingId) as { n: number };
    return r.n;
  }
```

In `capture-gate.ts`, add the following, plus a `storedPayload` helper. PR 1 has NO retention constant: `platform/assemble.ts:3443` passes the literal `90 * 86_400_000` to the boot-time `pruneRejected`. Name it once, in `capture-store.ts` beside `pruneRejected` (the module that owns the rule), and use it at both sites, so the boot prune and the reject-time prune cannot drift:

```ts
/** How long a rejected capture's row is kept before `pruneRejected` deletes it (spec § 5.2). */
export const REJECTED_RETENTION_MS = 90 * 86_400_000;
```

Then change `assemble.ts:3443` to `captureStore.pruneRejected(Date.now() - REJECTED_RETENTION_MS);` and add the import. Add `platform/assemble.ts` to this task's commit.

```ts
/** Re-validate a stored payload: the stored JSON is already rebuilt, so this only re-types it. */
function storedPayload(row: CaptureRow): ValidatedCapture {
  if (row.payloadJson === null) throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} has no payload`);
  return validateCapturePayload(row.kind, JSON.parse(row.payloadJson) as unknown, row.createdAt);
}

// ---- accept / reject (spec § 5.2) ---------------------------------------------------------------

export function acceptCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "accepted"; nativeRef: string } {
  // 1. Capability: switching the sink off FREEZES the queue (reject and revoke still work).
  const cap = deps.capability();
  if (!cap.enabled) {
    throw new CaptureError(
      "ERR_CAPTURE_DISABLED",
      `the capture sink is off (${cap.reason}); accepting is frozen, rejecting and revoking still work`,
    );
  }
  // 2. Owner only.
  requireOwner(caller);
  // 3. Must be proposed.
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.state !== "proposed") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} is ${row.state}; only a proposed capture can be accepted`);
  }
  const v = storedPayload(row);
  // 4. Referenced items still exist (they may have been deleted since submit).
  const missing = missingItem(deps, referencedItemIds(v));
  if (missing !== undefined) {
    throw new CaptureError("ERR_CAPTURE_UNKNOWN_ITEM", `no indexed item ${missing}; the capture stays proposed`);
  }
  // 5. Kind-specific precondition (owner's veto/config wins; link endpoints still graphed).
  const link = assertAcceptable(deps.db, v);
  // 6. ONE transaction: native row, state, capture item, audit. Any failure rolls all of it back.
  const now = deps.now();
  const itemId = itemPrimaryKey(CAPTURE_ITEM_SERVICE, id);
  const text = renderAcceptedItem(v);
  let nativeRef = "";
  deps.db.transaction(() => {
    nativeRef = writeCaptureNative(deps.db, { captureId: id, itemId, v, link, nowMs: now });
    if (!deps.store.markAccepted(id, itemId, nativeRef, now)) {
      throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
    }
    upsertIndexedItem(deps.db, {
      service: CAPTURE_ITEM_SERVICE,
      type: CAPTURE_ITEM_TYPE,
      externalId: id,
      title: text.title,
      body: text.body,
      modifiedAt: now,
      syncedAt: now,
      metadata: {
        captureKind: row.kind,
        captureId: id,
        agentAuthored: true,
        clientLabel: row.clientLabel,
        nativeRef,
      },
    });
    appendAuditEntry(deps.db, {
      actionType: "capture.accept",
      // I4: no consent gate ran — the owner's own command is the decision. `approved` is
      // reserved for rows a gate earned (security-invariants.test.ts APPROVED_ROW_IS_EARNED).
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, nativeRef, outcome: "accepted" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  deps.scheduleEmbedding?.(itemId);
  return { id, state: "accepted", nativeRef };
}

export function rejectCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "rejected" } {
  // No capability check: the owner can always drain the queue (spec § 8.2).
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.state !== "proposed") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} is ${row.state}; only a proposed capture can be rejected`);
  }
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRejected(id, now);
    if (!won) return;
    appendAuditEntry(deps.db, {
      actionType: "capture.reject",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, outcome: "rejected" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won) throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  deps.store.pruneRejected(now - REJECTED_RETENTION_MS);
  return { id, state: "rejected" };
}
```

The CHECK `(state = 'revoked') = (payload_json IS NULL)` holds for accepted and rejected rows, since both keep their payload. In `capture-rpc.ts`, add:

```ts
        "captures.accept": (p, c) => acceptCapture(c.gate, c.caller, idParam(p)),
        "captures.reject": (p, c) => rejectCapture(c.gate, c.caller, idParam(p)),
```

Then update the gate's header comment so that D32(b) names all four entry points.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/mcp-sink packages/gateway/src/ipc/capture-rpc.test.ts` must PASS. Also run `bun test packages/gateway/src/security-invariants.test.ts`, which must stay green. The I4 earned-set test passes because no new `hitlStatus: "approved"` string was added.

- [ ] **Step 5: Commit.** Message: `feat(mcp): captures accept and reject — native write in one transaction, owner only`.

---

### Task 9: Revoke an accepted capture, and report native ownership in `captures.get`

**Files:**
- Modify: `packages/gateway/src/mcp-sink/capture-gate.ts` (`revokeCapture`, `getCapture`, `CaptureDetail`)
- Modify: `packages/gateway/src/mcp-sink/capture-gate.test.ts`

**Interfaces:**
- Produces: `CaptureDetail` gains `readonly nativeStatus: NativeStatus | null`, which is `null` unless the row is `accepted` with a `nativeRef`.
- `revokeCapture` accepts from `live` or `accepted`. Revoke still needs no capability.

- [ ] **Step 1: Write the failing tests.**

```ts
describe("revoke — accepted captures", () => {
  test("an accepted decision: native row, evidence, item and payload go; native_ref stays", () => {
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    acceptCapture(deps, OWNER, id);
    expect(revokeCapture(deps, OWNER, id)).toEqual({ id, state: "revoked" });
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE id = ?").get(`nimbus:${id}`)).toEqual({ n: 0 });
    const row = deps.store.get(id);
    expect(row?.payloadJson).toBeNull();
    expect(row?.nativeRef).toBe(`capture:${id}`);
    expect(JSON.parse(auditRows().at(-1)?.action_json ?? "{}")).toMatchObject({ outcome: "revoked", nativeRef: `capture:${id}` });
  });

  test("a newer accepted term takes the row over; revoking the older leaves it, and get() says superseded", () => {
    const a = submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "old" } }).id;
    acceptCapture(deps, OWNER, a);
    const b = submitCapture(deps, MCP, { kind: "term", payload: { term: "WAL", definition: "new" } }).id;
    acceptCapture(deps, OWNER, b);
    expect(getCapture(deps, OWNER, a).nativeStatus).toBe("superseded");
    expect(getCapture(deps, OWNER, b).nativeStatus).toBe("owned");
    revokeCapture(deps, OWNER, a);
    expect(db.query("SELECT definition FROM glossary_term WHERE term_key = 'wal'").get()).toEqual({ definition: "new" });
  });

  test("a link triple named by two accepted captures survives revoking one", () => {
    const [x, y] = graphedItems(2);
    const p = { kind: "link", payload: { fromItemId: x, toItemId: y, relation: "fixes" } };
    const a = submitCapture(deps, MCP, p).id;
    const b = submitCapture(deps, MCP, p).id;
    acceptCapture(deps, OWNER, a);
    acceptCapture(deps, OWNER, b);
    revokeCapture(deps, OWNER, a);
    expect(getCapture(deps, OWNER, b).nativeStatus).toBe("owned");
    revokeCapture(deps, OWNER, b);
    expect(db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'captured_fixes'").get()).toEqual({ n: 0 });
  });

  test("revoking a note removes evidence rows citing it; the decision stays", () => {
    const note = submitCapture(deps, MCP, { kind: "note", payload: { body: "context" } }).id;
    const dec = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s", evidence: [`nimbus:${note}`] } }).id;
    acceptCapture(deps, OWNER, dec);
    revokeCapture(deps, OWNER, note);
    expect(db.query("SELECT COUNT(*) AS n FROM decision_evidence").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM decision_record").get()).toEqual({ n: 1 });
  });

  test("a proposed or rejected capture cannot be revoked; a revoked one is a no-op success", () => {
    const { id } = submitCapture(deps, MCP, { kind: "decision", payload: { statement: "s" } });
    expect(codeOf(() => revokeCapture(deps, OWNER, id))).toBe("ERR_CAPTURE_STATE");
    acceptCapture(deps, OWNER, id);
    revokeCapture(deps, OWNER, id);
    expect(revokeCapture(deps, OWNER, id)).toEqual({ id, state: "revoked" });
  });

  test("nativeStatus is null for notes and non-accepted rows", () => {
    const n = submitCapture(deps, MCP, { kind: "note", payload: { body: "b" } }).id;
    expect(getCapture(deps, OWNER, n).nativeStatus).toBeNull();
  });
});
```

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL. Revoke refuses `accepted`, and `nativeStatus` does not exist.

- [ ] **Step 3: Implement.** In `revokeCapture`:

```ts
  if (row.state !== "live" && row.state !== "accepted") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${id} is ${row.state}; only a live note or an accepted capture can be revoked`,
    );
  }
  const from = row.state;
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRevoked(id, from, now);
    if (!won) return; // lost a race to another revoke: nothing to write
    if (from === "accepted" && row.nativeRef !== null) {
      revokeCaptureNative(
        deps.db,
        { id, kind: row.kind, nativeRef: row.nativeRef },
        deps.store.countAcceptedWithNativeRef(row.nativeRef, id) > 0,
      );
    }
    if (row.itemId !== null) {
      // No evidence row may keep pointing at an item that is about to disappear (spec § 5.3).
      deleteEvidenceCitingItem(deps.db, row.itemId);
      deleteItemByPrimaryKey(deps.db, row.itemId);
    }
    appendAuditEntry(deps.db, {
      actionType: "capture.revoke",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, nativeRef: row.nativeRef, outcome: "revoked" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  // UNCHANGED from PR 1 — keep the tail: a lost race is success only if the winner also revoked.
  if (!won && deps.store.get(id)?.state !== "revoked") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  }
  return { id, state: "revoked" };
}
```

The block above replaces everything in `revokeCapture` from the `row.state !== "live"` check to the end of the function. The lines before it (`requireOwner`, `requireId`, the not-found check and the `revoked` early return) stay as they are. `markRevoked`'s `expected: CaptureState` parameter already accepts `"accepted"`, so no store change is needed.

`getCapture` adds:

```ts
    nativeStatus:
      row.state === "accepted" && row.nativeRef !== null
        ? captureNativeStatus(deps.db, { id: row.id, kind: row.kind, nativeRef: row.nativeRef })
        : null,
```

Import `deleteEvidenceCitingItem` from `../decisions/decision-store.ts`. It deletes evidence rows and creates no `'agent'` row, so it is not a D32(d) name.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/mcp-sink` must PASS.

- [ ] **Step 5: Commit.** Message: `feat(mcp): revoke an accepted capture — deletes only what it still owns`.

---

### Task 10: I28 and D32(d) — the invariant triple for the accept side

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`. Add `checkAgentProvenanceWriters` after `checkCaptureGateImporters` (~:1886), and add its runner/reporting next to the D32(c) block (~:2853).
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts`, adding a `D32(d)` describe beside the D32(c) one (~:2082).
- Modify: `packages/gateway/src/security-invariants.test.ts`, in the `I28 — …` describe (~:2617).
- Modify: `docs/SECURITY-INVARIANTS.md` § I28 (~:765), `CLAUDE.md` and `GEMINI.md` (the I28 bullet at :73 and the D32 mention in the "Static complement" paragraph).

**Interfaces:**
- Produces: `export function checkAgentProvenanceWriters(files: readonly FileEntry[]): Violation[]`, with rule id `agent-provenance-writers`.

- [ ] **Step 1: Write the failing tests.** In `check-nimbus-invariants.test.ts`:

```ts
describe("D32(d) — agent-row writers are reachable only through capture-native.ts", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the definitions, capture-native and the gate", () => {
    expect(
      checkAgentProvenanceWriters([
        file("packages/gateway/src/decisions/decision-store.ts", "export function insertAgentDecision() {}\nexport function deleteAgentDecision() {}"),
        file("packages/gateway/src/glossary/glossary-store.ts", "export function upsertAgentTerm() {}\nexport function deleteAgentTerm() {}"),
        file("packages/gateway/src/mcp-sink/capture-native.ts", "insertAgentDecision(db, d); upsertAgentTerm(db, t); export function writeCaptureNative() {}"),
        file("packages/gateway/src/mcp-sink/capture-gate.ts", "writeCaptureNative(db, p); revokeCaptureNative(db, r, false);"),
        file("packages/gateway/src/x.test.ts", "insertAgentDecision(db, d)"),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a writer called from the decisions pass", "packages/gateway/src/decisions/decision-extract.ts", "insertAgentDecision(db, d);"],
    ["a writer aliased on import", "packages/gateway/src/agents/x.ts", 'import { upsertAgentTerm as up } from "../glossary/glossary-store.ts";'],
    ["capture-native called around the gate", "packages/gateway/src/ipc/capture-rpc.ts", "writeCaptureNative(db, p);"],
    ["a revoke inverse called elsewhere", "packages/gateway/src/platform/assemble.ts", "revokeCaptureNative(db, r, true);"],
  ])("FAILS on %s", (_n, relPath, src) => {
    expect(checkAgentProvenanceWriters([file(relPath, src)])).toHaveLength(1);
  });

  test("ignores a mention in a comment or a string", () => {
    expect(
      checkAgentProvenanceWriters([
        file("packages/gateway/src/x.ts", '// insertAgentDecision is capture-only\nconst s = "upsertAgentTerm";'),
      ]),
    ).toEqual([]);
  });
});
```

In `security-invariants.test.ts`, inside the I28 describe:

```ts
  test("acceptCapture checks capability → owner → proposed → items exist → precondition → one transaction, in that order", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const body = src.slice(src.indexOf("export function acceptCapture"));
    const order = [
      "deps.capability(",
      "requireOwner(caller)",
      'row.state !== "proposed"',
      "missingItem(",
      "assertAcceptable(",
      "deps.db.transaction(",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("a proposal writes no item and no native row until accepted (absent by construction)", async () => {
    // Build a real gate over openMigratedMemoryDb() as capture-gate.test.ts does, submit a decision
    // from an `mcp` caller, and assert: COUNT(item WHERE service='nimbus') = 0,
    // COUNT(decision_record) = 0; then accept as the owner and assert both are 1.
  });

  test("capture.accept never records an `approved` row (I4: no consent gate ran)", async () => {
    const src = await read("packages/gateway/src/mcp-sink/capture-gate.ts");
    const at = src.indexOf('actionType: "capture.accept"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toMatch(/hitlStatus:\s*"not_required"/);
  });
```

Write the middle test's body out in full; the comment says exactly what it must do.

- [ ] **Step 2: Run them, and see them fail.** Run `bun test scripts/structure-audit/check-nimbus-invariants.test.ts packages/gateway/src/security-invariants.test.ts -t "D32|I28"`. Expected: the D32(d) tests FAIL because the function is not exported. The new I28 tests PASS, since Tasks 7–9 already shipped the code. Red-prove them by temporarily swapping two calls in `acceptCapture`, then restoring.

- [ ] **Step 3: Implement** D32(d), mirroring `checkCaptureGateCallers` exactly, including `stripStringLiterals(stripComments(...))`, the `.test.ts` skip and the `packages/gateway/src/` scope:

```ts
// (d) Rows with 'agent' provenance arise ONLY from an owner-accepted capture. The four agent-row
//     writers are named only by their definitions and `mcp-sink/capture-native.ts`, and
//     capture-native's write/inverse entry points only by itself and `capture-gate.ts`, so the one
//     path to an 'agent' row is acceptCapture → writeCaptureNative. Stated bound: a hand-written
//     `INSERT … 'agent'` elsewhere is invisible to this identifier scan; capability confinement
//     (only the stores are handed those tables' writers) is the real defense, as with D27(b).
const D32_AGENT_WRITER_RE =
  /\b(?:insertAgentDecision|deleteAgentDecision|upsertAgentTerm|deleteAgentTerm)\b/g;
const D32_AGENT_WRITER_ALLOWED: readonly string[] = [
  "packages/gateway/src/decisions/decision-store.ts",
  "packages/gateway/src/glossary/glossary-store.ts",
  "packages/gateway/src/mcp-sink/capture-native.ts",
];
const D32_CAPTURE_NATIVE_RE = /\b(?:writeCaptureNative|revokeCaptureNative)\b/g;
const D32_CAPTURE_NATIVE_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-native.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];

export function checkAgentProvenanceWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D32_AGENT_WRITER_RE, D32_AGENT_WRITER_ALLOWED],
      [D32_CAPTURE_NATIVE_RE, D32_CAPTURE_NATIVE_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({ rule: "agent-provenance-writers", file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
      }
    }
  }
  return out;
}
```

Wire the function into the runner with the error line `D32(d) an agent-row writer reached outside the capture accept path — I28 regression: <snippet>`, following the D32(c) block. Run `bun run audit:invariants`; it must exit 0.

Docs, written in the same commit (the triple rule):
- **`docs/SECURITY-INVARIANTS.md` § I28 Statement.** Add a second paragraph: proposals (decision/term/link) are stored with no item, no native row and no embedding until the owner's `acceptCapture()`. Accept checks, in order: capability (a disabled sink freezes accept), owner kind, `proposed` state, referenced items still exist, the kind precondition (a vetoed or `nimbus.toml` term wins; link endpoints still graphed). It then writes the native row with `'agent'` provenance and a `capture_id` owner, the capture item and a `capture.accept` audit row (`not_required`) in ONE transaction. `rejectCapture()` needs no capability. Revoke deletes only what the capture still owns.
- **Wiring:** add `capture-native.ts` and V68.
- **Static complement:** add D32(d).
- **Bounds:** replace "PR 1 ships notes only…" with: acceptance proves the owner saw the text, not that it is true; an accepted term is never projected, so search finds it only through its capture item; `decisions --rebuild` / `glossary --rebuild` keep agent rows (revoke is how they leave).
- **`CLAUDE.md` and `GEMINI.md`:** update the I28 bullet to match in one sentence. Change "(static D32)" to "(static D32(a)–(d))".

- [ ] **Step 4: Run the tests.** Run `bun test scripts/structure-audit packages/gateway/src/security-invariants.test.ts`, then `bun run audit:invariants` and `bun run audit:doc-refs`.

- [ ] **Step 5: Commit.** Message: `feat(security): I28 accept side + D32(d) — agent rows arise only from an accepted capture`.

---

### Task 11: Disclosures — agent-authored decisions and terms survive a synthesis rewrite (I31)

**Files:**
- Modify: `packages/gateway/src/agents/_lib/brief-disclosures.ts`
- Modify: `packages/gateway/src/agents/_lib/render.ts`: `renderDecisionsEntry` (~:585) and `renderGlossaryTermsSection` (~:439)
- Modify: `packages/gateway/src/agents/_lib/brief-contract.ts`: add a `decisions` arm, and remove `decisions` from the `[]` block (~:131)
- Modify tests: `render.decisions.test.ts`, `brief-contract.coverage.test.ts`, `disclosure-anchor-coverage.test.ts`, and the glossary render/disclosure tests

**Interfaces:**
- Produces: `AGENT_CAPTURE_ANCHOR = "captured via MCP, accepted by the owner"`, `decisionsAgentDisclosure(): Disclosure`, and a third branch of `glossaryProvenanceDisclosure` for `"agent"`.

- [ ] **Step 1: Write the failing tests.**
  - **`render.decisions.test.ts`:** an entry with `extractionSource: "agent"` renders the line `      source        agent-authored (captured via MCP, accepted by the owner)` directly under its statement line. An `"llm"` entry renders no such line.
  - **`brief-contract.coverage.test.ts`:**
    - `requiredPhrases` for a decisions brief with one agent entry returns exactly `[decisionsAgentDisclosure()]`, and with no agent entry returns `[]`.
    - A synthesized markdown that drops the anchor under `## Decisions …` produces a `contractViolations` entry, and one that keeps it produces none.
    - (There is no `:665` comment to update: that pointer was stale. The comment that changes is in `brief-contract.ts` itself, above the `[]` block, `// Every other brief kind returns [] until its contractual strings are added.` It stays true once `decisions` leaves that block in Step 3; leave it as is.)
  - **Glossary:**
    - `glossaryProvenanceDisclosure("WAL", "agent")` returns a disclosure whose `anchors` equal `[AGENT_CAPTURE_ANCHOR]` and whose `line` contains the anchor.
    - Term-mode render includes the line.
    - List-mode `renderGlossaryTermsSection` marks the entry ` — agent-authored`, and still marks ` — authored` for manual.
  - **`disclosure-anchor-coverage.test.ts`:** both new disclosures pass the existing per-entry checks: every anchor occurs in its own `line`, and the anchor count is at least the sentence count. Add them to the list that test iterates.

- [ ] **Step 2: Run them, and see them fail.** Expected: FAIL, because the symbols do not exist.

- [ ] **Step 3: Implement.** In `brief-disclosures.ts`:

```ts
/**
 * Owner-ACCEPTED agent text (capture sink, I28) is never presented as extracted or owner-authored
 * (spec § 5.4). The anchor is the fixed fragment — never a date, never the full sentence.
 */
export const AGENT_CAPTURE_ANCHOR = "captured via MCP, accepted by the owner";

export function decisionsAgentDisclosure(): Disclosure {
  return {
    scope: section("Decisions"),
    line: `      source        agent-authored (${AGENT_CAPTURE_ANCHOR})`,
    anchors: [AGENT_CAPTURE_ANCHOR],
  };
}
```

In `glossaryProvenanceDisclosure`, add before `return undefined`:

```ts
  if (source === "agent") {
    return {
      scope: section(term),
      line: `- _Agent-authored: ${AGENT_CAPTURE_ANCHOR}._`,
      anchors: [AGENT_CAPTURE_ANCHOR],
    };
  }
```

In `renderDecisionsEntry`, add right after the first `lines` element:

```ts
  if (e.extractionSource === "agent") lines.push(decisionsAgentDisclosure().line);
```

In `render.ts`, add a module-level helper, and use it in `renderGlossaryTermsSection` in place of the current manual-only label (`render.ts:439`, `const authored = …`). A nested ternary would be a Sonar S3358 finding, and the helper keeps the section function's cognitive complexity where it is:

```ts
function provenanceLabel(source: DefinitionSource | null): string {
  if (source === "manual") return " — authored";
  if (source === "agent") return " — agent-authored";
  return "";
}
```

Likewise keep `renderDecisionsEntry`'s addition to the single `if` line above. Do not nest further conditions inside it. `DefinitionSource` is imported from `./glossary-types.ts` if `render.ts` does not already import it (today it compares `e.definitionSource` inline at `:439`).

In `brief-contract.ts`, add this before the `[]` block and remove `brief.kind === "decisions"` from that block:

```ts
  if (brief.kind === "decisions") {
    return brief.entries.some((e) => e.extractionSource === "agent") ? [decisionsAgentDisclosure()] : [];
  }
```

Confirm that `sectionBody(markdown, "Decisions")` matches the rendered heading `## Decisions · 30d · N found`. The research reports a normalized PREFIX match. If it does not match, use the exact heading-construction helper the renderer uses, and say so in the report.

- [ ] **Step 4: Run the tests.** `bun test packages/gateway/src/agents` must PASS.

- [ ] **Step 5: Commit.** Message: `feat(agents): agent-authored disclosure on accepted decisions and terms (I31-anchored)`.

---

### Task 12: MCP adapter — `propose_decision`, `propose_term`, `propose_link`

**Files:**
- Modify: `packages/cli/src/mcp/capture-tools.ts`
- Modify: `packages/cli/src/mcp/capture-tools.test.ts`

**Interfaces:**
- Produces: `CaptureToolSpec.kind` widens to `"note" | "decision" | "term" | "link"`. `CAPTURE_TOOL_SPECS` gains three entries, and `captureToolsFor` is unchanged: it already filters by `capture.status` kinds.

- [ ] **Step 1: Write the failing tests** in `capture-tools.test.ts`, mirroring the existing `capture_note` tests:
  - **Registration:** with `capture.status` → `{enabled: true, kinds: ["note","decision","term","link"]}`, all four tools are registered. With `kinds: ["note","term"]`, exactly `capture_note` and `propose_term` are.
  - **`propose_decision`:**
    - It sends `capture.submit` with `{kind: "decision", payload: {statement, rationale, alternatives, decidedAt: <ms>, evidence}, clientLabel}`.
    - `decidedAt: "2026-10-01T00:00:00Z"` becomes `Date.parse` of it.
    - An unparseable `decidedAt` returns `isError: true` without calling the gateway.
    - Omitted optionals are absent from the payload rather than sent as `undefined`.
  - **Success text:** each tool's text is exactly `Proposed <noun> <id>. It is NOT recorded yet: it appears nowhere until the owner runs \`nimbus captures accept <id>\`. Do not tell the user it has been recorded.`, where `<noun>` is `decision` / `glossary term` / `link`.
  - **`propose_link`:** the `relation` schema is a zod enum of the five relations.
  - **Annotations:** every spec has all four annotations `false`.

- [ ] **Step 2: Run them, and see them fail.** `bun test packages/cli/src/mcp/capture-tools.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Factor the existing submit body into a helper, and add the three specs:

```ts
type CaptureToolKind = "note" | "decision" | "term" | "link";

async function submit(
  c: IpcCallable,
  kind: CaptureToolKind,
  payload: Record<string, unknown>,
  clientLabel: () => string | undefined,
): Promise<string> {
  const params: Record<string, unknown> = { kind, payload };
  const label = clientLabel();
  if (label !== undefined) params["clientLabel"] = label;
  return idOf(await c.call<unknown>("capture.submit", params));
}

/** Copy only the keys the caller actually sent, so an omitted optional is absent, not undefined. */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

function proposed(noun: string, id: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Proposed ${noun} ${id}. It is NOT recorded yet: it appears nowhere until the owner runs \`nimbus captures accept ${id}\`. Do not tell the user it has been recorded.`,
      },
    ],
  };
}

const PROPOSAL_NOTE =
  "Stored on the user's machine (nothing leaves it), labelled agent-authored, and INERT until the " +
  "owner reviews it: it is not searchable and appears in no brief until accepted. ";
```

The three specs follow the shape of `capture_note`. They differ in:
- **`propose_decision`** (`kind: "decision"`):
  - **Schema:** `statement: z.string()`, `rationale: z.string().optional()`, `alternatives: z.array(z.string()).optional()`, `decidedAt: z.string().optional()`, `evidence: z.array(z.string()).optional()`.
  - **Description:** `"Propose a decision for the user's LOCAL Nimbus decision log. " + PROPOSAL_NOTE + "evidence takes item ids exactly as the \`id\` field a read tool returned; decidedAt is an ISO 8601 date."`
  - **`run`:**
    - Builds `pick(args, ["statement","rationale","alternatives","evidence"])`.
    - When `args["decidedAt"]` is a string, it sets `decidedAt = Date.parse(...)`.
    - When that yields `NaN`, it throws `new Error("decidedAt must be an ISO 8601 date")` inside `runTool`, which turns it into `isError`.
    - Returns `proposed("decision", id)`.
- **`propose_term`** (`kind: "term"`):
  - **Schema:** `term`, `definition`, `synonyms?`.
  - **Description:** `"Propose a glossary term for the user's LOCAL Nimbus glossary. " + PROPOSAL_NOTE + "A term the owner vetoed or defined in nimbus.toml cannot be overridden."`
  - **Result:** `proposed("glossary term", id)`.
- **`propose_link`** (`kind: "link"`):
  - **Schema:** `fromItemId`, `toItemId`, `relation: z.enum(["relates_to","fixes","caused_by","supersedes","documents"])`, `note?`.
  - **Description:** `"Propose a typed link between two indexed items in the user's LOCAL Nimbus relationship graph. " + PROPOSAL_NOTE + "Both ids must be the \`id\` field a read tool returned, and both items must be in the graph (a note captured over MCP is not)."`
  - **Result:** `proposed("link", id)`.

The schema is never stricter than the gateway, which stays authoritative. Keep `capture_note`'s text byte-identical.

- [ ] **Step 4: Run the tests.** `bun test packages/cli/src/mcp` must PASS, and so must the adapter registration test that iterates `CAPTURE_TOOL_SPECS`.

- [ ] **Step 5: Commit.** Message: `feat(mcp): propose_decision, propose_term and propose_link tools`.

---

### Task 13: `nimbus captures accept|reject`, `--limit`, native status in `show`; the agent tag in `nimbus query`

**Files:**
- Modify: `packages/cli/src/commands/captures.ts`, `captures-format.ts`, `captures.test.ts`, `captures-cmd.test.ts`
- Modify: `packages/cli/src/commands/query.ts` (`printItemCard`, ~:330) + `query.test.ts`
- Modify: the CLI help/usage registry, if `nimbus captures`' verbs are listed there. Grep for `captures revoke`.

**Interfaces:**
- `CapturesArgs`:
  - gains the verbs `"accept" | "reject"`, in the `show | revoke` arm;
  - adds `limit?: number` on `list`.
- `CaptureDetailView` gains `nativeStatus: "owned" | "superseded" | "absent" | null`.

- [ ] **Step 1: Write the failing tests.**
  - **`parseCapturesArgs`:**
    - `accept <id>` and `reject <id>` parse.
    - `accept` with no id, or with an extra argument, is `undefined`.
    - `list --limit 20` → `limit: 20`.
    - `--limit 0`, `--limit 201` and `--limit x` are `undefined`.
  - **`runCapturesWith`:**
    - `accept` calls `captures.accept {id}` and prints `Accepted <id>: it now counts as a <kind-noun> (<nativeRef>) and is labelled agent-authored.`, where `<kind-noun>` comes from the `nativeRef` shape. Use `decision` for `capture:…`; `link` when the ref contains `|`; `glossary term` otherwise.
    - `reject` calls `captures.reject` and prints `Rejected <id>. Nothing was written; the record is kept 90 days, then pruned.`
    - `--json` prints the raw result.
    - A refusal prints the code and exits 1.
    - `list --limit 20` forwards `{limit: 20}`.
  - **`formatCaptureDetail`:**
    - `nativeStatus: "superseded"` prints `Superseded: a later accepted capture or the owner's own entry now owns this; revoking this capture leaves it in place.`
    - `"absent"` prints `Native row: gone (removed since it was accepted).`
    - `"owned"` prints `Native row: present and owned by this capture.`
    - `null` prints nothing extra.
    - `parseDetail` reads `nativeStatus` and ignores an unknown value (→ `null`).
  - **`captures-cmd.test.ts`:** `runCapturesCmd(["accept","cap_1"])` succeeds through the mocked IPC fixture, and `["accept"]` exits 2 with usage.
  - **`query.test.ts`:** a row with `service: "nimbus"` and `type: "capture"` prints a meta line containing `agent-authored`. A `github` row does not.

- [ ] **Step 2: Run them, and see them fail.** `bun test packages/cli/src/commands/captures packages/cli/src/commands/query.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Usage text:** `CAPTURES_USAGE` gains `nimbus captures accept <id> [--json]` and `nimbus captures reject <id> [--json]`, plus ` [--limit 1-200]` on `list`.
  - **Arguments:** `parseCapturesArgs` treats `accept`/`reject` like `show`/`revoke`, and parses `--limit` as an integer 1..200. Otherwise the result is `undefined`.
  - **Commands:** `runCapturesWith` adds the two verbs.
  - **Display:** `formatCaptureDetail` prints the native-status line after `Item:`, and passes every agent-supplied string through `stripControl` as today.
  - **`query.ts`:** inside `printItemCard`, after the type is pushed, add:

```ts
  // An MCP capture is agent-authored text in the owner's own index (I28): say so on the card.
  if (row["service"] === "nimbus" && typeFieldIsCapture(typeField)) meta.push("agent-authored");
```

    Here `typeFieldIsCapture` is `(t: unknown) => t === "capture"`. Inline it if that is clearer.

- [ ] **Step 4: Run the tests.** `bun test packages/cli/src/commands` must PASS, and the per-file coverage of `captures.ts` / `captures-format.ts` must be ≥85% line and ≥80% branch.

- [ ] **Step 5: Commit.** Message: `feat(cli): nimbus captures accept/reject, --limit, native status; agent tag in nimbus query`.

---

### Task 14: End-to-end — propose, absent, accept, present with disclosure, revoke, gone

**Files:**
- Modify: `packages/gateway/test/e2e/mcp-capture.e2e.test.ts`

- [ ] **Step 0: Enable the proposal kinds in the e2e gateway.** `bootGateway` (`mcp-capture.e2e.test.ts:88-94`) writes `kinds = ["note"]`, and `captureToolsFor` registers a tool only for a kind `capture.status` reports. As written, the MCP server would offer no `propose_*` tool, and the `toContain("propose_decision")` assertion below would fail. Change that line to `'kinds = ["note", "decision", "term", "link"]'`. PR 1's note tests are unaffected, since `note` stays in the list. Confirm that the "sink OFF" test still asserts NO capture tool at all when `enabled = false`.

- [ ] **Step 1: Write the test** inside the existing `describe`, BEFORE the "sink OFF" test, which reboots the gateway:

```ts
  test("propose_decision → absent from `nimbus decisions` → accept → present with the agent disclosure → revoke → gone", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      for (const t of ["propose_decision", "propose_term", "propose_link"]) expect(names).toContain(t);

      const marker = `zebradecision${randomUUID().slice(0, 6)}`;
      const prop = await mcp.callTool("propose_decision", { statement: `Adopt ${marker}`, rationale: "e2e" });
      expect(prop.isError).toBe(false);
      expect(prop.text).toContain("NOT recorded yet");
      const id = /Proposed decision (cap_[A-Za-z0-9_-]+)/.exec(prop.text)?.[1];
      expect(id).toBeDefined();

      // Absent by construction while proposed.
      const before = await runCli(["decisions"]);
      expect(before.code).toBe(0);
      expect(before.stdout).not.toContain(marker);
      const searchBefore = await mcp.callTool("searchIndex", { query: marker });
      expect(searchBefore.text).not.toContain(String(id));

      const accepted = await runCli(["captures", "accept", String(id)]);
      expect(accepted.code).toBe(0);

      // POSITIVE CONTROL for the absence above: the same query now finds it, with the disclosure.
      const after = await runCli(["decisions"]);
      expect(after.stdout).toContain(marker);
      expect(after.stdout).toContain("captured via MCP, accepted by the owner");

      expect((await runCli(["captures", "revoke", String(id)])).code).toBe(0);
      const gone = await runCli(["decisions"]);
      expect(gone.stdout).not.toContain(marker);
    } finally {
      await mcp.close();
    }
  }, 180_000);

  test("propose_term → reject → listed as rejected, never in the glossary", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const term = `zebraterm${randomUUID().slice(0, 6)}`;
      const prop = await mcp.callTool("propose_term", { term, definition: "an e2e term" });
      const id = /Proposed glossary term (cap_[A-Za-z0-9_-]+)/.exec(prop.text)?.[1];
      expect((await runCli(["captures", "reject", String(id)])).code).toBe(0);
      const listed = await runCli(["captures", "list", "--state", "rejected", "--json"]);
      expect(listed.stdout).toContain(String(id));
      const glossary = await runCli(["glossary"]);
      expect(glossary.stdout).not.toContain(term);
    } finally {
      await mcp.close();
    }
  }, 180_000);
```

Check the real CLI verbs before relying on them. `nimbus decisions` and `nimbus glossary` with no arguments must print the brief to stdout under the e2e env; confirm by reading `packages/cli/src/commands/decisions.ts` and `glossary.ts`. If either needs a window flag to include a `decidedAt` = now row, pass it explicitly. The default `decidedAt` is the submit time, which falls inside any default window. If agent synthesis is configured in the e2e gateway config, keep it OFF, so the deterministic render is what's asserted.

- [ ] **Step 2: Run it.** `bun test packages/gateway/test/e2e/mcp-capture.e2e.test.ts` must PASS on Windows. Linux and macOS are verified by CI. Run `bun run audit:platform-test-gaps` and report what it names.

- [ ] **Step 3: Commit.** Message: `test(e2e): proposals over a real gateway and MCP server — absent, accept, disclose, revoke`.

---

### Task 15: Docs, final gates, PR

**Files:**
- Modify:
  - `docs/architecture.md` § Spine S3 Subsystems (capture sink): proposals, accept/reject, ownership, the V68 rebuild, D32(d), and the "never projected" ruling.
  - `docs/cli-reference.md`: `nimbus captures accept|reject`, `--limit`, the `show` native-status line, and the MCP server section (`propose_*` tools, registered per `[mcp_sink] kinds`).
  - `docs/CHANGELOG.md`: a dated entry.
  - `docs/roadmap.md`: the S3 row; PR 2 of 3 shipped.
  - `CLAUDE.md` and `GEMINI.md` S3 status prose: one sentence, mirroring each other.
- Delete: `docs/superpowers/` (strip before the PR).

- [ ] **Step 1: Scan for invisible characters.** Save this as `.superpowers/sdd/<workspace>/scan.ts` and run `bun <that>/scan.ts $(git diff --name-only origin/main...HEAD)`. It must report `invisible: 0`.

```ts
import { readFileSync } from "node:fs";
let bad = 0;
for (const p of process.argv.slice(2)) {
  let s = "";
  try { s = readFileSync(p, "utf8"); } catch { continue; }
  [...s].forEach((ch, i) => {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f) ||
        (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) { bad++; console.log(p, i, c.toString(16)); }
  });
}
console.log("invisible:", bad);
```

- [ ] **Step 2: Update the docs.** Write the doc changes listed under **Files**. Every count or enumeration you touch must be re-derived from code: MCP tool counts and the I-numbers. Then run `bun run audit:doc-refs` and `bun run audit:status-drift`.

- [ ] **Step 3: Run the gates.**
  - `bun run preflight:fast` must PASS.
  - `bun test packages/gateway packages/cli scripts --path-ignore-patterns='**/install-remote-windows.test.ts'` must report 0 failures. Record the exact counts.

- [ ] **Step 4: Strip and push.** Create `dev/asaf/s3-mcp-capture-sink-pr2-pr` from HEAD, `git rm -r docs/superpowers`, commit `chore: strip planning docs`, re-run `bun run preflight:fast`, and push.

- [ ] **Step 5: Open the PR.** Use the title from Global Constraints. The body is plain prose (balance every parenthesis: an unbalanced `(` drops the commit from release notes) and covers:
  - what it does;
  - the accept/reject/revoke rules;
  - the spec corrections that change behaviour: never projected; rebuilds keep agent rows; accept audits `not_required`; reject needs no capability;
  - V68;
  - D32(d);
  - what is NOT shipped: the act door, PR 3, which has its own spec; batch accept; and `data.delete` still not clearing `capture` rows;
  - verification, with real numbers and the platforms actually run;
  - the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line.

  Merging is the owner's call.

---

## Self-review (planner)

- **Spec coverage (each to a step):**
  - §4.2 payloads → T2 S3.
  - §4.3 no item while proposed → T7 S3, pinned by T7 S1 and T10.
  - §4.4 V68 → T1.
  - §5.1 step 8 → T7.
  - §5.2:
    - accept order → T8, T10;
    - term precondition → T6, T8;
    - link precondition → T6, T8;
    - decision row → T3, T6;
    - term row → T4, T6;
    - link edge → T5, T6;
    - reject → T8.
  - §5.3:
    - ownership-scoped revoke → T9;
    - shared triple → T9;
    - note-as-evidence → T9.
  - §5.4 disclosures → T11 (the `why` part dropped, per the corrections table).
  - §6 tools → T12. §7 IPC → T8. §8.3 CLI → T13.
  - §10:
    - I28 → T10;
    - D32(d) → T10.
  - §11:
    - V68 FK on/off → T1;
    - manual pass leaves agent rows → T4;
    - link touching a capture item → T7;
    - second accepted term → T9;
    - shared triple → T9;
    - note revoke removes evidence → T9;
    - E2E → T14.
  - §13 glossary takeover risk → T4.
- **Type consistency:**
  - `ValidatedCapture` (T2) feeds T6–T9.
  - `NativeStatus` (T6) is reused by `CaptureDetail.nativeStatus` (T9) and the CLI view (T13).
  - `writeCaptureNative`, `revokeCaptureNative` and `captureNativeStatus` are named identically in T6, T8, T9 and T10.
  - `CAPTURED_RELATION_TYPES` is defined in T2 and consumed in T5 and T6.
- **Placeholders:** comment-bodied tests in T5, T8 and T10 say exactly what to seed and assert, and the implementer writes them out. No TBDs.
