# pre-mortem PR A — V53 schema + theme extraction pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the V53 tables and the debounced background pass that mines recurring blocker themes
per service, so PR B's `nimbus pre-mortem` agent has something to read.

**Architecture:** A fourth persisted-pass subsystem in the shape of `glossary` / `decisions` /
`ownership`: discover → extract → reconcile, driven by a single-row composite watermark and a
debounced post-sync refresher wired in `platform/assemble.ts`. The pass writes
`premortem_theme` + `premortem_theme_evidence`; nothing reads them until PR B.

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:sqlite`, `bun:test`, Biome.

Design spec: `docs/superpowers/specs/2026-08-09-pre-mortem-design.md`
(+ its `-review` / `-review-response`).

> **FIXTURE RULE FOR EVERY TASK IN THIS PLAN.** Seed graph entities through the REAL
> `upsertGraphEntity` helper from `../graph/relationship-graph.ts` — never a hand-rolled
> `INSERT INTO graph_entity`. `graph_entity.id` is `deterministicGraphEntityId(type, externalId)`,
> a sha256, and is NOT the item id. A hand-rolled insert that sets `id` to the item id makes
> `graph_entity.id == item.id` true in the fixture and nowhere else, which already hid a query that
> returned nothing in production behind six green tests. `epic-services.test.ts` does this
> correctly — copy it. Any raw `INSERT OR IGNORE INTO graph_entity` still shown in the code blocks
> below is a KNOWN DEFECT in this plan's text; use the helper instead.

## Global Constraints

- **No `any`** — external/model output is `unknown`, narrowed explicitly.
- **All SQLite writes in SOURCE files go through `dbRun` / `dbExec` / `dbStmtRun`** (invariant I14,
  static rule D12). Scope verified, not assumed: the audit's `iterateSourceFiles` loads 1,154 files
  and **zero** `.test.ts` among them, and 121 existing test files use bare `db.run(` on a green
  `main`. **Test files may therefore use `db.run(` directly** — the fixtures in this plan do, and
  rewriting them to `dbRun` would be wasted work.
- **Bound parameters only, never string interpolation, in SQL** (invariant I9).
- **Any indexed third-party content reaching the model must be wrapped in `wrapToolOutput`**
  (invariant I11). The theme prompt carries ticket bodies, so this applies.
- **Schema is append-only and forward-only.** V53 is the next free version; V52 is current
  (`CURRENT_SCHEMA_VERSION` in `index/local-index.ts`). Never edit a shipped step.
- **No model call is ever required.** `use_llm = false`, or no local model, must leave the pass
  writing **zero themes** and still advancing its watermark.
- **Confidence is derived from evidence counts, never from the model's self-report.**
- Branch `dev/asafgolombek/pre-mortem`, worktree `.claude/worktrees/pre-mortem`. Paths below are
  repo-root-relative; edit them at the **worktree** absolute path.
- Run `bun run preflight:fast` before the final commit of the branch.

---

### Task 1: V53 migration — four tables

**Files:**

- Create: `packages/gateway/src/index/premortem-v53-sql.ts`
- Modify: `packages/gateway/src/index/local-index.ts` (`CURRENT_SCHEMA_VERSION` 52 → 53)
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + one `simpleStep`; **no**
  `BACKFILL_LABELS` change — see the step below)
- Test: `packages/gateway/src/index/migrations/runner.test.ts` (append)

**Interfaces:**

- Consumes: nothing.
- Produces: tables `premortem_theme`, `premortem_theme_evidence`, `premortem_pass_state`,
  `premortem_watcher_proposal`; the exported constant `PREMORTEM_V53_SQL`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/index/migrations/runner.test.ts`:

```ts
test("V53 creates the four pre-mortem tables and seeds the pass-state row", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);

  const tables = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'premortem_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  expect(tables.map((t) => t.name)).toEqual([
    "premortem_pass_state",
    "premortem_theme",
    "premortem_theme_evidence",
    "premortem_watcher_proposal",
  ]);

  // Single-row watermark, seeded so the pass never has to branch on "no row yet".
  const state = db.query(`SELECT id, watermark_ms, watermark_id FROM premortem_pass_state`).all();
  expect(state).toEqual([{ id: 1, watermark_ms: 0, watermark_id: "" }]);

  db.close();
});

test("premortem_pass_state cannot hold a second row", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  expect(() => {
    db.run(`INSERT INTO premortem_pass_state (id, watermark_ms) VALUES (2, 0)`);
  }).toThrow();
  db.close();
});

test("deleting a theme cascades its evidence", () => {
  const db = new Database(":memory:");
  // REQUIRED. SQLite defaults `foreign_keys` to OFF per connection; production
  // turns it ON in `index/local-index.ts`, but a bare `new Database` in a test
  // does not. Without this line the DELETE below leaves the evidence row and
  // this test fails while the schema is perfectly correct.
  db.run("PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 53);
  db.run(
    `INSERT INTO premortem_theme (id, service, label, normalized, status, confidence, updated_at)
     VALUES ('t1', 'acme/billing-api', 'rate limits', 'rate limits', 'extracted', 0.5, 1)`,
  );
  db.run(
    `INSERT INTO premortem_theme_evidence (theme_id, item_id, evidence_key, label, occurred_at)
     VALUES ('t1', 'jira:PROJ-1', 'jira:PROJ-1', 'PROJ-1', 1)`,
  );
  db.run(`DELETE FROM premortem_theme WHERE id = 't1'`);
  const left = db.query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence`).get() as { n: number };
  expect(left.n).toBe(0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts`
Expected: FAIL — `runIndexedSchemaMigrations(db, 53)` cannot reach 53; no `premortem_*` tables.

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/index/premortem-v53-sql.ts`:

```ts
/**
 * V53 — pre-mortem theme extraction (Spine S1).
 *
 * `premortem_theme.id` is CONTENT-DERIVED = hash(service, normalized label), never positional.
 * A positional key would re-hash every later theme when text earlier in a document changes,
 * orphaning accumulated evidence rows and re-spending the extraction budget on a theme already
 * mined.
 *
 * `premortem_pass_state` carries a COMPOSITE cursor for the same reason `decision_pass_state`
 * does: `watermark_ms` alone cannot express "resume inside a group of items sharing one
 * `modified_at`", and a bulk import stamping thousands of rows with one job-level timestamp makes
 * that ordinary. `watermark_id` breaks the tie on `item.id`, a primary key and therefore total.
 *
 * `premortem_watcher_proposal` is written by PR B, not by the pass — the table lands here because
 * schema precedes its reader. It records every watcher id pre-mortem has proposed, so an id
 * present here but ABSENT from `watcher` is one the user deleted deliberately and must never be
 * re-created.
 */
export const PREMORTEM_V53_SQL = `
CREATE TABLE IF NOT EXISTS premortem_theme (
  id            TEXT PRIMARY KEY,
  service       TEXT NOT NULL,
  label         TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('extracted','demoted')),
  confidence    REAL NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_premortem_theme_service_norm
  ON premortem_theme(service, normalized);
CREATE INDEX IF NOT EXISTS idx_premortem_theme_service_status
  ON premortem_theme(service, status, confidence DESC);

CREATE TABLE IF NOT EXISTS premortem_theme_evidence (
  theme_id     TEXT NOT NULL REFERENCES premortem_theme(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  label        TEXT NOT NULL,
  url          TEXT,
  occurred_at  INTEGER,
  PRIMARY KEY (theme_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS idx_premortem_evidence_theme
  ON premortem_theme_evidence(theme_id);
CREATE INDEX IF NOT EXISTS idx_premortem_evidence_item
  ON premortem_theme_evidence(item_id);

CREATE TABLE IF NOT EXISTS premortem_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO premortem_pass_state (id, watermark_ms, watermark_id) VALUES (1, 0, '');

CREATE TABLE IF NOT EXISTS premortem_watcher_proposal (
  watcher_id  TEXT PRIMARY KEY,
  epic_item_id TEXT NOT NULL,
  risk_kind   TEXT NOT NULL,
  service     TEXT NOT NULL,
  proposed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_premortem_proposal_epic
  ON premortem_watcher_proposal(epic_item_id);
`;
```

In `packages/gateway/src/index/local-index.ts`, change the constant:

```ts
export const CURRENT_SCHEMA_VERSION = 53;
```

In `packages/gateway/src/index/migrations/runner.ts`, add the import beside the other `*-sql.ts`
imports:

```ts
import { PREMORTEM_V53_SQL } from "../premortem-v53-sql.ts";
```

Append to `INDEXED_SCHEMA_STEPS`, immediately after the `{ fromVersion: 51, toVersion: 52, ... }`
entry:

```ts
  simpleStep(52, 53, "premortem theme extraction tables", PREMORTEM_V53_SQL),
```

**Do NOT touch `BACKFILL_LABELS`.** An earlier draft of this plan said to append a label here; that
was wrong. `runner.ts` carries an explicit comment above that array — *"BACKFILL_LABELS
intentionally stops at v37 ... Do NOT append a label per new migration or that error branch becomes
unreachable"* — and `runner.test.ts` pins the missing-label throw to v38. Appending would turn a
passing pinned test red and make the error branch unreachable. The array stays at 37 entries.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts`
Expected: PASS — including every pre-existing migration test. Several assert the current schema
version; if one fails on `52`, update it to `53`, and **only** those.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/premortem-v53-sql.ts packages/gateway/src/index/local-index.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/runner.test.ts
git commit -m "feat(gateway): V53 pre-mortem theme tables"
```

---

### Task 2: Theme identity — normalization and content-derived id

Pure functions, no I/O, so the tricky semantics get tested once. Normalization deliberately does
**not** stem or fold synonyms: merging "rate limit" with "rate limiting" is fine, but folding
"timeout" into "latency" would silently merge distinct blockers.

**Files:**

- Create: `packages/gateway/src/premortem/theme-identity.ts`
- Create: `packages/gateway/src/premortem/theme-identity.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `normalizeThemeLabel(raw: string): string`
  - `themeId(service: string, rawLabel: string): string`
  - `const THEME_CONFIDENCE_CEILING = 0.86`
  - `themeConfidence(evidenceCount: number): number`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/theme-identity.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  normalizeThemeLabel,
  THEME_CONFIDENCE_CEILING,
  themeConfidence,
  themeId,
} from "./theme-identity.ts";

test("normalization collapses case, whitespace and edge punctuation", () => {
  expect(normalizeThemeLabel("Rate limits.")).toBe("rate limits");
  expect(normalizeThemeLabel("rate  limits")).toBe("rate limits");
  expect(normalizeThemeLabel("  RATE LIMITS  ")).toBe("rate limits");
  expect(normalizeThemeLabel("“rate limits”")).toBe("rate limits");
});

test("normalization does NOT stem or fold synonyms", () => {
  // Deliberate: folding distinct blockers together would destroy the signal the
  // agent exists to surface. If these ever converge, the contract has drifted.
  expect(normalizeThemeLabel("timeout")).not.toBe(normalizeThemeLabel("latency"));
  expect(normalizeThemeLabel("rate limit")).not.toBe(normalizeThemeLabel("rate limiting"));
});

test("the id is content-derived: same service+label always yields the same id", () => {
  expect(themeId("billing-api", "Rate limits.")).toBe(themeId("billing-api", "rate  limits"));
});

test("the id is service-scoped: the same label in two services is two themes", () => {
  expect(themeId("billing-api", "rate limits")).not.toBe(themeId("payments", "rate limits"));
});

test("different labels under one service are different themes", () => {
  expect(themeId("billing-api", "rate limits")).not.toBe(themeId("billing-api", "review drag"));
});

test("a digit-only service and label cannot collide across the boundary", () => {
  // Length prefixes alone are NOT self-terminating: with an undelimited decimal
  // prefix, ("1","1".repeat(11)) and ("1".repeat(11),"1") both encode to fifteen
  // '1' characters. The ":" terminator closes that class.
  expect(themeId("1", "1".repeat(11))).not.toBe(themeId("1".repeat(11), "1"));
});

test("a shifted boundary between service and label does not collide", () => {
  // A naive `service + separator + label` join is ambiguous, because a
  // normalized label legitimately contains internal spaces. These two pairs
  // would hash identically under that construction, and since this value is
  // `premortem_theme.id`'s PRIMARY KEY, the collision would merge two distinct
  // themes' evidence into one row.
  expect(themeId("x y", "z")).not.toBe(themeId("x", "y z"));
});

test("confidence rises with corroboration and never reaches 1.0", () => {
  // No connector indexes ticket comments (#1128 fetches summary/description/
  // status/dates only), so a blocker argued out entirely in a comment thread is
  // invisible to this pass. Presenting a full-marks scale the user cannot reach
  // is the anti-pattern decisions' 0.86 ceiling exists to avoid.
  expect(themeConfidence(1)).toBeLessThan(themeConfidence(2));
  expect(themeConfidence(2)).toBeLessThan(themeConfidence(5));
  expect(themeConfidence(1000)).toBeLessThanOrEqual(THEME_CONFIDENCE_CEILING);
  expect(THEME_CONFIDENCE_CEILING).toBe(0.86);
});

test("zero evidence is zero confidence, not a floor", () => {
  expect(themeConfidence(0)).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/theme-identity.test.ts`
Expected: FAIL — `Cannot find module './theme-identity.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/theme-identity.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * Identity and confidence for a recurring blocker theme.
 *
 * Normalization is deliberately shallow — case, whitespace and surrounding
 * punctuation only. Stemming or synonym-folding would merge "timeout" with
 * "latency", destroying exactly the distinction a reader needs.
 */

/** Matched at either end only, so internal punctuation ("2xx/5xx") survives. */
const EDGE_PUNCTUATION = /^[\s"'“”‘’.,;:!?()[\]-]+|[\s"'“”‘’.,;:!?()[\]-]+$/g;

export function normalizeThemeLabel(raw: string): string {
  return raw.replace(EDGE_PUNCTUATION, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Content-derived, never positional: a typo fix earlier in a source document
 * must not re-hash this theme and orphan its accumulated evidence rows.
 * Service-scoped, because "rate limits" on `billing-api` and on `search` are
 * two different findings.
 */
export function themeId(service: string, rawLabel: string): string {
  const normalized = normalizeThemeLabel(rawLabel);
  const h = createHash("sha256");
  // LENGTH-PREFIXED AND TERMINATED. Two collision classes were found here, one
  // round apart, and both merged distinct themes under one PRIMARY KEY:
  //   1. A bare `service + " " + label` join is ambiguous because a normalized
  //      label legitimately contains internal spaces —
  //      ("x y","z") and ("x","y z") hashed identically.
  //   2. A length prefix ALONE is not self-terminating when the data is
  //      digit-leading — ("1","1"x11) and ("1"x11,"1") both encode to fifteen
  //      '1' characters.
  // The ":" terminator closes (2): digits and ":" are disjoint, so the prefix
  // ends unambiguously for every possible input. Do not "simplify" it away.
  h.update(`${String(service.length)}:`);
  h.update(service);
  h.update(`${String(normalized.length)}:`);
  h.update(normalized);
  return h.digest("hex").slice(0, 32);
}

/**
 * Ceiling, not a cap applied at the end: no connector indexes ticket comments,
 * so this pass is structurally blind to a blocker argued out entirely in a
 * comment thread. Mirrors `decisions`' 0.86 for the same class of reason.
 */
export const THEME_CONFIDENCE_CEILING = 0.86;

/**
 * Derived from corroboration COUNT — never from the model's self-report, which
 * is the rule `decisions` established. Saturating, so one loud epic cannot
 * outrank four quiet corroborating ones.
 */
export function themeConfidence(evidenceCount: number): number {
  if (evidenceCount <= 0) {
    return 0;
  }
  return THEME_CONFIDENCE_CEILING * (1 - 1 / (1 + evidenceCount));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/theme-identity.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/theme-identity.ts packages/gateway/src/premortem/theme-identity.test.ts
git commit -m "feat(gateway): pre-mortem theme identity and confidence helpers"
```

---

### Task 3: Theme store

**Files:**

- Create: `packages/gateway/src/premortem/theme-store.ts`
- Create: `packages/gateway/src/premortem/theme-store.test.ts`

**Interfaces:**

- Consumes: `themeId`, `normalizeThemeLabel`, `themeConfidence` (Task 2).
- Produces:
  - `type PremortemTheme = { id: string; service: string; label: string; status: "extracted" | "demoted"; confidence: number; evidenceCount: number; lastSeenAt: number }`
  - `type ThemeEvidenceInput = { itemId: string; evidenceKey: string; label: string; url?: string; occurredAt?: number }`
  - `upsertTheme(db, input: { service: string; label: string; nowMs: number; evidence: readonly ThemeEvidenceInput[] }): string`
  - `themesForServices(db, services: readonly string[]): PremortemTheme[]`
  - `readPassState(db): { watermarkMs: number; watermarkId: string }`
  - `writePassState(db, s: { watermarkMs: number; watermarkId: string; nowMs: number; newThemes: number; scanned: number }): void`
  - `pruneOrphanedEvidence(db): number`
  - `demoteThemesWithNoLiveEvidence(db, nowMs: number): number`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/theme-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  demoteThemesWithNoLiveEvidence,
  pruneOrphanedEvidence,
  readPassState,
  themesForServices,
  upsertTheme,
  writePassState,
} from "./theme-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  // Evidence liveness is checked against `item`, so seed one real row.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES ('jira:PROJ-1', 'jira', 'issue', 'PROJ-1', 'T', 1, 1, 0)`,
  );
  return db;
}

test("upsert is idempotent on (service, normalized label) and accumulates evidence", () => {
  const db = freshDb();
  const a = upsertTheme(db, {
    service: "acme/billing-api",
    label: "Rate limits.",
    nowMs: 100,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-1", label: "PROJ-1" }],
  });
  const b = upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate  limits",
    nowMs: 200,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-2", label: "PROJ-2" }],
  });
  expect(b).toBe(a);

  const [theme] = themesForServices(db, ["acme/billing-api"]);
  expect(theme?.evidenceCount).toBe(2);
  // Confidence tracks the accumulated count, not the last write.
  expect(theme?.confidence).toBeGreaterThan(0);
  expect(theme?.lastSeenAt).toBe(200);
  db.close();
});

test("re-supplying the same evidence key does not inflate the count", () => {
  const db = freshDb();
  const ev = [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-1", label: "PROJ-1" }];
  upsertTheme(db, { service: "acme/billing-api", label: "rate limits", nowMs: 1, evidence: ev });
  upsertTheme(db, { service: "acme/billing-api", label: "rate limits", nowMs: 2, evidence: ev });
  const [theme] = themesForServices(db, ["acme/billing-api"]);
  expect(theme?.evidenceCount).toBe(1);
  db.close();
});

test("themesForServices is service-scoped and skips demoted rows", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k1", label: "PROJ-1" }],
  });
  upsertTheme(db, {
    service: "search",
    label: "index rebuilds",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k2", label: "PROJ-1" }],
  });
  expect(themesForServices(db, ["acme/billing-api"]).map((t) => t.service)).toEqual(["acme/billing-api"]);
  expect(themesForServices(db, ["acme/billing-api", "search"])).toHaveLength(2);
  expect(themesForServices(db, [])).toEqual([]);
  db.close();
});

test("a theme whose every source item is gone is demoted, not deleted", () => {
  // Demote rather than delete: the row is the durable record of extraction
  // budget already spent, and deleting it would re-mine the same theme on the
  // next pass.
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:GONE", evidenceKey: "k1", label: "GONE" }],
  });
  const demoted = demoteThemesWithNoLiveEvidence(db, 500);
  expect(demoted).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  const row = db.query(`SELECT status FROM premortem_theme`).get() as { status: string };
  expect(row.status).toBe("demoted");
  db.close();
});

test("a theme with at least one live source survives the sweep", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [
      { itemId: "jira:GONE", evidenceKey: "k1", label: "GONE" },
      { itemId: "jira:PROJ-1", evidenceKey: "k2", label: "PROJ-1" },
    ],
  });
  expect(demoteThemesWithNoLiveEvidence(db, 500)).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);
  db.close();
});

test("pruning removes dead evidence rows and lowers the theme's confidence", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [
      { itemId: "jira:PROJ-1", evidenceKey: "k1", label: "live" },
      { itemId: "jira:GONE", evidenceKey: "k2", label: "dead" },
    ],
  });
  const before = themesForServices(db, ["acme/billing-api"])[0]?.confidence ?? 0;

  expect(pruneOrphanedEvidence(db)).toBe(1);

  const after = themesForServices(db, ["acme/billing-api"])[0];
  expect(after?.evidenceCount).toBe(1);
  // Corroboration the user can no longer inspect must not still be counted.
  expect(after?.confidence).toBeLessThan(before);
  db.close();
});

test("pruning is a no-op when every source is live", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k1", label: "live" }],
  });
  expect(pruneOrphanedEvidence(db)).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])[0]?.evidenceCount).toBe(1);
  db.close();
});

test("pass state round-trips the composite watermark", () => {
  const db = freshDb();
  expect(readPassState(db)).toEqual({ watermarkMs: 0, watermarkId: "" });
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "jira:PROJ-9",
    nowMs: 100,
    newThemes: 3,
    scanned: 7,
  });
  expect(readPassState(db)).toEqual({ watermarkMs: 42, watermarkId: "jira:PROJ-9" });
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/theme-store.test.ts`
Expected: FAIL — `Cannot find module './theme-store.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/theme-store.ts`:

```ts
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { normalizeThemeLabel, themeConfidence, themeId } from "./theme-identity.ts";

export type PremortemTheme = {
  id: string;
  service: string;
  label: string;
  status: "extracted" | "demoted";
  confidence: number;
  evidenceCount: number;
  lastSeenAt: number;
};

export type ThemeEvidenceInput = {
  itemId: string;
  evidenceKey: string;
  label: string;
  url?: string;
  occurredAt?: number;
};

/**
 * Insert-or-accumulate on `(service, normalized label)`. Evidence rows carry a
 * composite primary key, so re-supplying one is a no-op rather than a duplicate
 * — which is what keeps confidence honest across repeated passes.
 */
export function upsertTheme(
  db: Database,
  input: {
    service: string;
    label: string;
    nowMs: number;
    evidence: readonly ThemeEvidenceInput[];
  },
): string {
  const id = themeId(input.service, input.label);
  const normalized = normalizeThemeLabel(input.label);

  dbRun(
    db,
    `INSERT INTO premortem_theme
       (id, service, label, normalized, status, confidence, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, 'extracted', 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status       = 'extracted',
       last_seen_at = excluded.last_seen_at,
       updated_at   = excluded.updated_at`,
    [id, input.service, input.label, normalized, input.nowMs, input.nowMs, input.nowMs],
  );

  for (const e of input.evidence) {
    dbRun(
      db,
      `INSERT OR IGNORE INTO premortem_theme_evidence
         (theme_id, item_id, evidence_key, label, url, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, e.itemId, e.evidenceKey, e.label, e.url ?? null, e.occurredAt ?? null],
    );
  }

  // Recompute from the stored count so confidence reflects total corroboration,
  // never just this pass's contribution.
  const row = db
    .query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence WHERE theme_id = ?`)
    .get(id) as { n: number };
  dbRun(db, `UPDATE premortem_theme SET confidence = ? WHERE id = ?`, [
    themeConfidence(row.n),
    id,
  ]);

  return id;
}

export function themesForServices(db: Database, services: readonly string[]): PremortemTheme[] {
  if (services.length === 0) {
    return [];
  }
  // I9: one bound placeholder per service; the list is never interpolated.
  const placeholders = services.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT t.id, t.service, t.label, t.status, t.confidence, t.last_seen_at,
              (SELECT COUNT(*) FROM premortem_theme_evidence e WHERE e.theme_id = t.id) AS n
         FROM premortem_theme t
        WHERE t.status = 'extracted' AND t.service IN (${placeholders})
        ORDER BY t.confidence DESC, t.label ASC`,
    )
    .all(...services) as Array<{
    id: string;
    service: string;
    label: string;
    status: string;
    confidence: number;
    last_seen_at: number;
    n: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    label: r.label,
    status: r.status === "demoted" ? "demoted" : "extracted",
    confidence: r.confidence,
    evidenceCount: r.n,
    lastSeenAt: r.last_seen_at,
  }));
}

export function readPassState(db: Database): { watermarkMs: number; watermarkId: string } {
  const row = db
    .query(`SELECT watermark_ms, watermark_id FROM premortem_pass_state WHERE id = 1`)
    .get() as { watermark_ms: number; watermark_id: string } | undefined;
  return { watermarkMs: row?.watermark_ms ?? 0, watermarkId: row?.watermark_id ?? "" };
}

export function writePassState(
  db: Database,
  s: { watermarkMs: number; watermarkId: string; nowMs: number; newThemes: number; scanned: number },
): void {
  dbRun(
    db,
    `UPDATE premortem_pass_state
        SET watermark_ms = ?, watermark_id = ?, last_pass_at = ?,
            last_pass_new = ?, scanned_items = ?
      WHERE id = 1`,
    [s.watermarkMs, s.watermarkId, s.nowMs, s.newThemes, s.scanned],
  );
}

/**
 * Delete evidence whose source item has left the index, and recompute the
 * confidence of every theme that lost a row.
 *
 * There is no foreign key from `premortem_theme_evidence.item_id` to `item(id)`
 * — items are synced and pruned dynamically — so without this sweep dead rows
 * accumulate forever behind every removed item. It also keeps confidence
 * honest: corroboration the user can no longer inspect should not still be
 * counted toward it.
 *
 * KNOWN LIMIT, accepted deliberately: an item that is pruned and later
 * re-synced UNCHANGED keeps its original `modified_at`, so it lands behind the
 * watermark and is never re-mined — its evidence does not come back, and the
 * theme's confidence stays permanently lower. The alternative (keeping dead
 * rows forever so a hypothetical restore works) overstates corroboration in
 * the common case to protect the rare one.
 */
export function pruneOrphanedEvidence(db: Database): number {
  const orphans = db
    .query(
      `SELECT e.theme_id AS theme_id, e.evidence_key AS evidence_key
         FROM premortem_theme_evidence e
        WHERE NOT EXISTS (SELECT 1 FROM item i WHERE i.id = e.item_id)`,
    )
    .all() as Array<{ theme_id: string; evidence_key: string }>;
  if (orphans.length === 0) {
    return 0;
  }

  const touched = new Set<string>();
  for (const o of orphans) {
    dbRun(
      db,
      `DELETE FROM premortem_theme_evidence WHERE theme_id = ? AND evidence_key = ?`,
      [o.theme_id, o.evidence_key],
    );
    touched.add(o.theme_id);
  }

  for (const themeIdValue of touched) {
    const row = db
      .query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence WHERE theme_id = ?`)
      .get(themeIdValue) as { n: number };
    dbRun(db, `UPDATE premortem_theme SET confidence = ? WHERE id = ?`, [
      themeConfidence(row.n),
      themeIdValue,
    ]);
  }
  return orphans.length;
}

/**
 * Demote — never delete — a theme whose every source item has left the index.
 * The row is the durable record of extraction budget already spent; deleting it
 * would re-mine the identical theme on the next pass.
 */
export function demoteThemesWithNoLiveEvidence(db: Database, nowMs: number): number {
  const stale = db
    .query(
      `SELECT t.id FROM premortem_theme t
        WHERE t.status = 'extracted'
          AND NOT EXISTS (
            SELECT 1 FROM premortem_theme_evidence e
              JOIN item i ON i.id = e.item_id
             WHERE e.theme_id = t.id
          )`,
    )
    .all() as Array<{ id: string }>;
  for (const s of stale) {
    dbRun(db, `UPDATE premortem_theme SET status = 'demoted', updated_at = ? WHERE id = ?`, [
      nowMs,
      s.id,
    ]);
  }
  return stale.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/theme-store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/theme-store.ts packages/gateway/src/premortem/theme-store.test.ts
git commit -m "feat(gateway): pre-mortem theme store with evidence-derived confidence"
```

---

### Task 4: `[premortem]` config section

> **CORRECTION (found in review, fix round 1).** The code below originally specified
> `parseNimbusPremortemToml(raw: unknown)` treating the input as an already-parsed object. That is
> WRONG for this file. `loadTomlSection` is typed `parse: (raw: string) => T` and passes
> `readFileSync(path, "utf8")` — the raw TOML **text**. An object-shaped parser therefore returns
> defaults for every real config file, silently discarding the whole section, and it TYPECHECKS
> because a function taking `unknown` is assignable where `(raw: string)` is expected. Follow the
> neighbouring `parseNimbusOwnershipToml`: take `raw: string`, drive it with
> `forEachSectionEntry(raw, "[premortem]", ...)` plus a private `applyNimbusPremortemKey`, and use
> the file's own `parseBool` / `parseIntWithMin(valRaw, 1)` value helpers. Test through
> `loadNimbusPremortemFromConfigDir` with a real temp-dir `nimbus.toml`, not by calling the parser
> with an object literal — that shortcut is exactly what hid this.

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts` (append a section after the `[ownership]`
  block, following its exact shape)
- Modify: `packages/gateway/src/config/nimbus-toml.test.ts` (append)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type NimbusPremortemToml = { enabled: boolean; debounceMs: number; useLlm: boolean; maxLlmCallsPerPass: number; retryCooldownMs: number; maxCohortSize: number; maxCandidateScan: number }`
  - `const DEFAULT_NIMBUS_PREMORTEM_TOML: NimbusPremortemToml`
  - `parseNimbusPremortemToml(raw: unknown): NimbusPremortemToml`
  - `loadNimbusPremortemFromConfigDir(configDir: string): NimbusPremortemToml`

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/config/nimbus-toml.test.ts`:

```ts
test("[premortem] defaults are the documented ones", () => {
  expect(DEFAULT_NIMBUS_PREMORTEM_TOML).toEqual({
    enabled: true,
    debounceMs: 60_000,
    useLlm: true,
    maxLlmCallsPerPass: 25,
    retryCooldownMs: 3_600_000,
    maxCohortSize: 10,
    maxCandidateScan: 200,
  });
});

test("[premortem] parses overrides and ignores unknown keys", () => {
  const parsed = parseNimbusPremortemToml({
    enabled: false,
    max_cohort_size: 4,
    max_candidate_scan: 50,
    nonsense: "ignored",
  });
  expect(parsed.enabled).toBe(false);
  expect(parsed.maxCohortSize).toBe(4);
  expect(parsed.maxCandidateScan).toBe(50);
  // Untouched keys keep their defaults.
  expect(parsed.useLlm).toBe(true);
});

test("[premortem] rejects a non-positive bound rather than silently clamping", () => {
  // These bound real work: max_candidate_scan = 0 would silently produce an
  // empty cohort that reads as "no comparable epics" — a wrong answer, not an
  // empty one.
  expect(parseNimbusPremortemToml({ max_candidate_scan: 0 }).maxCandidateScan).toBe(200);
  expect(parseNimbusPremortemToml({ max_cohort_size: -3 }).maxCohortSize).toBe(10);
  expect(parseNimbusPremortemToml({ max_cohort_size: "ten" }).maxCohortSize).toBe(10);
});
```

Add `DEFAULT_NIMBUS_PREMORTEM_TOML` and `parseNimbusPremortemToml` to that file's existing import
list from `./nimbus-toml.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts`
Expected: FAIL — the two symbols do not exist.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/gateway/src/config/nimbus-toml.ts`, after the `[ownership]` section:

```ts
// ---------------------------------------------------------------------------
// [premortem] — recurring blocker theme extraction pass (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusPremortemToml = {
  /** Default ON, like [glossary]/[decisions]/[ownership]. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** When false the pass runs but writes zero themes; structural risks are unaffected. */
  useLlm: boolean;
  /** Hard ceiling on model calls per pass. */
  maxLlmCallsPerPass: number;
  /** Cooldown before a failed extraction is retried. */
  retryCooldownMs: number;
  /** Cap on the cohort PR B assembles. */
  maxCohortSize: number;
  /** Cap on closed epics scanned for a service set before the cohort lane stops. */
  maxCandidateScan: number;
};

export const DEFAULT_NIMBUS_PREMORTEM_TOML: NimbusPremortemToml = {
  enabled: true,
  debounceMs: 60_000,
  useLlm: true,
  maxLlmCallsPerPass: 25,
  retryCooldownMs: 3_600_000,
  maxCohortSize: 10,
  maxCandidateScan: 200,
};

/**
 * A malformed or non-positive bound falls back to its default rather than
 * clamping to zero: `max_candidate_scan = 0` would yield an empty cohort that
 * reads as "no comparable epics ever closed", which is a wrong answer rather
 * than an empty one.
 */
function positiveIntOr(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

export function parseNimbusPremortemToml(raw: unknown): NimbusPremortemToml {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_NIMBUS_PREMORTEM_TOML };
  }
  const rec = raw as Record<string, unknown>;
  const d = DEFAULT_NIMBUS_PREMORTEM_TOML;
  return {
    enabled: typeof rec["enabled"] === "boolean" ? rec["enabled"] : d.enabled,
    debounceMs: positiveIntOr(rec["debounce_ms"], d.debounceMs),
    useLlm: typeof rec["use_llm"] === "boolean" ? rec["use_llm"] : d.useLlm,
    maxLlmCallsPerPass: positiveIntOr(rec["max_llm_calls_per_pass"], d.maxLlmCallsPerPass),
    retryCooldownMs: positiveIntOr(rec["retry_cooldown_ms"], d.retryCooldownMs),
    maxCohortSize: positiveIntOr(rec["max_cohort_size"], d.maxCohortSize),
    maxCandidateScan: positiveIntOr(rec["max_candidate_scan"], d.maxCandidateScan),
  };
}

export function loadNimbusPremortemFromConfigDir(configDir: string): NimbusPremortemToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_PREMORTEM_TOML,
    parseNimbusPremortemToml,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts
git commit -m "feat(gateway): [premortem] config section"
```

---

### Task 5: Affected-service resolution

> **CORRECTION (found in review, fix round 1).** Two further errors were in the original text here.
> (a) `graph_relation.to_id` is a `graph_entity.id`, which is
> `deterministicGraphEntityId(type, externalId)` = a sha256 — **never** the `item.id`. Joining
> `res.to_id = child.id` therefore matched nothing in production. The child side must go through
> `graph_entity` on `type` + `external_id`, the precedent `agents/impact.ts` already follows.
> (b) The child lookup needs scoping by the epic's own `service`, or two trackers colliding on a
> bare key like `PROJ-1` merge an unrelated epic's services.
> **And the tests hid (a):** the fixture inserted `graph_entity.id` = the raw item id, making the
> two coincide only in the fixture. Mint fixture entities with the real `upsertGraphEntity`, never a
> hand-rolled INSERT — this same fixture-shape trap has now concealed three separate defects in
> this plan. for an epic

**The axis everything else depends on.** A theme's `service` is the **affected** service the work
touched (`billing-api`), derived through the graph — **not** the connector that owns the row
(`jira`). Storing the connector service would make PR B's Lane 4, which matches themes against a
cohort's affected services, return zero rows for every epic while looking perfectly healthy.

Shared deliberately: PR B's Lane 1 (target services) and Lane 2 (candidate services) call this same
function, so the two halves can never drift onto different definitions of "service".

**Files:**

- Create: `packages/gateway/src/premortem/epic-services.ts`
- Create: `packages/gateway/src/premortem/epic-services.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `affectedServicesForEpic(db, epicItemId: string, epicKey: string): string[]` — sorted,
  de-duplicated, `[]` when nothing resolves.

The traversal is: epic → children (`item.metadata.parent_key = epicKey`, from #1128) → each child's
**incoming** `resolves` edges (the graph stores `PR --resolves--> issue`) → **the PR entity's
`metadata.repo`**, giving a repo full name such as `acme/billing-api`.

**The last hop is a JSON field on the PR entity, NOT an `in_repo` edge.** This was verified against
`graph/graph-populator.ts` rather than assumed: `syncPrGraph` builds the PR entity with
`metadata: { repo: repoFull }`, while `in_repo` edges are written only for **commits** and **files**
and point at a *workspace*, never for pull requests. A traversal through `in_repo` would return `[]`
for every epic in a real index while passing any test that seeded its own edges.

**A theme's service key is therefore a repo full name** (`acme/billing-api`), not an abstract
service name. Accepted deliberately: it needs no configuration and works on any index today. The
cost is that a monorepo collapses every epic into one bucket, and PR B's brief must print whatever
key it actually used rather than implying a curated service catalogue exists.

`repoFull` can be absent on a PR whose metadata carried no repo path, so a `NULL` extract is skipped
rather than becoming a `"null"` service.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/epic-services.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { affectedServicesForEpic } from "./epic-services.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

function addItem(db: Database, id: string, externalId: string, metadata: object): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, 1, 1, 0)`,
    [id, externalId, JSON.stringify(metadata)],
  );
}

/**
 * Real `graph_entity` columns (graph-v7-sql.ts): id, type, external_id, label,
 * service, metadata — there is NO `kind` column and `external_id` is NOT NULL.
 * A PR entity carries its repo as `metadata.repo`, which is the hop this
 * traversal reads.
 */
function addEntity(db: Database, id: string, type: string, repo?: string): void {
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, 'github', ?)`,
    [id, type, id, id, repo === undefined ? null : JSON.stringify({ repo })],
  );
}

/** Real `graph_relation` columns: from_id, to_id, type, weight, metadata, created_at. */
function addRelation(db: Database, from: string, to: string, type: string): void {
  db.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, 1)`,
    [from, to, type],
  );
}

test("derives services through children -> resolving PRs -> the PR's repo", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, "github:pr:7", "jira:PROJ-2", "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("merges and sorts services across several children", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  for (const [child, pr, repo] of [
    ["jira:PROJ-2", "github:pr:7", "acme/billing-api"],
    ["jira:PROJ-3", "github:pr:8", "acme/payments-worker"],
    ["jira:PROJ-4", "github:pr:9", "acme/billing-api"],
  ] as const) {
    addItem(db, child, child.split(":")[1] ?? child, { meta_v: 1, parent_key: "PROJ-1" });
    addEntity(db, child, "issue");
    addEntity(db, pr, "pr", repo);
    addRelation(db, pr, child, "resolves");
  }
  // Sorted and de-duplicated: the caller compares these sets, so a stable
  // order keeps cohort ranking deterministic across runs.
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([
    "acme/billing-api",
    "acme/payments-worker",
  ]);
  db.close();
});

test("a PR with no repo in its metadata contributes nothing, not a null service", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  addEntity(db, "github:pr:7", "pr"); // no repo
  addRelation(db, "github:pr:7", "jira:PROJ-2", "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("an epic with no children resolves to no services", () => {
  // The brand-new-epic case. PR B turns this into a named gap and the
  // `--service` prompt; it must never look like an answer.
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("children whose PRs never referenced them resolve to no services", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("a child of a DIFFERENT epic is not counted", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:OTHER-9", "OTHER-9", { meta_v: 1, parent_key: "OTHER-1" });
  addEntity(db, "jira:OTHER-9", "issue");
  addEntity(db, "github:pr:7", "pr", "acme/search");
  addRelation(db, "github:pr:7", "jira:OTHER-9", "resolves");
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/epic-services.test.ts`
Expected: FAIL — `Cannot find module './epic-services.ts'`

If instead it fails on `no such table: graph_entity` / `graph_relation`, or on a missing column,
open `packages/gateway/src/index/graph-v7-sql.ts` and match the real column names in the two
helpers — the graph schema is the source of truth, not this plan's fixture.

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/epic-services.ts`:

```ts
import type { Database } from "bun:sqlite";

/**
 * The AFFECTED services an epic touched — `billing-api`, not `jira`.
 *
 * This is the single definition of "service" for pre-mortem. The theme pass
 * writes themes under these values and PR B's cohort lanes read them back, so
 * a second, divergent definition anywhere would leave every theme lookup
 * matching zero rows while both halves looked individually correct.
 *
 * Traversal: epic → children (`metadata.parent_key`, #1128) → each child's
 * INCOMING `resolves` edges (the graph stores `PR --resolves--> issue`) → the
 * PR ENTITY's `metadata.repo`, e.g. `acme/billing-api`.
 *
 * The last hop is a JSON field, NOT an `in_repo` edge: `graph-populator.ts`
 * writes `in_repo` only for commits and files (pointing at a workspace), never
 * for pull requests, so an edge traversal would return [] on every real index
 * while passing any test that seeded its own edges.
 *
 * Returns `[]` rather than guessing when any hop is missing. A brand-new epic
 * legitimately has no children, and PR B turns the empty result into a named
 * gap plus the `--service` prompt — never into a silently weaker cohort.
 */
export function affectedServicesForEpic(
  db: Database,
  epicItemId: string,
  epicKey: string,
): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(pr.metadata, '$.repo') AS service
         FROM item child
         JOIN graph_entity   child_ent ON child_ent.type = 'issue'
                                       AND child_ent.external_id = child.id
         JOIN graph_relation res       ON res.to_id = child_ent.id AND res.type = 'resolves'
         JOIN graph_entity   pr        ON pr.id     = res.from_id
        WHERE json_extract(child.metadata, '$.parent_key') = ?
          AND child.id <> ?
          AND child.service = (SELECT service FROM item WHERE id = ?)
          AND json_extract(pr.metadata, '$.repo') IS NOT NULL
        ORDER BY service ASC`,
    )
    .all(epicKey, epicItemId, epicItemId) as Array<{ service: string }>;
  return rows.map((r) => r.service);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/epic-services.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/epic-services.ts packages/gateway/src/premortem/epic-services.test.ts
git commit -m "feat(gateway): derive an epic's affected services through the graph"
```

---

### Task 6: Discover stage — bounded scan of closed epics per service

**Files:**

- Create: `packages/gateway/src/premortem/theme-discover.ts`
- Create: `packages/gateway/src/premortem/theme-discover.test.ts`

**Interfaces:**

- Consumes: `readPassState` (Task 3).
- Produces:
  - `type DiscoveredEpic = { itemId: string; epicKey: string; title: string; body: string; bodyComplete: boolean; resolvedAtMs?: number; modifiedAt: number }`
  - `discoverClosedEpics(db, opts: { watermarkMs: number; watermarkId: string; batchSize: number }): DiscoveredEpic[]`

**`DiscoveredEpic` deliberately carries no `service` field.** A theme's service is the *affected*
service from Task 5, never the connector (`jira`) that owns the row. Exposing `item.service` here
would invite exactly that mix-up, and it is the one that silently empties every theme lookup in
PR B.

`epicKey` is the ticket key (`PROJ-1`) that children point at via `metadata.parent_key` — Task 5
needs it, and it is not derivable from `itemId` for every connector.

`resolvedAtMs` is **optional**, not `0`-defaulted: the ticket-depth contract this workstream
established says a missing timestamp omits its key rather than claiming the epoch, and evidence
rows store `occurred_at` as nullable for the same reason.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/theme-discover.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { discoverClosedEpics } from "./theme-discover.ts";

function seedEpic(
  db: Database,
  p: {
    id: string;
    modifiedAt: number;
    statusCategory: string;
    issueType?: string;
    body?: string;
    bodyComplete?: number;
    resolvedAtMs?: number;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, ?, ?, ?, 1, 0)`,
    [
      p.id,
      p.id.split(":")[1] ?? p.id,
      p.body ?? "some body",
      p.bodyComplete ?? 1,
      JSON.stringify({
        meta_v: 1,
        status_category: p.statusCategory,
        issue_type: p.issueType ?? "Epic",
        resolved_at_ms: p.resolvedAtMs ?? 5000,
      }),
      p.modifiedAt,
    ],
  );
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

test("discovers only CLOSED epics", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 11, statusCategory: "canceled" });
  seedEpic(db, { id: "jira:C", modifiedAt: 12, statusCategory: "in_progress" });
  seedEpic(db, { id: "jira:D", modifiedAt: 13, statusCategory: "unknown" });

  const found = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found.map((e) => e.itemId).sort()).toEqual(["jira:A", "jira:B"]);
  db.close();
});

test("skips non-epic issues", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done", issueType: "Bug" });
  expect(discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 })).toEqual([]);
  db.close();
});

test("resumes strictly after the composite watermark", () => {
  // Three rows share modified_at = 10. Resuming on watermark_ms alone would
  // either re-scan all three or skip the two after the tie.
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:C", modifiedAt: 10, statusCategory: "done" });

  const found = discoverClosedEpics(db, {
    watermarkMs: 10,
    watermarkId: "jira:A",
    batchSize: 50,
  });
  expect(found.map((e) => e.itemId)).toEqual(["jira:B", "jira:C"]);
  db.close();
});

test("respects batchSize and returns rows in watermark order", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:C", modifiedAt: 30, statusCategory: "done" });
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 20, statusCategory: "done" });

  const found = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 2 });
  expect(found.map((e) => e.itemId)).toEqual(["jira:A", "jira:B"]);
  db.close();
});

test("reports body truncation so the brief can count it", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done", bodyComplete: 0 });
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.bodyComplete).toBe(false);
  db.close();
});

test("exposes the epic key children point at, and no connector service field", () => {
  // `epicKey` feeds affectedServicesForEpic. There is deliberately no `service`
  // field: a theme's service is the AFFECTED service, and surfacing the
  // connector one here is how that distinction gets lost.
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.epicKey).toBe("A");
  expect(found).not.toHaveProperty("service");
  db.close();
});

test("a missing resolved_at_ms is absent, never 0", () => {
  // Same rule the ticket-depth contract set: 0 would read as 1970, and a
  // consumer must be able to tell "unresolved" from "resolved at the epoch".
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES ('jira:N', 'jira', 'issue', 'N', 'T', 'b', 1, ?, 10, 1, 0)`,
    [JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic" })],
  );
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.resolvedAtMs).toBeUndefined();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/theme-discover.test.ts`
Expected: FAIL — `Cannot find module './theme-discover.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/theme-discover.ts`:

```ts
import type { Database } from "bun:sqlite";

/**
 * Discover stage: closed epics the pass has not yet mined.
 *
 * Selects an EXPLICIT column list, never `SELECT *`. Bodies run to 16 KiB since
 * V48, and a pass that pulls a whole epic corpus into memory would degrade the
 * interactive gateway — the opposite of why this work was moved off the request
 * path.
 */

export type DiscoveredEpic = {
  itemId: string;
  /** The ticket key children reference via `metadata.parent_key` (e.g. `PROJ-1`). */
  epicKey: string;
  title: string;
  body: string;
  bodyComplete: boolean;
  /** Absent when the source never supplied one — never 0, which would read as 1970. */
  resolvedAtMs?: number;
  modifiedAt: number;
};

/**
 * Resumes STRICTLY after `(watermarkMs, watermarkId)`. The composite tie-break
 * matters: a bulk import stamps thousands of rows with one `modified_at`, and
 * `modified_at > ?` alone would skip every row after the first in that group
 * while `>=` would re-scan them forever.
 */
export function discoverClosedEpics(
  db: Database,
  opts: { watermarkMs: number; watermarkId: string; batchSize: number },
): DiscoveredEpic[] {
  const rows = db
    .query(
      `SELECT id, external_id, title, body, body_complete, metadata, modified_at
         FROM item
        WHERE json_extract(metadata, '$.status_category') IN ('done','canceled')
          AND json_extract(metadata, '$.issue_type') = 'Epic'
          AND (modified_at > ? OR (modified_at = ? AND id > ?))
        ORDER BY modified_at ASC, id ASC
        LIMIT ?`,
    )
    .all(opts.watermarkMs, opts.watermarkMs, opts.watermarkId, opts.batchSize) as Array<{
    id: string;
    external_id: string;
    title: string;
    body: string | null;
    body_complete: number;
    metadata: string;
    modified_at: number;
  }>;

  return rows.map((r) => {
    const meta = JSON.parse(r.metadata) as Record<string, unknown>;
    const resolved = meta["resolved_at_ms"];
    return {
      itemId: r.id,
      epicKey: r.external_id,
      title: r.title,
      body: r.body ?? "",
      bodyComplete: r.body_complete === 1,
      // Omit the key entirely when absent — never 0.
      ...(typeof resolved === "number" ? { resolvedAtMs: resolved } : {}),
      modifiedAt: r.modified_at,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/theme-discover.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/theme-discover.ts packages/gateway/src/premortem/theme-discover.test.ts
git commit -m "feat(gateway): pre-mortem discover stage over closed epics"
```

---

### Task 7: Extract stage — LLM adapter with a hard no-model path

**Files:**

- Create: `packages/gateway/src/premortem/theme-llm-adapter.ts`
- Create: `packages/gateway/src/premortem/theme-llm-adapter.test.ts`

**Interfaces:**

- Consumes: `DiscoveredEpic` (Task 6).
- Produces:
  - `type ThemeLlm = { complete: (prompt: string) => Promise<string | null> }`
  - `type ExtractedTheme = { label: string; sourceItemIds: string[] }`
  - `extractThemes(epics: readonly DiscoveredEpic[], opts: { llm?: ThemeLlm }): Promise<ExtractedTheme[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/theme-llm-adapter.test.ts`:

```ts
import { expect, test } from "bun:test";

import type { DiscoveredEpic } from "./theme-discover.ts";
import { extractThemes } from "./theme-llm-adapter.ts";

// NOTE: `DiscoveredEpic` has NO `service` field and DOES require `epicKey`.
// An earlier draft of this fixture had it backwards and would not have compiled
// — the same invent-your-own-shape trap that hid three defects in this plan.
const EPICS: DiscoveredEpic[] = [
  {
    itemId: "jira:A",
    epicKey: "PROJ-1",
    title: "Billing v1",
    body: "Stripe capped us at 100 rps, had to batch",
    bodyComplete: true,
    resolvedAtMs: 1,
    modifiedAt: 1,
  },
  {
    itemId: "jira:B",
    epicKey: "PROJ-2",
    title: "Billing v1.5",
    body: "waiting on Twilio quota increase",
    bodyComplete: true,
    resolvedAtMs: 2,
    modifiedAt: 2,
  },
];

test("with no model, extraction yields ZERO themes — never a guess", () => {
  // There is no snippet fallback and deliberately so: glossary can pick a
  // snippet because it already knows the term, but here DISCOVERY is the task,
  // so there is nothing to look up. Inventing themes from keywords would
  // fabricate findings from a single incidental mention.
  return extractThemes(EPICS, {}).then((themes) => {
    expect(themes).toEqual([]);
  });
});

test("parses labels and their attributed sources from the model", async () => {
  const llm = {
    complete: async () =>
      JSON.stringify({
        themes: [
          { label: "third-party rate limits", sources: ["jira:A", "jira:B"] },
          { label: "vendor quota approval", sources: ["jira:B"] },
        ],
      }),
  };
  const themes = await extractThemes(EPICS, { llm });
  expect(themes).toEqual([
    { label: "third-party rate limits", sourceItemIds: ["jira:A", "jira:B"] },
    { label: "vendor quota approval", sourceItemIds: ["jira:B"] },
  ]);
});

test("drops a source the model invented, keeping the theme", async () => {
  // The model must not be able to attribute a theme to an epic that was never
  // in its prompt — that would fabricate corroboration, and corroboration IS
  // the confidence score.
  const llm = {
    complete: async () =>
      JSON.stringify({ themes: [{ label: "rate limits", sources: ["jira:A", "jira:NOPE"] }] }),
  };
  const themes = await extractThemes(EPICS, { llm });
  expect(themes).toEqual([{ label: "rate limits", sourceItemIds: ["jira:A"] }]);
});

test("drops a theme left with no valid source at all", async () => {
  const llm = {
    complete: async () => JSON.stringify({ themes: [{ label: "ghost", sources: ["jira:NOPE"] }] }),
  };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
});

test("malformed model output yields no themes rather than throwing", async () => {
  const llm = { complete: async () => "not json at all" };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
});

test("a null completion yields no themes", async () => {
  const llm = { complete: async () => null };
  expect(await extractThemes(EPICS, { llm })).toEqual([]);
});

test("a label that normalizes to nothing is dropped", async () => {
  // "..." survives a `trim() !== ""` check but normalizes to "", which would
  // key a theme on the empty string and surface a blank bullet in the brief.
  const llm = {
    complete: async () =>
      JSON.stringify({
        themes: [
          { label: "...", sources: ["jira:A"] },
          { label: "   ", sources: ["jira:A"] },
          { label: "rate limits", sources: ["jira:A"] },
        ],
      }),
  };
  expect(await extractThemes(EPICS, { llm })).toEqual([
    { label: "rate limits", sourceItemIds: ["jira:A"] },
  ]);
});

test("an empty epic batch never calls the model", async () => {
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };
  expect(await extractThemes([], { llm })).toEqual([]);
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/theme-llm-adapter.test.ts`
Expected: FAIL — `Cannot find module './theme-llm-adapter.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/theme-llm-adapter.ts`:

```ts
import { wrapToolOutput } from "../engine/tool-output-envelope.ts";
import type { DiscoveredEpic } from "./theme-discover.ts";
import { normalizeThemeLabel } from "./theme-identity.ts";

/** Minimal local-model surface; the real adapter is injected from assemble.ts. */
export type ThemeLlm = { complete: (prompt: string) => Promise<string | null> };

export type ExtractedTheme = { label: string; sourceItemIds: string[] };

const INSTRUCTIONS = [
  "You are given closed engineering epics, each with an id and body text.",
  "Identify recurring BLOCKER themes — reasons work was delayed or abandoned.",
  "Respond with JSON only:",
  '{"themes":[{"label":"short noun phrase","sources":["<epic id>", ...]}]}',
  "- A theme must recur, or be a substantive blocker; do not list one-off remarks.",
  "- `sources` must contain only ids present in the input. Never invent an id.",
  "- The label must be grounded in the text. Never invent facts not present.",
].join("\n");

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * NO snippet fallback exists, by decision. `glossary` can fall back to picking a
 * snippet because it already holds the term and needs only a definition; here
 * discovery IS the task, so there is nothing to look up. Without a model the
 * honest output is zero themes — the brief says so, and every structural risk
 * is still computed.
 */
export async function extractThemes(
  epics: readonly DiscoveredEpic[],
  opts: { llm?: ThemeLlm },
): Promise<ExtractedTheme[]> {
  if (opts.llm === undefined || epics.length === 0) {
    return [];
  }

  // I11: indexed third-party content reaching the model must be enveloped.
  const wrapped = wrapToolOutput(
    { service: "nimbus", tool: "premortem.themes" },
    { epics: epics.map((e) => ({ id: e.itemId, title: e.title, body: e.body })) },
  );

  let raw: string | null;
  try {
    raw = await opts.llm.complete(`${INSTRUCTIONS}\n\nSources:\n${wrapped}`);
  } catch {
    return [];
  }
  if (raw === null || raw === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rec = asRecord(parsed);
  const list = rec?.["themes"];
  if (!Array.isArray(list)) {
    return [];
  }

  const known = new Set(epics.map((e) => e.itemId));
  const out: ExtractedTheme[] = [];
  for (const entry of list) {
    const t = asRecord(entry);
    if (t === undefined) continue;
    const label = t["label"];
    if (typeof label !== "string") continue;
    // Normalize to test emptiness, not `trim()`: a label of "..." passes a trim
    // check but normalizes to "", which would key a theme on the empty string
    // and render as a blank bullet.
    if (normalizeThemeLabel(label) === "") continue;
    const sources = t["sources"];
    if (!Array.isArray(sources)) continue;
    // A source the model invented would fabricate corroboration, and
    // corroboration IS the confidence score — so filter, never trust.
    const valid = sources.filter((s): s is string => typeof s === "string" && known.has(s));
    if (valid.length === 0) continue;
    out.push({ label: label.trim(), sourceItemIds: [...new Set(valid)] });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/theme-llm-adapter.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/theme-llm-adapter.ts packages/gateway/src/premortem/theme-llm-adapter.test.ts
git commit -m "feat(gateway): pre-mortem theme extraction with a hard no-model path"
```

---

### Task 8: Pass orchestrator

**Files:**

- Create: `packages/gateway/src/premortem/premortem-pass.ts`
- Create: `packages/gateway/src/premortem/premortem-pass.test.ts`

**Interfaces:**

- Consumes: `affectedServicesForEpic` (Task 5), `discoverClosedEpics` (Task 6),
  `extractThemes` + `ThemeLlm` (Task 7), `upsertTheme` / `readPassState` / `writePassState` /
  `demoteThemesWithNoLiveEvidence` / `pruneOrphanedEvidence` / `ThemeEvidenceInput` (Task 3).
- Produces:
  - `type PremortemPassOptions = { nowMs: number; batchSize?: number; maxLlmCalls: number; llm?: ThemeLlm; signal?: AbortSignal }`
  - `type PremortemPassResult = { scanned: number; themesWritten: number; demoted: number; prunedEvidence: number; llmCalls: number }`
  - `runPremortemPass(db, opts: PremortemPassOptions): Promise<PremortemPassResult>`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/premortem-pass.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runPremortemPass } from "./premortem-pass.ts";
import { readPassState, themesForServices } from "./theme-store.ts";

/**
 * Seeds a closed epic AND the graph path that gives it an affected service:
 * epic → child → resolving PR → repo. Without that path the epic resolves to
 * no services and contributes no themes, so every test here needs it.
 */
function seedClosedEpic(
  db: Database,
  id: string,
  modifiedAt: number,
  body: string,
  service = "acme/billing-api",
): void {
  const key = id.split(":")[1] ?? id;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, 1, ?, ?, 1, 0)`,
    [
      id,
      key,
      body,
      JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic", resolved_at_ms: 9 }),
      modifiedAt,
    ],
  );
  const childId = `jira:${key}-child`;
  const prId = `github:pr:${key}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'C', ?, 1, 1, 0)`,
    [childId, `${key}-child`, JSON.stringify({ meta_v: 1, parent_key: key })],
  );
  // Real graph_entity columns: id, type, external_id, label, service, metadata.
  // The PR carries its repo as metadata.repo — that JSON field IS the service
  // hop, not an `in_repo` edge (which exists only for commits and files).
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, 'issue', ?, ?, 'jira', NULL)`,
    [childId, childId, childId],
  );
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, 'pr', ?, ?, 'github', ?)`,
    [prId, prId, prId, JSON.stringify({ repo: service })],
  );
  db.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'resolves', 1)`,
    [prId, childId],
  );
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

const okLlm = {
  complete: async () =>
    JSON.stringify({ themes: [{ label: "rate limits", sources: ["jira:A"] }] }),
};

test("writes themes under the AFFECTED service, not the connector", async () => {
  // The single most important assertion in this file. Keying on 'jira' would
  // make PR B's theme lookup — which matches a cohort's affected services —
  // return zero rows for every epic, while this pass looked perfectly healthy.
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us", "acme/billing-api");

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.scanned).toBe(1);
  expect(r.themesWritten).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"]).map((t) => t.label)).toEqual(["rate limits"]);
  expect(themesForServices(db, ["jira"])).toEqual([]);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("an epic touching two services writes the theme under both", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us", "acme/billing-api");
  // A second child of the same epic, landing in a different repo.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES ('jira:A-two', 'jira', 'issue', 'A-two', 'C2', ?, 1, 1, 0)`,
    [JSON.stringify({ meta_v: 1, parent_key: "A" })],
  );
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES ('jira:A-two', 'issue', 'jira:A-two', 'C2', 'jira', NULL)`,
  );
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES ('github:pr:A2', 'pr', 'github:pr:A2', 'PR', 'github', ?)`,
    [JSON.stringify({ repo: "acme/payments-worker" })],
  );
  db.run(
    `INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES ('github:pr:A2', 'jira:A-two', 'resolves', 1)`,
  );

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.themesWritten).toBe(2);
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);
  expect(themesForServices(db, ["acme/payments-worker"])).toHaveLength(1);
  db.close();
});

test("an epic whose services cannot be resolved contributes no theme", async () => {
  // Correct, not a silent drop: with no service there is no key under which
  // PR B could ever find the theme. The watermark still advances.
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES ('jira:A', 'jira', 'issue', 'A', 'T', 'b', 1, ?, 10, 1, 0)`,
    [JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic" })],
  );

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.themesWritten).toBe(0);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("a second pass over unchanged data scans nothing and calls no model", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");
  await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });

  let calls = 0;
  const counting = {
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };
  const r = await runPremortemPass(db, { nowMs: 200, maxLlmCalls: 5, llm: counting });
  expect(r.scanned).toBe(0);
  expect(calls).toBe(0);
  db.close();
});

test("with NO model: zero themes, but the watermark still advances", async () => {
  // The watermark must advance so a later pass, once a model is available, does
  // not re-scan the entire corpus from zero.
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5 });
  expect(r.themesWritten).toBe(0);
  expect(r.llmCalls).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("maxLlmCalls bounds the pass and leaves the rest for next time", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "one");
  seedClosedEpic(db, "jira:B", 20, "two");
  seedClosedEpic(db, "jira:C", 30, "three");

  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return JSON.stringify({ themes: [] });
    },
  };
  const r = await runPremortemPass(db, { nowMs: 100, batchSize: 1, maxLlmCalls: 2, llm });
  expect(calls).toBe(2);
  expect(r.llmCalls).toBe(2);
  // Stopped after B, so C is still ahead of the watermark.
  expect(readPassState(db)).toEqual({ watermarkMs: 20, watermarkId: "jira:B" });
  db.close();
});

test("an aborted pass keeps the watermark it had already checkpointed", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "one");
  seedClosedEpic(db, "jira:B", 20, "two");

  const ctrl = new AbortController();
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 1) ctrl.abort();
      return JSON.stringify({ themes: [] });
    },
  };
  await runPremortemPass(db, {
    nowMs: 100,
    batchSize: 1,
    maxLlmCalls: 9,
    llm,
    signal: ctrl.signal,
  });
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("the reconcile sweep prunes orphaned evidence and demotes the theme", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");
  await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);

  db.run(`DELETE FROM item WHERE id = 'jira:A'`);
  const r = await runPremortemPass(db, { nowMs: 200, maxLlmCalls: 5, llm: okLlm });
  expect(r.prunedEvidence).toBe(1);
  expect(r.demoted).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  // The evidence row is gone, not merely ignored — otherwise dead rows
  // accumulate forever behind every pruned item.
  const left = db.query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence`).get() as {
    n: number;
  };
  expect(left.n).toBe(0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/premortem-pass.test.ts`
Expected: FAIL — `Cannot find module './premortem-pass.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/premortem-pass.ts`:

```ts
import type { Database } from "bun:sqlite";

import { affectedServicesForEpic } from "./epic-services.ts";
import { type DiscoveredEpic, discoverClosedEpics } from "./theme-discover.ts";
import { extractThemes, type ThemeLlm } from "./theme-llm-adapter.ts";
import {
  demoteThemesWithNoLiveEvidence,
  pruneOrphanedEvidence,
  readPassState,
  type ThemeEvidenceInput,
  upsertTheme,
  writePassState,
} from "./theme-store.ts";

export type PremortemPassOptions = {
  nowMs: number;
  /** Rows pulled per iteration; also the model's prompt batch. */
  batchSize?: number;
  maxLlmCalls: number;
  llm?: ThemeLlm;
  signal?: AbortSignal;
};

export type PremortemPassResult = {
  scanned: number;
  themesWritten: number;
  demoted: number;
  /** Dead evidence rows removed by the reconcile sweep. Omitting this field
   *  contradicts the return statement below and fails tsc strict. */
  prunedEvidence: number;
  llmCalls: number;
};

const DEFAULT_BATCH_SIZE = 20;

/**
 * discover → extract → reconcile, checkpointing the watermark PER BATCH.
 *
 * The watermark advances even when no model is available and zero themes are
 * written. That is deliberate: the alternative re-scans the whole corpus on
 * every tick forever, and the batch genuinely has been examined — there was
 * simply nothing this configuration could extract from it.
 */
export async function runPremortemPass(
  db: Database,
  opts: PremortemPassOptions,
): Promise<PremortemPassResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let { watermarkMs, watermarkId } = readPassState(db);
  let scanned = 0;
  let themesWritten = 0;
  let llmCalls = 0;

  for (;;) {
    if (opts.signal?.aborted === true) break;
    if (llmCalls >= opts.maxLlmCalls && opts.llm !== undefined) break;

    const batch: DiscoveredEpic[] = discoverClosedEpics(db, {
      watermarkMs,
      watermarkId,
      batchSize,
    });
    if (batch.length === 0) break;

    if (opts.llm !== undefined) {
      llmCalls += 1;
      const themes = await extractThemes(batch, { llm: opts.llm });
      const byId = new Map(batch.map((e) => [e.itemId, e]));

      // A theme's service is the AFFECTED service its attesting epics touched
      // (`billing-api`), never the connector that owns the row (`jira`). PR B
      // matches themes against a cohort's affected services, so writing the
      // connector service here would leave every lookup returning zero rows
      // while both halves looked individually correct.
      const servicesByEpic = new Map<string, string[]>();
      for (const e of batch) {
        servicesByEpic.set(e.itemId, affectedServicesForEpic(db, e.itemId, e.epicKey));
      }

      for (const t of themes) {
        // One theme row per affected service, each carrying only the evidence
        // that actually touched that service.
        const evidenceByService = new Map<string, ThemeEvidenceInput[]>();
        for (const id of t.sourceItemIds) {
          const epic = byId.get(id);
          if (epic === undefined) continue;
          for (const service of servicesByEpic.get(id) ?? []) {
            const list = evidenceByService.get(service) ?? [];
            list.push({
              itemId: id,
              evidenceKey: id,
              label: epic.title,
              // Omit rather than default to 0 — `occurred_at` is nullable and
              // 1970 is a lie.
              ...(epic.resolvedAtMs === undefined ? {} : { occurredAt: epic.resolvedAtMs }),
            });
            evidenceByService.set(service, list);
          }
        }
        // An epic whose services could not be resolved contributes nothing.
        // That is correct, not a silent drop: with no service there is no key
        // under which PR B could ever find the theme.
        for (const [service, evidence] of evidenceByService) {
          upsertTheme(db, { service, label: t.label, nowMs: opts.nowMs, evidence });
          themesWritten += 1;
        }
      }
    }

    const last = batch[batch.length - 1];
    if (last === undefined) break;
    watermarkMs = last.modifiedAt;
    watermarkId = last.itemId;
    scanned += batch.length;

    // Checkpoint per batch, so an abort or crash resumes here rather than at 0.
    writePassState(db, {
      watermarkMs,
      watermarkId,
      nowMs: opts.nowMs,
      newThemes: themesWritten,
      scanned,
    });

    if (batch.length < batchSize) break;
  }

  // Reconcile: prune first, then demote. Pruning removes evidence whose source
  // item has left the index, which both stops dead rows accumulating forever
  // and keeps confidence honest — corroboration the user can no longer see
  // should not still be counted. Demotion then reduces to "no evidence left".
  const prunedEvidence = pruneOrphanedEvidence(db);
  const demoted = demoteThemesWithNoLiveEvidence(db, opts.nowMs);
  return { scanned, themesWritten, demoted, prunedEvidence, llmCalls };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/premortem-pass.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/premortem-pass.ts packages/gateway/src/premortem/premortem-pass.test.ts
git commit -m "feat(gateway): pre-mortem pass orchestrator with per-batch checkpointing"
```

---

### Task 9: Debounced refresher

Copies `decisions/decision-refresh.ts` in shape: a debounce timer, a single-flight guard, and a
`dirty` re-arm so a sync landing mid-pass schedules exactly one follow-up rather than queueing.

**Files:**

- Create: `packages/gateway/src/premortem/premortem-refresh.ts`
- Create: `packages/gateway/src/premortem/premortem-refresh.test.ts`

**Interfaces:**

- Consumes: `PremortemPassResult` (Task 8).
- Produces:
  - `type PremortemRefresher = { trigger: () => void; runNow: () => Promise<PremortemPassResult>; stop: () => void }`
  - `createPremortemRefresher(deps: { debounceMs: number; runPass: (signal: AbortSignal) => Promise<PremortemPassResult>; onError: (err: unknown) => void }): PremortemRefresher`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/premortem/premortem-refresh.test.ts`:

```ts
import { expect, test } from "bun:test";

import { createPremortemRefresher } from "./premortem-refresh.ts";

const EMPTY = { scanned: 0, themesWritten: 0, demoted: 0, prunedEvidence: 0, llmCalls: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("many triggers inside the debounce window run the pass once", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await sleep(60);
  expect(runs).toBe(1);
  r.stop();
});

test("a trigger during a run schedules exactly one follow-up", async () => {
  // Not zero (the new data would go unmined until the next sync) and not one
  // per trigger (a busy sync would queue an unbounded backlog of passes).
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      await sleep(40);
      return EMPTY;
    },
    onError: () => {},
  });
  r.trigger();
  await sleep(20); // first run in flight
  r.trigger();
  r.trigger();
  await sleep(140);
  expect(runs).toBe(2);
  r.stop();
});

test("stop() cancels a pending debounce", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.trigger();
  r.stop();
  await sleep(60);
  expect(runs).toBe(0);
});

test("a throwing pass reaches onError and does not wedge the refresher", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
      return EMPTY;
    },
    onError: (e) => errors.push(e),
  });
  r.trigger();
  await sleep(40);
  r.trigger();
  await sleep(40);
  expect(errors).toHaveLength(1);
  expect(runs).toBe(2);
  r.stop();
});

test("runNow bypasses the debounce and returns the result", async () => {
  const r = createPremortemRefresher({
    debounceMs: 10_000,
    runPass: async () => ({ scanned: 3, themesWritten: 1, demoted: 0, prunedEvidence: 0, llmCalls: 1 }),
    onError: () => {},
  });
  expect(await r.runNow()).toEqual({
    scanned: 3,
    themesWritten: 1,
    demoted: 0,
    prunedEvidence: 0,
    llmCalls: 1,
  });
  r.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/premortem/premortem-refresh.test.ts`
Expected: FAIL — `Cannot find module './premortem-refresh.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/premortem/premortem-refresh.ts`:

```ts
import type { PremortemPassResult } from "./premortem-pass.ts";

export type PremortemRefresher = {
  /** Debounced; safe to call on every sync completion. */
  trigger: () => void;
  /** Immediate, single-flight-respecting run — the `premortem.refresh` IPC path. */
  runNow: () => Promise<PremortemPassResult>;
  stop: () => void;
};

export type PremortemRefresherDeps = {
  debounceMs: number;
  runPass: (signal: AbortSignal) => Promise<PremortemPassResult>;
  onError: (err: unknown) => void;
};

/**
 * Mirrors `decisions/decision-refresh.ts`. The `dirty` flag is the important
 * part: a sync completing mid-pass must schedule exactly ONE follow-up — zero
 * would leave the new data unmined until the next sync, and one-per-trigger
 * would let a busy sync queue an unbounded backlog of passes.
 */
export function createPremortemRefresher(deps: PremortemRefresherDeps): PremortemRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  let controller: AbortController | undefined;

  async function execute(): Promise<PremortemPassResult> {
    running = true;
    controller = new AbortController();
    try {
      return await deps.runPass(controller.signal);
    } finally {
      running = false;
      controller = undefined;
      if (dirty && !stopped) {
        dirty = false;
        arm();
      }
    }
  }

  function fire(): void {
    timer = undefined;
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    void execute().catch((err: unknown) => {
      deps.onError(err);
    });
  }

  function arm(): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, deps.debounceMs);
    // Never hold the process open for a background pass.
    timer.unref?.();
  }

  return {
    trigger(): void {
      if (stopped) return;
      if (running) {
        dirty = true;
        return;
      }
      arm();
    },
    async runNow(): Promise<PremortemPassResult> {
      return await execute();
    },
    stop(): void {
      stopped = true;
      dirty = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      controller?.abort();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/premortem/premortem-refresh.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/premortem/premortem-refresh.ts packages/gateway/src/premortem/premortem-refresh.test.ts
git commit -m "feat(gateway): pre-mortem debounced refresher"
```

---

### Task 10: Wire the pass into the gateway + `premortem.refresh` IPC

**Files:**

- Create: `packages/gateway/src/ipc/premortem-rpc.ts`
- Create: `packages/gateway/src/ipc/premortem-rpc.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (imports; refresher construction beside
  `decisionsRefresher`; trigger on sync completion; pass the refresher into the IPC server options)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (route `premortem.*`)
- Modify: `packages/gateway/src/ipc/lan-server.ts` (add `premortem.refresh` to the LAN-forbidden set)
- Modify: `packages/gateway/src/ipc/lan-server.test.ts` (assert it is forbidden)

**Interfaces:**

- Consumes: `createPremortemRefresher` (8), `runPremortemPass` (7),
  `loadNimbusPremortemFromConfigDir` (4).
- Produces: IPC method `premortem.refresh` → `{ scanned, themesWritten, demoted, llmCalls }`.
  PR B consumes the same refresher instance for `nimbus pre-mortem --refresh`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/premortem-rpc.test.ts`:

```ts
import { expect, test } from "bun:test";

import { dispatchPremortemRpc } from "./premortem-rpc.ts";

const RESULT = { scanned: 4, themesWritten: 2, demoted: 1, prunedEvidence: 0, llmCalls: 1 };

test("premortem.refresh runs the pass and returns its counts", async () => {
  let ran = 0;
  const out = await dispatchPremortemRpc("premortem.refresh", null, {
    premortemRefresher: {
      runNow: async () => {
        ran += 1;
        return RESULT;
      },
    },
  });
  expect(ran).toBe(1);
  expect(out).toEqual({ kind: "hit", value: RESULT });
});

test("an unrelated method misses so the next dispatcher can claim it", async () => {
  const out = await dispatchPremortemRpc("glossary.refresh", null, {
    premortemRefresher: { runNow: async () => RESULT },
  });
  expect(out.kind).toBe("miss");
});

test("refresh with the pass disabled is an explicit error, not a silent no-op", async () => {
  // A silent success would tell the user their themes were refreshed when the
  // subsystem is switched off entirely.
  await expect(
    dispatchPremortemRpc("premortem.refresh", null, { premortemRefresher: undefined }),
  ).rejects.toThrow(/premortem.*disabled/i);
});

test("premortem.refresh rejects parameters rather than ignoring them", async () => {
  // It takes none. Accepting and dropping one would let a caller believe they
  // had scoped the refresh.
  await expect(
    dispatchPremortemRpc("premortem.refresh", { service: "jira" }, {
      premortemRefresher: { runNow: async () => RESULT },
    }),
  ).rejects.toThrow(/no parameters/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/premortem-rpc.test.ts`
Expected: FAIL — `Cannot find module './premortem-rpc.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/ipc/premortem-rpc.ts`:

```ts
import type { PremortemPassResult } from "../premortem/premortem-pass.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class PremortemRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "PremortemRpcError";
    this.rpcCode = rpcCode;
  }
}

export type PremortemRpcContext = {
  /** Absent when `[premortem].enabled = false` — the pass was never constructed. */
  premortemRefresher?: { runNow: () => Promise<PremortemPassResult> };
};

/**
 * Takes NO parameters and has no `rebuild` counterpart, following
 * `ownership.refresh`: the pass owns every row in its tables and re-derives
 * them from the index, so "rebuild" would be a synonym for refresh.
 */
async function handleRefresh(
  params: unknown,
  ctx: PremortemRpcContext,
): Promise<PremortemPassResult> {
  if (params !== null && params !== undefined) {
    const rec = typeof params === "object" && !Array.isArray(params) ? params : {};
    if (Object.keys(rec).length > 0) {
      throw new PremortemRpcError(-32602, "premortem.refresh takes no parameters");
    }
  }
  if (ctx.premortemRefresher === undefined) {
    throw new PremortemRpcError(
      -32603,
      "premortem theme extraction is disabled ([premortem].enabled = false)",
    );
  }
  return await ctx.premortemRefresher.runNow();
}

export async function dispatchPremortemRpc(
  method: string,
  params: unknown,
  ctx: PremortemRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<PremortemRpcContext>(method, params, ctx, {
    "premortem.refresh": (p, c) => handleRefresh(p, c),
  });
}
```

In `packages/gateway/src/platform/assemble.ts`, add the imports beside the decisions ones:

```ts
import { loadNimbusPremortemFromConfigDir } from "../config/nimbus-toml.ts";
import { runPremortemPass } from "../premortem/premortem-pass.ts";
import { createPremortemRefresher } from "../premortem/premortem-refresh.ts";
```

Construct it immediately after `decisionsRefresher`, gated on `enabled` in the same way:

```ts
  // Pre-mortem theme pass (S1). Construction is gated on `[premortem].enabled` — like
  // decisionsRefresher, not glossaryRefresher — so a disabled pass leaves this unset
  // rather than idling, and `premortem.refresh` fails loudly instead of silently
  // reporting success.
  const premortemCfg = loadNimbusPremortemFromConfigDir(paths.configDir);
  const premortemLlmForPass = premortemCfg.useLlm ? decisionLlm : undefined;
  const premortemRefresher = premortemCfg.enabled
    ? createPremortemRefresher({
        debounceMs: premortemCfg.debounceMs,
        runPass: (signal) =>
          runPremortemPass(db, {
            nowMs: Date.now(),
            maxLlmCalls: premortemCfg.maxLlmCallsPerPass,
            ...(premortemLlmForPass === undefined ? {} : { llm: premortemLlmForPass }),
            signal,
          }),
        onError: (err) => {
          syncLogger.warn({ err }, "premortem theme pass failed");
        },
      })
    : undefined;
```

Find where `decisionsRefresher.trigger()` is called on sync completion and add the sibling call
immediately after it:

```ts
      premortemRefresher?.trigger();
```

Find where `decisionsRefresher` is passed into the IPC server options and add:

```ts
      ...(premortemRefresher === undefined ? {} : { premortemRefresher }),
```

In `packages/gateway/src/ipc/server/dispatchers.ts`, register the dispatcher next to the decisions
one, passing the refresher through from options:

```ts
export async function tryDispatchPremortemRpc(
  method: string,
  params: unknown,
  ctx: ServerCtx,
): Promise<RpcMissOrHit> {
  return dispatchPremortemRpc(method, params, {
    ...(ctx.options.premortemRefresher === undefined
      ? {}
      : { premortemRefresher: ctx.options.premortemRefresher }),
  });
}
```

Add `premortemRefresher?: { runNow: () => Promise<PremortemPassResult> }` to the options type in
`packages/gateway/src/ipc/server/options.ts`, and add `tryDispatchPremortemRpc` to the dispatcher
chain beside `tryDispatchDecisionsRpc`.

In `packages/gateway/src/ipc/lan-server.ts`, add `"premortem.refresh"` to the LAN-forbidden method
set alongside `"decisions.refresh"` / `"ownership.refresh"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/premortem-rpc.test.ts packages/gateway/src/ipc/lan-server.test.ts packages/gateway/src/ipc/server/dispatchers.test.ts`
Expected: PASS. If `lan-server.test.ts` asserts an exact count of forbidden methods, increment it.

- [ ] **Step 5: Add the LAN-forbidden assertion**

Append to `packages/gateway/src/ipc/lan-server.test.ts`:

```ts
test("premortem.refresh is forbidden over LAN", () => {
  // It writes local rows and can spend the local model budget. Only the
  // read-only agents.premortem brief (PR B) is LAN-reachable.
  expect(checkLanMethodAllowed("premortem.refresh").allowed).toBe(false);
});
```

Run: `bun test packages/gateway/src/ipc/lan-server.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/premortem-rpc.ts packages/gateway/src/ipc/premortem-rpc.test.ts packages/gateway/src/ipc/lan-server.ts packages/gateway/src/ipc/lan-server.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/options.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(gateway): wire the pre-mortem pass and premortem.refresh IPC"
```

---

### Task 11: Docs and branch gates

PR A ships a schema and a background pass with no user-facing command — the docs say exactly that,
so the next reader does not go looking for `nimbus pre-mortem`.

**Files:**

- Modify: `docs/architecture.md` (V53 tables + the `premortem.refresh` method)
- Modify: `docs/schema-reference.md` (the four V53 tables) — the `nimbus-db-migrations` New Table
  Checklist calls for this and Task 1's review flagged it as the one real gap. V51 and V52 both
  skipped it in their own commits, so the precedent is drift, not permission: close it here.
- Modify: `docs/CHANGELOG.md` (Unreleased entry)
- Modify: `CLAUDE.md` and `GEMINI.md` (schema V52 → V53 in the status line — **both**, they mirror)

**Interfaces:**

- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Update the docs**

- `docs/architecture.md`: add the four V53 tables to the schema reference and `premortem.refresh`
  to the IPC catalogue, marked LAN-forbidden and not renderer-exposed.
- `docs/schema-reference.md`: document the four V53 tables alongside the V47 decisions and V51
  ownership entries already there.
- **State the Jira-only limitation** in the CHANGELOG entry and in `docs/architecture.md`: the
  discover stage keys on `metadata.issue_type = 'Epic'`, which only Jira writes, and no
  `linear:project` items are indexed, so no Linear epic-shaped row exists to mine. Supporting
  Linear requires a connector change and is not in PR A.
- `docs/CHANGELOG.md`: an Unreleased entry naming the V53 tables and the theme pass, and stating
  plainly that **no user-facing command ships in this PR** — `nimbus pre-mortem` arrives in PR B.
  Note the no-model behaviour (zero themes, watermark still advances) since that is the surprising
  part.
- `CLAUDE.md` **and** `GEMINI.md`: the status line says `schema V52`; both become `V53`. The two
  files mirror each other and drift if only one is edited.

Do **not** touch `.claude/commands/nimbus-agent-patterns.md` or `docs/roadmap.md` here — the agent
shape invariant is unchanged until PR B introduces the watcher writes.

- [ ] **Step 2: Run the branch gates**

```bash
bun run preflight:fast
bun test packages/gateway/src/premortem packages/gateway/src/ipc/premortem-rpc.test.ts
bun test packages/gateway/src/index/migrations packages/gateway/src/config/nimbus-toml.test.ts
```

Expected: all green. `preflight:fast` fail-fasts, so a single early failure hides every later gate —
re-run it after each fix rather than assuming the rest passed.

- [ ] **Step 3: Check the coverage floor for the new files**

Every new file must clear ≥85% line and ≥80% branch. Docker is authoritative, but a scoped run
under-reports and is therefore sufficient proof when it passes:

```bash
rm -rf coverage && mkdir -p coverage/.nyc-tmp
(cd packages/gateway && bun test --timeout 60000 \
  --preload "$PWD/../../scripts/coverage/istanbul-register.ts" \
  --preload "$PWD/../../scripts/coverage/report-coverage.ts")
bun scripts/coverage/merge-coverage.ts
grep -A 40 'premortem' coverage/lcov.info | grep -E '^(SF|LF|LH|BRF|BRH):'
```

Do **not** run `bun run audit:coverage-floor:update-baseline` — the baseline's `files` map is empty
on `main`, and updating it would bank any violation as the new floor.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md docs/CHANGELOG.md CLAUDE.md GEMINI.md
git commit -m "docs: V53 pre-mortem tables and the theme pass"
```

---

## Self-review notes

**Spec coverage.** V53 tables → Task 1 (all four, including `premortem_watcher_proposal`, which PR B
writes — schema precedes its reader). Content-derived id + normalization → Task 2. Confidence from
evidence count + the 0.86 ceiling → Task 2, enforced in Task 3. Composite watermark → Tasks 1, 3, 6,
8. Explicit column list + batching → Tasks 6, 8. **Themes keyed on the AFFECTED service** → Task 5,
enforced in Task 8. `[premortem]` config + `enabled`-gated construction → Tasks 4, 10. No-model ⇒
zero themes with the watermark still advancing → Tasks 7, 8. Reconcile prune-then-demote → Tasks 3,
8. `premortem.refresh`, no params, no rebuild, LAN-forbidden → Task 10.

**Deferred to PR B, by design:** the `agents.premortem` brief and its four lanes, cohort selection
with IDF weighting, the five structural risks, watcher creation and the three re-run rules, every
honesty rule that is phrased in the brief, the CLI, the Tauri `ALLOWED_METHODS` 104 → 105 bump, and
the `nimbus-agent-patterns` shape-invariant amendment. None of that is reachable until a read
surface exists.

**Naming consistency.** `premortem_theme`, `premortem_theme_evidence`, `premortem_pass_state`,
`premortem_watcher_proposal`, `themeId`, `normalizeThemeLabel`, `themeConfidence`,
`THEME_CONFIDENCE_CEILING`, `upsertTheme`, `ThemeEvidenceInput`, `themesForServices`,
`readPassState`, `writePassState`, `pruneOrphanedEvidence`, `demoteThemesWithNoLiveEvidence`,
`affectedServicesForEpic`, `discoverClosedEpics`, `DiscoveredEpic`, `extractThemes`, `ThemeLlm`,
`ExtractedTheme`, `runPremortemPass`, `PremortemPassOptions`, `PremortemPassResult`,
`createPremortemRefresher`, `PremortemRefresher`, `dispatchPremortemRpc`, `premortemRefresher` are
each used with one spelling and one type in every task that mentions them.

**The word "service" has exactly one meaning in this plan: the AFFECTED service an epic's work
touched** (`billing-api`), produced by `affectedServicesForEpic` in Task 5. It is never the
connector that owns the row (`jira`). `DiscoveredEpic` deliberately has no `service` field so the
two cannot be confused at a call site. An earlier draft of this plan got this backwards, which
would have left PR B's theme lookup matching zero rows while every test here still passed.

**Traps this plan inherits from prior workstreams in this repo** — re-check rather than trust:

- `bun run preflight:fast` **fail-fasts**; an early lint failure hides a dozen later audits.
- Never pipe a verification command through `tail` — the reported exit code becomes `tail`'s.
- Assertions counting a collection (`ALLOWED_METHODS.len()`, the LAN-forbidden set, migration
  version constants) break on any addition. Grep for the count before assuming a test is unrelated.
- `bun test --coverage` is inert in this repo (bunfig sets `coverage = false`); the istanbul
  preloads in Step 3 are the only working local path.
- Confirm `decisionLlm` is the correct local-model handle in `assemble.ts` at implementation time.
  Task 10 reuses it for `premortemLlmForPass`; if that variable has been renamed, follow the
  `decisionsRefresher` construction rather than this plan's literal name.
